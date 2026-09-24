import { createHash } from "node:crypto";
import {
  chmod,
  constants,
  lstat,
  mkdtemp,
  open,
  realpath,
  rmdir,
  unlink
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractFile, listPackage, statFile, uncache } from "@electron/asar";
import {
  STORAGE_CAPABILITY_GATE_ENTRY,
  STORAGE_CAPABILITY_MAIN_ENTRY,
  STORAGE_CAPABILITY_MAX_ENTRY_BYTES,
  STORAGE_CAPABILITY_MAX_PACKAGE_BYTES,
  STORAGE_CAPABILITY_UTILITY_ENTRY,
  StorageCapabilityPackageStaticEvidenceSchema
} from "@cadrane/contracts/storage-capability";

const EXPECTED_ENTRIES = Object.freeze([
  STORAGE_CAPABILITY_MAIN_ENTRY,
  STORAGE_CAPABILITY_UTILITY_ENTRY,
  STORAGE_CAPABILITY_GATE_ENTRY
]);
const MAX_ASAR_HEADER_BYTES = 16 * 1024 * 1024;

export async function inspectStorageCapabilityPackage({ asarPath, outputPath }) {
  assertCanonicalAbsolutePath(asarPath, "ASAR");
  assertCanonicalAbsolutePath(outputPath, "output");
  if (asarPath === outputPath) throw new Error("Storage capability inspection paths must differ.");

  await inspectRealOutputParent(outputPath);
  const snapshot = await createVerifiedBoundedSnapshot(asarPath);
  const entryBytes = new Map();
  uncache(snapshot.path);

  try {
    const before = await inspectRealRegularFile(
      snapshot.path,
      STORAGE_CAPABILITY_MAX_PACKAGE_BYTES,
      "snapshot"
    );
    await preflightAsarHeader(snapshot.path, before.size);
    const listed = listPackage(snapshot.path, { isPack: false });
    for (const entry of EXPECTED_ENTRIES) {
      if (listed.filter((candidate) => candidate === `/${entry}`).length !== 1) {
        throw new Error("Storage capability package is missing an exact probe entry.");
      }
      const metadata = statFile(snapshot.path, entry, false);
      if (
        "link" in metadata ||
        "files" in metadata ||
        metadata.unpacked === true ||
        !Number.isSafeInteger(metadata.size) ||
        metadata.size <= 0 ||
        metadata.size > STORAGE_CAPABILITY_MAX_ENTRY_BYTES
      ) {
        throw new Error("Storage capability package contains an invalid probe entry.");
      }
      const extracted = extractFile(snapshot.path, entry, false);
      if (extracted.byteLength !== metadata.size) {
        extracted.fill(0);
        throw new Error("Storage capability package probe size changed during inspection.");
      }
      entryBytes.set(entry, extracted);
    }

    assertProbeMarkers(entryBytes);
    const after = await inspectRealRegularFile(
      snapshot.path,
      STORAGE_CAPABILITY_MAX_PACKAGE_BYTES,
      "snapshot"
    );
    const secondAsarSha256 = await sha256FileBounded(snapshot.path, before.size);
    if (!sameFileSnapshot(before, after) || snapshot.sha256 !== secondAsarSha256) {
      throw new Error("Storage capability package changed during inspection.");
    }

    const evidence = StorageCapabilityPackageStaticEvidenceSchema.parse({
      schemaVersion: 1,
      domain: "switchboard/storage-capability/package-static-inspection/v1",
      inspectionKind: "packaged-static-inspection",
      durableSpacesEnabled: false,
      package: {
        asarSha256: snapshot.sha256,
        asarBytes: Number(before.size)
      },
      entries: {
        mainProbe: entryEvidence(
          STORAGE_CAPABILITY_MAIN_ENTRY,
          entryBytes.get(STORAGE_CAPABILITY_MAIN_ENTRY),
          { safeStorageReference: "present" }
        ),
        utilityProbe: entryEvidence(
          STORAGE_CAPABILITY_UTILITY_ENTRY,
          entryBytes.get(STORAGE_CAPABILITY_UTILITY_ENTRY),
          { nodeSqliteReference: "present" }
        ),
        durableSpacesGate: entryEvidence(
          STORAGE_CAPABILITY_GATE_ENTRY,
          entryBytes.get(STORAGE_CAPABILITY_GATE_ENTRY),
          { durableSpacesEnabled: false }
        )
      },
      unobserved: {
        safeStorageAvailability: "unobserved",
        safeStorageRoundtrip: "unobserved",
        nodeSqliteModuleLoad: "unobserved",
        databaseOpen: "unobserved",
        fts5: "unobserved",
        schemaTransaction: "unobserved",
        restart: "unobserved",
        recovery: "unobserved"
      }
    });
    await writeReceiptNoClobber(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally {
    for (const bytes of entryBytes.values()) bytes.fill(0);
    uncache(snapshot.path);
    await destroySnapshot(snapshot);
  }
}

function entryEvidence(entryPath, bytes, extra) {
  if (!Buffer.isBuffer(bytes)) throw new Error("Storage capability package probe is unavailable.");
  return {
    path: entryPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    ...extra
  };
}

function assertProbeMarkers(entries) {
  const main = decodedEntry(entries, STORAGE_CAPABILITY_MAIN_ENTRY);
  const utility = decodedEntry(entries, STORAGE_CAPABILITY_UTILITY_ENTRY);
  const gate = decodedEntry(entries, STORAGE_CAPABILITY_GATE_ENTRY);

  if (
    !main.includes("switchboard-storage-capability-main-probe-v1") ||
    !main.includes("safeStorage.isEncryptionAvailable") ||
    /setUsePlainTextEncryption|encryptString|decryptString/.test(main)
  ) throw new Error("Storage capability main probe marker is invalid.");

  if (
    !utility.includes("switchboard-storage-capability-utility-probe-v1") ||
    !utility.includes("node:sqlite") ||
    !utility.includes("DatabaseSync") ||
    /new\s+[^;\n]*DatabaseSync|\.exec\s*\(|\.prepare\s*\(|CREATE\s+TABLE|SELECT\s+/i.test(utility)
  ) throw new Error("Storage capability utility probe marker is invalid.");

  if (
    !gate.includes("switchboard-durable-spaces-gate-v1") ||
    !/DURABLE_SPACES_ENABLED\s*=\s*false/.test(gate) ||
    /DURABLE_SPACES_ENABLED\s*=\s*true/.test(gate)
  ) throw new Error("Storage capability durable-spaces gate marker is invalid.");
}

function decodedEntry(entries, entry) {
  const bytes = entries.get(entry);
  if (!Buffer.isBuffer(bytes)) throw new Error("Storage capability package probe is unavailable.");
  return bytes.toString("utf8");
}

async function inspectRealRegularFile(filePath, maxBytes, label) {
  const metadata = await lstat(filePath, { bigint: true });
  if (!metadata.isFile() || metadata.size <= 0n || metadata.size > BigInt(maxBytes)) {
    throw new Error(`Storage capability ${label} must be a bounded regular file.`);
  }
  if (await realpath(filePath) !== filePath) {
    throw new Error(`Storage capability ${label} path must be real and canonical.`);
  }
  return metadata;
}

async function inspectRealOutputParent(outputPath) {
  const parent = path.dirname(outputPath);
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || await realpath(parent) !== parent) {
    throw new Error("Storage capability output parent must be a real canonical directory.");
  }
}

async function createVerifiedBoundedSnapshot(sourcePath) {
  const pathMetadata = await inspectRealRegularFile(
    sourcePath,
    STORAGE_CAPABILITY_MAX_PACKAGE_BYTES,
    "ASAR"
  );
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Storage capability inspection requires no-follow file access.");
  }
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let root;
  let snapshotPath;
  let destination;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const extra = Buffer.alloc(1);
  try {
    const openedMetadata = await source.stat({ bigint: true });
    if (
      !openedMetadata.isFile() ||
      openedMetadata.size <= 0n ||
      openedMetadata.size > BigInt(STORAGE_CAPABILITY_MAX_PACKAGE_BYTES) ||
      !sameFileSnapshot(pathMetadata, openedMetadata)
    ) throw new Error("Storage capability ASAR changed before snapshotting.");

    const temporaryParent = await realpath(os.tmpdir());
    root = await mkdtemp(path.join(temporaryParent, "switchboard-storage-capability-"));
    await chmod(root, 0o700);
    snapshotPath = path.join(root, "app.asar");
    destination = await open(snapshotPath, "wx", 0o600);
    const hash = createHash("sha256");
    const expectedBytes = Number(openedMetadata.size);
    let position = 0;
    while (position < expectedBytes) {
      const requested = Math.min(buffer.byteLength, expectedBytes - position);
      const { bytesRead } = await source.read(buffer, 0, requested, position);
      if (bytesRead <= 0) throw new Error("Storage capability ASAR was truncated during snapshotting.");
      hash.update(buffer.subarray(0, bytesRead));
      await writeAll(destination, buffer, bytesRead, position);
      position += bytesRead;
    }
    const trailing = await source.read(extra, 0, 1, position);
    const finalSourceMetadata = await source.stat({ bigint: true });
    if (trailing.bytesRead !== 0 || !sameFileSnapshot(openedMetadata, finalSourceMetadata)) {
      throw new Error("Storage capability ASAR changed during snapshotting.");
    }
    await destination.sync();
    await destination.close();
    destination = undefined;
    await chmod(snapshotPath, 0o400);
    return { root, path: snapshotPath, sha256: hash.digest("hex") };
  } catch (error) {
    if (destination !== undefined) await destination.close().catch(() => undefined);
    if (snapshotPath !== undefined) await unlink(snapshotPath).catch(() => undefined);
    if (root !== undefined) await rmdir(root).catch(() => undefined);
    throw error;
  } finally {
    buffer.fill(0);
    extra.fill(0);
    await source.close();
  }
}

async function writeAll(handle, buffer, byteLength, startPosition) {
  let written = 0;
  while (written < byteLength) {
    const result = await handle.write(
      buffer,
      written,
      byteLength - written,
      startPosition + written
    );
    if (result.bytesWritten <= 0) throw new Error("Storage capability snapshot write failed.");
    written += result.bytesWritten;
  }
}

async function destroySnapshot(snapshot) {
  await chmod(snapshot.path, 0o600).catch(() => undefined);
  await unlink(snapshot.path).catch(() => undefined);
  await rmdir(snapshot.root).catch(() => undefined);
}

async function preflightAsarHeader(asarPath, archiveBytes) {
  if (archiveBytes < 16n) throw new Error("Storage capability ASAR header is truncated.");
  const handle = await open(asarPath, "r");
  const header = Buffer.alloc(16);
  try {
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (bytesRead !== header.byteLength) throw new Error("Storage capability ASAR header is truncated.");
    const sizePicklePayload = header.readUInt32LE(0);
    const declaredHeaderBytes = header.readUInt32LE(4);
    const headerPicklePayload = header.readUInt32LE(8);
    const headerJsonBytes = header.readInt32LE(12);
    if (
      sizePicklePayload !== 4 ||
      declaredHeaderBytes < 8 ||
      declaredHeaderBytes > MAX_ASAR_HEADER_BYTES ||
      BigInt(declaredHeaderBytes) > archiveBytes - 8n ||
      headerPicklePayload !== declaredHeaderBytes - 4 ||
      headerJsonBytes <= 0 ||
      headerJsonBytes > headerPicklePayload - 4
    ) throw new Error("Storage capability ASAR header is invalid or oversized.");
  } finally {
    header.fill(0);
    await handle.close();
  }
}

function assertCanonicalAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) throw new Error(`Storage capability ${label} path must be canonical and absolute.`);
}

