import type { DesktopBridge, LocalShortcutKind } from "@cadrane/contracts";

/** Per-click identity, including a Stop that arrives before the host issues its handle. */
export function createLocalShortcutRequest(api: DesktopBridge["localShortcuts"], kind: LocalShortcutKind) {
  let handle: string | null = null;
  let stopped = false;
  let started = false;
  return {
    async run<T>(task: (handle: string) => Promise<T>): Promise<T | null> {
      if (started) throw new Error("This local request was already started.");
      started = true;
      try {
        if (stopped) return null;
        handle = (await api.begin({ kind })).handle;
        if (stopped) return null;
        const value = await task(handle);
        return stopped ? null : value;
      } catch (error) {
        if (stopped) return null;
        throw error;
      } finally {
        // Also releases a reservation if dispatch failed before reaching the host.
        if (handle !== null) await api.stop({ handle }).catch(() => undefined);
      }
    },

    stop(): void {
      stopped = true;
      if (handle !== null) void api.stop({ handle }).catch(() => undefined);
    }
  };
}
