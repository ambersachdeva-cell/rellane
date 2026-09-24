import { createHash } from "node:crypto";
import { chmod, constants, lstat, mkdtemp, open, readdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractFile, listPackage, statFile, uncache } from "@electron/asar";
import { z } from "zod";
import { NativeCapabilityQaC3aBuildBindingSchema } from "@cadrane/contracts/native-capability-qa";

const MAIN = "dist/main/native-capability-qa-main.cjs";
const UTILITY = "dist/utility/native-capability-qa-utility.cjs";
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const MAX_BINDING_BYTES = 64 * 1024;
const ALLOWED_LAYOUT = new Set(["/package.json", "/dist", "/dist/main", `/${MAIN}`, "/dist/utility", `/${UTILITY}`]);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Identity = z.strictObject({ path: z.string(), sha256: Hash, bytes: z.number().int().positive().max(MAX_ENTRY_BYTES) });
const BuildManifestSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("native-capability-qa-candidate-build"), c3aBinding: NativeCapabilityQaC3aBuildBindingSchema, gates: z.strictObject({ safeStorageRoundtrip: z.literal(false), durableSpacesEnabled: z.literal(false) }), entries: z.strictObject({ main: Identity.extend({ path: z.literal(MAIN) }), utility: Identity.extend({ path: z.literal(UTILITY) }) }), inputs: z.strictObject({ packageJson: Identity.extend({ path: z.literal("package.json") }), tsupConfig: Identity.extend({ path: z.literal("tsup.config.ts") }), mainSource: Identity.extend({ path: z.literal("src/native-capability-qa-main.ts") }), utilitySource: Identity.extend({ path: z.literal("src/native-capability-qa-utility.ts") }), protocolSource: Identity.extend({ path: z.literal("src/native-capability-qa-protocol.ts") }), controllerSource: Identity.extend({ path: z.literal("src/native-capability-qa-main-controller.ts") }), receiptSource: Identity.extend({ path: z.literal("src/native-capability-qa-receipt.ts") }), contractsSource: Identity.extend({ path: z.literal("../../packages/contracts/src/native-capability-qa.ts") }), contractsPackage: Identity.extend({ path: z.literal("../../packages/contracts/package.json") }), rootLock: Identity.extend({ path: z.literal("../../pnpm-lock.yaml") }) }) });
const ReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("native-capability-qa-package-static"),
  c3aBinding: NativeCapabilityQaC3aBuildBindingSchema,
  bindingSha256: Hash,
  buildManifestSha256: Hash,
  application: z.strictObject({ name: z.literal("@cadrane/storage-capability-qa"), version: z.literal("0.1.0"), private: z.literal(true), type: z.literal("module"), main: z.literal("./dist/main/native-capability-qa-main.cjs") }),
  package: z.strictObject({ asarSha256: Hash, asarBytes: z.number().int().positive().max(MAX_PACKAGE_BYTES), infoPlist: Identity, executable: Identity, defaultApp: Identity, icon: Identity }),
  entries: z.strictObject({
    main: z.strictObject({ path: z.literal(MAIN), sha256: Hash, bytes: z.number().int().positive().max(MAX_ENTRY_BYTES), safeStorageReference: z.literal("present"), roundtrip: z.literal("disabled"), durableSpacesEnabled: z.literal(false) }),
    utility: z.strictObject({ path: z.literal(UTILITY), sha256: Hash, bytes: z.number().int().positive().max(MAX_ENTRY_BYTES), nodeSqliteReference: z.literal("present"), inMemoryOnly: z.literal(true) })
  }),
  unobserved: z.strictObject({ safeStorageAvailability: z.literal("unobserved"), safeStorageRoundtrip: z.literal("unobserved"), nodeSqliteModuleLoad: z.literal("unobserved"), databaseOpen: z.literal("unobserved"), fts5: z.literal("unobserved"), cleanExit: z.literal("unobserved"), keychainMutation: z.literal("unobserved"), crossLaunchDecrypt: z.literal("unobserved"), crashRecovery: z.literal("unobserved"), durableRecovery: z.literal("unobserved") })
});

