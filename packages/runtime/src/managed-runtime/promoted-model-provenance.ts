import { RuntimeBoundaryError } from "../errors.js";
import type { PromotedManagedModel } from "./types.js";

const processVerifiedModels = new WeakSet<object>();

/**
 * Internal privilege boundary: callers must perform the complete managed-store
 * verification immediately before invoking this factory.
 *
 * This module is intentionally absent from the public package barrel. The
 * process-local WeakSet prevents an identical-looking object received through
 * IPC, deserialization, or ordinary structural construction from becoming a
 * runtime launch authority.
 */
export function promoteVerifiedManagedModel(
  input: PromotedManagedModel
): PromotedManagedModel {
  const promoted = Object.freeze({ ...input });
  processVerifiedModels.add(promoted);
  return promoted;
}

export function assertProcessVerifiedManagedModel(
  model: PromotedManagedModel
): void {
  if (!processVerifiedModels.has(model)) {
    throw new RuntimeBoundaryError({
      code: "SECURITY_BOUNDARY",
      message:
        "The managed model was not promoted by this process after store verification.",
      retryable: false
    });
  }
}
