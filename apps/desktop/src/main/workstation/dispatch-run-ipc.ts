import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";

export type LaneState =
  | "queued"
  | "awaiting-approval"
  | "working"
  | "answered"
  | "stopped"
  | "failed"
  | "unavailable";

export interface DispatchLane {
  readonly providerId: string;
  readonly label: string;
  readonly state: LaneState;
  readonly line: string;
  readonly elapsed: string;
  readonly answerTurnId: string | null;
  readonly chars: number;
  readonly canStop: boolean;
}

export interface DispatchBoard {
  readonly runId: string;
  readonly caseId: string;
  readonly brief: string;
  readonly lanes: readonly DispatchLane[];
  readonly headline: string;
  readonly working: number;
  readonly answered: number;
  readonly done: boolean;
}

export const MAX_DISPATCH_BRIEF_CHARS = 10_000;
export const MIN_DISPATCH_PROVIDERS = 1;
export const MAX_DISPATCH_PROVIDERS = 5;

export const WorkstationDispatchStartInputSchema = z.object({
  caseId: z.string().min(1),
  brief: z.string().max(MAX_DISPATCH_BRIEF_CHARS),
  providerIds: z.array(z.string().min(1)).min(MIN_DISPATCH_PROVIDERS).max(MAX_DISPATCH_PROVIDERS),
  sourceTurnIds: z.array(z.string().min(1)).optional()
});

export type WorkstationDispatchStartInput = z.infer<typeof WorkstationDispatchStartInputSchema>;

export const WorkstationDispatchPollInputSchema = z.object({
  runId: z.string().min(1)
});

export type WorkstationDispatchPollInput = z.infer<typeof WorkstationDispatchPollInputSchema>;

export const WorkstationDispatchStopInputSchema = z.object({
  runId: z.string().min(1),
  providerId: z.string().min(1).optional()
});

export type WorkstationDispatchStopInput = z.infer<typeof WorkstationDispatchStopInputSchema>;

export interface InstallDispatchRunOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** Runs the brief on one provider. Resolves with the text it produced. */
  readonly askProvider: (input: {
    readonly providerId: string;
    readonly caseId: string;
    readonly brief: string;
    readonly sourceTurnIds: readonly string[];
    readonly signal: AbortSignal;
    /**
     * What this bot is doing, as it does it.
     *
     * Watching several subscriptions think about one problem is the thing this
     * product is for, and this board showed four identical copies of "Working
     * on your brief..." while four different lines of reasoning went past
     * underneath. The adapters were reporting; nobody was listening.
     */
    readonly onActivity?: (line: string) => void;
  }) => Promise<{ readonly text: string; readonly turnId: string }>;
  /** Which providers exist and whether each is usable right now. */
  readonly providers: () => Promise<readonly { readonly id: string; readonly label: string; readonly usable: boolean }[]>;
  readonly now?: () => number;
}

/**
 * The newest line from each lane, by run and provider.
 *
 * Held beside the runs rather than inside the lane record, because a lane is
 * rebuilt whole on every state change and an activity line arrives between
 * those — putting it in the record meant it was overwritten by the next
 * rebuild before anybody polled for it.
 */
const laneActivity = new Map<string, string>();

function activityKey(runId: string, providerId: string): string {
  return `${runId}\u0000${providerId}`;
}

/** Bots narrate at their own pace; one line each, and never a wall of text. */
function noteActivity(runId: string, providerId: string, line: string): void {
  const trimmed = line.trim().replace(/\s+/gu, " ");
  if (trimmed.length === 0) {
    return;
  }
  laneActivity.set(
    activityKey(runId, providerId),
    trimmed.length > 140 ? `${trimmed.slice(0, 137)}…` : trimmed
  );
}

interface InternalLane {
  readonly providerId: string;
  readonly label: string;
  readonly state: LaneState;
  readonly line: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly answerTurnId: string | null;
  readonly chars: number;
  readonly canStop: boolean;
  readonly controller: AbortController;
}

interface InternalRun {
  readonly runId: string;
  readonly caseId: string;
  readonly brief: string;
  readonly lanes: InternalLane[];
}

function countToWord(n: number): string {
  switch (n) {
    case 0:
      return "zero";
    case 1:
      return "one";
    case 2:
      return "two";
    case 3:
      return "three";
    case 4:
      return "four";
    case 5:
      return "five";
    default:
      return String(n);
  }
}

interface HeadlineCounts {
  readonly working: number;
  readonly answered: number;
  readonly failed: number;
  readonly stopped: number;
  readonly unavailable: number;
  readonly total: number;
}

