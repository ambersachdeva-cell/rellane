import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error This is electron-builder's JavaScript hook entrypoint, not app code.
import { afterPack } from "../../scripts/macos-plist-hardening.mjs";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("macOS package Info.plist hardening", () => {
  it("removes Electron's broad ATS exception and unused privacy prompts from an isolated bundle", async () => {
    const appOutDir = await makeBundle();

    await afterPack(makeContext(appOutDir));

    const plist = await readFixture(appOutDir);
    expect(plist).not.toContain("NSAllowsArbitraryLoads");
    expect(plist).not.toContain("NSCameraUsageDescription");
    expect(plist).not.toContain("NSMicrophoneUsageDescription");
    expect(plist).not.toContain("NSAudioCaptureUsageDescription");
    expect(plist).not.toContain("NSBluetoothPeripheralUsageDescription");
    expect(plist).not.toContain("NSBluetoothAlwaysUsageDescription");
    expect(plist).toContain("NSAllowsLocalNetworking");
    expect(plist).toContain("localhost");
    expect(plist).toContain("127.0.0.1");
  });

  it("does nothing for non-macOS packaging contexts", async () => {
    const appOutDir = await makeBundle();

    await afterPack(makeContext(appOutDir, "win32"));

    expect(await readFixture(appOutDir)).toContain("NSAllowsArbitraryLoads");
  });

  it("fails closed when the application bundle has no Info.plist", async () => {
    const appOutDir = await makeBundle({ writeInfoPlist: false });

    await expect(afterPack(makeContext(appOutDir)))
      .rejects.toThrow("cannot read Info.plist");
  });

  it("fails before mutation when required loopback policy is absent", async () => {
    const appOutDir = await makeBundle({ includeLoopbackExceptions: false });

    await expect(afterPack(makeContext(appOutDir)))
      .rejects.toThrow("NSAppTransportSecurity:NSExceptionDomains:localhost");
    expect(await readFixture(appOutDir)).toContain("NSAllowsArbitraryLoads");
  });

  it("fails before mutation when a loopback exception is not a dictionary", async () => {
    const appOutDir = await makeBundle({ loopbackExceptionValuesAreDictionaries: false });

    await expect(afterPack(makeContext(appOutDir)))
      .rejects.toThrow("NSAppTransportSecurity:NSExceptionDomains:localhost to be a dictionary");
    expect(await readFixture(appOutDir)).toContain("NSAllowsArbitraryLoads");
  });

  it("fails closed for a relative bundle path", async () => {
    await expect(afterPack(makeContext("relative")))
      .rejects.toThrow("absolute appOutDir");
  });

  it("fails closed when electron-builder's product filename names no bundle", async () => {
    const appOutDir = await makeBundle();

    await expect(afterPack(makeContext(appOutDir, "darwin", "Wrong Product")))
      .rejects.toThrow("cannot read application bundle");
  });

  it("fails closed for missing or unsafe electron-builder product filenames", async () => {
    const appOutDir = await makeBundle();

    await expect(afterPack({ electronPlatformName: "darwin", appOutDir, packager: { appInfo: {} } }))
      .rejects.toThrow("safe product filename");
    await expect(afterPack(makeContext(appOutDir, "darwin", "../unexpected")))
      .rejects.toThrow("safe product filename");
  });
});

