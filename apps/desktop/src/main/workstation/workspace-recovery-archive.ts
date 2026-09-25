/**
 * Authenticated multi-store workspace archive packer and unpacker.
 *
 * Implements authenticated encryption (AES-256-GCM) with AAD-protected headers,
 * authentication-before-decompression, bounded gzip decompression, strict path
 * validation, and atomic no-clobber publication.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes
} from "node:crypto";
import { link, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  type WorkspaceRecoveryManifest,
  type RecoveryManifestFileEntry,
  validateRecoveryManifest,
  isSafeRecoveryRelativePath,
  MAX_RECOVERY_FILE_BYTES,
  MAX_RECOVERY_TOTAL_BYTES,
  RECOVERY_APP_IDENTITY
} from "./workspace-recovery-manifest.js";
import { AmbiguousPublicationError, defaultSyncDirectory } from "../book/bounded-archive.js";

export const WORKSPACE_ARCHIVE_MAGIC = "CADRANE-WORKSPACE-BACKUP" as const;
export const WORKSPACE_ARCHIVE_FORMAT = 1 as const;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const MAX_HEADER_BYTES = 2048;

export interface WorkspaceArchiveHeader {
  readonly magic: typeof WORKSPACE_ARCHIVE_MAGIC;
  readonly format: typeof WORKSPACE_ARCHIVE_FORMAT;
  readonly createdAt: string;
  readonly appIdentity: typeof RECOVERY_APP_IDENTITY;
  readonly sourceIdentity: string;
  readonly bookSchema: number;
  readonly fileCount: number;
  readonly plainBytes: number;
  readonly manifestSha256: string;
  readonly salt: string;
  readonly nonce: string;
}

export interface WorkspaceArchiveLimits {
  readonly maxPlainBytes: number;
  readonly maxArchiveBytes: number;
  readonly maxFileBytes: number;
  readonly maxEntries: number;
}

export const DEFAULT_RECOVERY_LIMITS: WorkspaceArchiveLimits = {
  maxPlainBytes: MAX_RECOVERY_TOTAL_BYTES,
  maxArchiveBytes: 256 * 1024 * 1024,
  maxFileBytes: MAX_RECOVERY_FILE_BYTES,
  maxEntries: 10_000
};

export class WorkspaceArchiveError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "WorkspaceArchiveError";
  }
}

function deriveArchiveKey(secret: Buffer, salt: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      salt,
      `${WORKSPACE_ARCHIVE_MAGIC}/v${WORKSPACE_ARCHIVE_FORMAT}`,
      KEY_BYTES
    )
  );
}

/**
 * Packs multiple files and manifest into a single deterministic buffer.
 */
function packPayload(
  files: ReadonlyMap<string, Buffer>,
  manifest: WorkspaceRecoveryManifest
): Buffer {
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const entries: Buffer[] = [];

  // Header: entry count (4 bytes)
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(manifest.files.length, 0);
  entries.push(countBuf);

  for (const fileEntry of manifest.files) {
    const pathBuf = Buffer.from(fileEntry.relativePath, "utf8");
    const metaBuf = Buffer.alloc(2 + 1 + 4 + 32);

    // Path length (2 bytes)
    metaBuf.writeUInt16BE(pathBuf.byteLength, 0);
    // Is directory flag (1 byte)
    metaBuf.writeUInt8(fileEntry.kind === "directory" ? 1 : 0, 2);
    // File content length (4 bytes)
    const content = fileEntry.kind === "file" ? (files.get(fileEntry.relativePath) ?? Buffer.alloc(0)) : Buffer.alloc(0);
    metaBuf.writeUInt32BE(content.byteLength, 3);
    // SHA256 digest raw (32 bytes)
    const rawSha = fileEntry.kind === "file"
      ? Buffer.from(fileEntry.sha256, "hex")
      : Buffer.alloc(32, 0);
    rawSha.copy(metaBuf, 7);

    entries.push(metaBuf);
    entries.push(pathBuf);
    if (fileEntry.kind === "file") {
      entries.push(content);
    }
  }

  // Trailing manifest block: length (4 bytes) + JSON bytes
  const manifestLenBuf = Buffer.alloc(4);
  manifestLenBuf.writeUInt32BE(manifestBytes.byteLength, 0);
  entries.push(manifestLenBuf);
  entries.push(manifestBytes);

  return Buffer.concat(entries);
}

