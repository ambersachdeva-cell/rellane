import {
  isPrivateControlKeyMaterial,
  type DaemonDurableSpaceLockAcknowledgement,
  type DaemonDurableSpaceLockRequest,
  type DaemonDurableSpaceUnlockAcknowledgement,
  type DaemonDurableSpaceUnlockRequest
} from "@cadrane/contracts/daemon-control";
import { CanonicalDurableIdSchema } from "@cadrane/contracts";

const MAX_ACTIVE_SPACES = 32;
const MAX_CONSUMED_CONTROLS = 256;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const NATIVE_TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER = typeof SharedArrayBuffer === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;

export class DurableUnlockSessionError extends Error {
  constructor() {
    super("The durable-space control request was rejected.");
    this.name = "DurableUnlockSessionError";
  }
}

interface ActiveSpaceKey {
  readonly keyId: string;
  readonly key: Uint8Array;
}

export interface ActiveWorkspaceKeyReference {
  readonly spaceId: string;
  readonly keyId: string;
}

/**
 * Holds only daemon-owned copies of unlocked space keys. This intentionally has
 * no storage or work capability: it is the session boundary that later
 * durable-storage work must explicitly consume.
 */
export class DurableUnlockSessionController {
  private readonly active = new Map<string, ActiveSpaceKey>();
  private readonly consumedRequestIds = new Set<string>();
  private readonly consumedUnlockBindings = new Set<string>();

  constructor(private readonly daemonSessionId: string) {
    if (!CanonicalDurableIdSchema.safeParse(daemonSessionId).success) {
      throw new DurableUnlockSessionError();
    }
  }

  unlock(
    request: DaemonDurableSpaceUnlockRequest
  ): DaemonDurableSpaceUnlockAcknowledgement {
    const received = request.payload.keyMaterial;
    let owned: Uint8Array | null = null;
    try {
      this.assertSession(request.payload.daemonSessionId);
      if (!isPrivateControlKeyMaterial(received)) {
        throw new DurableUnlockSessionError();
      }
      const existing = this.active.get(request.payload.spaceId);
      if (existing !== undefined || this.active.size >= MAX_ACTIVE_SPACES) {
        throw new DurableUnlockSessionError();
      }
      this.assertRequestAvailable(request.requestId);
      this.assertUnlockBindingAvailable(request.payload);
      owned = copyNativeUint8Array(received);
      this.commitRequest(request.requestId);
      this.commitUnlockBinding(request.payload);
      this.active.set(request.payload.spaceId, {
        keyId: request.payload.keyId,
        key: owned
      });
      owned = null;
      return {
        unlocked: true,
        daemonSessionId: this.daemonSessionId,
        spaceId: request.payload.spaceId,
        keyId: request.payload.keyId
      };
    } finally {
      wipeRecognizableKeyMaterial(received);
      if (owned !== null) {
        wipeRecognizableKeyMaterial(owned);
      }
    }
  }

  lock(
    request: DaemonDurableSpaceLockRequest
  ): DaemonDurableSpaceLockAcknowledgement {
    this.assertSession(request.payload.daemonSessionId);
    const active = this.active.get(request.payload.spaceId);
    if (active === undefined || active.keyId !== request.payload.keyId) {
      throw new DurableUnlockSessionError();
    }
    this.assertRequestAvailable(request.requestId);
    this.commitRequest(request.requestId);
    wipeRecognizableKeyMaterial(active.key);
    this.active.delete(request.payload.spaceId);
    return {
      locked: true,
      daemonSessionId: this.daemonSessionId,
      spaceId: request.payload.spaceId,
      keyId: request.payload.keyId
    };
  }

