import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CanonicalDurableIdSchema } from "@cadrane/contracts";

const WORKSPACE_KEY_SCHEMA_VERSION = 1 as const;
const INNER_WORKSPACE_KEY_DOMAIN = "switchboard/workspace-key-inner/v1" as const;
const OUTER_WORKSPACE_KEY_DOMAIN = "switchboard/workspace-key-record/v1" as const;
const WRAPPING_PLATFORM = "darwin" as const;
const WRAPPING_MECHANISM = "electron-safe-storage" as const;
const KEY_BYTES = 32;
const MAX_WRAPPED_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const OUTER_FIELDS = ["schemaVersion", "domain", "platform", "wrapping", "spaceId", "keyId", "wrappedKey", "recordSha256"] as const;
const INNER_FIELDS = ["schemaVersion", "domain", "spaceId", "keyId", "key"] as const;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const NATIVE_TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER = typeof SharedArrayBuffer === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;
const NATIVE_TYPED_ARRAY_FILL = TYPED_ARRAY_PROTOTYPE.fill;

/** Minimal injected boundary; this API deliberately has no plaintext-encryption opt-in. */
export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
}

export interface WrappedWorkspaceKeyRecord {
  readonly schemaVersion: typeof WORKSPACE_KEY_SCHEMA_VERSION;
  readonly domain: typeof OUTER_WORKSPACE_KEY_DOMAIN;
  readonly platform: typeof WRAPPING_PLATFORM;
  readonly wrapping: typeof WRAPPING_MECHANISM;
  readonly spaceId: string;
  readonly keyId: string;
  /** Canonical base64url of safe-storage ciphertext, never plaintext key material. */
  readonly wrappedKey: string;
  /** Corruption triage only; authority remains safe-storage decryption and inner bindings. */
  readonly recordSha256: string;
}

/** Store implementations must atomically reject an already-present exact key record. */
export interface WrappedWorkspaceKeyStore {
  createNoClobber(record: WrappedWorkspaceKeyRecord): boolean | Promise<boolean>;
  read(spaceId: string, keyId: string): WrappedWorkspaceKeyRecord | undefined | Promise<WrappedWorkspaceKeyRecord | undefined>;
}

export class FileWrappedWorkspaceKeyStore implements WrappedWorkspaceKeyStore {
  private readonly directory: string;
  private readonly filePath: string;

  constructor(dataDirectory: string, fileName = "automation-workspace-key-v1.json") {
    this.directory = path.join(dataDirectory, "cadrane-secure");
    this.filePath = path.join(this.directory, fileName);
  }

