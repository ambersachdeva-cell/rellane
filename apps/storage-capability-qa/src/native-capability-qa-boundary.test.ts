import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.resolve(root, "../desktop");

describe("native capability QA isolation", () => {
  it("keeps C3b out of the ordinary desktop package and keeps ordinary product code out of QA", async () => {
    const [desktopPackage, qaPackage, main, utility] = await Promise.all([
      readFile(path.join(desktop, "package.json"), "utf8"),
      readFile(path.join(root, "package.json"), "utf8"),
      readFile(path.join(root, "src/native-capability-qa-main.ts"), "utf8"),
      readFile(path.join(root, "src/native-capability-qa-utility.ts"), "utf8")
    ]);
    expect(desktopPackage).not.toMatch(/storage-capability-qa|native-capability-qa/);
    expect(qaPackage).toContain("com.switchboard.storage-capability-qa");
    expect(qaPackage).toContain('"dist/**/*"');
    expect(main + utility).not.toMatch(/BrowserWindow|installIpcHandlers|DaemonClient|renderer|preload|model/i);
  });
});
