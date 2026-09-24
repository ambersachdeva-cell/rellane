import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge, LocalShortcutKind } from "@cadrane/contracts";
import { createLocalShortcutRequest } from "../local-shortcut.js";

export function useLocalShortcut() {
  const current = useRef<ReturnType<typeof createLocalShortcutRequest> | null>(null);
  const [phase, setPhase] = useState<"idle" | "running" | "stopping">("idle");
  useEffect(() => () => { current.current?.stop(); current.current = null; }, []);
  const stop = useCallback(() => {
    if (!current.current) return;
    current.current.stop();
    setPhase("stopping");
  }, []);
  const run = useCallback(async <T,>(api: DesktopBridge, kind: LocalShortcutKind,
    task: (handle: string) => Promise<T>): Promise<T | null> => {
    if (current.current) throw new Error("A local request is already running. Stop it or wait for it to finish.");
    const request = createLocalShortcutRequest(api.localShortcuts, kind);
    current.current = request;
    setPhase("running");
    try { return await request.run(task); }
    finally {
      if (current.current === request) { current.current = null; setPhase("idle"); }
    }
  }, []);
  return { phase, busy: phase !== "idle", run, stop };
}
