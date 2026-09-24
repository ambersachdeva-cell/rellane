import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readActivity } from "./activity.js";
import { Ledger } from "./security/ledger.js";
import { SecretStore } from "./security/secrets.js";

function fakeKeychain() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`os:${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^os:/u, "")
  };
}

let directory: string;
let ledger: Ledger;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cadrane-activity-"));
  ledger = new Ledger(directory, new SecretStore({ directory, crypto: fakeKeychain() }));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const run = (over: Record<string, unknown> = {}) => ({
  kind: "skill.run",
  detail: { skill: "librarian", folder: "/Users/amber/Downloads", done: 47, refused: 0, failed: 0, ...over }
});

describe("what the owner reads", () => {
  it("says what happened, not what was planned", async () => {
    await ledger.append(run({ done: 4, refused: 2, failed: 1 }), 1000);
    const log = await readActivity(ledger);
    expect(log.entries[0]?.summary).toBe("Librarian: 4 changes made, 2 declined, 1 failure.");
  });

  it("counts in the singular", async () => {
    await ledger.append(run({ done: 1, failed: 1 }), 1000);
    expect((await readActivity(ledger)).entries[0]?.summary).toBe(
      "Librarian: 1 change made, 1 failure."
    );
  });

  it("does not report a run that did nothing as a success", async () => {
    await ledger.append(run({ done: 0 }), 1000);
    expect((await readActivity(ledger)).entries[0]?.summary).toBe("Librarian found nothing to do.");
  });

  it("describes an undo in the owner's terms", async () => {
    await ledger.append({ kind: "skill.undo", detail: { receipt: "abc" } }, 1000);
    expect((await readActivity(ledger)).entries[0]?.summary).toBe("Put everything back.");
  });

  it("shows a record it cannot phrase rather than dropping it", async () => {
    // Hiding it would make the list disagree with the count the integrity line
    // quotes, which is worse than an unpolished sentence.
    await ledger.append({ kind: "outbound.approved", detail: { outcome: "Sent 1 message" } }, 1000);
    expect((await readActivity(ledger)).entries[0]?.summary).toBe("Sent 1 message");
  });

  it("puts the newest first", async () => {
    await ledger.append(run({ done: 1 }), 1000);
    await ledger.append(run({ done: 2 }), 2000);
    const log = await readActivity(ledger);
    expect(log.entries.map((entry) => entry.seq)).toEqual([1, 0]);
  });
});

describe("what never reaches the renderer", () => {
  it("hands over a folder name, never a path it could replay", async () => {
    await ledger.append(run(), 1000);
    const log = await readActivity(ledger);
    expect(log.entries[0]?.where).toBe("Downloads");
    expect(JSON.stringify(log)).not.toContain("/Users/amber");
  });

  it("copes with a record that names no folder", async () => {
    await ledger.append({ kind: "skill.undo", detail: {} }, 1000);
    expect((await readActivity(ledger)).entries[0]?.where).toBeNull();
  });
});

describe("integrity travels with the entries", () => {
  it("vouches for an untouched record", async () => {
    await ledger.append(run(), 1000);
    const log = await readActivity(ledger);
    expect(log.trustworthy).toBe(true);
    expect(log.integrity).toBe("1 entry, unbroken.");
  });

  it("stops vouching once the record has been edited", async () => {
    await ledger.append(run(), 1000);
    await ledger.append(run(), 2000);
    // Drop the last line: a valid chain, but not the one we anchored.
    const { readFile, writeFile } = await import("node:fs/promises");
    const file = join(directory, "ledger.jsonl");
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    await writeFile(file, `${lines[0]}\n`);

    const log = await readActivity(ledger);
    expect(log.trustworthy).toBe(false);
    expect(log.integrity).toContain("missing from the end");
    expect(log.entries).toEqual([]);
  });
});

describe("bounds", () => {
  it("returns nothing at all before the ledger exists", async () => {
    const log = await readActivity(null);
    expect(log).toEqual({
      entries: [],
      integrity: "Action history has not opened yet.",
      trustworthy: false
    });
  });

  it("caps a request that asks for everything", async () => {
    for (let i = 0; i < 12; i += 1) {
      await ledger.append(run({ done: i + 1 }), 1000 + i);
    }
    expect((await readActivity(ledger, 5)).entries).toHaveLength(5);
    // A nonsense limit falls back rather than throwing or returning nothing.
    expect((await readActivity(ledger, Number.NaN)).entries).toHaveLength(12);
    expect((await readActivity(ledger, -3)).entries).toHaveLength(1);
    expect((await readActivity(ledger, 10_000)).entries).toHaveLength(12);
  });
});

/**
 * A receipt is a timeline entry with a restore point attached — one record, not
 * two systems. These are the rules that keep the timeline from offering a
 * restore it cannot perform, which is the one thing DESIGN.md §8 forbids by
 * name.
 */
describe("what can still be put back", () => {
  it("carries the receipt id so a row can be acted on", async () => {
    await ledger.append(run({ receiptId: "r1" }), 1000);
    expect((await readActivity(ledger)).entries[0]?.receiptId).toBe("r1");
  });

  it("has no receipt id for an entry that never had one", async () => {
    await ledger.append(run(), 1000);
    const entry = (await readActivity(ledger)).entries[0];
    expect(entry?.receiptId).toBeNull();
    expect(entry?.restorable).toBe(false);
  });

  it("marks a run undone once a later entry reverses it", async () => {
    await ledger.append(run({ receiptId: "r1" }), 1000);
    await ledger.append({ kind: "skill.undo", detail: { receipt: "r1" } }, 2000);
    const entries = (await readActivity(ledger)).entries;
    expect(entries.find((entry) => entry.receiptId === "r1")?.undone).toBe(true);
  });

  it("refuses to offer a restore when the snapshots are no longer held", async () => {
    await ledger.append(run({ receiptId: "r1" }), 1000);
    // The default: a caller that has not checked says nothing can be put back,
    // rather than promising a restore it has not verified.
    expect((await readActivity(ledger)).entries[0]?.restorable).toBe(false);
  });

  it("offers a restore while the window is open", async () => {
    await ledger.append(run({ receiptId: "r1" }), 1000);
    const log = await readActivity(ledger, undefined, new Set(["r1"]));
    expect(log.entries[0]?.restorable).toBe(true);
  });

  it("will not offer to put back something already put back", async () => {
    await ledger.append(run({ receiptId: "r1" }), 1000);
    await ledger.append({ kind: "skill.undo", detail: { receipt: "r1" } }, 2000);
    // Even with the snapshots still held: there is nothing left to restore.
    const log = await readActivity(ledger, undefined, new Set(["r1"]));
    expect(log.entries.find((entry) => entry.receiptId === "r1")?.restorable).toBe(false);
  });

  it("sees an undo that falls outside the page it returns", async () => {
    await ledger.append(run({ receiptId: "r1" }), 1000);
    for (let i = 0; i < 8; i += 1) {
      await ledger.append(run({ receiptId: `filler-${i}` }), 1100 + i);
    }
    await ledger.append({ kind: "skill.undo", detail: { receipt: "r1" } }, 3000);

    // The page holds the newest three, so the run itself is off the end — but
    // the undo it belongs to must still be found, or a later page would show
    // the run as restorable after it had already been reversed.
    const paged = await readActivity(ledger, 3, new Set(["r1"]));
    expect(paged.entries).toHaveLength(3);

    const all = await readActivity(ledger, 100, new Set(["r1"]));
    expect(all.entries.find((entry) => entry.receiptId === "r1")?.restorable).toBe(false);
  });
});
