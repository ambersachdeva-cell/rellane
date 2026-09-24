/**
 * The ledger: an encrypted, append-only, tamper-evident record of everything
 * Rellane did to someone's files.
 *
 * Receipts previously lived in memory and died with the process, which meant
 * the honest answer to "what did this thing do to my Downloads folder last
 * Tuesday" was that nobody knows. For software whose entire pitch is that it
 * acts on your behalf, that is the wrong answer, and it gets worse rather than
 * better once a second person is paying for it.
 *
 * Three properties, and it is worth being precise about which is which, because
 * "encrypted" and "tamper-proof" get used interchangeably by people selling
 * things and they are not the same claim.
 *
 *   Confidential — every entry is sealed with AES-256-GCM before it touches
 *   the disk. The filing plan for a folder of client quotes names those
 *   clients; a plaintext audit log is a data leak wearing a compliance hat.
 *
 *   Tamper-EVIDENT — each entry carries an HMAC-SHA256 over its own contents
 *   *and the previous entry's MAC*. Changing any historical entry, deleting one
 *   from the middle, or reordering two of them breaks the chain from that point
 *   forward, and `verify` reports the exact sequence number where it broke.
 *   Note the word: evident, not proof. We detect edits, we do not prevent them.
 *
 *   Anchored — the head MAC and entry count are kept in the Keychain-backed
 *   secret store, not in the ledger file. This closes the obvious hole in
 *   hash-chaining: an attacker who can rewrite the whole file could otherwise
 *   just rebuild a consistent chain from scratch. To do that undetected they
 *   now need the ledger key as well, which lives in the Keychain.
 *
 * The two keys are derived separately through HKDF, one for encryption and one
 * for authentication, rather than using the root key for both. That is standard
 * practice and costs nothing.
 *
 * What this does NOT defend against, stated plainly because the alternative is
 * marketing: code already running as this user can ask the Keychain for the
 * ledger key exactly as we do, and with the key it can forge a clean chain and
 * a matching anchor. The bar this clears is Amber's actual bar — a copied
 * ledger file is unreadable, and editing history in place requires real access
 * to the machine rather than a text editor.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { plural, verb } from "../../shared/copy.js";
import type { SecretStore } from "./secrets.js";

const GENESIS = "0".repeat(64);
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Anchor keys, kept beside the other secrets so they inherit the Keychain. */
const ANCHOR_HEAD = "ledger.anchor.head";
const ANCHOR_COUNT = "ledger.anchor.count";
const LEDGER_KEY = "ledger.key";

export interface LedgerRecord {
  /** What happened: "skill.run", "skill.undo", "outbound.approved". */
  readonly kind: string;
  /**
   * The real detail — actual folder names, actual counts.
   *
   * Not redacted, deliberately. The ledger exists so its owner can answer "what
   * happened to my Downloads folder last Tuesday", and a redacted ledger cannot
   * answer that. It is safe to hold the real thing here because it is encrypted
   * at rest and never leaves the machine.
   *
   * Redaction belongs to the diagnostics bundle instead, which is the path
   * where data actually goes somewhere. Nothing from here is copied into it —
   * that bundle carries only the integrity verdict, never entry contents.
   */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface SealedRecord extends LedgerRecord {
  readonly seq: number;
  readonly at: string;
  /** MAC of the entry before this one; GENESIS for the first. */
  readonly prev: string;
  readonly mac: string;
}

export type Integrity =
  | { readonly status: "intact"; readonly entries: number }
  /** An entry's contents no longer match its MAC. */
  | { readonly status: "altered"; readonly atSeq: number }
  /** The chain is self-consistent but shorter than what the Keychain recorded. */
  | { readonly status: "truncated"; readonly expected: number; readonly found: number }
  /** A write reached the file but its checkpoint does not cover it. */
  | { readonly status: "ahead"; readonly expected: number; readonly found: number }
  /** Self-consistent and the right length, but not the chain we anchored. */
  | { readonly status: "substituted" }
  /** A line would not decrypt. This verdict does not establish the cause. */
  | { readonly status: "unreadable"; readonly atLine: number }
  | { readonly status: "unavailable"; readonly reason: "file" | "key-store" | "key" | "anchor" };

export interface LedgerSnapshot {
  readonly integrity: Integrity;
  /** Only an entirely verified snapshot can supply authoritative action rows. */
  readonly records: readonly SealedRecord[];
}

type LedgerSecrets = Pick<SecretStore, "getForVerification" | "set" | "delete">;
interface LedgerKeys { readonly macKey: Buffer; readonly encKey: Buffer }
interface LedgerState extends LedgerSnapshot {
  readonly keys: LedgerKeys | null;
  readonly head: string;
  readonly count: number;
}

export class LedgerUnavailable extends Error {
  constructor(readonly integrity: Integrity) {
    super(`Action history could not be verified, so no new receipt was written. ${describeIntegrity(integrity)}`);
    this.name = "LedgerUnavailable";
  }
}

/**
 * Stable serialisation for the MAC.
 *
 * `JSON.stringify` preserves insertion order, so two objects with identical
 * contents but different key order would produce different MACs and a ledger
 * that fails to verify itself for no reason. Sorting keys removes that.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${entries.join(",")}}`;
}

export class Ledger {
  private readonly file: string;
  private readonly secrets: LedgerSecrets;
  /** Inspection, appends and explicit erasure share one ordering in this process. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(directory: string, secrets: LedgerSecrets) {
    this.file = join(directory, "ledger.jsonl");
    this.secrets = secrets;
  }

  /**
   * Records one entry and returns it sealed.
   *
   * Appends are queued rather than concurrent. Two skills finishing at the same
   * moment would otherwise read the same head MAC and write two entries both
   * claiming the same predecessor, which is indistinguishable from tampering
   * when the chain is next verified.
   */
  async append(record: LedgerRecord, now = Date.now()): Promise<SealedRecord> {
    // Snapshot caller-owned data now. JSON normalization also makes the stored
    // representation and its MAC agree (for example, for Date-valued detail).
    const copy = copyRecord(record);
    const at = new Date(now).toISOString();
    return this.queue(() => this.appendNow(copy, at));
  }