/**
 * Unpacks files and manifest from a decompressed payload buffer.
 */
function unpackPayload(
  payload: Buffer,
  limits: WorkspaceArchiveLimits
): {
  readonly files: Map<string, Buffer>;
  readonly manifest: WorkspaceRecoveryManifest;
} {
  let offset = 0;
  if (payload.byteLength < 4) {
    throw new WorkspaceArchiveError("Decompressed archive payload is too short.");
  }

  const fileCount = payload.readUInt32BE(offset);
  offset += 4;

  if (fileCount > limits.maxEntries) {
    throw new WorkspaceArchiveError("Archive entry count exceeds configured limit.");
  }

  const files = new Map<string, Buffer>();

  for (let i = 0; i < fileCount; i++) {
    if (offset + 2 + 1 + 4 + 32 > payload.byteLength) {
      throw new WorkspaceArchiveError("Corrupted file entry header in archive payload.");
    }

    const pathLen = payload.readUInt16BE(offset);
    const isDir = payload.readUInt8(offset + 2) === 1;
    const contentLen = payload.readUInt32BE(offset + 3);
    const expectedSha = payload.subarray(offset + 7, offset + 39).toString("hex");
    offset += 39;

    if (offset + pathLen > payload.byteLength) {
      throw new WorkspaceArchiveError("Corrupted file path in archive payload.");
    }
    const relativePath = payload.toString("utf8", offset, offset + pathLen);
    offset += pathLen;

    if (!isSafeRecoveryRelativePath(relativePath)) {
      throw new WorkspaceArchiveError(`Unsafe path encountered in archive payload: ${relativePath}`);
    }

    if (isDir) {
      if (contentLen !== 0) {
        throw new WorkspaceArchiveError(`Directory entry ${relativePath} has non-zero byte length.`);
      }
    } else {
      if (contentLen > limits.maxFileBytes) {
        throw new WorkspaceArchiveError(`File ${relativePath} exceeds maximum file byte bound.`);
      }
      if (offset + contentLen > payload.byteLength) {
        throw new WorkspaceArchiveError(`Corrupted file content in archive payload for ${relativePath}.`);
      }
      const content = Buffer.from(payload.subarray(offset, offset + contentLen));
      offset += contentLen;

      const actualSha = createHash("sha256").update(content).digest("hex");
      if (actualSha !== expectedSha) {
        throw new WorkspaceArchiveError(`Hash mismatch for unpacked archive entry ${relativePath}.`);
      }
      files.set(relativePath, content);
    }
  }

  if (offset + 4 > payload.byteLength) {
    throw new WorkspaceArchiveError("Missing manifest length block in archive payload.");
  }
  const manifestLen = payload.readUInt32BE(offset);
  offset += 4;

  if (offset + manifestLen > payload.byteLength) {
    throw new WorkspaceArchiveError("Corrupted manifest data in archive payload.");
  }
  const manifestText = payload.toString("utf8", offset, offset + manifestLen);
  offset += manifestLen;

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch (error) {
    throw new WorkspaceArchiveError("Failed to parse manifest JSON from archive payload.", error);
  }

  const manifest = validateRecoveryManifest(parsed);
  return { files, manifest };
}

export interface PackWorkspaceArchiveOptions {
  readonly manifest: WorkspaceRecoveryManifest;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly secret: Buffer;
  readonly destination: string;
  readonly limits?: WorkspaceArchiveLimits | undefined;
  readonly syncDirectory?: ((directory: string) => Promise<void>) | undefined;
}

export interface PackWorkspaceArchiveReceipt {
  readonly destination: string;
  readonly header: WorkspaceArchiveHeader;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly plainBytes: number;
}