function formatHeadline(counts: HeadlineCounts): string {
  if (counts.total === 0) {
    return "No bots selected.";
  }

  const clauses: string[] = [];

  if (counts.working > 0) {
    const noun = counts.working === 1 ? "bot" : "bots";
    clauses.push(`${countToWord(counts.working)} ${noun} working`);
  }

  if (counts.answered > 0) {
    if (clauses.length === 0) {
      const noun = counts.answered === 1 ? "bot answered" : "bots answered";
      clauses.push(`${countToWord(counts.answered)} ${noun}`);
    } else {
      clauses.push(`${countToWord(counts.answered)} answered`);
    }
  }

  if (counts.failed > 0) {
    if (clauses.length === 0) {
      const noun = counts.failed === 1 ? "bot failed" : "bots failed";
      clauses.push(`${countToWord(counts.failed)} ${noun}`);
    } else {
      clauses.push(`${countToWord(counts.failed)} failed`);
    }
  }

  if (counts.stopped > 0) {
    if (clauses.length === 0) {
      const noun = counts.stopped === 1 ? "bot stopped" : "bots stopped";
      clauses.push(`${countToWord(counts.stopped)} ${noun}`);
    } else {
      clauses.push(`${countToWord(counts.stopped)} stopped`);
    }
  }

  if (counts.unavailable > 0) {
    if (clauses.length === 0) {
      const noun = counts.unavailable === 1 ? "bot unavailable" : "bots unavailable";
      clauses.push(`${countToWord(counts.unavailable)} ${noun}`);
    } else {
      clauses.push(`${countToWord(counts.unavailable)} unavailable`);
    }
  }

  if (clauses.length === 0) {
    return "All bots ready.";
  }

  const combined = clauses.join(", ");
  return combined.charAt(0).toUpperCase() + combined.slice(1) + ".";
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} sec`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  return `${hours} hr`;
}

function toPlainErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return "This subscription was unable to answer.";
}

function isRunDone(run: InternalRun): boolean {
  for (let i = 0; i < run.lanes.length; i++) {
    const lane = run.lanes[i]!;
    if (lane.canStop) {
      return false;
    }
  }
  return true;
}

function toDispatchBoard(run: InternalRun, clock: () => number): DispatchBoard {
  const lanes: DispatchLane[] = [];
  let workingCount = 0;
  let answeredCount = 0;
  let failedCount = 0;
  let stoppedCount = 0;
  let unavailableCount = 0;

  for (let i = 0; i < run.lanes.length; i++) {
    const lane = run.lanes[i]!;
    const elapsedMs =
      lane.endedAt !== null ? lane.endedAt - lane.startedAt : clock() - lane.startedAt;

    switch (lane.state) {
      case "working":
      case "queued":
      case "awaiting-approval":
        workingCount++;
        break;
      case "answered":
        answeredCount++;
        break;
      case "failed":
        failedCount++;
        break;
      case "stopped":
        stoppedCount++;
        break;
      case "unavailable":
        unavailableCount++;
        break;
    }

    lanes.push({
      providerId: lane.providerId,
      label: lane.label,
      state: lane.state,
      line: lane.line,
      elapsed: formatElapsed(elapsedMs),
      answerTurnId: lane.answerTurnId,
      chars: lane.chars,
      canStop: lane.canStop
    });
  }

  const headline = formatHeadline({
    working: workingCount,
    answered: answeredCount,
    failed: failedCount,
    stopped: stoppedCount,
    unavailable: unavailableCount,
    total: lanes.length
  });

  return {
    runId: run.runId,
    caseId: run.caseId,
    brief: run.brief,
    lanes,
    headline,
    working: workingCount,
    answered: answeredCount,
    done: workingCount === 0
  };
}

function stopRun(
  run: InternalRun,
  clock: () => number,
  providerId?: string | undefined
): void {
  for (let i = 0; i < run.lanes.length; i++) {
    const lane = run.lanes[i]!;
    if (providerId !== undefined && lane.providerId !== providerId) {
      continue;
    }
    if (lane.canStop) {
      lane.controller.abort();
      run.lanes[i] = {
        ...lane,
        state: "stopped",
        endedAt: clock(),
        line: "Stopped.",
        canStop: false
      };
    }
  }
}

export function installDispatchRun(options: InstallDispatchRunOptions): void {
  const clock = options.now ?? (() => Date.now());
  const runs = new Map<string, InternalRun>();
  let activeRun: InternalRun | null = null;

  ipcMain.handle(
    IPC_CHANNELS.workstationDispatchStart,
    async (event, input: unknown): Promise<{ readonly runId: string }> => {
      options.assertTrusted(event);
      const request = WorkstationDispatchStartInputSchema.parse(input);

      // Only one dispatch run can actively execute at any moment.
      if (activeRun !== null && !isRunDone(activeRun)) {
        stopRun(activeRun, clock);
      }

      const availableProviders = await options.providers();
      const providerMap = new Map<string, { readonly label: string; readonly usable: boolean }>();
      for (const p of availableProviders) {
        providerMap.set(p.id, { label: p.label, usable: p.usable });
      }

      // The session pool enforces one session per provider, so deduplicate.
      const seen = new Set<string>();
      const uniqueProviderIds: string[] = [];
      for (const id of request.providerIds) {
        if (!seen.has(id)) {
          seen.add(id);
          uniqueProviderIds.push(id);
        }
      }

      const runId = randomUUID();
      const startedAt = clock();
      const lanes: InternalLane[] = [];

      for (const id of uniqueProviderIds) {
        const info = providerMap.get(id);
        const label = info?.label ?? id;
        const usable = info?.usable ?? false;

        // Unusable subscriptions remain visible as unavailable rather than dropped.
        if (!usable) {
          lanes.push({
            providerId: id,
            label,
            state: "unavailable",
            line: "Not available right now.",
            startedAt,
            endedAt: startedAt,
            answerTurnId: null,
            chars: 0,
            canStop: false,
            controller: new AbortController()
          });
        } else {
          lanes.push({
            providerId: id,
            label,
            state: "working",
            line: laneActivity.get(activityKey(runId, id)) ?? "Working on your brief...",
            startedAt,
            endedAt: null,
            answerTurnId: null,
            chars: 0,
            canStop: true,
            controller: new AbortController()
          });
        }
      }

      const newRun: InternalRun = {
        runId,
        caseId: request.caseId,
        brief: request.brief,
        lanes
      };

      runs.set(runId, newRun);
      activeRun = newRun;

      // Launch every usable lane concurrently without letting errors cascade.
      for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i]!;
        if (lane.state !== "working") {
          continue;
        }

        void (async () => {
          try {
            const result = await options.askProvider({
              providerId: lane.providerId,
              caseId: request.caseId,
              brief: request.brief,
              sourceTurnIds: request.sourceTurnIds ?? [],
              signal: lane.controller.signal,
              onActivity: (line: string) => {
                noteActivity(newRun.runId, lane.providerId, line);
              }
            });

            const currentIdx = newRun.lanes.findIndex((l) => l.providerId === lane.providerId);
            if (currentIdx >= 0 && currentIdx < newRun.lanes.length) {
              const current = newRun.lanes[currentIdx]!;
              if (current.state === "stopped" || current.controller.signal.aborted) {
                return;
              }
              const firstLine = result.text.trim().split(/\r?\n/).find((l) => l.trim().length > 0);
              const preview = firstLine && firstLine.length > 0 ? firstLine : "Answer received.";
              newRun.lanes[currentIdx] = {
                ...current,
                state: "answered",
                endedAt: clock(),
                line: preview,
                answerTurnId: result.turnId,
                chars: result.text.length,
                canStop: false
              };
            }
          } catch (error) {
            const currentIdx = newRun.lanes.findIndex((l) => l.providerId === lane.providerId);
            if (currentIdx >= 0 && currentIdx < newRun.lanes.length) {
              const current = newRun.lanes[currentIdx]!;
              if (current.state === "stopped" || current.controller.signal.aborted) {
                return;
              }
              newRun.lanes[currentIdx] = {
                ...current,
                state: "failed",
                endedAt: clock(),
                line: toPlainErrorMessage(error),
                canStop: false
              };
            }
          }
        })();
      }

      return { runId };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationDispatchPoll,
    async (event, input: unknown): Promise<DispatchBoard> => {
      options.assertTrusted(event);
      const request = WorkstationDispatchPollInputSchema.parse(
        typeof input === "string" ? { runId: input } : input
      );

      const run = runs.get(request.runId);
      if (!run) {
        throw new Error(`Dispatch run "${request.runId}" was not found.`);
      }

      return toDispatchBoard(run, clock);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationDispatchStop,
    async (event, input: unknown): Promise<DispatchBoard> => {
      options.assertTrusted(event);
      const request = WorkstationDispatchStopInputSchema.parse(
        typeof input === "string" ? { runId: input } : input
      );

      const run = runs.get(request.runId);
      if (!run) {
        throw new Error(`Dispatch run "${request.runId}" was not found.`);
      }

      stopRun(run, clock, request.providerId);
      return toDispatchBoard(run, clock);
    }
  );
}