  async createNoClobber(record: WrappedWorkspaceKeyRecord): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      this.directory,
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`
    );
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    );
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();

      /**
       * `link` rather than `stat`-then-`rename`.
       *
       * The check-then-act was a TOCTOU against a `rename` that **overwrites
       * unconditionally**: two concurrent initialisations both passed the
       * `stat`, both renamed, and the second silently replaced the first —
       * destroying a workspace key and with it every record encrypted under it.
       * The method is named `createNoClobber` and could clobber.
       *
       * `link` is the POSIX primitive for exactly this: it creates the name or
       * fails with EEXIST, atomically, with no window in between.
       */
      try {
        await link(temporary, this.filePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return false;
        }
        throw error;
      }
    } finally {
      await handle.close().catch(() => undefined);
      const { unlink } = await import("node:fs/promises");
      await unlink(temporary).catch(() => undefined);
    }
  }

  async read(
    spaceId: string,
    keyId: string
  ): Promise<WrappedWorkspaceKeyRecord | undefined> {
    const record = await this.readExisting();
    return record?.spaceId === spaceId && record.keyId === keyId
      ? record
      : undefined;
  }

  async reference(
    spaceId: string
  ): Promise<WorkspaceKeyReference | undefined> {
    const record = await this.readExisting();
    return record?.spaceId === spaceId
      ? Object.freeze({ spaceId: record.spaceId, keyId: record.keyId })
      : undefined;
  }

  private async readExisting(): Promise<WrappedWorkspaceKeyRecord | undefined> {
    try {
      const detail = await stat(this.filePath);
      if (!detail.isFile() || detail.size <= 0 || detail.size > MAX_WRAPPED_BYTES * 4) {
        throw recoveryRequired();
      }
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isStrictOuterRecord(parsed)) throw recoveryRequired();
      return parsed;
    } catch (error) {
      if (isMissing(error)) return undefined;
      if (error instanceof WorkspaceKeyBrokerError) throw error;
      throw recoveryRequired();
    }
  }
}

export interface WorkspaceKeyBrokerEntropy {
  randomBytes(byteLength: number): Uint8Array;
  randomId(): string;
}

export interface WorkspaceKeyBrokerOptions {
  readonly platform?: string;
  readonly safeStorage: SafeStorageAdapter;
  readonly store: WrappedWorkspaceKeyStore;
  readonly entropy?: WorkspaceKeyBrokerEntropy;
}

export interface WorkspaceKeyReference {
  readonly spaceId: string;
  readonly keyId: string;
}

export type WorkspaceKeyBrokerErrorCode =
  | "UNAVAILABLE"
  | "ALREADY_EXISTS"
  | "CREATE_FAILED"
  | "RECOVERY_REQUIRED";

/** Content-free errors: callers must never receive key, store, adapter, or path details. */
export class WorkspaceKeyBrokerError extends Error {
  readonly code: WorkspaceKeyBrokerErrorCode;

  constructor(code: WorkspaceKeyBrokerErrorCode) {
    super(messageFor(code));
    this.name = "WorkspaceKeyBrokerError";
    this.code = code;
  }
}

/**
 * Private main-process workspace-key boundary. It is intentionally not exported
 * from a barrel or wired to IPC/preload. The adapter's decrypted string is an
 * unavoidable immutable JavaScript residual; all mutable byte copies are wiped.
 */
export class WorkspaceKeyBroker {
  private readonly platform: string;
  private readonly safeStorage: SafeStorageAdapter;
  private readonly store: WrappedWorkspaceKeyStore;
  private readonly entropy: WorkspaceKeyBrokerEntropy;

  constructor(options: WorkspaceKeyBrokerOptions) {
    this.platform = options.platform ?? process.platform;
    this.safeStorage = options.safeStorage;
    this.store = options.store;
    this.entropy = options.entropy ?? defaultEntropy;
  }

  async createWorkspaceKey(spaceId: string): Promise<WorkspaceKeyReference> {
    let entropySource: Uint8Array | undefined;
    let keyMaterial: Uint8Array | undefined;
    let adapterCiphertext: Uint8Array | undefined;
    let wrappedBytes: Uint8Array | undefined;
    try {
      this.requireAvailable();
      if (!isCanonicalDurableId(spaceId)) throw createFailed();

      const keyId = this.entropy.randomId();
      if (!isCanonicalDurableId(keyId)) throw createFailed();
      entropySource = this.entropy.randomBytes(KEY_BYTES);
      keyMaterial = snapshotExactBytes(entropySource, KEY_BYTES);
      const inner = canonicalInnerEnvelope(spaceId, keyId, keyMaterial);
      // `inner` is immutable text containing the key; safeStorage only accepts text.
      adapterCiphertext = this.safeStorage.encryptString(inner);
      wrappedBytes = snapshotBoundedBytes(adapterCiphertext, MAX_WRAPPED_BYTES, false);
      const unsignedRecord = {
        schemaVersion: WORKSPACE_KEY_SCHEMA_VERSION,
        domain: OUTER_WORKSPACE_KEY_DOMAIN,
        platform: WRAPPING_PLATFORM,
        wrapping: WRAPPING_MECHANISM,
        spaceId,
        keyId,
        wrappedKey: canonicalBase64UrlFromBytes(wrappedBytes)
      } as const;
      const record = Object.freeze({
        ...unsignedRecord,
        recordSha256: outerRecordSha256(unsignedRecord)
      });
      const created = await this.store.createNoClobber(record);
      if (created !== true) throw alreadyExists();
      return Object.freeze({ spaceId, keyId });
    } catch (error) {
      if (error instanceof WorkspaceKeyBrokerError) throw error;
      throw createFailed();
    } finally {
      wipe(adapterCiphertext);
      wipe(wrappedBytes);
      wipe(keyMaterial);
      wipe(entropySource);
    }
  }

  /**
   * The callback receives an ephemeral copy and this method always resolves to
   * void, so the broker itself can never return key material.
   */
  async withUnlockedKey(
    reference: WorkspaceKeyReference,
    callback: (keyMaterial: Uint8Array) => void | Promise<void>
  ): Promise<void> {
    let decodedWrapped: Uint8Array | undefined;
    let adapterInput: Uint8Array | undefined;
    let decodedKey: Uint8Array | undefined;
    let callbackKey: Uint8Array | undefined;
    let enteredCallback = false;
    try {
      this.requireAvailable();
      if (!isWorkspaceKeyReference(reference)) throw recoveryRequired();
      const record = await this.store.read(reference.spaceId, reference.keyId);
      if (!isStrictOuterRecord(record) || !constantTimeStringEquals(outerRecordSha256(record), record.recordSha256) ||
        record.spaceId !== reference.spaceId || record.keyId !== reference.keyId) {
        throw recoveryRequired();
      }
      decodedWrapped = decodeCanonicalBase64Url(record.wrappedKey, MAX_WRAPPED_BYTES, false);
      adapterInput = snapshotBoundedBytes(decodedWrapped, MAX_WRAPPED_BYTES, false);
      // Adapter plaintext is immutable text; validate it before ever exposing key bytes.
      const innerText = this.safeStorage.decryptString(adapterInput);
      const inner = parseCanonicalInnerEnvelope(innerText);
      if (inner.spaceId !== reference.spaceId || inner.keyId !== reference.keyId ||
        inner.spaceId !== record.spaceId || inner.keyId !== record.keyId) {
        throw recoveryRequired();
      }
      decodedKey = decodeCanonicalBase64Url(inner.key, KEY_BYTES, true);
      callbackKey = snapshotExactBytes(decodedKey, KEY_BYTES);
      enteredCallback = true;
      await callback(callbackKey);
    } catch (error) {
      if (enteredCallback) throw error;
      if (error instanceof WorkspaceKeyBrokerError && error.code === "UNAVAILABLE") throw error;
      throw recoveryRequired();
    } finally {
      wipe(callbackKey);
      wipe(decodedKey);
      wipe(adapterInput);
      wipe(decodedWrapped);
    }
  }

  private requireAvailable(): void {
    try {
      if (this.platform !== "darwin" || this.safeStorage.isEncryptionAvailable() !== true) {
        throw unavailable();
      }
    } catch (error) {
      if (error instanceof WorkspaceKeyBrokerError) throw error;
      throw unavailable();
    }
  }
}

const defaultEntropy: WorkspaceKeyBrokerEntropy = Object.freeze({
  randomBytes,
  randomId: randomUUID
});

function canonicalInnerEnvelope(spaceId: string, keyId: string, keyMaterial: Uint8Array): string {
  let keyCopy: Uint8Array | undefined;
  try {
    keyCopy = snapshotExactBytes(keyMaterial, KEY_BYTES);
    return JSON.stringify({
      schemaVersion: WORKSPACE_KEY_SCHEMA_VERSION,
      domain: INNER_WORKSPACE_KEY_DOMAIN,
      spaceId,
      keyId,
      key: canonicalBase64UrlFromBytes(keyCopy)
    });
  } finally {
    wipe(keyCopy);
  }
}

function parseCanonicalInnerEnvelope(value: unknown): { spaceId: string; keyId: string; key: string } {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) throw recoveryRequired();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    throw recoveryRequired();
  }
  if (!hasExactDataFields(parsed, INNER_FIELDS) || parsed.schemaVersion !== WORKSPACE_KEY_SCHEMA_VERSION ||
    parsed.domain !== INNER_WORKSPACE_KEY_DOMAIN || !isCanonicalDurableId(parsed.spaceId) ||
    !isCanonicalDurableId(parsed.keyId) || !isCanonicalKeyString(parsed.key) ||
    JSON.stringify(parsed) !== value) {
    throw recoveryRequired();
  }
  return { spaceId: parsed.spaceId, keyId: parsed.keyId, key: parsed.key };
}

function isStrictOuterRecord(value: unknown): value is WrappedWorkspaceKeyRecord {
  return hasExactDataFields(value, OUTER_FIELDS) && value.schemaVersion === WORKSPACE_KEY_SCHEMA_VERSION &&
    value.domain === OUTER_WORKSPACE_KEY_DOMAIN && value.platform === WRAPPING_PLATFORM &&
    value.wrapping === WRAPPING_MECHANISM && isCanonicalDurableId(value.spaceId) &&
    isCanonicalDurableId(value.keyId) && isCanonicalWrappedKeyString(value.wrappedKey) &&
    typeof value.recordSha256 === "string" && SHA256_PATTERN.test(value.recordSha256);
}

function isWorkspaceKeyReference(value: unknown): value is WorkspaceKeyReference {
  return hasExactDataFields(value, ["spaceId", "keyId"]) && isCanonicalDurableId(value.spaceId) &&
    isCanonicalDurableId(value.keyId);
}

function isCanonicalDurableId(value: unknown): value is string {
  return CanonicalDurableIdSchema.safeParse(value).success;
}

function isCanonicalKeyString(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 43 || !BASE64URL_PATTERN.test(value)) return false;
  try {
    const decoded = decodeCanonicalBase64Url(value, KEY_BYTES, true);
    wipe(decoded);
    return true;
  } catch (_error) {
    return false;
  }
}

function isCanonicalWrappedKeyString(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_WRAPPED_BYTES * 2 || !BASE64URL_PATTERN.test(value)) {
    return false;
  }
  try {
    const decoded = decodeCanonicalBase64Url(value, MAX_WRAPPED_BYTES, false);
    wipe(decoded);
    return true;
  } catch (_error) {
    return false;
  }
}

function decodeCanonicalBase64Url(value: string, maxBytes: number, exactLength: boolean): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) throw recoveryRequired();
  const decoded = Buffer.from(value, "base64url");
  try {
    if (decoded.byteLength === 0 || decoded.byteLength > maxBytes || (exactLength && decoded.byteLength !== maxBytes) ||
      decoded.toString("base64url") !== value) {
      throw recoveryRequired();
    }
    return new Uint8Array(decoded);
  } finally {
    wipe(decoded);
  }
}

function canonicalBase64UrlFromBytes(value: Uint8Array): string {
  let copied: Uint8Array | undefined;
  let encoded: Buffer | undefined;
  try {
    copied = snapshotBoundedBytes(value, MAX_WRAPPED_BYTES, false);
    encoded = Buffer.allocUnsafe(copied.byteLength);
    encoded.set(copied);
    return encoded.toString("base64url");
  } finally {
    wipe(encoded);
    wipe(copied);
  }
}

function outerRecordSha256(record: Omit<WrappedWorkspaceKeyRecord, "recordSha256"> | WrappedWorkspaceKeyRecord): string {
  const hash = createHash("sha256");
  hash.update("switchboard/workspace-key-record-sha256/v1", "ascii");
  updateLengthPrefixedField(hash, "schemaVersion", String(record.schemaVersion));
  updateLengthPrefixedField(hash, "domain", record.domain);
  updateLengthPrefixedField(hash, "platform", record.platform);
  updateLengthPrefixedField(hash, "wrapping", record.wrapping);
  updateLengthPrefixedField(hash, "spaceId", record.spaceId);
  updateLengthPrefixedField(hash, "keyId", record.keyId);
  updateLengthPrefixedField(hash, "wrappedKey", record.wrappedKey);
  return hash.digest("hex");
}

function updateLengthPrefixedField(hash: ReturnType<typeof createHash>, name: string, value: string): void {
  let header: Buffer | undefined;
  try {
    header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(Buffer.byteLength(name, "utf8"));
    hash.update(header);
    hash.update(name, "utf8");
    header.writeUInt32BE(Buffer.byteLength(value, "utf8"));
    hash.update(header);
    hash.update(value, "utf8");
  } finally {
    wipe(header);
  }
}

function constantTimeStringEquals(actualValue: string, expectedValue: string): boolean {
  if (!SHA256_PATTERN.test(actualValue) || !SHA256_PATTERN.test(expectedValue)) return false;
  const actual = Buffer.from(actualValue, "ascii");
  const expected = Buffer.from(expectedValue, "ascii");
  try {
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  } finally {
    wipe(actual);
    wipe(expected);
  }
}

function snapshotExactBytes(value: unknown, expectedBytes: number): Uint8Array {
  const snapshot = snapshotBoundedBytes(value, expectedBytes, true);
  if (snapshot.byteLength !== expectedBytes) {
    wipe(snapshot);
    throw new TypeError("Invalid byte length.");
  }
  return snapshot;
}

function snapshotBoundedBytes(value: unknown, maxBytes: number, exactLength: boolean): Uint8Array {
  const details = nativeTypedArrayDetails(value);
  if (details === undefined || isSharedArrayBuffer(details.buffer) || details.byteLength === 0 || details.byteLength > maxBytes ||
    (exactLength && details.byteLength !== maxBytes)) {
    throw new TypeError("Invalid byte input.");
  }
  let copied: Uint8Array | undefined;
  try {
    copied = new Uint8Array(value as Uint8Array);
    const copiedDetails = nativeTypedArrayDetails(copied);
    if (copiedDetails === undefined || copiedDetails.byteLength !== details.byteLength) throw new TypeError("Byte snapshot mismatch.");
    return new Uint8Array(copied);
  } finally {
    wipe(copied);
  }
}

function nativeTypedArrayDetails(value: unknown): { readonly buffer: unknown; readonly byteLength: number } | undefined {
  if (!(value instanceof Uint8Array) || NATIVE_TYPED_ARRAY_BUFFER_GETTER === undefined || NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined) {
    return undefined;
  }
  try {
    const buffer = NATIVE_TYPED_ARRAY_BUFFER_GETTER.call(value);
    const byteLength = NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
    return typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0
      ? { buffer, byteLength }
      : undefined;
  } catch (_error) {
    return undefined;
  }
}

function isSharedArrayBuffer(value: unknown): boolean {
  if (NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined) return false;
  try {
    const byteLength = NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER.call(value);
    return typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0;
  } catch (_error) {
    return false;
  }
}

function hasExactDataFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) return false;
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor !== undefined && Object.hasOwn(descriptor, "value");
  });
}

function wipe(value: Uint8Array | undefined): void {
  try {
    if (value instanceof Uint8Array) NATIVE_TYPED_ARRAY_FILL.call(value, 0);
  } catch (_error) {
    // A hostile adapter byte object cannot prevent cleanup of broker-owned copies.
  }
}

function unavailable(): WorkspaceKeyBrokerError {
  return new WorkspaceKeyBrokerError("UNAVAILABLE");
}

function alreadyExists(): WorkspaceKeyBrokerError {
  return new WorkspaceKeyBrokerError("ALREADY_EXISTS");
}

function createFailed(): WorkspaceKeyBrokerError {
  return new WorkspaceKeyBrokerError("CREATE_FAILED");
}

function recoveryRequired(): WorkspaceKeyBrokerError {
  return new WorkspaceKeyBrokerError("RECOVERY_REQUIRED");
}

function messageFor(code: WorkspaceKeyBrokerErrorCode): string {
  switch (code) {
    case "UNAVAILABLE": return "Workspace-key protection is unavailable.";
    case "ALREADY_EXISTS": return "A workspace key already exists.";
    case "CREATE_FAILED": return "Workspace-key creation failed.";
    case "RECOVERY_REQUIRED": return "Workspace-key recovery is required.";
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