export async function packWorkspaceArchive(
  options: PackWorkspaceArchiveOptions
): Promise<PackWorkspaceArchiveReceipt> {
  const { manifest, files, secret, destination } = options;
  const limits = options.limits ?? DEFAULT_RECOVERY_LIMITS;

  if (!Buffer.isBuffer(secret) || secret.byteLength < 16) {
    throw new WorkspaceArchiveError("Recovery secret must be a Buffer of at least 16 bytes.");
  }

  // Verify all files declared in manifest exist in memory map
  for (const entry of manifest.files) {
    if (entry.kind === "file") {
      const fileData = files.get(entry.relativePath);
      if (!fileData) {
        throw new WorkspaceArchiveError(`Missing file data for declared manifest entry: ${entry.relativePath}`);
      }
      if (fileData.byteLength !== entry.bytes) {
        throw new WorkspaceArchiveError(`Byte size mismatch for file ${entry.relativePath}`);
      }
      const actualSha = createHash("sha256").update(fileData).digest("hex");
      if (actualSha !== entry.sha256) {
        throw new WorkspaceArchiveError(`Digest mismatch for file ${entry.relativePath}`);
      }
    }
  }

  const packed = packPayload(files, manifest);
  if (packed.byteLength > limits.maxPlainBytes) {
    throw new WorkspaceArchiveError("Uncompressed archive plain bytes exceed bounded limit.");
  }

  const gzipped = gzipSync(packed, {
    level: 6,
    maxOutputLength: limits.maxArchiveBytes
  });

  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = deriveArchiveKey(secret, salt);

  const header: WorkspaceArchiveHeader = {
    magic: WORKSPACE_ARCHIVE_MAGIC,
    format: WORKSPACE_ARCHIVE_FORMAT,
    createdAt: new Date().toISOString(),
    appIdentity: RECOVERY_APP_IDENTITY,
    sourceIdentity: manifest.sourceIdentity,
    bookSchema: manifest.bookSchema,
    fileCount: manifest.totalFiles,
    plainBytes: packed.byteLength,
    manifestSha256: manifest.manifestSha256,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64")
  };

  const headerLine = `${JSON.stringify(header)}\n`;
  const headerBytes = Buffer.from(headerLine, "utf8");
  if (headerBytes.byteLength > MAX_HEADER_BYTES) {
    throw new WorkspaceArchiveError("Archive header exceeds maximum allowable bytes.");
  }

  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(headerBytes);
  const ciphertext = Buffer.concat([cipher.update(gzipped), cipher.final()]);
  const tag = cipher.getAuthTag();

  const archive = Buffer.concat([headerBytes, ciphertext, tag]);
  if (archive.byteLength > limits.maxArchiveBytes) {
    throw new WorkspaceArchiveError("Final archive ciphertext exceeds maximum output limit.");
  }

  const destinationDir = path.dirname(destination);
  const tempWriting = path.join(
    destinationDir,
    `.${path.basename(destination)}.stage.${Date.now()}.${randomBytes(6).toString("hex")}`
  );

  try {
    await writeFile(tempWriting, archive);
    const handle = await open(tempWriting, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Atomic no-clobber publication using link
    await link(tempWriting, destination);
  } finally {
    await rm(tempWriting, { force: true });
  }

  try {
    await (options.syncDirectory ?? defaultSyncDirectory)(destinationDir);
  } catch (error) {
    throw new AmbiguousPublicationError(destination, error);
  }

  return {
    destination,
    header,
    archiveBytes: archive.byteLength,
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    plainBytes: packed.byteLength
  };
}

export interface UnpackedArchiveResult {
  readonly header: WorkspaceArchiveHeader;
  readonly manifest: WorkspaceRecoveryManifest;
  readonly files: ReadonlyMap<string, Buffer>;
}

export function parseWorkspaceArchiveHeader(fileBuffer: Buffer): {
  readonly header: WorkspaceArchiveHeader;
  readonly headerLineBytes: Buffer;
  readonly ciphertextAndTag: Buffer;
} {
  const newlineIndex = fileBuffer.indexOf(0x0a);
  if (newlineIndex === -1 || newlineIndex > MAX_HEADER_BYTES) {
    throw new WorkspaceArchiveError("Archive header line is missing or exceeds bounded length.");
  }

  const headerLineBytes = fileBuffer.subarray(0, newlineIndex + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerLineBytes.toString("utf8"));
  } catch (error) {
    throw new WorkspaceArchiveError("Archive header contains malformed JSON.", error);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new WorkspaceArchiveError("Archive header must be an object.");
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.magic !== WORKSPACE_ARCHIVE_MAGIC) {
    throw new WorkspaceArchiveError("File is not a Rellane workspace recovery archive.");
  }
  if (obj.format !== WORKSPACE_ARCHIVE_FORMAT) {
    throw new WorkspaceArchiveError(`Unsupported archive format version: ${obj.format}`);
  }
  if (obj.appIdentity !== RECOVERY_APP_IDENTITY) {
    throw new WorkspaceArchiveError(`Mismatched archive app identity: ${obj.appIdentity}`);
  }
  if (typeof obj.sourceIdentity !== "string" || !obj.sourceIdentity) {
    throw new WorkspaceArchiveError("Archive header sourceIdentity is invalid.");
  }
  if (!Number.isSafeInteger(obj.bookSchema) || (obj.bookSchema as number) < 1) {
    throw new WorkspaceArchiveError("Archive header bookSchema is invalid.");
  }
  if (!Number.isSafeInteger(obj.plainBytes) || (obj.plainBytes as number) <= 0) {
    throw new WorkspaceArchiveError("Archive header plainBytes is non-positive or invalid.");
  }
  if (typeof obj.salt !== "string" || typeof obj.nonce !== "string") {
    throw new WorkspaceArchiveError("Archive header missing cryptographic parameters.");
  }

  return {
    header: obj as unknown as WorkspaceArchiveHeader,
    headerLineBytes,
    ciphertextAndTag: fileBuffer.subarray(newlineIndex + 1)
  };
}