function sameFileSnapshot(first, second) {
  return first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs;
}

async function sha256FileBounded(filePath, expectedBytesBigInt) {
  if (expectedBytesBigInt <= 0n || expectedBytesBigInt > BigInt(STORAGE_CAPABILITY_MAX_PACKAGE_BYTES)) {
    throw new Error("Storage capability hash input is out of bounds.");
  }
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const extra = Buffer.alloc(1);
  try {
    const expectedBytes = Number(expectedBytesBigInt);
    let position = 0;
    while (position < expectedBytes) {
      const requested = Math.min(buffer.byteLength, expectedBytes - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead <= 0) throw new Error("Storage capability snapshot was truncated while hashing.");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if ((await handle.read(extra, 0, 1, position)).bytesRead !== 0) {
      throw new Error("Storage capability snapshot grew while hashing.");
    }
    return hash.digest("hex");
  } finally {
    buffer.fill(0);
    extra.fill(0);
    await handle.close();
  }
}

async function writeReceiptNoClobber(outputPath, serialized) {
  let handle;
  let created = false;
  try {
    handle = await open(outputPath, "wx", 0o600);
    created = true;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(outputPath, 0o600);
    const parentHandle = await open(path.dirname(outputPath), "r");
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (created) await unlink(outputPath).catch(() => undefined);
    throw error;
  }
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== "--asar" || argv[2] !== "--output") {
    throw new Error("Usage: inspect-storage-capability-package --asar ABSOLUTE --output ABSOLUTE");
  }
  return { asarPath: argv[1], outputPath: argv[3] };
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  inspectStorageCapabilityPackage(parseArguments(process.argv.slice(2))).then(
    () => undefined,
    () => {
      console.error("Storage capability package inspection failed.");
      process.exitCode = 1;
    }
  );
}
