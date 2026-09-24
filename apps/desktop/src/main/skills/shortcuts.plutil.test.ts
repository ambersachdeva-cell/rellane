import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildShortcutPlist, readShortcutIntent } from "./shortcuts.js";

const run = promisify(execFile);

/**
 * macOS itself is the authority on whether this plist is valid.
 *
 * My own XML checks only prove the string looks right to me. `plutil` is what
 * Shortcuts.app effectively runs, so this is the difference between "well
 * formed" and "will actually import".
 */
describe("the plist is valid to macOS, not just to me", () => {
  it("passes plutil -lint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cadrane-shortcut-"));
    try {
      const spec = readShortcutIntent("tidy my downloads & quotes <2026>", {
        folder: "/Users/amber/Bills & Quotes"
      });
      const file = join(dir, "test.plist");
      await writeFile(file, buildShortcutPlist(spec!));

      const { stdout } = await run("/usr/bin/plutil", ["-lint", file]);
      expect(stdout).toMatch(/OK/u);

      // And it round-trips back to the values we put in.
      const { stdout: json } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]);
      const parsed = JSON.parse(json) as { WFWorkflowActions: unknown[] };
      expect(parsed.WFWorkflowActions).toHaveLength(spec!.actions.length);
      expect(json).toContain("Bills & Quotes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
