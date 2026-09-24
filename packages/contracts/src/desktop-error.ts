import { z } from "zod";

export const DesktopErrorSchema = z.object({
  code: z.enum([
    "BAD_REQUEST",
    "BUSY",
    "CATALOG_INVALID",
    "CANCELLED",
    "DAEMON_UNAVAILABLE",
    "DOWNLOAD_FAILED",
    "FILE_UNSUPPORTED",
    "INTEGRITY_FAILED",
    "LICENSE_REQUIRED",
    "RUNTIME_UNAVAILABLE",
    "RUNTIME_RESPONSE_INVALID",
    "SECURITY_BOUNDARY",
    "STORAGE_UNAVAILABLE",
    "TIMEOUT",
    "UNKNOWN"
  ]),
  message: z.string().min(1).max(1_000),
  retryable: z.boolean()
}).strict();
export type DesktopError = z.infer<typeof DesktopErrorSchema>;
