import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceKeyBroker,
  WorkspaceKeyBrokerError,
  type SafeStorageAdapter,
  type WorkspaceKeyBrokerEntropy,
  type WrappedWorkspaceKeyRecord,
  type WrappedWorkspaceKeyStore
} from "./workspace-key-broker.js";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_KEY_ID = "33333333-3333-4333-8333-333333333333";
const FIXED_KEY = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);

describe("WorkspaceKeyBroker creation", () => {
  it("fails closed before entropy or storage when not macOS protected storage", async () => {
    const entropy = fixtureEntropy();
    const store = new MemoryStore();
    const unavailable = new WorkspaceKeyBroker({
      platform: "linux", safeStorage: new SyntheticSafeStorage(true), store, entropy
    });
    await expect(unavailable.createWorkspaceKey(SPACE_ID)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(entropy.randomBytes).not.toHaveBeenCalled();
    expect(store.createNoClobber).not.toHaveBeenCalled();

    const protectedStorageUnavailable = new WorkspaceKeyBroker({
      platform: "darwin", safeStorage: new SyntheticSafeStorage(false), store, entropy
    });
    await expect(protectedStorageUnavailable.createWorkspaceKey(SPACE_ID)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(entropy.randomBytes).not.toHaveBeenCalled();
  });

  it("creates exactly one opaque no-clobber record and clears owned adapter bytes", async () => {
    const adapter = new SyntheticSafeStorage();
    const store = new MemoryStore();
    const entropy = fixtureEntropy();
    const broker = fixtureBroker({ adapter, store, entropy });
    const reference = await broker.createWorkspaceKey(SPACE_ID);

    expect(reference).toEqual({ spaceId: SPACE_ID, keyId: KEY_ID });
    expect(store.createNoClobber).toHaveBeenCalledTimes(1);
    const stored = store.record!;
    expect(Object.keys(stored).sort()).toEqual([
      "domain", "keyId", "platform", "recordSha256", "schemaVersion", "spaceId", "wrappedKey", "wrapping"
    ]);
    expect(JSON.stringify(stored)).not.toContain(Buffer.from(FIXED_KEY).toString("base64url"));
    expect(stored.wrappedKey).not.toContain("{");
    expect(stored).toMatchObject({
      domain: "switchboard/workspace-key-record/v1",
      platform: "darwin",
      wrapping: "electron-safe-storage"
    });
    expect(adapter.lastEncryptOutput).toBeDefined();
    expect(allZero(adapter.lastEncryptOutput!)).toBe(true);
    expect(entropy.lastOutput).toBeDefined();
    expect(allZero(entropy.lastOutput!)).toBe(true);
  });

  it("reports an atomic collision without overwrite or replacement", async () => {
    const store = new MemoryStore(false);
    const entropy = fixtureEntropy();
    const adapter = new SyntheticSafeStorage();
    const broker = fixtureBroker({ store, entropy, adapter });
    await expect(broker.createWorkspaceKey(SPACE_ID)).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    expect(store.createNoClobber).toHaveBeenCalledTimes(1);
    expect(store.record).toBeUndefined();
    expect(allZero(entropy.lastOutput!)).toBe(true);
    expect(allZero(adapter.lastEncryptOutput!)).toBe(true);
  });

  it.each([
    ["malformed entropy bytes", () => new Uint8Array(31)],
    ["shared entropy bytes", () => sharedBytes(32)],
    ["spoofed entropy bytes", () => Object.create(Uint8Array.prototype) as Uint8Array],
    ["malformed adapter bytes", () => new Uint8Array(0)],
    ["shared adapter bytes", () => sharedBytes(12)],
    ["spoofed adapter bytes", () => Object.create(Uint8Array.prototype) as Uint8Array]
  ])("maps %s to a content-free creation failure", async (_name, bytes) => {
    const adapter = new SyntheticSafeStorage();
    const entropy = fixtureEntropy();
    let supplied: Uint8Array | undefined;
    if (_name.includes("entropy")) entropy.randomBytes.mockImplementation(() => {
      supplied = bytes();
      return supplied;
    });
    else adapter.encryptOverride = bytes;
    const store = new MemoryStore();
    const broker = new WorkspaceKeyBroker({ platform: "darwin", safeStorage: adapter, store, entropy });
    await expect(broker.createWorkspaceKey(SPACE_ID)).rejects.toMatchObject({ code: "CREATE_FAILED" });
    expect(store.createNoClobber).not.toHaveBeenCalled();
    if (ArrayBuffer.isView(supplied)) expect(allZero(supplied)).toBe(true);
    if (ArrayBuffer.isView(adapter.lastEncryptOutput)) expect(allZero(adapter.lastEncryptOutput)).toBe(true);
  });

  it("maps encryption and storage exceptions to creation failure without leaking details", async () => {
    const encryptionFailure = new SyntheticSafeStorage();
    encryptionFailure.encryptError = new Error("secret encryption detail");
    const encryptionEntropy = fixtureEntropy();
    await expect(fixtureBroker({ adapter: encryptionFailure, entropy: encryptionEntropy }).createWorkspaceKey(SPACE_ID))
      .rejects.toMatchObject({ code: "CREATE_FAILED", message: "Workspace-key creation failed." });
    expect(allZero(encryptionEntropy.lastOutput!)).toBe(true);

    const store = new MemoryStore();
    store.createError = new Error("private store location");
    const storeEntropy = fixtureEntropy();
    const storeAdapter = new SyntheticSafeStorage();
    await expect(fixtureBroker({ store, entropy: storeEntropy, adapter: storeAdapter }).createWorkspaceKey(SPACE_ID))
      .rejects.toMatchObject({ code: "CREATE_FAILED", message: "Workspace-key creation failed." });
    expect(allZero(storeEntropy.lastOutput!)).toBe(true);
    expect(allZero(storeAdapter.lastEncryptOutput!)).toBe(true);
  });
});

describe("WorkspaceKeyBroker unlock", () => {
  it("gives one fresh ephemeral key to a callback and clears it afterward", async () => {
    const adapter = new SyntheticSafeStorage();
    const store = new MemoryStore();
    const broker = fixtureBroker({ adapter, store });
    const reference = await broker.createWorkspaceKey(SPACE_ID);
    let callbackKey: Uint8Array | undefined;
    await broker.withUnlockedKey(reference, (key) => {
      callbackKey = key;
      expect(key).toEqual(FIXED_KEY);
    });
    expect(callbackKey).toBeDefined();
    expect(allZero(callbackKey!)).toBe(true);
    expect(adapter.lastDecryptInput).toBeDefined();
    expect(allZero(adapter.lastDecryptInput!)).toBe(true);
  });

  it("propagates callback failures only after clearing ephemeral key material", async () => {
    const brokerFixture = initialized();
    const failure = new Error("callback failure");
    let callbackKey: Uint8Array | undefined;
    await expect(brokerFixture.broker.withUnlockedKey(brokerFixture.reference, (key) => {
      callbackKey = key;
      throw failure;
    })).rejects.toBe(failure);
    expect(callbackKey).toBeDefined();
    expect(allZero(callbackKey!)).toBe(true);
  });

  it.each([
    ["missing", (store: MemoryStore) => { store.record = undefined; }],
    ["tampered record digest", (store: MemoryStore) => { store.record = { ...store.record!, recordSha256: "0".repeat(64) }; }],
    ["recomputed swapped outer binding", (store: MemoryStore) => {
      store.record = outerRecord({ ...store.record!, keyId: OTHER_KEY_ID });
      store.read.mockReturnValue(store.record);
    }],
    ["corrupt outer field", (store: MemoryStore) => { store.record = { ...store.record!, extra: true } as unknown as WrappedWorkspaceKeyRecord; }]
  ])("requires recovery for %s outer data without replacement", async (_name, mutate) => {
    const fixture = initialized();
    mutate(fixture.store);
    await expect(fixture.broker.withUnlockedKey(fixture.reference, () => undefined))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED", message: "Workspace-key recovery is required." });
    expect(fixture.store.createNoClobber).not.toHaveBeenCalled();
  });

  it.each([
    ["decrypt failure", (adapter: SyntheticSafeStorage) => { adapter.decryptError = new Error("adapter details"); }],
    ["inner key binding", (adapter: SyntheticSafeStorage) => { adapter.decryptOverride = canonicalInner({ keyId: OTHER_KEY_ID }); }],
    ["wrong inner key length", (adapter: SyntheticSafeStorage) => { adapter.decryptOverride = canonicalInner({ key: Buffer.from([7]).toString("base64url") }); }],
    ["noncanonical inner JSON", (adapter: SyntheticSafeStorage) => { adapter.decryptOverride = ` ${canonicalInner({})}`; }]
  ])("requires recovery for %s without writing a replacement", async (_name, mutate) => {
    const fixture = initialized();
    mutate(fixture.adapter);
    await expect(fixture.broker.withUnlockedKey(fixture.reference, () => undefined))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(fixture.store.createNoClobber).not.toHaveBeenCalled();
    if (fixture.adapter.lastDecryptInput !== undefined) expect(allZero(fixture.adapter.lastDecryptInput)).toBe(true);
  });

  it("maps read failures to recovery without key generation or replacement", async () => {
    const fixture = initialized();
    fixture.store.read.mockImplementation(() => {
      throw new Error("private store failure");
    });
    await expect(fixture.broker.withUnlockedKey(fixture.reference, () => undefined))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED", message: "Workspace-key recovery is required." });
    expect(fixture.store.createNoClobber).not.toHaveBeenCalled();
  });

  it("does not import product runtime and documents the immutable adapter-string residual", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("./workspace-key-broker.ts", import.meta.url), "utf8"));
    expect(source).not.toMatch(/from\s+["']electron["']/);
    expect(source).toContain("immutable JavaScript residual");
  });
});

function initialized(): { broker: WorkspaceKeyBroker; store: MemoryStore; adapter: SyntheticSafeStorage; reference: { spaceId: string; keyId: string } } {
  const adapter = new SyntheticSafeStorage();
  const store = new MemoryStore();
  const broker = fixtureBroker({ adapter, store });
  const reference = { spaceId: SPACE_ID, keyId: KEY_ID };
  const inner = canonicalInner({});
  const bytes = Uint8Array.from(Buffer.from(inner, "utf8"));
  const record: WrappedWorkspaceKeyRecord = {
    ...outerRecord({ wrappedKey: Buffer.from(bytes).toString("base64url") })
  };
  store.record = record;
  // The initialized fixture represents an already atomically-created record.
  store.createNoClobber.mockClear();
  store.createNoClobber.mockReturnValue(true);
  return { broker, store, adapter, reference };
}

function fixtureBroker(options: { adapter?: SyntheticSafeStorage; store?: MemoryStore; entropy?: WorkspaceKeyBrokerEntropy } = {}): WorkspaceKeyBroker {
  return new WorkspaceKeyBroker({
    platform: "darwin",
    safeStorage: options.adapter ?? new SyntheticSafeStorage(),
    store: options.store ?? new MemoryStore(),
    entropy: options.entropy ?? fixtureEntropy()
  });
}

function fixtureEntropy(): WorkspaceKeyBrokerEntropy & { randomBytes: ReturnType<typeof vi.fn>; randomId: ReturnType<typeof vi.fn>; lastOutput: Uint8Array | undefined } {
  const entropy: WorkspaceKeyBrokerEntropy & { randomBytes: ReturnType<typeof vi.fn>; randomId: ReturnType<typeof vi.fn>; lastOutput: Uint8Array | undefined } = {
    lastOutput: undefined,
    randomBytes: vi.fn(() => {
      const output = new Uint8Array(FIXED_KEY);
      entropy.lastOutput = output;
      return output;
    }),
    randomId: vi.fn(() => KEY_ID)
  };
  return entropy;
}

class SyntheticSafeStorage implements SafeStorageAdapter {
  readonly isEncryptionAvailable = vi.fn(() => this.available);
  readonly encryptString = vi.fn((value: string) => {
    if (this.encryptError !== undefined) throw this.encryptError;
    const output = this.encryptOverride?.() ?? Uint8Array.from(Buffer.from(value, "utf8"));
    this.lastEncryptOutput = output;
    return output;
  });
  readonly decryptString = vi.fn((value: Uint8Array) => {
    this.lastDecryptInput = value;
    if (this.decryptError !== undefined) throw this.decryptError;
    return this.decryptOverride ?? Buffer.from(value).toString("utf8");
  });
  available: boolean;
  encryptOverride: (() => Uint8Array) | undefined;
  decryptOverride: string | undefined;
  encryptError: Error | undefined;
  decryptError: Error | undefined;
  lastEncryptOutput: Uint8Array | undefined;
  lastDecryptInput: Uint8Array | undefined;

  constructor(available = true) {
    this.available = available;
  }
}

class MemoryStore implements WrappedWorkspaceKeyStore {
  record: WrappedWorkspaceKeyRecord | undefined;
  createError: Error | undefined;
  readonly createNoClobber = vi.fn((record: WrappedWorkspaceKeyRecord) => {
    if (this.createError !== undefined) throw this.createError;
    if (this.record !== undefined) return false;
    this.record = record;
    return true;
  });
  readonly read = vi.fn((spaceId: string, keyId: string) => {
    if (this.record?.spaceId !== spaceId || this.record.keyId !== keyId) return undefined;
    return this.record;
  });

  constructor(created = true) {
    if (!created) this.createNoClobber.mockReturnValue(false);
  }
}

function canonicalInner(overrides: Partial<{ spaceId: string; keyId: string; key: string }>): string {
  return JSON.stringify({
    schemaVersion: 1,
    domain: "switchboard/workspace-key-inner/v1",
    spaceId: overrides.spaceId ?? SPACE_ID,
    keyId: overrides.keyId ?? KEY_ID,
    key: overrides.key ?? Buffer.from(FIXED_KEY).toString("base64url")
  });
}

function outerRecord(overrides: Partial<Omit<WrappedWorkspaceKeyRecord, "recordSha256">>): WrappedWorkspaceKeyRecord {
  const record = {
    schemaVersion: 1 as const,
    domain: "switchboard/workspace-key-record/v1" as const,
    platform: "darwin" as const,
    wrapping: "electron-safe-storage" as const,
    spaceId: SPACE_ID,
    keyId: KEY_ID,
    wrappedKey: Buffer.from(canonicalInner({}), "utf8").toString("base64url"),
    ...overrides
  };
  return { ...record, recordSha256: outerRecordSha256(record) };
}

function outerRecordSha256(record: Omit<WrappedWorkspaceKeyRecord, "recordSha256">): string {
  const hash = createHash("sha256");
  hash.update("switchboard/workspace-key-record-sha256/v1", "ascii");
  for (const [name, value] of [
    ["schemaVersion", String(record.schemaVersion)], ["domain", record.domain], ["platform", record.platform],
    ["wrapping", record.wrapping], ["spaceId", record.spaceId], ["keyId", record.keyId], ["wrappedKey", record.wrappedKey]
  ] as const) {
    const header = Buffer.allocUnsafe(4);
    try {
      header.writeUInt32BE(Buffer.byteLength(name, "utf8"));
      hash.update(header); hash.update(name, "utf8");
      header.writeUInt32BE(Buffer.byteLength(value, "utf8"));
      hash.update(header); hash.update(value, "utf8");
    } finally {
      header.fill(0);
    }
  }
  return hash.digest("hex");
}

function allZero(value: Uint8Array): boolean {
  return value.every((item) => item === 0);
}

function sharedBytes(length: number): Uint8Array {
  return new Uint8Array(new SharedArrayBuffer(length));
}
