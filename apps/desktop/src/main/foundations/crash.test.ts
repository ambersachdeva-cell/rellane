import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CRASH_DIR,
  forgetCrashes,
  KEEP_REPORTS,
  MAX_TRACE_CHARS,
  readCrashes,
  recordCrash,
  reportName
} from "./crash.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-crash-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("what a crash leaves behind", () => {
  it("writes a readable report naming what failed", async () => {
    const path = await recordCrash(dir, "the book would not open", new Error("disk is full"));

    expect(path).not.toBeNull();
    const text = await readFile(path ?? "", "utf8");
    expect(text).toContain("what: the book would not open");
    expect(text).toContain("disk is full");
  });

  it("redacts before writing, not before sharing", async () => {
    // A file sitting on disk with client names in it is already a leak: a
    // backup picks it up, a screen-share shows it. The owner's folders here are
    // named after his customers.
    const secret = join(homedir(), "Clients", "Devgiri Traders", "invoice.pdf");
    const path = await recordCrash(dir, "filing", new Error(`could not read ${secret}`));

    const text = await readFile(path ?? "", "utf8");
    expect(text).not.toContain("Devgiri");
    expect(text).not.toContain(homedir());
    // The shape survives, so the report is still diagnosable.
    expect(text).toContain(".pdf");
  });

  it("keeps an email address and a long token out of it", async () => {
    const path = await recordCrash(
      dir,
      "sending",
      new Error("rejected for devgiri@example.co.in with sk-abcdefghijklmnopqrstuvwxyz012345")
    );

    const text = await readFile(path ?? "", "utf8");
    expect(text).not.toContain("devgiri@example.co.in");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("truncates a runaway trace rather than storing it whole", async () => {
    const path = await recordCrash(dir, "loop", new Error("x".repeat(MAX_TRACE_CHARS * 3)));

    expect((await readFile(path ?? "", "utf8")).length).toBeLessThan(MAX_TRACE_CHARS + 500);
  });
});

describe("not becoming its own problem", () => {
  it("keeps only the newest few", async () => {
    // A machine crashing in a loop must not fill its own disk, and nobody reads
    // the fortieth copy of one trace.
    for (let index = 0; index < KEEP_REPORTS + 4; index += 1) {
      await recordCrash(dir, "again", new Error("same"), new Date(2026, 0, 1, 0, index));
    }

    expect((await readdir(join(dir, CRASH_DIR))).length).toBe(KEEP_REPORTS);
  });

  it("never throws, whatever state the machine is in", async () => {
    // This runs while the app is already failing. A crash handler that throws
    // replaces a legible report with nothing at all.
    await expect(recordCrash("/dev/null/nope", "x", new Error("y"))).resolves.toBeNull();
    await expect(recordCrash(dir, "x", { weird: true })).resolves.not.toBeNull();
  });

  it("reads nothing, rather than failing, when there are no crashes", async () => {
    expect(await readCrashes(dir)).toEqual([]);
  });
});

describe("what the owner sees", () => {
  it("returns the exact text that would be handed over, newest first", async () => {
    await recordCrash(dir, "first", new Error("one"), new Date(2026, 0, 1, 10, 0));
    await recordCrash(dir, "second", new Error("two"), new Date(2026, 0, 1, 11, 0));

    const reports = await readCrashes(dir);

    expect(reports).toHaveLength(2);
    expect(reports[0]?.what).toBe("second");
    // Full text, not a summary: the point is reading what you would be sharing.
    expect(reports[0]?.text).toContain("two");
  });

  it("survives a report somebody edited or truncated", async () => {
    await mkdir(join(dir, CRASH_DIR), { recursive: true });
    await writeFile(join(dir, CRASH_DIR, reportName(new Date())), "not the usual shape");

    const reports = await readCrashes(dir);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.what).toBe("Something failed");
  });

  it("can be deleted, because it is the owner's copy", async () => {
    await recordCrash(dir, "x", new Error("y"));
    await forgetCrashes(dir);

    expect(await readCrashes(dir)).toEqual([]);
  });
});
