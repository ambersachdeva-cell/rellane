/** History inspection must not rewrite the evidence it is trying to verify. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "./ledger.js";
import { SecretStore } from "./secrets.js";

const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`fictional:${text}`),
  decryptString: (bytes: Buffer) => {
    const text = bytes.toString();
    if (!text.startsWith("fictional:")) throw new Error("not our synthetic store");
    return text.slice(10);
  }
};
let directory: string;
let file: string;
let secrets: SecretStore;
let ledger: Ledger;
const record = { kind: "synthetic.run", detail: { changed: 1 } };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cadrane-history-preservation-"));
  file = join(directory, "ledger.jsonl");
  secrets = new SecretStore({ directory, crypto });
  ledger = new Ledger(directory, secrets);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

async function storedBytes() {
  return { log: await readFile(file), secrets: await readFile(join(directory, "secrets.bin")) };
}

describe("non-mutating history inspection", () => {
  it("does not initialize files or keys while reading an actually empty history", async () => {
    const set = vi.spyOn(secrets, "set");
    expect(await ledger.verify()).toEqual({ status: "intact", entries: 0 });
    expect(await ledger.read()).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
    expect(set).not.toHaveBeenCalled();
  });

  it("reports a filesystem read error as unavailable and cannot append over it", async () => {
    await mkdir(file);
    expect(await ledger.snapshot()).toEqual({ integrity: { status: "unavailable", reason: "file" }, records: [] });
    await expect(ledger.append(record)).rejects.toThrow("Action history could not be verified");
    expect(await readdir(directory)).toEqual(["ledger.jsonl"]);
    expect(await readdir(file)).toEqual([]);
  });

  it("does not mint a new key when an existing log loses its original key, even in this process", async () => {
    await ledger.append(record);
    await secrets.delete("ledger.key");
    const before = await storedBytes();
    const set = vi.spyOn(secrets, "set");
    expect(await ledger.verify()).toEqual({ status: "unavailable", reason: "key" });
    const reopened = new Ledger(directory, new SecretStore({ directory, crypto }));
    expect(await reopened.read()).toEqual([]);
    await expect(reopened.append(record)).rejects.toThrow("key needed to verify");
    expect(await storedBytes()).toEqual(before);
    expect(set).not.toHaveBeenCalled();
  });

  it.each(["bad envelope", JSON.stringify({ version: 1, payload: Buffer.from("fictional:[]").toString("base64") })])(
    "does not treat unreadable or invalid protected storage as an empty install: %s", async raw => {
      const secretFile = join(directory, "secrets.bin");
      await writeFile(secretFile, raw);
      expect(await ledger.verify()).toEqual({ status: "unavailable", reason: "key-store" });
      await expect(ledger.append(record)).rejects.toThrow("protected history keys");
      expect(await readFile(secretFile, "utf8")).toBe(raw);
      expect(await readdir(directory)).toEqual(["secrets.bin"]);
    }
  );
});

describe("history that cannot authorize another append", () => {
  it("keeps corrupted ciphertext and all anchors unchanged, without returning a trusted prefix", async () => {
    await ledger.append(record);
    await ledger.append({ kind: "synthetic.second", detail: {} });
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    const bytes = Buffer.from(lines[1]!, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(file, `${lines[0]}\n${bytes.toString("base64")}\n`);
    const before = await storedBytes();
    expect(await ledger.snapshot()).toEqual({ integrity: { status: "unreadable", atLine: 2 }, records: [] });
    await expect(ledger.append(record)).rejects.toThrow("Action history could not be verified");
    expect(await storedBytes()).toEqual(before);
  });

  it("does not recreate a missing log while its checkpoint still records history", async () => {
    await ledger.append(record);
    await rm(file);
    const before = await readFile(join(directory, "secrets.bin"));
    expect(await ledger.verify()).toEqual({ status: "truncated", expected: 1, found: 0 });
    await expect(ledger.append(record)).rejects.toThrow("missing from the end");
    expect(await readFile(join(directory, "secrets.bin"))).toEqual(before);
    expect(await readdir(directory)).toEqual(["secrets.bin"]);
  });

  it.each(["1garbage", "-1", "9007199254740992"])("refuses invalid checkpoint count %s", async count => {
    await ledger.append(record);
    await secrets.set("ledger.anchor.count", count);
    const before = await storedBytes();
    expect(await ledger.verify()).toEqual({ status: "unavailable", reason: "anchor" });
    await expect(ledger.append(record)).rejects.toThrow("checkpoint is incomplete or invalid");
    expect(await storedBytes()).toEqual(before);
  });

  it("refuses an incomplete two-part checkpoint without reconstructing it from the file", async () => {
    await ledger.append(record);
    await secrets.delete("ledger.anchor.count");
    const before = await storedBytes();
    expect(await ledger.verify()).toEqual({ status: "unavailable", reason: "anchor" });
    await expect(ledger.append(record)).rejects.toThrow("checkpoint");
    expect(await storedBytes()).toEqual(before);
  });

  it("records an interrupted checkpoint as ahead, then refuses to advance it again", async () => {
    await ledger.append(record);
    const set = secrets.set.bind(secrets);
    vi.spyOn(secrets, "set").mockImplementation(async (key, value) => {
      if (key === "ledger.anchor.head") throw new Error("synthetic disk failure");
      await set(key, value);
    });
    await expect(ledger.append(record)).rejects.toThrow("synthetic disk failure");
    const before = await storedBytes();
    expect(await ledger.verify()).toEqual({ status: "ahead", expected: 1, found: 2 });
    await expect(ledger.append(record)).rejects.toThrow("beyond its saved checkpoint");
    expect(await storedBytes()).toEqual(before);
  });
});

describe("one ordered inspection and write lane", () => {
  it("does not expose a half-written checkpoint to a concurrent snapshot", async () => {
    await ledger.append(record);
    let entered!: () => void;
    let release!: () => void;
    const atCheckpoint = new Promise<void>(resolve => { entered = resolve; });
    const continueCheckpoint = new Promise<void>(resolve => { release = resolve; });
    const set = secrets.set.bind(secrets);
    vi.spyOn(secrets, "set").mockImplementation(async (key, value) => {
      if (key === "ledger.anchor.head") { entered(); await continueCheckpoint; }
      await set(key, value);
    });
    const append = ledger.append(record);
    await atCheckpoint;
    let readFinished = false;
    const snapshot = ledger.snapshot().then(result => { readFinished = true; return result; });
    await Promise.resolve();
    expect(readFinished).toBe(false);
    release();
    await append;
    const result = await snapshot;
    expect(result.integrity).toEqual({ status: "intact", entries: 2 });
    expect(result.records.map(entry => entry.seq)).toEqual([0, 1]);
  });

  it("snapshots caller data and normalizes its stored representation before computing the MAC", async () => {
    const detail = { n: 1, when: new Date(0) };
    const pending = ledger.append({ kind: "synthetic.normalized", detail });
    detail.n = 99;
    await pending;
    expect(await ledger.verify()).toEqual({ status: "intact", entries: 1 });
    expect((await ledger.read())[0]?.detail).toEqual({ n: 1, when: "1970-01-01T00:00:00.000Z" });
  });

  it("orders explicit erasure with pending writes and keeps the established next-write behavior", async () => {
    const first = ledger.append(record);
    const wipe = ledger.wipe();
    const next = ledger.append({ kind: "synthetic.after-explicit-wipe", detail: {} });
    await Promise.all([first, wipe, next]);
    expect(await ledger.verify()).toEqual({ status: "intact", entries: 1 });
    expect((await ledger.read()).map(entry => [entry.seq, entry.kind])).toEqual([[0, "synthetic.after-explicit-wipe"]]);
  });
});
