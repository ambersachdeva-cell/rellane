import { safeStorage } from "electron";

export const STORAGE_CAPABILITY_MAIN_PROBE_MARKER =
  "switchboard-storage-capability-main-probe-v1" as const;

/** Inert package probe: no caller is wired into the running application. */
export function inspectSafeStorageAvailability(): boolean {
  return safeStorage.isEncryptionAvailable();
}
