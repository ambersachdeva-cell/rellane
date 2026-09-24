/**
 * These tests attack the ledger rather than exercising it.
 *
 * A tamper-evidence test that only appends and reads back proves nothing — the
 * whole claim is about what happens when someone edits the file, so most of
 * what follows edits the file.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeIntegrity, Ledger } from "./ledger.js";
import { SecretStore } from "./secrets.js";

/**
 * Stands in for the Keychain.
 *
 * Deliberately reversible rather than a no-op: a fake that returns plaintext
 * would let a bug where we forget to encrypt pass every test in this file.
 */
function fakeKeychain() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`os:${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^os:/u, "")
  };
}

let directory: string;
let secrets: SecretStore;
let ledger: Ledger;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cadrane-ledger-"));
  secrets = new SecretStore({ directory, crypto: fakeKeychain() });
  ledger = new Ledger(directory, secrets);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const file = () => join(directory, "ledger.jsonl");

async function lines(): Promise<string[]> {
  const raw = await readFile(file(), "utf8");
  return raw.split("\n").filter((line) => line.length > 0);
}

describe("what the ledger records", () => {
  it("chains each entry to the one before it", async () => {
    const first = await ledger.append({ kind: "skill.run", detail: { moved: 12 } }, 1000);
    const second = await ledger.append({ kind: "skill.undo", detail: { restored: 12 } }, 2000);

    expect(first.seq).toBe(0);
    expect(first.prev).toBe("0".repeat(64));
    expect(second.seq).toBe(1);
    expect(second.prev).toBe(first.mac);
  });

  it("reads back exactly what was written", async () => {
    await ledger.append({ kind: "skill.run", detail: { folder: "Downloads", moved: 47 } }, 1000);
    const [entry] = await ledger.read();
    expect(entry?.kind).toBe("skill.run");
    expect(entry?.detail).toEqual({ folder: "Downloads", moved: 47 });
    expect(entry?.at).toBe("1970-01-01T00:00:01.000Z");
  });

  it("survives a restart, which is the entire reason it exists", async () => {
    await ledger.append({ kind: "skill.run", detail: { moved: 3 } }, 1000);
    // A second Ledger over the same directory is what the next launch does.
    const reopened = new Ledger(directory, new SecretStore({ directory, crypto: fakeKeychain() }));
    expect(await reopened.read()).toHaveLength(1);
    expect(await reopened.verify()).toEqual({ status: "intact", entries: 1 });
  });

  it("keeps ordering when appends are fired concurrently", async () => {
    // Two skills finishing together must not both claim the same predecessor.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => ledger.append({ kind: "skill.run", detail: { i } }, 1000 + i))
    );
    expect(await ledger.verify()).toEqual({ status: "intact", entries: 8 });
    expect((await ledger.read()).map((entry) => entry.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("confidentiality", () => {
  it("writes nothing readable to disk", async () => {
    await ledger.append(
      { kind: "skill.run", detail: { client: "SharmaPharma", amount: "68000" } },
      1000
    );
    const raw = await readFile(file(), "utf8");
    expect(raw).not.toContain("SharmaPharma");
    expect(raw).not.toContain("68000");
    expect(raw).not.toContain("skill.run");
  });

  it("uses a fresh IV per entry, so identical records do not produce identical lines", async () => {
    await ledger.append({ kind: "skill.run", detail: { same: true } }, 1000);
    await ledger.append({ kind: "skill.run", detail: { same: true } }, 1000);
    const [a, b] = await lines();
    expect(a).not.toBe(b);
  });

  it("mints a key per install rather than shipping one", async () => {
    await ledger.append({ kind: "skill.run", detail: {} }, 1000);
    const other = await mkdtemp(join(tmpdir(), "cadrane-ledger-"));
    try {
      const otherSecrets = new SecretStore({ directory: other, crypto: fakeKeychain() });
      await new Ledger(other, otherSecrets).append({ kind: "skill.run", detail: {} }, 1000);
      expect(await otherSecrets.get("ledger.key")).not.toBe(await secrets.get("ledger.key"));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("tamper evidence", () => {
  it("accepts an untouched chain", async () => {
    await ledger.append({ kind: "skill.run", detail: { moved: 1 } }, 1000);
    await ledger.append({ kind: "skill.run", detail: { moved: 2 } }, 2000);
    expect(await ledger.verify()).toEqual({ status: "intact", entries: 2 });
  });

  it("notices an entry removed from the middle", async () => {
    for (const i of [0, 1, 2]) {
      await ledger.append({ kind: "skill.run", detail: { i } }, 1000 + i);
    }
    const all = await lines();
    await writeFile(file(), `${[all[0], all[2]].join("\n")}\n`);

    const result = await ledger.verify();
    // Entry 2 now claims a predecessor that is no longer above it.
    expect(result).toEqual({ status: "altered", atSeq: 2 });
  });

  it("notices two entries swapped", async () => {
    for (const i of [0, 1, 2]) {
      await ledger.append({ kind: "skill.run", detail: { i } }, 1000 + i);
    }
    const all = await lines();
    await writeFile(file(), `${[all[0], all[2], all[1]].join("\n")}\n`);
    expect((await ledger.verify()).status).toBe("altered");
  });

  it("notices entries removed from the end, which chaining alone would miss", async () => {
    for (const i of [0, 1, 2]) {
      await ledger.append({ kind: "skill.run", detail: { i } }, 1000 + i);
    }
    const all = await lines();
    // Truncation leaves a perfectly valid chain. Only the anchor catches it.
    await writeFile(file(), `${all[0]}\n`);
    expect(await ledger.verify()).toEqual({ status: "truncated", expected: 3, found: 1 });
  });

  it("notices a ledger rebuilt wholesale by someone holding the key", async () => {
    await ledger.append({ kind: "skill.run", detail: { real: true } }, 1000);
    const anchoredHead = await secrets.get("ledger.anchor.head");

    // The strongest realistic attack: recreate a self-consistent chain of the
    // same length with different contents. Everything internal checks out.
    await rm(file(), { force: true });
    await secrets.set("ledger.anchor.head", "0".repeat(64));
    await secrets.set("ledger.anchor.count", "0");
    const forged = new Ledger(directory, secrets);
    await forged.append({ kind: "skill.run", detail: { real: false } }, 1000);

    // Restore the anchor the real ledger left behind — the one part of the
    // system the attacker could not reach without the Keychain.
    await secrets.set("ledger.anchor.head", anchoredHead ?? "");
    expect(await forged.verify()).toEqual({ status: "substituted" });
  });

  it("rejects a line whose ciphertext was edited", async () => {
    await ledger.append({ kind: "skill.run", detail: { moved: 1 } }, 1000);
    const [line] = await lines();
    const bytes = Buffer.from(line ?? "", "base64");
    // Flip one bit deep in the ciphertext. GCM's auth tag must catch it.
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0x01, bytes.length - 1);
    await writeFile(file(), `${bytes.toString("base64")}\n`);

    expect(await ledger.verify()).toEqual({ status: "unreadable", atLine: 1 });
  });

  it("does not hand back entries it cannot vouch for", async () => {
    await ledger.append({ kind: "skill.run", detail: { moved: 1 } }, 1000);
    await writeFile(file(), "not-even-base64-really\n");
    expect(await ledger.read()).toEqual([]);
  });

  it("treats an empty ledger as intact rather than as a problem", async () => {
    expect(await ledger.verify()).toEqual({ status: "intact", entries: 0 });
  });
});

describe("key ordering cannot change a MAC", () => {
  it("verifies regardless of the order detail keys were written in", async () => {
    // JSON.stringify preserves insertion order; the MAC must not.
    await ledger.append({ kind: "skill.run", detail: { b: 2, a: 1 } }, 1000);
    await ledger.append({ kind: "skill.run", detail: { a: 1, b: 2 } }, 2000);
    expect(await ledger.verify()).toEqual({ status: "intact", entries: 2 });
  });
});

describe("what the owner is told", () => {
  it("says something true and specific for each verdict", () => {
    expect(describeIntegrity({ status: "intact", entries: 0 })).toContain("Nothing has been recorded");
    expect(describeIntegrity({ status: "intact", entries: 1 })).toContain("1 entry");
    expect(describeIntegrity({ status: "intact", entries: 4 })).toContain("4 entries");
    expect(describeIntegrity({ status: "altered", atSeq: 7 })).toContain("Entry 8");
    expect(describeIntegrity({ status: "altered", atSeq: 7 })).toContain("cannot be verified");
    expect(describeIntegrity({ status: "altered", atSeq: 7 })).not.toContain("still trustworthy");
    expect(describeIntegrity({ status: "truncated", expected: 9, found: 4 })).toContain("5 entries");
    expect(describeIntegrity({ status: "substituted" })).toContain("does not match its saved checkpoint");
    // Failed authentication does not tell us why the record is unreadable.
    const unreadable = describeIntegrity({ status: "unreadable", atLine: 2 });
    expect(unreadable).toContain("Entry 2");
    expect(unreadable).toContain("cannot be verified");
    expect(unreadable).toContain("Keep the original data");
    expect(unreadable).not.toContain("different Mac");
  });
});

describe("wiping", () => {
  it("removes the record and its anchor together", async () => {
    await ledger.append({ kind: "skill.run", detail: {} }, 1000);
    await ledger.wipe();
    // A leftover anchor would make the next entry look like a substitution.
    expect(await ledger.verify()).toEqual({ status: "intact", entries: 0 });
    await ledger.append({ kind: "skill.run", detail: {} }, 2000);
    expect(await ledger.verify()).toEqual({ status: "intact", entries: 1 });
  });
});