/**
 * Authenticates, decrypts, and unpacks a workspace archive from raw bytes.
 * Authenticates GCM tag BEFORE decompression.
 */
export function unpackWorkspaceArchive(
  archiveBuffer: Buffer,
  secret: Buffer,
  limits: WorkspaceArchiveLimits = DEFAULT_RECOVERY_LIMITS
): UnpackedArchiveResult {
  if (archiveBuffer.byteLength > limits.maxArchiveBytes) {
    throw new WorkspaceArchiveError("Archive size exceeds maximum allowable archive byte limit.");
  }

  const { header, headerLineBytes, ciphertextAndTag } = parseWorkspaceArchiveHeader(archiveBuffer);

  if (ciphertextAndTag.byteLength <= TAG_BYTES) {
    throw new WorkspaceArchiveError("Archive holds no encrypted payload.");
  }

  const salt = Buffer.from(header.salt, "base64");
  const nonce = Buffer.from(header.nonce, "base64");
  if (salt.byteLength !== SALT_BYTES || nonce.byteLength !== NONCE_BYTES) {
    throw new WorkspaceArchiveError("Invalid salt or nonce byte length in archive header.");
  }

  const key = deriveArchiveKey(secret, salt);
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.byteLength - TAG_BYTES);
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.byteLength - TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(headerLineBytes);
  decipher.setAuthTag(tag);

  let gzipped: Buffer;
  try {
    gzipped = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new WorkspaceArchiveError(
      "Archive authentication failed. Either the recovery secret is incorrect, or the archive has been damaged or altered.",
      error
    );
  }

  // Decompress only after tag authentication succeeds
  let packed: Buffer;
  try {
    packed = gunzipSync(gzipped, { maxOutputLength: limits.maxPlainBytes });
  } catch (error) {
    throw new WorkspaceArchiveError("Failed to decompress archive payload or output exceeds bounds.", error);
  }

  if (packed.byteLength !== header.plainBytes) {
    throw new WorkspaceArchiveError("Decompressed byte length disagrees with authenticated archive header.");
  }

  const { files, manifest } = unpackPayload(packed, limits);
  if (manifest.manifestSha256 !== header.manifestSha256) {
    throw new WorkspaceArchiveError("Manifest digest disagrees with authenticated archive header.");
  }

  return { header, manifest, files };
}
