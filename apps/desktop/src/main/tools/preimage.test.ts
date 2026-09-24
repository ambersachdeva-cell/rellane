import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeSnapshot,
  discard,
  FALLBACK_MAX_BYTES,
  outlookFrom,
  probeUndo,
  restore,
  SnapshotUnavailable,
  takePreimage
} from "./preimage.js";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cadrane-preimage-test-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("pre-image snapshots", () => {
  it("clones a file on APFS without copying its bytes", async () => {
    const file = join(base, "invoice.pdf");
    await writeFile(file, "original contents");

    const snapshot = await takePreimage(file);

    // /tmp is APFS on any modern Mac, so this is the path that must be taken.
    expect(snapshot.method).toBe("apfs-clone");
    expect(await readFile(snapshot.preimage, "utf8")).toBe("original contents");
    await discard(snapshot);
  });

  it("restores a file that was overwritten", async () => {
    const file = join(base, "quote.txt");
    await writeFile(file, "₹68 per piece");
    const snapshot = await takePreimage(file);

    await writeFile(file, "₹42 per piece");
    expect(await readFile(file, "utf8")).toBe("₹42 per piece");

    await restore(snapshot);
    expect(await readFile(file, "utf8")).toBe("₹68 per piece");
    await discard(snapshot);
  });

  it("restores a whole folder after files are moved out of it", async () => {
    const folder = join(base, "Downloads");
    await mkdir(folder);
    await writeFile(join(folder, "a.pdf"), "a");
    await writeFile(join(folder, "b.pdf"), "b");

    const snapshot = await takePreimage(folder);
    await rm(join(folder, "a.pdf"));
    await rm(join(folder, "b.pdf"));

    await restore(snapshot);
    expect(await readFile(join(folder, "a.pdf"), "utf8")).toBe("a");
    expect(await readFile(join(folder, "b.pdf"), "utf8")).toBe("b");
    await discard(snapshot);
  });

  it("restores even when the original was deleted entirely", async () => {
    const file = join(base, "gone.txt");
    await writeFile(file, "still here");
    const snapshot = await takePreimage(file);

    await rm(file);
    await restore(snapshot);

    expect(await readFile(file, "utf8")).toBe("still here");
    await discard(snapshot);
  });

  it("leaves the snapshot independent of later writes", async () => {
    const file = join(base, "diverge.txt");
    await writeFile(file, "before");
    const snapshot = await takePreimage(file);

    await writeFile(file, "after after after");

    // Copy-on-write means the clone must not have followed the change.
    expect(await readFile(snapshot.preimage, "utf8")).toBe("before");
    await discard(snapshot);
  });

  it("refuses rather than silently failing when the target is missing", async () => {
    await expect(takePreimage(join(base, "nope.txt"))).rejects.toBeInstanceOf(SnapshotUnavailable);
    await expect(takePreimage(join(base, "nope.txt"))).rejects.toMatchObject({ reason: "missing" });
  });

  it("cleans up completely when discarded", async () => {
    const file = join(base, "temp.txt");
    await writeFile(file, "x");
    const snapshot = await takePreimage(file);
    await discard(snapshot);
    await expect(stat(snapshot.preimage)).rejects.toBeTruthy();
  });

  it("says plainly that a clone used no extra disk", async () => {
    const file = join(base, "described.txt");
    await writeFile(file, "y".repeat(4096));
    const snapshot = await takePreimage(file);
    expect(describeSnapshot(snapshot)).toMatch(/using no extra disk/u);
    await discard(snapshot);
  });
});

/**
 * The probe behind the plan sheet's undo sentence.
 *
 * Its whole reason to exist is that the sheet was describing an outcome it had
 * not checked, so these tests care as much about what it does *not* do — write
 * into the folder, leave temp directories behind — as about the verdict.
 */
