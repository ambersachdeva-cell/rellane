import { createRequire } from "node:module";

export type AtomicPublishErrorCode =
  | "INVALID_ARGUMENT"
  | "UNSAFE_PARENT"
  | "UNSUPPORTED_VOLUME"
  | "INVALID_SOURCE"
  | "DESTINATION_EXISTS"
  | "PUBLISH_FAILED"
  | "NATIVE_ADDON_UNAVAILABLE";

export class AtomicPublishError extends Error {
  readonly code: AtomicPublishErrorCode;

  constructor(code: AtomicPublishErrorCode, message: string) {
    super(message);
    this.name = "AtomicPublishError";
    this.code = code;
  }
}

interface AtomicPublishAddon {
  atomicPublish(parent: string, temporaryName: string, finalName: string): void;
}

const require = createRequire(import.meta.url);
let addon: AtomicPublishAddon | undefined;
const temporaryNamePrefix = "switchboard-sidecar-tmp-";

function nativeAddon(): AtomicPublishAddon {
  if (addon !== undefined) {
    return addon;
  }

  try {
    addon = require("../../native/atomic-publish/build/Release/atomic_publish.node") as AtomicPublishAddon;
    return addon;
  } catch {
    throw new AtomicPublishError(
      "NATIVE_ADDON_UNAVAILABLE",
      "The atomic publish boundary is unavailable."
    );
  }
}

function invalidArgument(): never {
  throw new AtomicPublishError(
    "INVALID_ARGUMENT",
    "Atomic publish rejected invalid input."
  );
}

function assertCanonicalAbsoluteParent(parent: string): void {
  if (
    parent.length < 2 ||
    !parent.startsWith("/") ||
    parent.endsWith("/") ||
    parent.includes("\0")
  ) {
    invalidArgument();
  }

  for (const component of parent.slice(1).split("/")) {
    if (component.length === 0 || component === "." || component === "..") {
      invalidArgument();
    }
  }
}

function assertBasename(name: string, requiresTemporaryPrefix = false): void {
  if (
    name.length === 0 ||
    name.length > 128 ||
    name === "." ||
    name === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)
  ) {
    invalidArgument();
  }
  if (requiresTemporaryPrefix && !name.startsWith(temporaryNamePrefix)) {
    invalidArgument();
  }
}

function asAtomicPublishError(error: unknown): AtomicPublishError {
  if (error instanceof AtomicPublishError) {
    return error;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  const stableCodes: readonly AtomicPublishErrorCode[] = [
    "INVALID_ARGUMENT",
    "UNSAFE_PARENT",
    "UNSUPPORTED_VOLUME",
    "INVALID_SOURCE",
    "DESTINATION_EXISTS",
    "PUBLISH_FAILED"
  ];
  if (typeof code === "string" && stableCodes.includes(code as AtomicPublishErrorCode)) {
    return new AtomicPublishError(code as AtomicPublishErrorCode, "Atomic publish failed.");
  }
  return new AtomicPublishError("PUBLISH_FAILED", "Atomic publish failed.");
}

/**
 * Atomically publishes one prepared directory into a previously absent sibling
 * name. This is intentionally synchronous: it is an offline assembly-time
 * boundary, not an Electron/runtime operation.
 */
export function atomicPublishDirectory(
  parent: string,
  temporaryName: string,
  finalName: string
): void {
  assertCanonicalAbsoluteParent(parent);
  assertBasename(temporaryName, true);
  assertBasename(finalName);
  if (temporaryName === finalName) {
    invalidArgument();
  }

  try {
    nativeAddon().atomicPublish(parent, temporaryName, finalName);
  } catch (error) {
    throw asAtomicPublishError(error);
  }
}
