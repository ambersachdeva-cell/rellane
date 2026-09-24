import { z } from "zod";
import { DAEMON_PROTOCOL_VERSION } from "./local-intelligence.js";
import { CanonicalDurableIdSchema } from "./useful-work.js";

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const NATIVE_TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer"
)?.get;
const NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength"
)?.get;
const NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER = typeof SharedArrayBuffer === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;

/**
 * Control key material must be a plain, non-shared native Uint8Array. The
 * cached native accessors reject forged typed-array lookalikes and proxies.
 */
export function isPrivateControlKeyMaterial(value: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    return false;
  }
  try {
    if (Object.getPrototypeOf(value) !== Uint8Array.prototype) {
      return false;
    }
    const details = nativeTypedArrayDetails(value);
    return details !== undefined && details.byteLength === 32 && !isSharedBuffer(details.buffer);
  } catch {
    return false;
  }
}

function nativeTypedArrayDetails(value: unknown): { buffer: unknown; byteLength: number } | undefined {
  if (
    NATIVE_TYPED_ARRAY_BUFFER_GETTER === undefined ||
    NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) return undefined;
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

export const PrivateControlKeyMaterialSchema = z.custom<Uint8Array>(
  isPrivateControlKeyMaterial,
  "Expected a plain non-shared 32-byte Uint8Array."
);

const DaemonControlHeader = {
  protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
  requestId: CanonicalDurableIdSchema
} as const;

/** Full private readiness event, including the new daemon-session authority. */
export const DaemonPrivateReadyEventSchema = z.strictObject({
  protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
  type: z.literal("daemon.ready"),
  pid: z.number().int().positive(),
  daemonSessionId: CanonicalDurableIdSchema
});
export type DaemonPrivateReadyEvent = z.infer<typeof DaemonPrivateReadyEventSchema>;

export const DaemonDurableSpaceUnlockRequestSchema = z.strictObject({
  ...DaemonControlHeader,
  type: z.literal("durable-space.unlock"),
  payload: z.strictObject({
    daemonSessionId: CanonicalDurableIdSchema,
    spaceId: CanonicalDurableIdSchema,
    keyId: CanonicalDurableIdSchema,
    keyMaterial: PrivateControlKeyMaterialSchema
  })
});
export type DaemonDurableSpaceUnlockRequest = z.infer<
  typeof DaemonDurableSpaceUnlockRequestSchema
>;

export const DaemonDurableSpaceLockRequestSchema = z.strictObject({
  ...DaemonControlHeader,
  type: z.literal("durable-space.lock"),
  payload: z.strictObject({
    daemonSessionId: CanonicalDurableIdSchema,
    spaceId: CanonicalDurableIdSchema,
    keyId: CanonicalDurableIdSchema
  })
});
export type DaemonDurableSpaceLockRequest = z.infer<
  typeof DaemonDurableSpaceLockRequestSchema
>;

export const DaemonDurableSpaceUnlockAcknowledgementSchema = z.strictObject({
  unlocked: z.literal(true),
  daemonSessionId: CanonicalDurableIdSchema,
  spaceId: CanonicalDurableIdSchema,
  keyId: CanonicalDurableIdSchema
});
export type DaemonDurableSpaceUnlockAcknowledgement = z.infer<
  typeof DaemonDurableSpaceUnlockAcknowledgementSchema
>;

export const DaemonDurableSpaceLockAcknowledgementSchema = z.strictObject({
  locked: z.literal(true),
  daemonSessionId: CanonicalDurableIdSchema,
  spaceId: CanonicalDurableIdSchema,
  keyId: CanonicalDurableIdSchema
});
export type DaemonDurableSpaceLockAcknowledgement = z.infer<
  typeof DaemonDurableSpaceLockAcknowledgementSchema
>;

/**
 * Main-process to utility-process control contract. This module is available
 * only through the explicit daemon-control package subpath and is deliberately
 * absent from the renderer-facing contracts barrel.
 */
export const DaemonShutdownRequestSchema = z.strictObject({
  ...DaemonControlHeader,
  type: z.literal("daemon.shutdown"),
  payload: z.strictObject({})
});
export type DaemonShutdownRequest = z.infer<
  typeof DaemonShutdownRequestSchema
>;

export const DaemonShutdownAcknowledgementSchema = z.strictObject({
  shutdown: z.literal("clean")
});
export type DaemonShutdownAcknowledgement = z.infer<
  typeof DaemonShutdownAcknowledgementSchema
>;
