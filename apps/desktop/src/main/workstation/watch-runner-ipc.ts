import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";

/**
 * The shapes and the judging both live in watch-plan. This file had its own
 * copies of each — the types byte-for-byte identical, the judging a plainer
 * version that said "Content has changed." where the real one says which page,
 * which number, and what it went from and to. Re-exported here so the schemas
 * and handlers below still read as one file.
 */
import { isDue, judgeChange } from "./watch-plan.js";
import type { Cadence, ChangeVerdict, Watch, WatchTarget } from "./watch-plan.js";

export type { WatchTarget, Cadence, Watch, ChangeVerdict };
export { isDue, judgeChange };

export interface InstallWatchOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly load: () => Promise<readonly Watch[]>;
  readonly save: (watches: readonly Watch[]) => Promise<void>;
  /** Reads the current state of a target. Null when it could not be reached. */
  readonly look: (target: WatchTarget, signal: AbortSignal) => Promise<string | null>;
  /** What it saw last time, and where to put what it sees now. */
  readonly lastSeen: (watchId: string) => Promise<string | null>;
  readonly remember: (watchId: string, text: string) => Promise<void>;
  /** Sends him one plain message. Already sanitised by the caller's channel. */
  readonly tell: (text: string) => Promise<void>;
  readonly now?: () => number;
}

export interface InstalledWatch {
  readonly stop: () => void;
  readonly checkDue: () => Promise<void>;
}

export const MAX_REMEMBER_BYTES = 256 * 1024;

const CADENCE_INTERVALS_MS: Readonly<Record<Cadence, number>> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
};

export const WatchTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("page"),
    url: z.string().min(1),
    label: z.string().min(1)
  }),
  z.object({
    kind: z.literal("folder"),
    path: z.string().min(1),
    label: z.string().min(1)
  }),
  z.object({
    kind: z.literal("routine"),
    routineId: z.string().min(1),
    label: z.string().min(1)
  })
]);

export const CadenceSchema = z.enum(["hourly", "daily", "weekly"]);

export const TellMeWhenSchema = z.enum([
  "anything-changes",
  "numbers-change",
  "something-new-appears"
]);

export const WatchSchema = z.object({
  id: z.string().min(1),
  target: WatchTargetSchema,
  cadence: CadenceSchema,
  tellMeWhen: TellMeWhenSchema,
  quietHours: z.boolean(),
  lastCheckedAt: z.number().nullable(),
  lastChangedAt: z.number().nullable(),
  paused: z.boolean()
});

export const WorkstationWatchListInputSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.undefined(),
  z.null()
]).optional();

export const WorkstationWatchSaveInputSchema = z.object({
  watch: WatchSchema
});

export const WorkstationWatchRemoveInputSchema = z.object({
  id: z.string().min(1)
});

export const WorkstationWatchNowInputSchema = z.object({
  id: z.string().min(1)
});

export function capRememberedText(text: string): string {
  if (text.length <= MAX_REMEMBER_BYTES && Buffer.byteLength(text, "utf8") <= MAX_REMEMBER_BYTES) {
    return text;
  }
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= MAX_REMEMBER_BYTES) {
    return text;
  }
  return buf.subarray(0, MAX_REMEMBER_BYTES).toString("utf8");
}

