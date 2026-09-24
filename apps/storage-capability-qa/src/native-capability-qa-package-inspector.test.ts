import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@cadrane/contracts/native-capability-qa", async () => import("../../../packages/contracts/src/native-capability-qa.js"));
import { NATIVE_CAPABILITY_QA_C3A_BINDING } from "@cadrane/contracts/native-capability-qa";
import { inspectNativeCapabilityQaPackage } from "../scripts/inspect-native-capability-qa-package.mjs";
const temporary: string[] = []; afterEach(async () => { await Promise.all(temporary.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

describe("native capability QA packaged-root inspector", () => {
  it("writes deterministic receipt bound to exact shipped siblings and candidate manifest", async () => {
    const item = await fixture(); const one = path.join(item.root, "one.json"); const two = path.join(item.root, "two.json");
    const first = await inspectNativeCapabilityQaPackage({ appRoot: item.appRoot, buildManifestPath: item.manifest, outputPath: one });
    expect(first).toEqual(await inspectNativeCapabilityQaPackage({ appRoot: item.appRoot, buildManifestPath: item.manifest, outputPath: two }));
    expect(first).toHaveProperty("buildManifestSha256"); expect(await readFile(one, "utf8")).toBe(await readFile(two, "utf8"));
  });
  it("rejects tampered ASAR bytes even when all markers remain", async () => {
    for (const extra of ["safeStorage.encryptString('x')", "safeStorage.decryptString('x')", "process.env.X", "process.argv", "fetch('x')", "new sqlite.DatabaseSync('file:test')", "VACUUM INTO 'x'", "fetch('x')"]) {
      const key = extra.includes("sqlite") || extra.includes("VACUUM") ? "utility" : "main"; const item = await fixture({ [key]: extra, trusted: true });
      await expect(inspectNativeCapabilityQaPackage({ appRoot: item.appRoot, buildManifestPath: item.manifest, outputPath: path.join(item.root, "bad.json") })).rejects.toThrow();
    }
  });
  it("rejects an app-root symlink", async () => {
    const item = await fixture(); const link = path.join(item.root, "linked.app"); await symlink(item.appRoot, link);
    await expect(inspectNativeCapabilityQaPackage({ appRoot: link, buildManifestPath: item.manifest, outputPath: path.join(item.root, "link.json") })).rejects.toThrow();
  });
  it("rejects an unexpected packaged resource", async () => {
    const item = await fixture();
    await writeFile(path.join(item.appRoot, "Contents/Resources/unexpected.bin"), "x");
    await expect(inspectNativeCapabilityQaPackage({ appRoot: item.appRoot, buildManifestPath: item.manifest, outputPath: path.join(item.root, "resource.json") })).rejects.toThrow("Resources layout");
  });
  it("rejects app.asar.unpacked", async () => {
    const item = await fixture(); await mkdir(path.join(item.appRoot, "Contents/Resources/app.asar.unpacked"));
    await expect(inspectNativeCapabilityQaPackage({ appRoot: item.appRoot, buildManifestPath: item.manifest, outputPath: path.join(item.root, "unpacked.json") })).rejects.toThrow("unpacked");
  });
  it("rejects Info.plist identity mutation", async () => {
    const item = await fixture(); await writeFile(path.join(item.appRoot, "Contents/Info.plist"), "<plist><dict/></plist>");
    await expect(inspectNativeCapabilityQaPackage({ appRoot: item.appRoot, buildManifestPath: item.manifest, outputPath: path.join(item.root, "plist.json") })).rejects.toThrow("Info.plist");
  });
  it("rejects missing executable", async () => {
    const item = await fixture(); await unlink(path.join(item.appRoot, "Contents/MacOS/Switchboard Storage Capability QA"));
    await expect(inspectNativeCapabilityQaPackage({ appRoot: item.appRoot, buildManifestPath: item.manifest, outputPath: path.join(item.root, "missing-executable.json") })).rejects.toThrow();
  });
  it("rejects executable symlink", async () => {
    const item = await fixture(); const executable = path.join(item.appRoot, "Contents/MacOS/Switchboard Storage Capability QA"); await unlink(executable); await symlink(path.join(item.appRoot, "Contents/Info.plist"), executable);
    await expect(inspectNativeCapabilityQaPackage({ appRoot: item.appRoot, buildManifestPath: item.manifest, outputPath: path.join(item.root, "linked-executable.json") })).rejects.toThrow("regular file");
  });
  it("rejects a different shipped binding", async () => {
    const item = await fixture(); await writeFile(path.join(item.appRoot, "Contents/Resources/c3a-build-binding.json"), "{}", { mode: 0o600 });
    await expect(inspectNativeCapabilityQaPackage({ appRoot: item.appRoot, buildManifestPath: item.manifest, outputPath: path.join(item.root, "binding.json") })).rejects.toThrow();
  });
  it("does not clobber an existing receipt", async () => {
    const fresh = await fixture(); const output = path.join(fresh.root, "exists.json"); await writeFile(output, "keep");
    await expect(inspectNativeCapabilityQaPackage({ appRoot: fresh.appRoot, buildManifestPath: fresh.manifest, outputPath: output })).rejects.toMatchObject({ code: "EEXIST" });
  });
});

async function fixture(options: { main?: string; utility?: string; trusted?: boolean } = {}) {
  const raw = await mkdtemp(path.join(os.tmpdir(), "switchboard-qa-app-")); const root = await realpath(raw); temporary.push(root); const source = path.join(root, "source");
  await mkdir(path.join(source, "dist/main"), { recursive: true }); await mkdir(path.join(source, "dist/utility"), { recursive: true });
  const mainBase = "const marker='switchboard-native-capability-qa-main-v1'; const QA_SAFE_STORAGE_ROUNDTRIP_ENABLED = false; const QA_DURABLE_SPACES_ENABLED = false; safeStorage.isEncryptionAvailable();"; const utilityBase = "const marker='switchboard-native-capability-qa-utility-v1'; const name='node:sqlite'; const memory=':memory:'; const f='fts5'; database.close();";
  const main = `${mainBase} ${options.main ?? ""}`; const utility = `${utilityBase} ${options.utility ?? ""}`;
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "@cadrane/storage-capability-qa", version: "0.1.0", private: true, type: "module", main: "./dist/main/native-capability-qa-main.cjs", scripts: {} })); await writeFile(path.join(source, "dist/main/native-capability-qa-main.cjs"), main); await writeFile(path.join(source, "dist/utility/native-capability-qa-utility.cjs"), utility);
  const appRoot = path.join(root, "Switchboard Storage Capability QA.app"); const resources = path.join(appRoot, "Contents/Resources"); await mkdir(path.join(appRoot, "Contents/MacOS"), { recursive: true }); await mkdir(resources, { recursive: true }); const asar = path.join(resources, "app.asar"); await createPackage(source, asar); await chmod(asar, 0o600);
  await writeFile(path.join(resources, "c3a-build-binding.json"), `${JSON.stringify(NATIVE_CAPABILITY_QA_C3A_BINDING)}\n`); await writeFile(path.join(resources, "default_app.asar"), "default"); await writeFile(path.join(resources, "electron.icns"), "icon"); await writeFile(path.join(appRoot, "Contents/MacOS/Switchboard Storage Capability QA"), "executable");
  await writeFile(path.join(appRoot, "Contents/Info.plist"), "<plist><dict><key>CFBundleIdentifier</key><string>com.switchboard.storage-capability-qa</string><key>CFBundleName</key><string>Switchboard Storage Capability QA</string><key>CFBundleExecutable</key><string>Switchboard Storage Capability QA</string><key>CFBundleShortVersionString</key><string>0.1.0</string></dict></plist>");
  const digest = (value: Buffer | string, filePath: string) => ({ path: filePath, sha256: createHash("sha256").update(value).digest("hex"), bytes: Buffer.byteLength(value) }); const manifest = path.join(root, "candidate.json");
  const manifestValue = { schemaVersion: 1, kind: "native-capability-qa-candidate-build", c3aBinding: NATIVE_CAPABILITY_QA_C3A_BINDING, gates: { safeStorageRoundtrip: false, durableSpacesEnabled: false }, entries: { main: digest(options.trusted ? mainBase : main, "dist/main/native-capability-qa-main.cjs"), utility: digest(options.trusted ? utilityBase : utility, "dist/utility/native-capability-qa-utility.cjs") }, inputs: { packageJson: digest("x", "package.json"), tsupConfig: digest("x", "tsup.config.ts"), mainSource: digest("x", "src/native-capability-qa-main.ts"), utilitySource: digest("x", "src/native-capability-qa-utility.ts"), protocolSource: digest("x", "src/native-capability-qa-protocol.ts"), controllerSource: digest("x", "src/native-capability-qa-main-controller.ts"), receiptSource: digest("x", "src/native-capability-qa-receipt.ts"), contractsSource: digest("x", "../../packages/contracts/src/native-capability-qa.ts"), contractsPackage: digest("x", "../../packages/contracts/package.json"), rootLock: digest("x", "../../pnpm-lock.yaml") } }; await writeFile(manifest, `${JSON.stringify(manifestValue)}\n`, { mode: 0o600 }); return { root, appRoot, manifest };
}