export async function inspectNativeCapabilityQaPackage({ appRoot, buildManifestPath, outputPath }) {
  assertCanonicalAbsolute(appRoot, "app root"); assertCanonicalAbsolute(buildManifestPath, "build manifest"); assertCanonicalAbsolute(outputPath, "output");
  if (new Set([appRoot, buildManifestPath, outputPath]).size !== 3) throw new Error("QA inspection paths must differ.");
  await assertRealDirectory(appRoot);
  const contents = path.join(appRoot, "Contents"); const resources = path.join(contents, "Resources");
  await assertRealDirectory(contents); await assertRealDirectory(resources);
  const asarPath = path.join(resources, "app.asar"); const bindingPath = path.join(resources, "c3a-build-binding.json");
  try { await lstat(`${asarPath}.unpacked`); throw new Error("QA package has unpacked ASAR content."); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const expectedResources = ["app.asar", "c3a-build-binding.json", "default_app.asar", "electron.icns"];
  const resourcesList = await readdir(resources); if (resourcesList.length !== expectedResources.length || resourcesList.some((entry) => !expectedResources.includes(entry))) throw new Error("QA Resources layout is unexpected.");
  await assertRealDirectory(path.dirname(outputPath));
  const bindingBytes = await readBoundedRealFile(bindingPath, MAX_BINDING_BYTES, "binding");
  const manifestBytes = await readBoundedRealFile(buildManifestPath, MAX_BINDING_BYTES, "build manifest");
  const infoBytes = await readBoundedRealFile(path.join(contents, "Info.plist"), MAX_BINDING_BYTES, "Info.plist");
  const executableBytes = await readBoundedRealFile(path.join(contents, "MacOS/Switchboard Storage Capability QA"), MAX_ENTRY_BYTES, "executable");
  const defaultAppBytes = await readBoundedRealFile(path.join(resources, "default_app.asar"), MAX_PACKAGE_BYTES, "default app");
  const iconBytes = await readBoundedRealFile(path.join(resources, "electron.icns"), MAX_PACKAGE_BYTES, "icon");
  let snapshot; let main; let utility;
  try {
    const binding = NativeCapabilityQaC3aBuildBindingSchema.parse(JSON.parse(bindingBytes.toString("utf8")));
    const buildManifest = BuildManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    if (JSON.stringify(buildManifest.c3aBinding) !== JSON.stringify(binding)) throw new Error("QA shipped binding differs from build manifest.");
    assertInfoPlist(infoBytes);
    snapshot = await createSnapshot(asarPath);
    const before = await assertRealRegular(snapshot.path, MAX_PACKAGE_BYTES, "snapshot");
    await preflightHeader(snapshot.path, before.size);
    uncache(snapshot.path);
    const listed = listPackage(snapshot.path, { isPack: false });
    if (listed.length !== ALLOWED_LAYOUT.size || listed.some((entry) => !ALLOWED_LAYOUT.has(entry))) throw new Error("QA package layout is not exact.");
    const manifest = extractManifest(snapshot.path, listed);
    main = extractExact(snapshot.path, listed, MAIN);
    utility = extractExact(snapshot.path, listed, UTILITY);
    if (hash(main) !== buildManifest.entries.main.sha256 || main.byteLength !== buildManifest.entries.main.bytes || hash(utility) !== buildManifest.entries.utility.sha256 || utility.byteLength !== buildManifest.entries.utility.bytes) throw new Error("QA package entries differ from the trusted build manifest.");
    assertMain(main); assertUtility(utility);
    const after = await assertRealRegular(snapshot.path, MAX_PACKAGE_BYTES, "snapshot");
    const secondHash = await sha256Bounded(snapshot.path, before.size);
    if (!sameSnapshot(before, after) || secondHash !== snapshot.sha256) throw new Error("QA package changed during inspection.");
    const receipt = ReceiptSchema.parse({
      schemaVersion: 1, kind: "native-capability-qa-package-static", c3aBinding: binding, application: manifest,
      bindingSha256: createHash("sha256").update(bindingBytes).digest("hex"),
      buildManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      package: { asarSha256: snapshot.sha256, asarBytes: Number(before.size), infoPlist: identity("Contents/Info.plist", infoBytes), executable: identity("Contents/MacOS/Switchboard Storage Capability QA", executableBytes), defaultApp: identity("Contents/Resources/default_app.asar", defaultAppBytes), icon: identity("Contents/Resources/electron.icns", iconBytes) },
      entries: {
        main: { path: MAIN, sha256: hash(main), bytes: main.byteLength, safeStorageReference: "present", roundtrip: "disabled", durableSpacesEnabled: false },
        utility: { path: UTILITY, sha256: hash(utility), bytes: utility.byteLength, nodeSqliteReference: "present", inMemoryOnly: true }
      },
      unobserved: { safeStorageAvailability: "unobserved", safeStorageRoundtrip: "unobserved", nodeSqliteModuleLoad: "unobserved", databaseOpen: "unobserved", fts5: "unobserved", cleanExit: "unobserved", keychainMutation: "unobserved", crossLaunchDecrypt: "unobserved", crashRecovery: "unobserved", durableRecovery: "unobserved" }
    });
    await writeNoClobber(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    bindingBytes.fill(0);
    manifestBytes.fill(0); infoBytes.fill(0); executableBytes.fill(0); defaultAppBytes.fill(0); iconBytes.fill(0);
    main?.fill(0); utility?.fill(0);
    if (snapshot !== undefined) await destroySnapshot(snapshot);
  }
}
function identity(entryPath, bytes) { return { path: entryPath, sha256: hash(bytes), bytes: bytes.byteLength }; }
function assertInfoPlist(bytes) { const text = bytes.toString("utf8"); for (const [key, value] of [["CFBundleIdentifier", "com.switchboard.storage-capability-qa"], ["CFBundleName", "Switchboard Storage Capability QA"], ["CFBundleExecutable", "Switchboard Storage Capability QA"], ["CFBundleShortVersionString", "0.1.0"]]) { const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const pattern = new RegExp(`<key>${key}</key>\\s*<string>${escaped}</string>`); if (!pattern.test(text)) throw new Error("QA Info.plist identity is invalid."); } }

function extractExact(asarPath, listed, entry) {
  if (listed.filter((candidate) => candidate === `/${entry}`).length !== 1) throw new Error("QA package is missing an exact entry.");
  const metadata = statFile(asarPath, entry, false);
  if ("link" in metadata || "files" in metadata || metadata.unpacked === true || !Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > MAX_ENTRY_BYTES) throw new Error("QA package entry is invalid.");
  const bytes = extractFile(asarPath, entry, false);
  if (bytes.byteLength !== metadata.size) { bytes.fill(0); throw new Error("QA package entry size changed."); }
  return bytes;
}
function extractManifest(asarPath, listed) {
  if (listed.filter((candidate) => candidate === "/package.json").length !== 1) throw new Error("QA package is missing manifest.");
  const bytes = extractFile(asarPath, "package.json", false);
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    const identity = z.object({ name: z.literal("@cadrane/storage-capability-qa"), version: z.literal("0.1.0"), private: z.literal(true), type: z.literal("module"), main: z.literal("./dist/main/native-capability-qa-main.cjs") }).passthrough().parse(parsed);
    return { name: identity.name, version: identity.version, private: identity.private, type: identity.type, main: identity.main };
  } catch { throw new Error("QA package manifest identity is invalid."); } finally { bytes.fill(0); }
}
function assertMain(bytes) {
  const text = bytes.toString("utf8");
  if (!text.includes("switchboard-native-capability-qa-main-v1") || !text.includes("safeStorage.isEncryptionAvailable") || !/QA_SAFE_STORAGE_ROUNDTRIP_ENABLED\s*=\s*false/.test(text) || !/QA_DURABLE_SPACES_ENABLED\s*=\s*false/.test(text) || /BrowserWindow|installIpcHandlers|DaemonClient|src\/renderer|src\/preload|encryptString|decryptString|node:fs|node:child_process|process\.env|process\.argv|\bfetch\s*\(/.test(text)) throw new Error("QA main markers are invalid.");
}
function assertUtility(bytes) {
  const text = bytes.toString("utf8");
  if (!text.includes("switchboard-native-capability-qa-utility-v1") || !text.includes("node:sqlite") || !text.includes(":memory:") || !text.includes("fts5") || !text.includes("database.close") || /\bATTACH\b\s+(?:DATABASE|:)|\bloadExtension\s*\(|\bPRAGMA\s+journal_mode\b|\bjournal_mode\s*=\s*WAL\b|DatabaseSync\s*\(\s*['\"](?:file:|\/)|\bVACUUM\s+INTO\b|node:fs|process\.env|process\.argv|\bfetch\s*\(/i.test(text)) throw new Error("QA utility markers are invalid.");
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function assertCanonicalAbsolute(value, label) { if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0") || value.length > 4096) throw new Error(`QA ${label} path must be canonical and absolute.`); }
async function assertRealDirectory(value) { const metadata = await lstat(value); if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(value) !== value) throw new Error("QA output parent must be real."); }
async function assertRealRegular(value, max, label) { const metadata = await lstat(value, { bigint: true }); if (!metadata.isFile() || metadata.size <= 0n || metadata.size > BigInt(max) || await realpath(value) !== value) throw new Error(`QA ${label} must be bounded real regular file.`); return metadata; }
async function readBoundedRealFile(value, max, label) {
  const initial = await assertRealRegular(value, max, label);
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("QA inspection requires no-follow access.");
  const handle = await open(value, constants.O_RDONLY | constants.O_NOFOLLOW); const extra = Buffer.alloc(1);
  try {
    const opened = await handle.stat({ bigint: true }); if (!sameSnapshot(initial, opened)) throw new Error(`QA ${label} changed before reading.`);
    const bytes = Buffer.alloc(Number(opened.size)); let position = 0;
    while (position < bytes.byteLength) { const { bytesRead } = await handle.read(bytes, position, bytes.byteLength - position, position); if (bytesRead <= 0) { bytes.fill(0); throw new Error(`QA ${label} truncated while reading.`); } position += bytesRead; }
    if ((await handle.read(extra, 0, 1, position)).bytesRead !== 0 || !sameSnapshot(opened, await handle.stat({ bigint: true }))) { bytes.fill(0); throw new Error(`QA ${label} changed while reading.`); }
    return bytes;
  } finally { extra.fill(0); await handle.close(); }
}
async function createSnapshot(sourcePath) {
  const pathMetadata = await assertRealRegular(sourcePath, MAX_PACKAGE_BYTES, "ASAR");
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("QA inspection requires no-follow access.");
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW); let root; let snapshotPath; let target; const buffer = Buffer.allocUnsafe(1024 * 1024); const extra = Buffer.alloc(1);
  try {
    const opened = await source.stat({ bigint: true }); if (!sameSnapshot(pathMetadata, opened)) throw new Error("QA ASAR changed before snapshot.");
    root = await mkdtemp(path.join(await realpath(os.tmpdir()), "switchboard-qa-inspect-")); await chmod(root, 0o700); snapshotPath = path.join(root, "app.asar"); target = await open(snapshotPath, "wx", 0o600);
    const expected = Number(opened.size); let position = 0; const digest = createHash("sha256");
    while (position < expected) { const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.byteLength, expected - position), position); if (bytesRead <= 0) throw new Error("QA ASAR truncated during snapshot."); digest.update(buffer.subarray(0, bytesRead)); await writeAll(target, buffer, bytesRead, position); position += bytesRead; }
    if ((await source.read(extra, 0, 1, position)).bytesRead !== 0 || !sameSnapshot(opened, await source.stat({ bigint: true }))) throw new Error("QA ASAR changed during snapshot.");
    await target.sync(); await target.close(); target = undefined; await chmod(snapshotPath, 0o400); return { root, path: snapshotPath, sha256: digest.digest("hex") };
  } catch (error) { if (target !== undefined) await target.close().catch(() => undefined); if (snapshotPath !== undefined) await unlink(snapshotPath).catch(() => undefined); if (root !== undefined) await rmdir(root).catch(() => undefined); throw error; } finally { buffer.fill(0); extra.fill(0); await source.close(); }
}
async function writeAll(handle, buffer, length, offset) { let written = 0; while (written < length) { const result = await handle.write(buffer, written, length - written, offset + written); if (result.bytesWritten <= 0) throw new Error("QA snapshot write failed."); written += result.bytesWritten; } }
async function destroySnapshot(snapshot) { uncache(snapshot.path); await chmod(snapshot.path, 0o600).catch(() => undefined); await unlink(snapshot.path).catch(() => undefined); await rmdir(snapshot.root).catch(() => undefined); }
async function preflightHeader(asarPath, bytes) { if (bytes < 16n) throw new Error("QA ASAR header truncated."); const handle = await open(asarPath, "r"); const header = Buffer.alloc(16); try { if ((await handle.read(header, 0, 16, 0)).bytesRead !== 16) throw new Error("QA ASAR header truncated."); const outer = header.readUInt32LE(0); const declared = header.readUInt32LE(4); const inner = header.readUInt32LE(8); const json = header.readInt32LE(12); if (outer !== 4 || declared < 8 || declared > MAX_HEADER_BYTES || BigInt(declared) > bytes - 8n || inner !== declared - 4 || json <= 0 || json > inner - 4) throw new Error("QA ASAR header invalid or oversized."); } finally { header.fill(0); await handle.close(); } }
function sameSnapshot(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs; }
async function sha256Bounded(filePath, expectedBig) { const handle = await open(filePath, "r"); const buffer = Buffer.allocUnsafe(1024 * 1024); const extra = Buffer.alloc(1); try { const expected = Number(expectedBig); let position = 0; const digest = createHash("sha256"); while (position < expected) { const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, expected - position), position); if (bytesRead <= 0) throw new Error("QA snapshot truncated while hashing."); digest.update(buffer.subarray(0, bytesRead)); position += bytesRead; } if ((await handle.read(extra, 0, 1, position)).bytesRead !== 0) throw new Error("QA snapshot grew while hashing."); return digest.digest("hex"); } finally { buffer.fill(0); extra.fill(0); await handle.close(); } }
async function writeNoClobber(outputPath, text) { let handle; let made = false; try { handle = await open(outputPath, "wx", 0o600); made = true; await handle.writeFile(text, "utf8"); await handle.sync(); await handle.close(); handle = undefined; await chmod(outputPath, 0o600); const parent = await open(path.dirname(outputPath), "r"); try { await parent.sync(); } finally { await parent.close(); } } catch (error) { if (handle !== undefined) await handle.close().catch(() => undefined); if (made) await unlink(outputPath).catch(() => undefined); throw error; } }

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked === import.meta.url) { if (process.argv.length !== 8 || process.argv[2] !== "--app-root" || process.argv[4] !== "--build-manifest" || process.argv[6] !== "--output") throw new Error("Usage: inspect-native-capability-qa-package --app-root ABSOLUTE --build-manifest ABSOLUTE --output ABSOLUTE"); await inspectNativeCapabilityQaPackage({ appRoot: process.argv[3], buildManifestPath: process.argv[5], outputPath: process.argv[7] }); }