function isQuietHours(timestamp: number): boolean {
  const hour = new Date(timestamp).getHours();
  return hour < 7 || hour >= 22;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function installWatch(options: InstallWatchOptions): InstalledWatch {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);

  let isStopped = false;
  let isChecking = false;
  let currentAbortController: AbortController | null = null;
  const failureCounts = new Map<string, number>();

  interface HeldMessage {
    readonly text: string;
    readonly foundAt: number;
  }
  const heldMessages: HeldMessage[] = [];

  // Background inspection tasks must remain imperceptible on his working machine.
  // Running only one fetch at a time prevents competing network requests or CPU bursts.
  let activeQueue: Promise<void> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      isChecking = true;
      try {
        return await task();
      } finally {
        isChecking = false;
      }
    };

    const result = activeQueue.then(run, run);
    activeQueue = result.then(() => {}, () => {});
    return result;
  }

  async function deliverOrHold(watch: Watch, text: string, now: number): Promise<void> {
    if (watch.quietHours && isQuietHours(now)) {
      heldMessages.push({ text, foundAt: now });
      return;
    }
    await options.tell(text);
  }

  async function flushHeldMessages(now: number): Promise<void> {
    if (isQuietHours(now)) {
      return;
    }
    while (heldMessages.length > 0) {
      if (isStopped) break;
      const item = heldMessages.shift();
      if (!item) break;
      const timeStr = formatTime(item.foundAt);
      await options.tell(`${item.text}\n(Found at ${timeStr})`);
    }
  }

  async function checkSingleWatch(watch: Watch, now: number): Promise<ChangeVerdict | null> {
    if (isStopped) {
      return null;
    }

    const controller = new AbortController();
    currentAbortController = controller;

    let content: string | null = null;
    try {
      content = await options.look(watch.target, controller.signal);
    } catch {
      if (controller.signal.aborted || isStopped) {
        return null;
      }
      content = null;
    } finally {
      if (currentAbortController === controller) {
        currentAbortController = null;
      }
    }

    if (controller.signal.aborted || isStopped) {
      return null;
    }

    if (content === null) {
      const failures = (failureCounts.get(watch.id) ?? 0) + 1;
      failureCounts.set(watch.id, failures);

      const currentWatches = await options.load();
      const updatedWatches = currentWatches.map((w) => {
        if (w.id !== watch.id) return w;
        if (failures >= 3) {
          return {
            ...w,
            paused: true,
            lastCheckedAt: now
          };
        }
        return {
          ...w,
          lastCheckedAt: now
        };
      });
      await options.save(updatedWatches);

      if (failures === 3) {
        const message = `I have stopped checking "${watch.target.label}" after three attempts could not reach it. You can check it again when you are ready.`;
        await deliverOrHold(watch, message, now);
      }

      return null;
    }

    failureCounts.delete(watch.id);
    const capped = capRememberedText(content);
    const previous = await options.lastSeen(watch.id);

    if (previous === null) {
      // The initial inspection establishes the baseline comparison state.
      // Notifying on the very first read would invent a change that never happened.
      await options.remember(watch.id, capped);
      const currentWatches = await options.load();
      const updatedWatches = currentWatches.map((w) => {
        if (w.id !== watch.id) return w;
        return {
          ...w,
          lastCheckedAt: now
        };
      });
      await options.save(updatedWatches);

      return {
        changed: false,
        worthTelling: false,
        what: "First check recorded.",
        detail: []
      };
    }

    const verdict = judgeChange({ watch, before: previous, after: capped, now });
    await options.remember(watch.id, capped);

    const currentWatches = await options.load();
    const updatedWatches = currentWatches.map((w) => {
      if (w.id !== watch.id) return w;
      return {
        ...w,
        lastCheckedAt: now,
        lastChangedAt: verdict.changed ? now : w.lastChangedAt
      };
    });
    await options.save(updatedWatches);

    if (verdict.worthTelling) {
      const detailText = verdict.detail.length > 0 ? `\n${verdict.detail.join("\n")}` : "";
      const message = `${watch.target.label}: ${verdict.what}${detailText}`;
      await deliverOrHold(watch, message, now);
    }

    return verdict;
  }

  async function checkDue(): Promise<void> {
    if (isStopped || isChecking) {
      return;
    }
    const now = options.now ? options.now() : Date.now();
    await enqueue(async () => {
      if (isStopped) return;
      await flushHeldMessages(now);

      const watches = await options.load();
      for (const watch of watches) {
        if (isStopped) break;
        if (isDue(watch, now)) {
          await checkSingleWatch(watch, now);
        }
      }
    });
  }

  const intervalTimer = setInterval(() => {
    void checkDue();
  }, 60_000);
  if (typeof intervalTimer.unref === "function") {
    intervalTimer.unref();
  }

  function stop(): void {
    if (isStopped) return;
    isStopped = true;
    clearInterval(intervalTimer);
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    ipcMain.removeHandler(IPC_CHANNELS.workstationWatchList);
    ipcMain.removeHandler(IPC_CHANNELS.workstationWatchSave);
    ipcMain.removeHandler(IPC_CHANNELS.workstationWatchRemove);
    ipcMain.removeHandler(IPC_CHANNELS.workstationWatchNow);
  }

  ipcMain.handle(IPC_CHANNELS.workstationWatchList, async (event, input: unknown): Promise<{
    readonly watches: readonly Watch[];
    readonly checking: boolean;
  }> => {
    options.assertTrusted(event);
    const owner = ownerFor(event);
    WorkstationWatchListInputSchema.parse(input);

    const watches = await options.load();

    options.assertTrusted(event);
    if (ownerFor(event) !== owner) {
      throw new Error("This window changed while listing watches.");
    }

    return {
      watches,
      checking: isChecking
    };
  });

  ipcMain.handle(IPC_CHANNELS.workstationWatchSave, async (event, input: unknown): Promise<{
    readonly watches: readonly Watch[];
  }> => {
    options.assertTrusted(event);
    const owner = ownerFor(event);
    const request = WorkstationWatchSaveInputSchema.parse(input);

    const currentWatches = await options.load();

    options.assertTrusted(event);
    if (ownerFor(event) !== owner) {
      throw new Error("This window changed while saving the watch.");
    }

    const index = currentWatches.findIndex((w) => w.id === request.watch.id);
    const updatedWatches = index >= 0
      ? currentWatches.map((w, idx) => (idx === index ? request.watch : w))
      : [...currentWatches, request.watch];

    await options.save(updatedWatches);
    failureCounts.delete(request.watch.id);

    return { watches: updatedWatches };
  });

  ipcMain.handle(IPC_CHANNELS.workstationWatchRemove, async (event, input: unknown): Promise<{
    readonly watches: readonly Watch[];
  }> => {
    options.assertTrusted(event);
    const owner = ownerFor(event);
    const request = WorkstationWatchRemoveInputSchema.parse(input);

    const currentWatches = await options.load();

    options.assertTrusted(event);
    if (ownerFor(event) !== owner) {
      throw new Error("This window changed while removing the watch.");
    }

    const updatedWatches = currentWatches.filter((w) => w.id !== request.id);
    await options.save(updatedWatches);
    failureCounts.delete(request.id);

    return { watches: updatedWatches };
  });

  ipcMain.handle(IPC_CHANNELS.workstationWatchNow, async (event, input: unknown): Promise<{
    readonly verdict: ChangeVerdict | null;
  }> => {
    options.assertTrusted(event);
    const owner = ownerFor(event);
    const request = WorkstationWatchNowInputSchema.parse(input);

    const watches = await options.load();

    options.assertTrusted(event);
    if (ownerFor(event) !== owner) {
      throw new Error("This window changed while checking the watch.");
    }

    const targetWatch = watches.find((w) => w.id === request.id);
    if (!targetWatch) {
      throw new Error("Watch not found.");
    }

    const verdict = await enqueue(async () => {
      const now = options.now ? options.now() : Date.now();
      return await checkSingleWatch(targetWatch, now);
    });

    options.assertTrusted(event);
    if (ownerFor(event) !== owner) {
      throw new Error("This window changed while checking the watch.");
    }

    return { verdict };
  });

  return {
    stop,
    checkDue
  };
}
