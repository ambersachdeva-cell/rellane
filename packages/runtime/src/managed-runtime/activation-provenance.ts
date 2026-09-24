import { RuntimeBoundaryError } from "../errors.js";
import type {
  ActivatedLlamaRuntime,
  ManagedRuntimeAuthority,
  RuntimeIntegrityVerifier
} from "./types.js";

const processVerifiedActivations = new WeakSet<object>();
const processVerifiedAuthorities = new WeakSet<object>();

/**
 * Internal build/package boundary. Task 4E will call this only after producing
 * and anchoring the signed post-package receipt. It is intentionally absent
 * from the public runtime barrel.
 */
export function promoteVerifiedRuntimeActivation(
  input: ActivatedLlamaRuntime
): ActivatedLlamaRuntime {
  const promoted = deepFreeze(structuredClone(input));
  processVerifiedActivations.add(promoted);
  return promoted;
}

/**
 * Internal build/package boundary. The authority is the indivisible launch
 * capability: a process-promoted activation plus the verifier configured for
 * that exact build trust anchor.
 */
export function promoteVerifiedManagedRuntimeAuthority(
  input: ActivatedLlamaRuntime,
  integrityVerifier: RuntimeIntegrityVerifier
): ManagedRuntimeAuthority {
  const activation = promoteVerifiedRuntimeActivation(input);
  const authority = Object.freeze({
    activation,
    integrityVerifier
  });
  processVerifiedAuthorities.add(authority);
  return authority;
}

export function isProcessVerifiedRuntimeActivation(
  activation: ActivatedLlamaRuntime
): boolean {
  return processVerifiedActivations.has(activation);
}

export function assertProcessVerifiedRuntimeActivation(
  activation: ActivatedLlamaRuntime
): void {
  if (!isProcessVerifiedRuntimeActivation(activation)) {
    throw new RuntimeBoundaryError({
      code: "SECURITY_BOUNDARY",
      message:
        "The managed runtime activation was not promoted by this process.",
      retryable: false
    });
  }
}

export function isProcessVerifiedManagedRuntimeAuthority(
  authority: ManagedRuntimeAuthority
): boolean {
  return (
    processVerifiedAuthorities.has(authority) &&
    isProcessVerifiedRuntimeActivation(authority.activation)
  );
}

export function assertProcessVerifiedManagedRuntimeAuthority(
  authority: ManagedRuntimeAuthority
): void {
  if (!isProcessVerifiedManagedRuntimeAuthority(authority)) {
    throw new RuntimeBoundaryError({
      code: "SECURITY_BOUNDARY",
      message:
        "The managed runtime authority was not promoted by this process.",
      retryable: false
    });
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
