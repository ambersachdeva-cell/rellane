/**
 * Errors for the subscription brain.
 *
 * Mirrors the shape `packages/runtime` uses so the renderer sees one error
 * contract everywhere. Declared locally because the desktop app depends on
 * @cadrane/contracts but not on @cadrane/runtime.
 */

import type { DesktopError } from "@cadrane/contracts";

export class RuntimeBoundaryError extends Error {
  readonly detail: DesktopError;

  constructor(detail: DesktopError, options?: ErrorOptions) {
    super(detail.message, options);
    this.name = "RuntimeBoundaryError";
    this.detail = detail;
  }
}

export function toDesktopError(error: unknown): DesktopError {
  if (error instanceof RuntimeBoundaryError) {
    return error.detail;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "CANCELLED", message: "The request was cancelled.", retryable: true };
  }
  return {
    code: "UNKNOWN",
    message: error instanceof Error ? error.message.slice(0, 1_000) : "Unknown brain error.",
    retryable: false
  };
}
