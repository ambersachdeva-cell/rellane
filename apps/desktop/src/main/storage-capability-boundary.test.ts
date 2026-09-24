import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ availability: vi.fn(() => true) }));

vi.mock("electron", () => ({
  safeStorage: { isEncryptionAvailable: electron.availability }
}));

import {
  STORAGE_CAPABILITY_MAIN_PROBE_MARKER
} from "./storage-capability-probe.js";
import {
  DURABLE_SPACES_ENABLED,
  DURABLE_SPACES_GATE_MARKER
} from "./durable-spaces-gate.js";

const mainRoot = path.dirname(fileURLToPath(import.meta.url));
const desktopSrc = path.resolve(mainRoot, "..");
const daemonSrc = path.resolve(mainRoot, "../../../daemon/src");
const contractsSrc = path.resolve(mainRoot, "../../../../packages/contracts/src");

describe("storage capability package-only boundary", () => {
  it("imports inert markers without invoking protected storage", () => {
    expect(STORAGE_CAPABILITY_MAIN_PROBE_MARKER).toBe("switchboard-storage-capability-main-probe-v1");
    expect(DURABLE_SPACES_GATE_MARKER).toBe("switchboard-durable-spaces-gate-v1");
    expect(DURABLE_SPACES_ENABLED).toBe(false);
    expect(electron.availability).not.toHaveBeenCalled();
  });

  it("keeps probes and gate unreachable from every running product surface and public barrel", async () => {
    const files = [
      path.join(mainRoot, "index.ts"),
      path.join(mainRoot, "daemon-client.ts"),
      path.join(mainRoot, "ipc.ts"),
      path.join(desktopSrc, "preload/index.ts"),
      path.join(desktopSrc, "shared/ipc-channels.ts"),
      path.join(desktopSrc, "renderer/main.tsx"),
      path.join(desktopSrc, "renderer/App.tsx"),
      path.join(daemonSrc, "index.ts"),
      path.join(daemonSrc, "service.ts"),
      path.join(contractsSrc, "index.ts")
    ];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/storage-capability|durable-spaces-gate|DURABLE_SPACES_ENABLED/);
    }
  });

  it("keeps probe sources free of activation, database, encryption, and SQL effects", async () => {
    const [mainProbe, utilityProbe, gate] = await Promise.all([
      readFile(path.join(mainRoot, "storage-capability-probe.ts"), "utf8"),
      readFile(path.join(daemonSrc, "storage-capability-probe.ts"), "utf8"),
      readFile(path.join(mainRoot, "durable-spaces-gate.ts"), "utf8")
    ]);
    expect(mainProbe).toContain("safeStorage.isEncryptionAvailable()");
    expect(mainProbe).not.toMatch(/setUsePlainTextEncryption|encryptString|decryptString/);
    expect(utilityProbe).toContain('NODE_SQLITE_SPECIFIER = "node:sqlite"');
    expect(utilityProbe).toContain("await import(NODE_SQLITE_SPECIFIER)");
    expect(utilityProbe).toContain("sqlite.DatabaseSync");
    expect(utilityProbe).not.toMatch(/new\s+.*DatabaseSync|\.exec\(|\.prepare\(|CREATE\s+TABLE|SELECT\s+/i);
    expect(gate).toContain("DURABLE_SPACES_ENABLED = false as const");
  });
});