  private async appendNow(record: LedgerRecord, at: string): Promise<SealedRecord> {
    const state = await inspectLedger(this.file, this.secrets);
    if (state.integrity.status !== "intact") throw new LedgerUnavailable(state.integrity);
    let keys = state.keys;
    if (keys === null) {
      // inspectLedger allows this only for empty history with no key or anchor.
      // A failed check never mints or rotates an existing history's key.
      const root = randomBytes(32).toString("base64");
      await this.secrets.set(LEDGER_KEY, root);
      keys = deriveKeys(Buffer.from(root, "base64"));
    }
    const { macKey, encKey } = keys;
    const body = { seq: state.count, at, kind: record.kind, detail: record.detail, prev: state.head };
    const mac = createHmac("sha256", macKey).update(canonical(body)).digest("hex");
    const sealed: SealedRecord = { ...body, mac };

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", encKey, iv);
    const payload = Buffer.concat([cipher.update(JSON.stringify(sealed), "utf8"), cipher.final()]);
    const line = Buffer.concat([iv, cipher.getAuthTag(), payload]).toString("base64");

    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${line}\n`, { mode: 0o600 });

    // Anchor last. A failed/interrupted update is detected on the next read and
    // blocks another append. Never silently adopt the file as the new anchor.
    await this.secrets.set(ANCHOR_HEAD, mac);
    await this.secrets.set(ANCHOR_COUNT, String(state.count + 1));
    return sealed;
  }

  /** The entries and their verdict come from the same non-mutating inspection. */
  async snapshot(): Promise<LedgerSnapshot> {
    return this.queue(async () => {
      const { records, integrity } = await inspectLedger(this.file, this.secrets);
      return { records, integrity };
    });
  }

  /** No partial or unanchored history is passed off as authoritative records. */
  async read(): Promise<readonly SealedRecord[]> {
    return (await this.snapshot()).records;
  }

  /**
   * Walks the chain and says what, if anything, is wrong with it.
   *
   * Deliberately returns a verdict rather than throwing. A damaged ledger is
   * something to tell the owner about in plain words, not an exception that
   * takes down the app that was trying to read it.
   */
  async verify(): Promise<Integrity> {
    return (await this.snapshot()).integrity;
  }

  /** Forgets everything, anchor included. Used by "delete my data". */
  async wipe(): Promise<void> {
    return this.queue(async () => {
      await rm(this.file, { force: true });
      await this.secrets.delete(ANCHOR_HEAD);
      await this.secrets.delete(ANCHOR_COUNT);
    });
  }

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

/** Keep the established v1 encryption and authentication derivation unchanged. */
function deriveKeys(material: Buffer): LedgerKeys {
  return {
    encKey: Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), "cadrane.ledger.enc.v1", 32)),
    macKey: Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), "cadrane.ledger.mac.v1", 32))
  };
}

function copyRecord(record: LedgerRecord): LedgerRecord {
  const parsed: unknown = JSON.parse(JSON.stringify(record));
  if (!plainObject(parsed) || typeof parsed["kind"] !== "string" || parsed["kind"].length === 0 ||
    !plainObject(parsed["detail"])) throw new Error("The action record has an invalid shape.");
  return { kind: parsed["kind"], detail: parsed["detail"] };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read-only, including on first launch and with a missing/unreadable key. */
async function inspectLedger(file: string, secrets: LedgerSecrets): Promise<LedgerState> {
  const refuse = (integrity: Integrity): LedgerState => ({ integrity, records: [], keys: null, head: GENESIS, count: 0 });
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (plainObject(error) && error["code"] === "ENOENT") raw = "";
    else return refuse({ status: "unavailable", reason: "file" });
  }
  let root: string | null;
  let head: string | null;
  let countText: string | null;
  try {
    root = await secrets.getForVerification(LEDGER_KEY);
    head = await secrets.getForVerification(ANCHOR_HEAD);
    countText = await secrets.getForVerification(ANCHOR_COUNT);
  } catch {
    return refuse({ status: "unavailable", reason: "key-store" });
  }
  if ((head === null) !== (countText === null) ||
    (head !== null && !/^[0-9a-f]{64}$/u.test(head)) ||
    (countText !== null && (!/^(0|[1-9][0-9]*)$/u.test(countText) || !Number.isSafeInteger(Number(countText))))) {
    return refuse({ status: "unavailable", reason: "anchor" });
  }
  const anchoredCount = countText === null ? 0 : Number(countText);
  const anchoredHead = head ?? GENESIS;
  if ((anchoredCount === 0) !== (anchoredHead === GENESIS)) {
    return refuse({ status: "unavailable", reason: "anchor" });
  }
  if (root === null) {
    if (raw.length !== 0 || head !== null || countText !== null) return refuse({ status: "unavailable", reason: "key" });
    return { integrity: { status: "intact", entries: 0 }, records: [], keys: null, head: GENESIS, count: 0 };
  }
  const material = Buffer.from(root, "base64");
  if (material.length !== 32 || material.toString("base64") !== root) return refuse({ status: "unavailable", reason: "key" });
  const keys = deriveKeys(material);
  const lines = raw === "" ? [] : raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  // A partially written final line is not extended into a new record.
  if (raw !== "" && !raw.endsWith("\n")) return refuse({ status: "unreadable", atLine: lines.length });
  const records: SealedRecord[] = [];
  let prev = GENESIS;
  for (const [index, line] of lines.entries()) {
    const entry = decryptLine(line, keys.encKey);
    if (entry === null) return refuse({ status: "unreadable", atLine: index + 1 });
    const expected = createHmac("sha256", keys.macKey)
      .update(canonical({ seq: entry.seq, at: entry.at, kind: entry.kind, detail: entry.detail, prev: entry.prev }))
      .digest("hex");
    if (!equalHex(expected, entry.mac) || entry.prev !== prev || entry.seq !== index) {
      return refuse({ status: "altered", atSeq: entry.seq });
    }
    records.push(entry);
    prev = entry.mac;
  }
  if (records.length < anchoredCount) return refuse({ status: "truncated", expected: anchoredCount, found: records.length });
  if (records.length > anchoredCount) return refuse({ status: "ahead", expected: anchoredCount, found: records.length });
  if (prev !== anchoredHead) return refuse({ status: "substituted" });
  return { integrity: { status: "intact", entries: records.length }, records, keys, head: prev, count: records.length };
}

function decryptLine(line: string, encKey: Buffer): SealedRecord | null {
  try {
    const buffer = Buffer.from(line, "base64");
    if (buffer.length <= IV_BYTES + TAG_BYTES || buffer.toString("base64") !== line) {
      return null;
    }
    const decipher = createDecipheriv("aes-256-gcm", encKey, buffer.subarray(0, IV_BYTES));
    decipher.setAuthTag(buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(buffer.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final()
    ]).toString("utf8");
    const entry: unknown = JSON.parse(plain);
    if (!plainObject(entry) || !Number.isSafeInteger(entry["seq"]) || Number(entry["seq"]) < 0 ||
      typeof entry["at"] !== "string" || !Number.isFinite(Date.parse(entry["at"])) ||
      typeof entry["kind"] !== "string" || entry["kind"].length === 0 || !plainObject(entry["detail"]) ||
      typeof entry["prev"] !== "string" || !/^[0-9a-f]{64}$/u.test(entry["prev"]) ||
      typeof entry["mac"] !== "string" || !/^[0-9a-f]{64}$/u.test(entry["mac"])) return null;
    return entry as unknown as SealedRecord;
  } catch {
    // GCM's auth tag already failed, or the line is not ours. Either way it is
    // not a record we can vouch for, so we do not return it as one.
    return null;
  }
}

function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Plain-language verdict for the diagnostics screen. */
export function describeIntegrity(result: Integrity): string {
  switch (result.status) {
    case "intact":
      return result.entries === 0
        ? "Nothing has been recorded yet."
        : `${plural(result.entries, "entry", "entries")}, unbroken.`;
    case "altered":
      return `Entry ${result.atSeq + 1} does not match the recorded chain. This history cannot be verified. Keep the original records.`;
    case "truncated":
      return `${plural(result.expected - result.found, "entry", "entries")} ${verb(result.expected - result.found, "is", "are")} missing from the end of the recorded history. The cause is not established; keep the original records.`;
    case "ahead":
      return `The history contains ${plural(result.found - result.expected, "entry", "entries")} beyond its saved checkpoint. This history cannot be verified; a write may have been interrupted. Keep the original records.`;
    case "substituted":
      return "This history does not match its saved checkpoint. It cannot be verified; keep the original records.";
    case "unreadable":
      return `Entry ${result.atLine} could not be authenticated or read. This history cannot be verified. Keep the original data; do not rely on this record alone to confirm past actions.`;
    case "unavailable": {
      const why = {
        file: "The stored history file could not be read.",
        "key-store": "The protected history keys could not be read.",
        key: "The key needed to verify this history is missing or invalid.",
        anchor: "The saved history checkpoint is incomplete or invalid."
      }[result.reason];
      return `${why} History is unavailable. Keep the original data; no replacement key or history was created.`;
    }
  }
}
