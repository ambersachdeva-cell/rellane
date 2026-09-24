import { constants, promises } from "node:fs";
import { dirname } from "node:path";
import { RuntimeBoundaryError } from "../errors.js";

export interface ManagedFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly modifiedNanoseconds: string;
  readonly changedNanoseconds: string;
  readonly hardLinks: number;
}

export interface ManagedModelWritableFile {
  write(chunk: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ManagedModelMoveResult {
  readonly moved: boolean;
  readonly directoriesSynced: boolean;
}

export interface ManagedModelReadHandle {
  identity(): Promise<ManagedFileIdentity>;
  read(position: number, length: number): Promise<Buffer>;
  chunks(signal?: AbortSignal): AsyncIterable<Uint8Array>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ManagedModelFileSystem {
  ensurePrivateDirectory(path: string): Promise<void>;
  assertRealDirectory(path: string): Promise<void>;
  listDirectory(path: string): Promise<readonly string[]>;
  readUtf8(path: string): Promise<string | null>;
  replacePrivateFile(path: string, temporaryPath: string, content: string): Promise<void>;
  writeExclusivePrivateFile(path: string, content: string): Promise<boolean>;
  regularFileSize(path: string): Promise<number | null>;
  removeFile(path: string): Promise<void>;
  truncateRegularFile(path: string, size: number): Promise<void>;
  openWritable(
    path: string,
    append: boolean,
    expectedSize: number
  ): Promise<ManagedModelWritableFile>;
  openStableRead(path: string): Promise<ManagedModelReadHandle>;
  moveNoReplace(
    source: string,
    destination: string
  ): Promise<ManagedModelMoveResult>;
  syncDirectory(path: string): Promise<void>;
}

export class UnsafeManagedModelHardlinkError extends RuntimeBoundaryError {
  constructor(message = "The managed model file has an unsafe hardlink identity.") {
    super({
      code: "SECURITY_BOUNDARY",
      message,
      retryable: false
    });
    this.name = "UnsafeManagedModelHardlinkError";
  }
}

export class NodeManagedModelFileSystem implements ManagedModelFileSystem {
  constructor(
    private readonly fs: typeof promises = promises
  ) {}

  async ensurePrivateDirectory(path: string): Promise<void> {
    try {
      await this.fs.mkdir(path, { recursive: true, mode: 0o700 });
      await this.assertRealDirectory(path);
      try {
        await this.fs.chmod(path, 0o700);
      } catch (error) {
        if (process.platform !== "win32") {
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof RuntimeBoundaryError) {
        throw error;
      }
      throw storageError("Could not create or secure a managed model directory.", error);
    }
  }

  async assertRealDirectory(path: string): Promise<void> {
    try {
      const stat = await this.fs.lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw securityError("A managed model path contains a symlinked directory.");
      }
    } catch (error) {
      if (error instanceof RuntimeBoundaryError) {
        throw error;
      }
      throw storageError("Could not inspect a managed model directory.", error);
    }
  }

  async listDirectory(path: string): Promise<readonly string[]> {
    try {
      return await this.fs.readdir(path);
    } catch (error) {
      throw storageError("Could not inspect a managed model directory.", error);
    }
  }

  async readUtf8(path: string): Promise<string | null> {
    let handle: Awaited<ReturnType<typeof this.fs.open>> | null = null;
    try {
      handle = await this.fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await fileIdentity(handle);
      if (before.hardLinks !== 1 || before.size > 64 * 1024) {
        throw securityError("Managed model metadata is not a regular file.");
      }
      const content = await handle.readFile("utf8");
      const after = await fileIdentity(handle);
      if (!sameFileIdentity(before, after)) {
        throw securityError("Managed model metadata changed while it was being read.");
      }
      return content;
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        return null;
      }
      if (error instanceof RuntimeBoundaryError) {
        throw error;
      }
      throw storageError("Could not read managed model metadata.", error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async replacePrivateFile(
    path: string,
    temporaryPath: string,
    content: string
  ): Promise<void> {
    const created = await this.writeExclusivePrivateFile(temporaryPath, content);
    if (!created) {
      throw storageError("A managed model metadata staging name already exists.");
    }
    try {
      const existing = await this.fs.lstat(path).catch((error: unknown) => {
        if (isCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      });
      if (existing !== null && (!existing.isFile() || existing.isSymbolicLink())) {
        throw securityError("Managed model metadata cannot replace a non-regular file.");
      }
      await this.fs.rename(temporaryPath, path);
      await this.syncDirectory(dirname(path));
    } catch (error) {
      await this.fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof RuntimeBoundaryError) {
        throw error;
      }
      throw storageError("Could not durably replace managed model metadata.", error);
    }
  }

  async writeExclusivePrivateFile(path: string, content: string): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof this.fs.open>> | null = null;
    try {
      handle = await this.fs.open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600
      );
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      return true;
    } catch (error) {
      if (isCode(error, "EEXIST")) {
        return false;
      }
      throw storageError("Could not create exclusive managed model evidence.", error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async regularFileSize(path: string): Promise<number | null> {
    try {
      const stat = await this.fs.lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink !== 1) {
        throw new UnsafeManagedModelHardlinkError();
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw securityError("A managed model path is not a regular file.");
      }
      return stat.size;
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        return null;
      }
      if (error instanceof RuntimeBoundaryError) {
        throw error;
      }
      throw storageError("Could not inspect a managed model file.", error);
    }
  }

  async removeFile(path: string): Promise<void> {
    try {
      await this.fs.rm(path, { force: true });
    } catch (error) {
      throw storageError("Could not remove a managed model staging file.", error);
    }
  }

  async truncateRegularFile(path: string, size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw securityError("The managed model truncate size is invalid.");
    }
    let handle: Awaited<ReturnType<typeof this.fs.open>> | null = null;
    try {
      handle = await this.fs.open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
      const before = await fileIdentity(handle);
      if (before.hardLinks !== 1) {
        throw new UnsafeManagedModelHardlinkError();
      }
      if (before.size < size) {
        throw securityError("The managed model partial cannot be truncated safely.");
      }
      await handle.truncate(size);
      await handle.sync();
      const after = await fileIdentity(handle);
      if (after.hardLinks !== 1) {
        throw new UnsafeManagedModelHardlinkError();
      }
      if (after.size !== size) {
        throw securityError("The managed model partial changed while it was truncated.");
      }
    } catch (error) {
      if (error instanceof RuntimeBoundaryError) {
        throw error;
      }
      throw storageError("Could not truncate a managed model partial safely.", error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async openWritable(
    path: string,
    append: boolean,
    expectedSize: number
  ): Promise<ManagedModelWritableFile> {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      throw securityError("The managed model writable size is invalid.");
    }
    let handle: Awaited<ReturnType<typeof this.fs.open>> | null = null;
    try {
      const flags = append
        ? constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
        : constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW;
      handle = await this.fs.open(path, flags, 0o600);
      const initial = await fileIdentity(handle);
      if (initial.hardLinks !== 1) {
        throw new UnsafeManagedModelHardlinkError();
      }
      if (
        initial.size !== expectedSize ||
        (!append && expectedSize !== 0)
      ) {
        throw securityError("The managed model writable file has an unsafe identity.");
      }
      const writableHandle = handle;
      handle = null;
      return {
        write: async (chunk) => {
          try {
            let offset = 0;
            while (offset < chunk.byteLength) {
              const result = await writableHandle.write(
                chunk,
                offset,
                chunk.byteLength - offset
              );
              if (result.bytesWritten <= 0) {
                throw storageError("The managed model file write made no progress.");
              }
              offset += result.bytesWritten;
            }
          } catch (error) {
            if (error instanceof RuntimeBoundaryError) {
              throw error;
            }
            throw storageError("Could not write the managed model staging file.", error);
          }
        },
        sync: async () => {
          try {
            await writableHandle.sync();
          } catch (error) {
            throw storageError("Could not sync the managed model staging file.", error);
          }
        },
        close: async () => {
          try {
            await writableHandle.close();
          } catch (error) {
            throw storageError("Could not close the managed model staging file.", error);
          }
        }
      };
    } catch (error) {
      if (error instanceof RuntimeBoundaryError) {
        throw error;
      }
      if (!append && isCode(error, "EEXIST")) {
        throw securityError("A fresh managed model staging file already exists.");
      }
      throw storageError("Could not open the managed model staging file.", error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async openStableRead(path: string): Promise<ManagedModelReadHandle> {
    let handle: Awaited<ReturnType<typeof this.fs.open>> | null = null;
    try {
      handle = await this.fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const initial = await fileIdentity(handle);
      if (initial.hardLinks !== 1) {
        throw new UnsafeManagedModelHardlinkError();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof RuntimeBoundaryError) {
        throw error;
      }
      throw storageError("Could not open the managed model through a stable handle.", error);
    }
    if (handle === null) {
      throw storageError("Could not retain the stable managed model handle.");
    }
    const stableHandle = handle;

    return {
      identity: async () => fileIdentity(stableHandle),
      read: async (position, length) => {
        if (
          !Number.isSafeInteger(position) ||
          position < 0 ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > 64 * 1024
        ) {
          throw securityError("The stable model read request is outside its bounded range.");
        }
        const buffer = Buffer.alloc(length);
        let bytesRead = 0;
        while (bytesRead < length) {
          const result = await stableHandle.read(
            buffer,
            bytesRead,
            length - bytesRead,
            position + bytesRead
          );
          if (result.bytesRead === 0) {
            break;
          }
          bytesRead += result.bytesRead;
        }
        return buffer.subarray(0, bytesRead);
      },
      chunks: (signal) => stableChunks(stableHandle, signal),
      sync: async () => {
        try {
          await stableHandle.sync();
        } catch (error) {
          throw storageError("Could not sync the stable managed model handle.", error);
        }
      },
      close: async () => {
        try {
          await stableHandle.close();
        } catch (error) {
          throw storageError("Could not close the stable managed model handle.", error);
        }
      }
    };
  }

  async moveNoReplace(
    source: string,
    destination: string
  ): Promise<ManagedModelMoveResult> {
    try {
      await this.fs.link(source, destination);
    } catch (error) {
      if (isCode(error, "EEXIST")) {
        return { moved: false, directoriesSynced: true };
      }
      throw storageError("Could not create a no-clobber managed model destination.", error);
    }
    let sourceUnlinked = false;
    try {
      await this.fs.unlink(source);
      sourceUnlinked = true;
    } catch (error) {
      if (!sourceUnlinked) {
        await this.fs.unlink(destination).catch(() => undefined);
        await this.syncDirectory(dirname(destination)).catch(() => undefined);
      }
      throw storageError("Could not finish the no-clobber managed model move.", error);
    }
    const syncResults = await Promise.allSettled([
      this.syncDirectory(dirname(source)),
      this.syncDirectory(dirname(destination))
    ]);
    return {
      moved: true,
      directoriesSynced: syncResults.every((result) => result.status === "fulfilled")
    };
  }

  async syncDirectory(path: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof this.fs.open>> | null = null;
    try {
      handle = await this.fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      await handle.sync();
    } catch (error) {
      if (process.platform !== "win32") {
        throw storageError("Could not sync a managed model directory.", error);
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

async function fileIdentity(
  handle: Awaited<ReturnType<typeof promises.open>>
): Promise<ManagedFileIdentity> {
  const stat = await handle.stat({ bigint: true });
  if (!stat.isFile() || stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw securityError("The managed model handle is not a supported regular file.");
  }
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: Number(stat.size),
    modifiedNanoseconds: stat.mtimeNs.toString(),
    changedNanoseconds: stat.ctimeNs.toString(),
    hardLinks: Number(stat.nlink)
  };
}

function sameFileIdentity(
  left: ManagedFileIdentity,
  right: ManagedFileIdentity
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.changedNanoseconds === right.changedNanoseconds &&
    left.hardLinks === right.hardLinks
  );
}

async function* stableChunks(
  handle: Awaited<ReturnType<typeof promises.open>>,
  signal?: AbortSignal
): AsyncIterable<Uint8Array> {
  const stream = handle.createReadStream({
    autoClose: false,
    start: 0,
    ...(signal === undefined ? {} : { signal })
  });
  for await (const chunk of stream) {
    yield chunk as Buffer;
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function securityError(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "SECURITY_BOUNDARY",
    message,
    retryable: false
  });
}

function storageError(message: string, cause?: unknown): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "STORAGE_UNAVAILABLE",
    message,
    retryable: true
  }, { cause });
}