describe("desktop package dependency boundary", () => {
  it("excludes every node_modules payload only after all desktop entries bundle their runtime dependencies", async () => {
    const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const [packageJson, tsupConfig, viteConfig] = await Promise.all([
      readFile(path.join(desktopRoot, "package.json"), "utf8"),
      readFile(path.join(desktopRoot, "tsup.config.ts"), "utf8"),
      readFile(path.join(desktopRoot, "vite.config.ts"), "utf8")
    ]);
    const packageConfiguration = JSON.parse(packageJson) as {
      readonly build: {
        readonly files: readonly string[];
        readonly extraResources: readonly { readonly from: string; readonly to: string }[];
      };
    };

    expect(packageConfiguration.build.files).toContain("!**/node_modules/**/*");
    expect(packageConfiguration.build.extraResources).toContainEqual({ from: "../../NOTICES.md", to: "NOTICES.md" });

    const mainBundle = configBlock(tsupConfig, "src/main/index.ts");
    const preloadBundle = configBlock(tsupConfig, "src/preload/index.ts");
    const daemonBundle = configBlock(tsupConfig, "../daemon/src/index.ts");
    for (const bundle of [mainBundle, preloadBundle, daemonBundle]) {
      expect(bundle).toContain("bundle: true");
      expect(bundle).toContain('platform: "node"');
    }
    expect(mainBundle).toContain('noExternal: ["@cadrane/contracts", "zod", "docx", "jszip", "xml-js"]');
    expect(mainBundle).toContain('"src/main/storage-capability-probe.ts"');
    expect(mainBundle).toContain('"src/main/durable-spaces-gate.ts"');
    expect(preloadBundle).toContain('noExternal: ["@cadrane/contracts", "zod"]');
    expect(daemonBundle).toContain(
      'noExternal: ["@cadrane/contracts", "@cadrane/runtime", "zod"]'
    );
    /**
     * What this rule is actually for: nothing from `node_modules` may be left
     * for the runtime to find. Electron is the one exception, because it is
     * provided by the host.
     *
     * Node builtins are checked separately below rather than folded in here: a
     * builtin is never in `node_modules`, so externalising one cannot create the
     * payload this guard exists to prevent — and asserting the exact string
     * `external: ["electron"]` made a builtin look like a boundary violation.
     */
    for (const bundle of [mainBundle, preloadBundle]) {
      expect(bundle).toMatch(/external: \["electron"(, "node:[a-z]+")*\]/u);
    }

    /**
     * The `node:` prefix must survive bundling. Do not relax this.
     *
     * tsup strips it by default, and `node:sqlite` is the one builtin with no
     * unprefixed alias — so `require("sqlite")` resolves to nothing and the main
     * process dies at load, leaving the app running with no window and no error
     * anywhere useful. That failure hid the fact that the book had never been
     * opened at all (D-043).
     */
    for (const bundle of [mainBundle, preloadBundle, daemonBundle]) {
      expect(bundle).toContain("removeNodeProtocol: KEEP_NODE_PREFIX");
    }
    expect(tsupConfig).toContain("const KEEP_NODE_PREFIX = false;");
    expect(daemonBundle).toContain('external: ["node:sqlite"]');
    expect(daemonBundle).toContain('"../daemon/src/storage-capability-probe.ts"');

    const daemonTsupConfig = await readFile(path.join(desktopRoot, "../daemon/tsup.config.ts"), "utf8");
    expect(daemonTsupConfig).toContain('entry: ["src/index.ts", "src/storage-capability-probe.ts"]');
    expect(daemonTsupConfig).toContain('external: ["node:sqlite"]');
    expect(daemonTsupConfig.match(/\bclean:\s*true/g)).toHaveLength(1);

    expect(viteConfig).toContain('import react from "@vitejs/plugin-react"');
    expect(viteConfig).toContain("plugins: [react()]");
    expect(viteConfig).toContain("build:");
    // The renderer builds exactly two documents: the workbench and the
    // ⌥Space overlay. Pinned rather than banned, so a third entry — or a
    // stray plugin — still has to be a deliberate, reviewed change.
    expect(viteConfig).toContain("rollupOptions");
    expect(viteConfig.match(/resolve\(import\.meta\.dirname, "[^"]+"\)/g)).toEqual([
      'resolve(import.meta.dirname, "index.html")',
      'resolve(import.meta.dirname, "overlay.html")'
    ]);
    // Production must not ship sourcemaps: the packaged asar previously
    // contained a 1.1 MB map with full sourcesContent.
    expect(viteConfig).toContain('sourcemap: process.env["NODE_ENV"] !== "production"');
    expect(viteConfig).not.toMatch(/\bexternal\s*:/);
  });
});

function configBlock(source: string, entry: string): string {
  const start = source.indexOf(`entry: ["${entry}"`);
  if (start < 0) {
    throw new Error(`Missing tsup configuration for ${entry}.`);
  }
  const next = source.indexOf("\n  {", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

async function makeBundle(options: {
  readonly includeLoopbackExceptions?: boolean;
  readonly loopbackExceptionValuesAreDictionaries?: boolean;
  readonly writeInfoPlist?: boolean;
} = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchboard-plist-hardening-"));
  temporaryDirectories.push(root);
  const appOutDir = path.join(root, "mac-arm64");
  const contents = path.join(appOutDir, "Switchboard Local Intelligence.app", "Contents");
  await mkdir(contents, { recursive: true });
  if (options.writeInfoPlist !== false) {
    await writeFile(path.join(contents, "Info.plist"), createPlist(options), "utf8");
  }
  return appOutDir;
}

async function readFixture(appOutDir: string): Promise<string> {
  return readFile(
    path.join(appOutDir, "Switchboard Local Intelligence.app", "Contents", "Info.plist"),
    "utf8"
  );
}

function makeContext(
  appOutDir: string,
  electronPlatformName = "darwin",
  productFilename = "Switchboard Local Intelligence"
) {
  return {
    electronPlatformName,
    appOutDir,
    packager: { appInfo: { productFilename } }
  };
}

function createPlist(options: {
  readonly includeLoopbackExceptions?: boolean;
  readonly loopbackExceptionValuesAreDictionaries?: boolean;
}): string {
  const loopbackExceptions = options.includeLoopbackExceptions === false
    ? ""
    : options.loopbackExceptionValuesAreDictionaries === false
      ? `
      <key>NSExceptionDomains</key>
      <dict>
        <key>localhost</key><string>not-a-dictionary</string>
        <key>127.0.0.1</key><dict/>
      </dict>`
    : `
      <key>NSExceptionDomains</key>
      <dict>
        <key>localhost</key><dict/>
        <key>127.0.0.1</key><dict/>
      </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>NSAppTransportSecurity</key><dict>
    <key>NSAllowsArbitraryLoads</key><true/>
    <key>NSAllowsLocalNetworking</key><true/>${loopbackExceptions}
  </dict>
  <key>NSCameraUsageDescription</key><string>camera</string>
  <key>NSMicrophoneUsageDescription</key><string>microphone</string>
  <key>NSAudioCaptureUsageDescription</key><string>audio</string>
  <key>NSBluetoothPeripheralUsageDescription</key><string>bluetooth</string>
  <key>NSBluetoothAlwaysUsageDescription</key><string>bluetooth</string>
</dict></plist>`;
}