  /**
   * Private daemon-only key use. The caller receives a short-lived owned copy;
   * it is wiped immediately after the callback settles and is never returned.
   */
  async withOnlyUnlockedKey<T>(
    callback: (
      reference: ActiveWorkspaceKeyReference,
      keyMaterial: Uint8Array
    ) => T | Promise<T>
  ): Promise<T> {
    if (this.active.size !== 1) {
      throw new DurableUnlockSessionError();
    }
    const entry = this.active.entries().next().value as
      | [string, ActiveSpaceKey]
      | undefined;
    if (entry === undefined) {
      throw new DurableUnlockSessionError();
    }
    const [spaceId, active] = entry;
    const key = copyNativeUint8Array(active.key);
    try {
      return await callback(
        Object.freeze({ spaceId, keyId: active.keyId }),
        key
      );
    } finally {
      wipeRecognizableKeyMaterial(key);
    }
  }

  shutdown(): void {
    for (const active of this.active.values()) {
      wipeRecognizableKeyMaterial(active.key);
    }
    this.active.clear();
    this.consumedRequestIds.clear();
    this.consumedUnlockBindings.clear();
  }

  /** Test-only observability without disclosing key material. */
  get activeCount(): number {
    return this.active.size;
  }

  private assertSession(sessionId: string): void {
    if (sessionId !== this.daemonSessionId) {
      throw new DurableUnlockSessionError();
    }
  }

  private assertRequestAvailable(requestId: string): void {
    if (
      this.consumedRequestIds.has(requestId) ||
      this.consumedRequestIds.size >= MAX_CONSUMED_CONTROLS
    ) {
      throw new DurableUnlockSessionError();
    }
  }

  private commitRequest(requestId: string): void {
    this.consumedRequestIds.add(requestId);
  }

  private assertUnlockBindingAvailable(payload: {
    readonly daemonSessionId: string;
    readonly spaceId: string;
    readonly keyId: string;
  }): void {
    const binding = `${payload.daemonSessionId}:${payload.spaceId}:${payload.keyId}`;
    if (
      this.consumedUnlockBindings.has(binding) ||
      this.consumedUnlockBindings.size >= MAX_CONSUMED_CONTROLS
    ) {
      throw new DurableUnlockSessionError();
    }
  }

  private commitUnlockBinding(payload: {
    readonly daemonSessionId: string;
    readonly spaceId: string;
    readonly keyId: string;
  }): void {
    this.consumedUnlockBindings.add(bindingFor(payload));
  }
}

/** Best-effort wiping for native typed arrays received before schema success. */
export function wipeRecognizableKeyMaterial(value: unknown): void {
  const details = nativeTypedArrayDetails(value);
  if (details === undefined || isSharedBuffer(details.buffer)) return;
  try {
    Uint8Array.prototype.fill.call(value as Uint8Array, 0);
  } catch {
    // Never throw while handling untrusted control input.
  }
}

function copyNativeUint8Array(value: Uint8Array): Uint8Array {
  const source = nativeTypedArrayDetails(value);
  if (source === undefined) throw new DurableUnlockSessionError();
  let copied: Uint8Array | undefined;
  try {
    copied = new Uint8Array(value);
    const copiedDetails = nativeTypedArrayDetails(copied);
    if (copiedDetails === undefined || copiedDetails.byteLength !== source.byteLength) {
      throw new DurableUnlockSessionError();
    }
    return copied;
  } catch {
    if (copied !== undefined) wipeRecognizableKeyMaterial(copied);
    throw new DurableUnlockSessionError();
  }
}

function bindingFor(payload: {
  readonly daemonSessionId: string;
  readonly spaceId: string;
  readonly keyId: string;
}): string {
  return `${payload.daemonSessionId}:${payload.spaceId}:${payload.keyId}`;
}

function nativeTypedArrayDetails(value: unknown): { buffer: unknown; byteLength: number } | undefined {
  if (NATIVE_TYPED_ARRAY_BUFFER_GETTER === undefined || NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined) return undefined;
  try {
    const buffer = NATIVE_TYPED_ARRAY_BUFFER_GETTER.call(value);
    const byteLength = NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
    return typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0
      ? { buffer, byteLength }
      : undefined;
  } catch {
    return undefined;
  }
}

function isSharedBuffer(value: unknown): boolean {
  if (NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined) return false;
  try {
    const byteLength = NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER.call(value);
    return typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0;
  } catch {
    return false;
  }
}
