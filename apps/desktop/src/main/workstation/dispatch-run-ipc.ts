import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { nativeAskCompleted, nativeAskDetail, nativeAskEffectiveReason, type NativeAskOutcome } from "./types.js";
import type { WorkstationReview } from "@cadrane/contracts";

export type LaneState =
  | "queued"
  | "awaiting-approval"
  | "working"
  | "answered"
  | "stopped"
  | "failed"
  | "interrupted"
  | "unavailable";

export interface DispatchLane {
  readonly providerId: string;
  readonly label: string;
  readonly state: LaneState;
  readonly line: string;
  readonly elapsed: string;
  readonly answerTurnId: string | null;
  readonly draftTurnId: string | null;
  readonly outcome: NativeAskOutcome | null;
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

/** A Compare review names every paid call and exact model before launch. */
export const WorkstationDispatchPrepareInputSchema = z.strictObject({
  caseId: z.string().min(1),
  brief: z.string().trim().min(1).max(MAX_DISPATCH_BRIEF_CHARS),
  selections: z.array(z.strictObject({
    providerId: z.string().min(1),
    modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u)
  })).min(MIN_DISPATCH_PROVIDERS).max(MAX_DISPATCH_PROVIDERS)
    .refine((items) => new Set(items.map((item) => item.providerId)).size === items.length,
      "Choose each connection once."),
  sourceTurnIds: z.array(z.uuid()).max(20).optional()
    .refine((ids) => ids === undefined || new Set(ids).size === ids.length,
      "Choose each source once.")
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
  /** Runs the brief on one provider and preserves the native result. */
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
  }) => Promise<NativeAskOutcome & { readonly turnId: string | null }>;
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
  readonly draftTurnId: string | null;
  readonly outcome: NativeAskOutcome | null;
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
  readonly interrupted: number;
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
  if (counts.interrupted > 0) clauses.push(`${countToWord(counts.interrupted)} interrupted`);

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
  let interruptedCount = 0;
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
      case "interrupted":
        interruptedCount++;
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
      draftTurnId: lane.draftTurnId,
      outcome: lane.outcome,
      chars: lane.chars,
      canStop: lane.canStop
    });
  }

  const headline = formatHeadline({
    working: workingCount,
    answered: answeredCount,
    failed: failedCount,
    interrupted: interruptedCount,
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
            draftTurnId: null,
            outcome: null,
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
            draftTurnId: null,
            outcome: null,
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
                newRun.lanes[currentIdx] = {
                  ...current,
                  draftTurnId: result.turnId,
                  outcome: result,
                  chars: result.text.length
                };
                return;
              }
              const completed = nativeAskCompleted(result);
              const firstLine = result.text.trim().split(/\r?\n/).find((l) => l.trim().length > 0);
              const preview = completed ? (firstLine ?? "Answer received.") : nativeAskDetail(result);
              newRun.lanes[currentIdx] = {
                ...current,
                state: completed ? "answered" : nativeAskEffectiveReason(result) === "stopped" ? "stopped" : "failed",
                endedAt: clock(),
                line: preview,
                answerTurnId: completed ? result.turnId : null,
                draftTurnId: completed ? null : result.turnId,
                outcome: result,
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

/** The production Compare route: one parent review, host-owned serial children. */
export function installReviewedDispatchRun(options: {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly ownerFor: (event: IpcMainInvokeEvent) => object;
  readonly prepareLane: (input: {
    readonly caseId: string; readonly providerId: string; readonly modelId: string;
    readonly brief: string; readonly sourceTurnIds: readonly string[]; readonly owner: object;
  }) => Promise<WorkstationReview>;
  readonly runLane: (input: {
    readonly review: WorkstationReview; readonly owner: object; readonly signal: AbortSignal;
    readonly onActivity: (line: string) => void;
  }) => Promise<NativeAskOutcome & { readonly turnId: string | null }>;
  readonly persistParent: (input: { readonly event: "parent"; readonly runId: string;
    readonly caseId: string; readonly brief: string; readonly at: number;
    readonly children: readonly { readonly providerId: string; readonly label: string;
      readonly modelId: string; readonly contextSnapshotId: string; readonly sourceHash: string }[] }) => Promise<void>;
  readonly persistChild: (caseId: string, input: { readonly event: "child"; readonly runId: string;
    readonly index: number; readonly state: "starting" | "answered" | "stopped" | "failed" | "interrupted";
    readonly at: number; readonly line: string; readonly answerTurnId: string | null;
    readonly draftTurnId: string | null; readonly chars: number }) => Promise<void>;
  readonly recover: (runId: string) => Promise<DispatchBoard | null>;
  readonly now?: () => number;
}): { readonly stopActive: () => Promise<boolean>; readonly cancelOwner: (owner: object) => Promise<void>; readonly shutdown: () => Promise<void> } {
  const clock = options.now ?? (() => Date.now());
  const pending = new Map<string, { readonly owner: object; readonly caseId: string;
    readonly brief: string; readonly reviews: readonly WorkstationReview[]; readonly expiresAt: number }>();
  const revokedOwners = new WeakSet<object>();
  const runs = new Map<string, InternalRun & { readonly owner: object }>();
  let activeRun: (InternalRun & { readonly owner: object }) | null = null;
  const persistLane = (run: InternalRun, index: number, state: "starting" | "answered" | "stopped" | "failed" | "interrupted",
    line: string, answerTurnId: string | null, draftTurnId: string | null, chars: number) =>
    options.persistChild(run.caseId, { event: "child", runId: run.runId, index,
      state, at: clock(), line: line.slice(0, 800), answerTurnId, draftTurnId, chars });

  ipcMain.handle(IPC_CHANNELS.workstationDispatchPrepare, async (event, input: unknown) => {
    options.assertTrusted(event);
    const request = WorkstationDispatchPrepareInputSchema.parse(input);
    const owner = options.ownerFor(event);
    if (revokedOwners.has(owner)) throw new Error("That Compare window is no longer active.");
    const reviews: WorkstationReview[] = [];
    for (const selected of request.selections) {
      const review = await options.prepareLane({ caseId: request.caseId,
        providerId: selected.providerId, modelId: selected.modelId,
        brief: request.brief, sourceTurnIds: request.sourceTurnIds ?? [], owner });
      if (review.caseId !== request.caseId || review.providerId !== selected.providerId ||
          review.modelId !== selected.modelId)
        throw new Error("A Compare lane did not match its selected connection and model.");
      reviews.push(review);
    }
    if (revokedOwners.has(owner)) throw new Error("That Compare window is no longer active.");
    const token = randomBytes(32).toString("hex");
    const expiresAt = Math.min(...reviews.map((review) => review.expiresAt));
    for (const [key, value] of pending) if (value.expiresAt < clock()) pending.delete(key);
    if (pending.size >= 8) pending.delete(pending.keys().next().value!);
    pending.set(token, { owner, caseId: request.caseId, brief: request.brief, reviews, expiresAt });
    return { token, expiresAt,
      reviews: reviews.map(({ token: _laneToken, ...shown }) => shown) };
  });

  ipcMain.handle(IPC_CHANNELS.workstationDispatchStart, async (event, input: unknown) => {
    options.assertTrusted(event);
    const request = z.strictObject({ token: z.string().regex(/^[0-9a-f]{64}$/u) }).parse(input);
    const manifest = pending.get(request.token);
    pending.delete(request.token);
    if (manifest === undefined || manifest.owner !== options.ownerFor(event) ||
        revokedOwners.has(manifest.owner) || clock() > manifest.expiresAt)
      throw new Error("That Compare review expired or belongs to another window. Review it again.");
    if (activeRun !== null && !toDispatchBoard(activeRun, clock).done)
      throw new Error("The previous Compare is still running. Stop it or wait for its result.");
    const runId = randomUUID();
    await options.persistParent({ event: "parent", runId, caseId: manifest.caseId,
      brief: manifest.brief, at: clock(), children: manifest.reviews.map((review) => {
        if (!review.contextSnapshotId || !review.modelId)
          throw new Error("A Compare lane has no saved context or chosen model. Nothing was sent.");
        return { providerId: review.providerId, label: review.providerLabel,
          modelId: review.modelId, contextSnapshotId: review.contextSnapshotId,
          sourceHash: review.sourceHash };
      }) });
    if (revokedOwners.has(manifest.owner))
      throw new Error("That Compare window closed before dispatch. No provider was started.");
    const run: InternalRun & { readonly owner: object } = {
      runId, owner: manifest.owner, caseId: manifest.caseId, brief: manifest.brief,
      lanes: manifest.reviews.map((review): InternalLane => ({
        providerId: review.providerId, label: review.providerLabel, state: "queued",
        line: "Waiting for its reviewed turn.", startedAt: clock(), endedAt: null,
        answerTurnId: null, draftTurnId: null, outcome: null, chars: 0,
        canStop: true, controller: new AbortController()
      }))
    };
    runs.set(runId, run);
    while (runs.size > 24) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined || oldest === activeRun?.runId) break;
      runs.delete(oldest);
    }
    activeRun = run;
    void (async () => {
      for (let i = 0; i < manifest.reviews.length; i += 1) {
        const review = manifest.reviews[i]!;
        const lane = run.lanes[i]!;
        if (lane.controller.signal.aborted) continue;
        run.lanes[i] = { ...lane, state: "working", line: "Starting reviewed session.", startedAt: clock() };
        try {
          await persistLane(run, i, "starting", "Host admission pending.", null, null, 0);
        } catch {
          run.lanes[i] = { ...run.lanes[i]!, state: "failed",
            line: "Could not save the child intent. Nothing was sent.", endedAt: clock(), canStop: false };
          for (let j = i + 1; j < run.lanes.length; j += 1) {
            const queued = run.lanes[j]!;
            queued.controller.abort();
            run.lanes[j] = { ...queued, state: "interrupted", line: "Not started; parent recording failed.",
              endedAt: clock(), canStop: false };
          }
          return;
        }
        if (lane.controller.signal.aborted || revokedOwners.has(manifest.owner)) {
          run.lanes[i] = { ...run.lanes[i]!, state: "stopped", line: "Stopped before provider dispatch.",
            endedAt: clock(), canStop: false };
          try { await persistLane(run, i, "stopped", "Stopped before provider dispatch.", null, null, 0); }
          catch { /* The starting receipt still records that dispatch was cancelled. */ }
          continue;
        }
        try {
          const result = await options.runLane({ review, owner: manifest.owner,
            signal: lane.controller.signal,
            onActivity: (line) => {
              noteActivity(runId, lane.providerId, line);
              const current = run.lanes[i]!;
              if (current.state === "working")
                run.lanes[i] = { ...current, line: laneActivity.get(activityKey(runId, lane.providerId)) ?? current.line };
            } });
          const current = run.lanes[i]!;
          const completed = nativeAskCompleted(result);
          const stopped = nativeAskEffectiveReason(result) === "stopped";
          run.lanes[i] = { ...current,
            state: completed ? "answered" : stopped ? "stopped" : "failed",
            line: completed ? result.text.trim().split(/\r?\n/u)[0] ?? "Answer received." : nativeAskDetail(result),
            endedAt: clock(), answerTurnId: completed ? result.turnId : null,
            draftTurnId: completed ? null : result.turnId, outcome: result,
            chars: result.text.length, canStop: false };
          const settled = run.lanes[i]!;
          await persistLane(run, i, settled.state === "answered" ? "answered" : settled.state === "stopped" ? "stopped" : "failed",
            settled.line, settled.answerTurnId, settled.draftTurnId, settled.chars);
        } catch (error) {
          const current = run.lanes[i]!;
          run.lanes[i] = { ...current, state: "interrupted",
            line: `The host result needs inspection: ${toPlainErrorMessage(error)}`,
            endedAt: clock(), canStop: false };
          try { await persistLane(run, i, "interrupted", run.lanes[i]!.line,
            current.answerTurnId, current.draftTurnId, current.chars); } catch { /* host receipt remains authoritative */ }
          for (let j = i + 1; j < run.lanes.length; j += 1) {
            const queued = run.lanes[j]!;
            queued.controller.abort();
            run.lanes[j] = { ...queued, state: "interrupted", line: "Not started after an uncertain child result.",
              endedAt: clock(), canStop: false };
          }
          return;
        }
      }
    })();
    return { runId };
  });

  ipcMain.handle(IPC_CHANNELS.workstationDispatchPoll, async (event, input: unknown): Promise<DispatchBoard> => {
    options.assertTrusted(event);
    const request = WorkstationDispatchPollInputSchema.parse(input);
    const run = runs.get(request.runId);
    if (run === undefined) {
      const recovered = await options.recover(request.runId);
      if (recovered !== null) return recovered;
      throw new Error("That Compare run is unavailable.");
    }
    if (run.owner !== options.ownerFor(event)) throw new Error("That Compare run is unavailable.");
    return toDispatchBoard(run, clock);
  });

  ipcMain.handle(IPC_CHANNELS.workstationDispatchStop, async (event, input: unknown): Promise<DispatchBoard> => {
    options.assertTrusted(event);
    const request = WorkstationDispatchStopInputSchema.parse(input);
    const run = runs.get(request.runId);
    if (run === undefined || run.owner !== options.ownerFor(event)) throw new Error("That Compare run is unavailable.");
    if (request.providerId !== undefined && !run.lanes.some((lane) => lane.providerId === request.providerId))
      throw new Error("That Compare lane does not exist.");
    for (let i = 0; i < run.lanes.length; i += 1) {
      const lane = run.lanes[i]!;
      if (request.providerId !== undefined && lane.providerId !== request.providerId) continue;
      if (lane.state === "queued") {
        lane.controller.abort();
        run.lanes[i] = { ...lane, state: "stopped", line: "Stopped before dispatch.",
          endedAt: clock(), canStop: false };
        await persistLane(run, i, "stopped", "Stopped before dispatch.", null, null, 0);
      } else if (lane.state === "working" && lane.canStop) {
        lane.controller.abort();
        run.lanes[i] = { ...lane, line: "Stop requested; waiting for the provider to settle.", canStop: false };
      }
    }
    return toDispatchBoard(run, clock);
  });
  const cancelOwner = async (owner: object): Promise<void> => {
    revokedOwners.add(owner);
    for (const [token, review] of pending) if (review.owner === owner) pending.delete(token);
    const changes: Promise<void>[] = [];
    for (const run of runs.values()) {
      if (run.owner !== owner) continue;
      for (let i = 0; i < run.lanes.length; i += 1) {
        const lane = run.lanes[i]!;
        if (lane.state === "queued") {
          lane.controller.abort();
          run.lanes[i] = { ...lane, state: "stopped", line: "Owner window closed before dispatch.",
            endedAt: clock(), canStop: false };
          changes.push(persistLane(run, i, "stopped", "Owner window closed before dispatch.", null, null, 0));
        } else if (lane.state === "working") lane.controller.abort();
      }
    }
    await Promise.allSettled(changes);
  };
  const stopActive = async (): Promise<boolean> => {
    const run = activeRun;
    if (run === null || toDispatchBoard(run, clock).done) return false;
    const changes: Promise<void>[] = [];
    for (let i = 0; i < run.lanes.length; i += 1) {
      const lane = run.lanes[i]!;
      if (lane.state === "queued") {
        lane.controller.abort();
        run.lanes[i] = { ...lane, state: "stopped", line: "Global Stop before dispatch.",
          endedAt: clock(), canStop: false };
        changes.push(persistLane(run, i, "stopped", "Global Stop before dispatch.", null, null, 0));
      } else if (lane.state === "working") {
        lane.controller.abort();
        run.lanes[i] = { ...lane, line: "Global Stop requested; waiting for provider to settle.", canStop: false };
      }
    }
    await Promise.allSettled(changes);
    return true;
  };
  return { stopActive, cancelOwner, shutdown: async () => {
    const owners = new Set([...runs.values()].map((run) => run.owner));
    await Promise.allSettled([...owners].map((owner) => cancelOwner(owner)));
  } };
}
