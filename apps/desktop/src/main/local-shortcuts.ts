import { randomUUID } from "node:crypto";
import type { LocalShortcutKind } from "@cadrane/contracts";

interface Slot {
  handle: string;
  owner: object;
  kind: LocalShortcutKind;
  expires: number;
  running: boolean;
  controller: AbortController;
}

/** One bounded shortcut at a time. It uses the existing runtime, not another inference lane. */
export function createLocalShortcuts(now = Date.now, timeoutMs = 90_000) {
  let slot: Slot | null = null;
  return {
    begin(owner: object, kind: LocalShortcutKind): { handle: string } {
      if (slot && !slot.running && slot.expires <= now()) slot = null;
      if (slot) throw new Error("A local reading or draft is still finishing. Stop it or wait for it to finish.");
      const handle = randomUUID();
      slot = { handle, owner, kind, expires: now() + 60_000, running: false, controller: new AbortController() };
      return { handle };
    },

    async run<T>(owner: object, handle: string, kind: LocalShortcutKind,
      task: (signal: AbortSignal, check: () => void, startFileReading: () => void) => Promise<T>, assertOwner: () => void): Promise<T> {
      const active = slot;
      if (!active || active.owner !== owner || active.handle !== handle || active.kind !== kind || active.running || active.expires <= now())
        throw new Error("This local request expired or was already used. Start a new reading or draft.");
      // Claim synchronously, before any picker, discovery, filesystem or model await.
      active.running = true;
      const check = () => { active.controller.signal.throwIfAborted(); assertOwner(); };
      const deadline = (ms: number, message: string) => {
        const timer = setTimeout(() => active.controller.abort(new Error(message)), ms);
        timer.unref();
        return timer;
      };
      const workTimeout = "This local request took too long. Nothing was applied. Try a shorter source.";
      // Choosing a file is human time. Keep it bounded without spending the
      // reading deadline before the host has a file to read.
      let timeout = kind === "bill-file"
        ? deadline(300_000, "File selection expired. Close the picker and choose a file again. Nothing was read or applied.")
        : deadline(timeoutMs, workTimeout);
      let fileReadingStarted = false;
      const startFileReading = () => {
        check();
        if (slot !== active || kind !== "bill-file" || fileReadingStarted)
          throw new Error("File reading already started or this request has finished.");
        fileReadingStarted = true;
        clearTimeout(timeout);
        timeout = deadline(timeoutMs, workTimeout);
      };
      try {
        check();
        const result = await task(active.controller.signal, check, startFileReading);
        check();
        return result;
      } finally {
        clearTimeout(timeout);
        if (slot === active) slot = null;
      }
    },

    stop(owner: object, handle: string): { stopped: boolean } {
      const active = slot;
      if (!active || active.owner !== owner || active.handle !== handle || active.controller.signal.aborted) return { stopped: false };
      active.controller.abort(new Error("Stopped. Nothing from this request was applied or saved."));
      // Keep the occupied slot while real work unwinds. A late answer is discarded.
      if (!active.running) slot = null;
      return { stopped: true };
    },

    discard(owner: object): void {
      if (slot?.owner === owner) this.stop(owner, slot.handle);
    }
  };
}