describe("probing whether a folder can be put back", () => {
  it("reports an instant snapshot for a folder on this APFS volume", async () => {
    await writeFile(join(base, "invoice.pdf"), "x".repeat(2048));

    const outlook = await probeUndo(base);

    expect(outlook.kind).toBe("instant");
    expect(outlook.bytes).toBeGreaterThan(0);
  });

  it("finds a file to test with even when the folder only holds folders", async () => {
    await mkdir(join(base, "2026", "clients"), { recursive: true });
    await writeFile(join(base, "2026", "clients", "quote.txt"), "₹68 per piece");

    expect((await probeUndo(base)).kind).toBe("instant");
  });

  it("treats an empty folder as snapshottable, because there is nothing to lose", async () => {
    const empty = join(base, "empty");
    await mkdir(empty);

    expect((await probeUndo(empty)).kind).toBe("instant");
  });

  it("changes nothing in the folder it probes", async () => {
    await writeFile(join(base, "a.txt"), "one");
    await writeFile(join(base, "b.txt"), "two");
    const before = (await readdir(base)).sort();

    await probeUndo(base);

    expect((await readdir(base)).sort()).toEqual(before);
    expect(await readFile(join(base, "a.txt"), "utf8")).toBe("one");
  });

  it("leaves no probe directory behind", async () => {
    // Scoped to a private temp root, not the machine's shared one.
    //
    // This scanned `tmpdir()` and failed about one run in eight. The probe
    // itself was never at fault: it removes its holder in a `finally`. The
    // test was asserting a property of a directory the whole machine writes
    // to — including a running copy of Rellane, which probes folders for the
    // same outlook and drops `cadrane-undo-probe-*` in exactly this place.
    // Anyone with the app open got a red suite for a bug that was not there.
    const priv = await mkdtemp(join(tmpdir(), "cadrane-probe-scope-"));
    const previous = process.env["TMPDIR"];
    process.env["TMPDIR"] = priv;
    try {
      const inside = await mkdtemp(join(tmpdir(), "cadrane-preimage-inner-"));
      await writeFile(join(inside, "c.txt"), "three");
      const leftovers = async () =>
        (await readdir(priv)).filter((name) => name.startsWith("cadrane-undo-probe-"));

      await probeUndo(inside);

      expect(await leftovers()).toEqual([]);
    } finally {
      if (previous === undefined) {
        delete process.env["TMPDIR"];
      } else {
        process.env["TMPDIR"] = previous;
      }
      await rm(priv, { recursive: true, force: true });
    }
  });

  it("says a missing folder cannot be put back, rather than throwing at the sheet", async () => {
    const outlook = await probeUndo(join(base, "gone"));

    expect(outlook.kind).toBe("unavailable");
    expect(outlook.bytes).toBe(0);
  });

  /**
   * The branches this machine cannot produce. Every Mac here is APFS, so a
   * suite that only exercised the real probe would test one third of the
   * behaviour — and the untested two thirds are what a customer with an
   * external drive meets on their first run.
   */
  describe("the verdict, given what was measured", () => {
    it("promises a real copy when the volume cannot clone but the folder is small", () => {
      const outlook = outlookFrom("/Volumes/USB/Invoices", 40 * 1024 * 1024, false);

      expect(outlook.kind).toBe("copied");
      expect(outlook.bytes).toBe(40 * 1024 * 1024);
    });

    it("refuses undo when the volume cannot clone and the folder is over the ceiling", () => {
      const outlook = outlookFrom("/Volumes/USB/Invoices", FALLBACK_MAX_BYTES + 1, false);

      expect(outlook.kind).toBe("unavailable");
      // The refusal names the folder and the limit, per DESIGN.md §7.
      expect(outlook).toMatchObject({
        reason: expect.stringContaining("Invoices") as unknown as string
      });
      expect(outlook.kind === "unavailable" && outlook.reason).toMatch(/put back/u);
    });

    it("takes the copy path exactly at the ceiling rather than one byte early", () => {
      expect(outlookFrom("/Volumes/USB/x", FALLBACK_MAX_BYTES, false).kind).toBe("copied");
    });

    it("prefers the clone whatever the size, because cloning is free", () => {
      expect(outlookFrom(base, FALLBACK_MAX_BYTES * 100, true).kind).toBe("instant");
    });
  });
});

describe("an undo must never destroy what it is undoing", () => {
  it("keeps the original when the restore puts nothing back", async () => {
    // The quarantine is the last copy of what was there. Deleting it on the
    // strength of "the command exited zero" is how a silent partial restore
    // becomes permanent — so it goes only once the restore is *observed*.
    await writeFile(join(base, "ledger.txt"), "the real records");
    const snapshot = await takePreimage(join(base, "ledger.txt"));

    // The preimage disappears underneath us: the restore cannot land.
    await rm(snapshot.preimage, { recursive: true, force: true });

    await expect(restore(snapshot)).rejects.toThrow();
    // The original is still exactly where it was.
    expect(await readFile(join(base, "ledger.txt"), "utf8")).toBe("the real records");
  });

  it("restores a file to its exact previous contents", async () => {
    const file = join(base, "quote.txt");
    await writeFile(file, "₹9,360 outstanding");
    const snapshot = await takePreimage(file);

    await writeFile(file, "overwritten by mistake");
    await restore(snapshot);

    expect(await readFile(file, "utf8")).toBe("₹9,360 outstanding");
  });
});

describe("a snapshot defends its own boundaries", () => {
  it("refuses a target that would put the pre-image outside its holder", async () => {
    // `basename` is the whole snapshot path, and `basename("..")` is `".."`, so
    // a target of `..` would place the pre-image at the holder's own parent —
    // /tmp — which `cp -R` writes into and `discard` then deletes recursively.
    // The one caller today passes a realpathed, sandbox-validated directory, so
    // this is unreachable; it is checked because that is a property of a call
    // site rather than of this function, and this function shells out to
    // /bin/cp and rm -rf.
    await expect(takePreimage("..")).rejects.toThrow(SnapshotUnavailable);
    await expect(takePreimage(".")).rejects.toThrow(SnapshotUnavailable);
  });

  it("refuses a relative target", async () => {
    await expect(takePreimage("Downloads")).rejects.toThrow(/absolute/u);
  });

  it("records the holder rather than walking up from the pre-image", async () => {
    // The property that removes the class: `discard` never does path arithmetic
    // on something it is about to delete recursively.
    const folder = await mkdtemp(join(tmpdir(), "cadrane-preimage-test-"));
    await writeFile(join(folder, "bill.txt"), "Total 9,465");

    const snapshot = await takePreimage(folder);

    expect(snapshot.holder).not.toBe("");
    expect(snapshot.preimage.startsWith(snapshot.holder)).toBe(true);
    await discard(snapshot);
    await expect(stat(snapshot.holder)).rejects.toThrow();

    await rm(folder, { recursive: true, force: true });
  });

  it("will not delete a holder it did not create", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "not-ours-"));
    const keep = join(elsewhere, "keep.txt");
    await writeFile(keep, "still here");

    await expect(
      discard({
        source: "/does/not/matter",
        preimage: join(elsewhere, "x"),
        holder: elsewhere,
        method: "copy",
        bytes: 0,
        tookMs: 0
      })
    ).rejects.toThrow(SnapshotUnavailable);

    // The point of the refusal: the directory is still there.
    expect((await stat(keep)).isFile()).toBe(true);
    await rm(elsewhere, { recursive: true, force: true });
  });
});
