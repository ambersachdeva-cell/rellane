import type { DesktopError } from "@cadrane/contracts";

export class RuntimeBoundaryError extends Error {
  readonly detail: DesktopError;

  constructor(detail: DesktopError, options?: ErrorOptions) {
    super(detail.message, options);
    this.name = "RuntimeBoundaryError";
    this.detail = detail;
  }
}

/** Keep the HTTP status available to adapters without exposing response bodies. */
export class RuntimeHttpError extends RuntimeBoundaryError {
  constructor(readonly status: number) {
    super({
      code: "RUNTIME_RESPONSE_INVALID",
      message: `A service responded on the local runtime port with HTTP ${status}.`,
      retryable: status >= 500
    });
    this.name = "RuntimeHttpError";
  }
}

export function toDesktopError(error: unknown): DesktopError {
  if (error instanceof RuntimeBoundaryError) {
    return error.detail;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return {
      code: "CANCELLED",
      message: "The local operation was cancelled.",
      retryable: true
    };
  }
  return {
    code: "UNKNOWN",
    message: error instanceof Error ? error.message.slice(0, 1_000) : "Unknown local runtime error.",
    retryable: false
  };
}
