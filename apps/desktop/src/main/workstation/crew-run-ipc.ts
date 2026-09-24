import { randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";

/** One part of a split request, and who is taking it. */
export interface CrewPart {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly seatId: string;
  readonly seatLabel: string;
  readonly dependsOn: readonly string[];
  readonly refinePrompt?: string;
}

export type CrewPartState =
  | "waiting"
  | "claimed"
  | "working"
  | "answered"
  | "refining"
  | "done"
  | "failed"
  | "stopped";

export interface CrewPartView {
  readonly id: string;
  readonly title: string;
  readonly seatLabel: string;
  readonly state: CrewPartState;
  readonly line: string;
  readonly elapsed: string;
  readonly answerTurnId: string | null;
  readonly refinedFrom: readonly string[];
  readonly canStop: boolean;
}

export interface CrewRunView {
  readonly runId: string;
  readonly caseId: string;
  readonly request: string;
  readonly parts: readonly CrewPartView[];
  readonly round: "splitting" | "working" | "reading-each-other" | "done" | "stopped" | "failed";
  readonly headline: string;
  readonly canStop: boolean;
}

/** What one seat learned, written back so the next round starts with it. */
export interface CrewNote {
  readonly partId: string;
  readonly seatLabel: string;
  readonly finding: string;
  readonly confidence: "stated" | "inferred" | "uncertain";
  readonly at: number;
}

export const CrewPartInputSchema = z.object({
  id: z.string().trim().min(1, "Part ID is required."),
  title: z.string().trim().min(1, "Part title is required."),
  prompt: z.string().trim().min(1, "Part prompt is required."),
  seatId: z.string().trim().min(1, "Seat ID is required."),
  seatLabel: z.string().trim().min(1, "Seat label is required."),
  dependsOn: z.array(z.string()).default([]),
  refinePrompt: z.string().optional()
});

export const WorkstationCrewStartInputSchema = z.object({
  caseId: z.string().trim().min(1, "Case ID is required."),
  request: z.string().trim().min(1, "Request is required."),
  parts: z
    .array(CrewPartInputSchema)
    .min(1, "Crew runs need between 1 and 6 parts.")
    .max(6, "Crew runs need between 1 and 6 parts."),
  sourceTurnIds: z.array(z.string()).optional()
});

export type WorkstationCrewStartInput = z.infer<typeof WorkstationCrewStartInputSchema>;

export const WorkstationCrewPollInputSchema = z.object({
  runId: z.string().trim().min(1, "Run ID is required.")
});

export type WorkstationCrewPollInput = z.infer<typeof WorkstationCrewPollInputSchema>;

export const WorkstationCrewStopInputSchema = z.object({
  runId: z.string().trim().min(1, "Run ID is required."),
  partId: z.string().trim().min(1).optional()
});

export type WorkstationCrewStopInput = z.infer<typeof WorkstationCrewStopInputSchema>;

export interface InstallCrewRunOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** Asks one provider one prompt. Read-only: no workspace, no tools. */
  readonly ask: (input: {
    readonly seatId: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
    /**
     * What this bot is doing, as it does it.
     *
     * Watching several subscriptions think about one problem — and then read
     * each other — is the thing this product is for. The board said
     * "Claude is working on this part." for the whole run while the reasoning
     * went past underneath, unread.
     */
    readonly onActivity?: (line: string) => void;
  }) => Promise<{ readonly text: string }>;
  /** Writes an answer into the room, attributed to that bot. Returns the turn id. */
  readonly record: (input: {
    readonly caseId: string;
    readonly seatLabel: string;
    readonly body: string;
  }) => Promise<string>;
  readonly now?: () => number;
}

interface InternalPart {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly seatId: string;
  readonly seatLabel: string;
  readonly dependsOn: readonly string[];
  readonly refinePrompt?: string;
  state: CrewPartState;
  line: string;
  startedAt: number | null;
  finishedAt: number | null;
  answerTurnId: string | null;
  refinedFrom: readonly string[];
  readonly abortController: AbortController;
}

interface InternalRun {
  readonly runId: string;
  readonly caseId: string;
  readonly request: string;
  readonly parts: readonly InternalPart[];
  round: CrewRunView["round"];
  readonly abortController: AbortController;
}

function validateParts(parts: readonly z.infer<typeof CrewPartInputSchema>[]): void {
  const ids = new Set<string>();
  for (const part of parts) {
    if (ids.has(part.id)) {
      throw new Error("Every part must have a unique identifier.");
    }
    ids.add(part.id);
  }

  for (const part of parts) {
    for (const depId of part.dependsOn) {
      if (depId === part.id) {
        throw new Error("A part cannot depend on itself.");
      }
      if (!ids.has(depId)) {
        throw new Error("A part cannot depend on an unknown part.");
      }
    }
  }

  const state = new Map<string, number>();
  const graph = new Map<string, readonly string[]>();
  for (const part of parts) {
    graph.set(part.id, part.dependsOn);
  }

  function hasCycle(nodeId: string): boolean {
    state.set(nodeId, 1);
    const deps = graph.get(nodeId);
    if (deps !== undefined) {
      for (const depId of deps) {
        const depState = state.get(depId) ?? 0;
        if (depState === 1) {
          return true;
        }
        if (depState === 0 && hasCycle(depId)) {
          return true;
        }
      }
    }
    state.set(nodeId, 2);
    return false;
  }

  for (const part of parts) {
    if ((state.get(part.id) ?? 0) === 0 && hasCycle(part.id)) {
      throw new Error("Parts cannot depend on each other in a circle.");
    }
  }
}

function formatElapsed(startedAt: number | null, finishedAt: number | null, nowMs: number): string {
  if (startedAt === null) {
    return "0 sec";
  }
  const endMs = finishedAt !== null ? finishedAt : nowMs;
  const elapsedSeconds = Math.max(0, Math.floor((endMs - startedAt) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} sec`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} hr`;
}

const NUMBER_WORDS: readonly string[] = ["zero", "one", "two", "three", "four", "five", "six"];

function formatCount(count: number): string {
  if (count >= 0 && count < NUMBER_WORDS.length) {
    const word = NUMBER_WORDS[count];
    if (word !== undefined) {
      return word;
    }
  }
  return String(count);
}

function formatBotCount(count: number): string {
  const word = formatCount(count);
  return `${word} ${count === 1 ? "bot" : "bots"}`;
}

function capitalize(text: string): string {
  if (text.length === 0) {
    return text;
  }
  const first = text.charAt(0).toUpperCase();
  return `${first}${text.slice(1)}`;
}

/**
 * One line, named, short enough to read at a glance across four cards.
 *
 * Named because four unlabelled lines moving at once is noise; the whole point
 * is seeing which bot is thinking what.
 */
function narrate(seatLabel: string, line: string): string {
  const trimmed = line.trim().replace(/\s+/gu, " ");
  if (trimmed.length === 0) {
    return `${seatLabel} is working on this part.`;
  }
  const bounded = trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
  return `${seatLabel}: ${bounded}`;
}

function computeHeadline(round: CrewRunView["round"], parts: readonly InternalPart[]): string {
  const total = parts.length;
  const working = parts.filter(p => p.state === "working" || p.state === "claimed").length;
  const refining = parts.filter(p => p.state === "refining").length;
  const waiting = parts.filter(p => p.state === "waiting").length;
  const answered = parts.filter(p => p.state === "answered").length;
  const done = parts.filter(p => p.state === "done").length;
  const failed = parts.filter(p => p.state === "failed").length;
  const stopped = parts.filter(p => p.state === "stopped").length;

  if (round === "stopped") {
    const finished = done + answered;
    if (finished > 0) {
      return `Stopped. ${capitalize(formatBotCount(finished))} finished, ${formatCount(stopped)} stopped.`;
    }
    return `Stopped. ${capitalize(formatBotCount(stopped))} stopped.`;
  }

  if (round === "failed") {
    return `Failed. ${capitalize(formatBotCount(failed))} failed.`;
  }

  if (round === "done") {
    if (failed > 0) {
      return `${capitalize(formatBotCount(done))} finished, ${formatCount(failed)} failed.`;
    }
    if (stopped > 0) {
      return `${capitalize(formatBotCount(done))} finished, ${formatCount(stopped)} stopped.`;
    }
    return `${capitalize(formatBotCount(done))} finished.`;
  }

  if (round === "reading-each-other") {
    if (refining > 0) {
      return `${capitalize(formatBotCount(refining))} reading each other's answers.`;
    }
    return "Reading each other's answers.";
  }

  const busy = working;
  const finished = answered + done;
  if (busy > 0 && finished > 0) {
    return `${capitalize(formatBotCount(busy))} working, ${formatCount(finished)} finished.`;
  }
  if (busy > 0 && waiting > 0) {
    return `${capitalize(formatBotCount(busy))} working, ${formatCount(waiting)} waiting.`;
  }
  if (busy > 0) {
    return `${capitalize(formatBotCount(busy))} working.`;
  }
  if (waiting > 0 && finished > 0) {
    return `${capitalize(formatBotCount(finished))} finished, ${formatCount(waiting)} waiting.`;
  }
  if (waiting > 0) {
    return `${capitalize(formatBotCount(waiting))} waiting to start.`;
  }
  if (finished > 0) {
    return `${capitalize(formatBotCount(finished))} finished.`;
  }

  return `${capitalize(formatBotCount(total))} in progress.`;
}

function isPartStoppable(state: CrewPartState): boolean {
  return state === "waiting" || state === "claimed" || state === "working" || state === "refining";
}

function isRunStoppable(round: CrewRunView["round"]): boolean {
  return round === "splitting" || round === "working" || round === "reading-each-other";
}

function buildPartView(part: InternalPart, nowMs: number): CrewPartView {
  return {
    id: part.id,
    title: part.title,
    seatLabel: part.seatLabel,
    state: part.state,
    line: part.line,
    elapsed: formatElapsed(part.startedAt, part.finishedAt, nowMs),
    answerTurnId: part.answerTurnId,
    refinedFrom: part.refinedFrom,
    canStop: isPartStoppable(part.state)
  };
}

function buildRunView(run: InternalRun, nowMs: number): CrewRunView {
  return {
    runId: run.runId,
    caseId: run.caseId,
    request: run.request,
    parts: run.parts.map(p => buildPartView(p, nowMs)),
    round: run.round,
    headline: computeHeadline(run.round, run.parts),
    canStop: isRunStoppable(run.round)
  };
}

export interface CrewRunCoordinator {
  readonly start: (input: WorkstationCrewStartInput) => Promise<{ readonly runId: string }>;
  readonly poll: (input: WorkstationCrewPollInput) => CrewRunView;
  readonly stop: (input: WorkstationCrewStopInput) => CrewRunView;
}

export function createCrewRunCoordinator(options: InstallCrewRunOptions): CrewRunCoordinator {
  const now = options.now ?? Date.now;
  let currentRun: InternalRun | null = null;

  function dispatch(targetRun: InternalRun): void {
    if (targetRun.abortController.signal.aborted) {
      return;
    }

    let madeProgress = false;
    for (const part of targetRun.parts) {
      if (part.state !== "waiting") {
        continue;
      }

      let depFailed = false;
      let depStopped = false;
      let allDepsMet = true;

      for (const depId of part.dependsOn) {
        const dep = targetRun.parts.find(p => p.id === depId);
        if (dep === undefined || dep.state === "failed") {
          depFailed = true;
          break;
        }
        if (dep.state === "stopped") {
          depStopped = true;
          break;
        }
        if (dep.state !== "answered" && dep.state !== "done") {
          allDepsMet = false;
        }
      }

      if (depFailed) {
        part.state = "failed";
        part.line = "Could not start because an earlier part failed.";
        part.finishedAt = now();
        madeProgress = true;
        continue;
      }

      if (depStopped) {
        part.state = "failed";
        part.line = "Could not start because an earlier part was stopped.";
        part.finishedAt = now();
        madeProgress = true;
        continue;
      }

      if (allDepsMet) {
        part.state = "working";
        part.line = `${part.seatLabel} is working on this part.`;
        part.startedAt = now();
        madeProgress = true;
        void runPart(targetRun, part);
      }
    }

    if (madeProgress) {
      dispatch(targetRun);
      return;
    }

    checkFirstPhaseCompletion(targetRun);
  }

  async function runPart(targetRun: InternalRun, part: InternalPart): Promise<void> {
    if (targetRun.abortController.signal.aborted || part.abortController.signal.aborted) {
      part.state = "stopped";
      part.line = "Stopped.";
      part.finishedAt = now();
      dispatch(targetRun);
      return;
    }

    try {
      const result = await options.ask({
        seatId: part.seatId,
        prompt: part.prompt,
        signal: part.abortController.signal,
        onActivity: (line: string) => {
          if (part.state === "working") {
            part.line = narrate(part.seatLabel, line);
          }
        }
      });

      if (targetRun.abortController.signal.aborted || part.abortController.signal.aborted) {
        part.state = "stopped";
        part.line = "Stopped.";
        part.finishedAt = now();
        dispatch(targetRun);
        return;
      }

      const turnId = await options.record({
        caseId: targetRun.caseId,
        seatLabel: part.seatLabel,
        body: result.text
      });

      if (targetRun.abortController.signal.aborted || part.abortController.signal.aborted) {
        part.state = "stopped";
        part.line = "Stopped.";
        part.finishedAt = now();
        dispatch(targetRun);
        return;
      }

      part.answerTurnId = turnId;
      part.state = "answered";
      part.line = "Answer recorded in the case.";
      part.finishedAt = now();
    } catch {
      if (targetRun.abortController.signal.aborted || part.abortController.signal.aborted) {
        part.state = "stopped";
        part.line = "Stopped.";
      } else {
        part.state = "failed";
        part.line = `${part.seatLabel} could not answer.`;
      }
      part.finishedAt = now();
    } finally {
      dispatch(targetRun);
    }
  }

  function checkFirstPhaseCompletion(targetRun: InternalRun): void {
    if (targetRun.round !== "working") {
      return;
    }

    const hasActive = targetRun.parts.some(
      p => p.state === "waiting" || p.state === "claimed" || p.state === "working"
    );
    if (hasActive) {
      return;
    }

    const answered = targetRun.parts.filter(p => p.state === "answered");
    if (answered.length === 0) {
      const allStopped = targetRun.parts.every(p => p.state === "stopped");
      targetRun.round = allStopped ? "stopped" : "failed";
      return;
    }

    const canRefine = answered.filter(
      p => p.refinePrompt !== undefined && p.refinePrompt.trim().length > 0
    );

    if (canRefine.length === 0) {
      for (const p of answered) {
        p.state = "done";
        p.line = "Finished.";
      }
      const allStopped = targetRun.parts.every(p => p.state === "stopped");
      const allFailed = targetRun.parts.every(p => p.state === "failed");
      targetRun.round = allStopped ? "stopped" : allFailed ? "failed" : "done";
      return;
    }

    targetRun.round = "reading-each-other";

    for (const p of answered) {
      if (p.refinePrompt === undefined || p.refinePrompt.trim().length === 0) {
        p.state = "done";
        p.line = "Finished.";
      }
    }

    for (const p of canRefine) {
      p.state = "refining";
      p.line = `${p.seatLabel} is reviewing answers from other bots.`;
      p.refinedFrom = targetRun.parts
        .filter(other => other.id !== p.id && other.answerTurnId !== null)
        .map(other => other.id);
    }

    void runRefinePhase(targetRun, canRefine);
  }

  async function runRefinePhase(
    targetRun: InternalRun,
    refiningParts: readonly InternalPart[]
  ): Promise<void> {
    await Promise.all(
      refiningParts.map(async (part) => {
        if (targetRun.abortController.signal.aborted || part.abortController.signal.aborted) {
          part.state = "stopped";
          part.line = "Stopped.";
          part.finishedAt = now();
          return;
        }

        try {
          const result = await options.ask({
            onActivity: (line: string) => {
              if (part.state === "refining" || part.state === "working") {
                part.line = narrate(part.seatLabel, line);
              }
            },
            seatId: part.seatId,
            prompt: part.refinePrompt!,
            signal: part.abortController.signal
          });

          if (targetRun.abortController.signal.aborted || part.abortController.signal.aborted) {
            part.state = "stopped";
            part.line = "Stopped.";
            part.finishedAt = now();
            return;
          }

          const turnId = await options.record({
            caseId: targetRun.caseId,
            seatLabel: part.seatLabel,
            body: result.text
          });

          part.answerTurnId = turnId;
          part.state = "done";
          part.line = "Finished.";
          part.finishedAt = now();
        } catch {
          if (targetRun.abortController.signal.aborted || part.abortController.signal.aborted) {
            part.state = "stopped";
            part.line = "Stopped.";
          } else {
            part.state = "failed";
            part.line = `${part.seatLabel} could not refine the answer.`;
          }
          part.finishedAt = now();
        }
      })
    );

    if (targetRun.abortController.signal.aborted) {
      targetRun.round = "stopped";
      return;
    }

    const allStopped = targetRun.parts.every(p => p.state === "stopped");
    const allFailed = targetRun.parts.every(p => p.state === "failed");
    targetRun.round = allStopped ? "stopped" : allFailed ? "failed" : "done";
  }

  return {
    async start(input: WorkstationCrewStartInput): Promise<{ readonly runId: string }> {
      if (
        currentRun !== null &&
        (currentRun.round === "splitting" ||
          currentRun.round === "working" ||
          currentRun.round === "reading-each-other")
      ) {
        throw new Error("A crew run is already in progress. Wait for it to finish or stop it first.");
      }

      validateParts(input.parts);

      const runId = randomUUID();
      const internalParts: InternalPart[] = input.parts.map((p) => {
        const part: InternalPart = {
          id: p.id,
          title: p.title,
          prompt: p.prompt,
          seatId: p.seatId,
          seatLabel: p.seatLabel,
          dependsOn: p.dependsOn,
          ...(p.refinePrompt !== undefined && p.refinePrompt.trim().length > 0
            ? { refinePrompt: p.refinePrompt }
            : {}),
          state: "waiting",
          line: "Waiting for earlier parts to finish.",
          startedAt: null,
          finishedAt: null,
          answerTurnId: null,
          refinedFrom: [],
          abortController: new AbortController()
        };
        return part;
      });

      const run: InternalRun = {
        runId,
        caseId: input.caseId,
        request: input.request,
        parts: internalParts,
        round: "working",
        abortController: new AbortController()
      };
      currentRun = run;

      dispatch(run);

      return { runId };
    },

    poll(input: WorkstationCrewPollInput): CrewRunView {
      if (currentRun === null || currentRun.runId !== input.runId) {
        throw new Error("This crew run is no longer in memory. Runs do not survive an app restart.");
      }
      return buildRunView(currentRun, now());
    },

    stop(input: WorkstationCrewStopInput): CrewRunView {
      if (currentRun === null || currentRun.runId !== input.runId) {
        throw new Error("This crew run is no longer in memory. Runs do not survive an app restart.");
      }

      const targetRun = currentRun;

      if (input.partId !== undefined) {
        const part = targetRun.parts.find(p => p.id === input.partId);
        if (part === undefined) {
          throw new Error("Part not found in this crew run.");
        }

        if (isPartStoppable(part.state)) {
          part.abortController.abort();
          part.state = "stopped";
          part.line = "Stopped.";
          if (part.finishedAt === null) {
            part.finishedAt = now();
          }
          dispatch(targetRun);
        }

        return buildRunView(targetRun, now());
      }

      targetRun.abortController.abort();
      targetRun.round = "stopped";

      for (const part of targetRun.parts) {
        if (isPartStoppable(part.state)) {
          part.abortController.abort();
          part.state = "stopped";
          part.line = "Stopped.";
          if (part.finishedAt === null) {
            part.finishedAt = now();
          }
        }
      }

      return buildRunView(targetRun, now());
    }
  };
}

export function installCrewRun(options: InstallCrewRunOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  const coordinator = createCrewRunCoordinator(options);

  ipcMain.handle(
    IPC_CHANNELS.workstationCrewStart,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<{ readonly runId: string }> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationCrewStartInputSchema.parse(input);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while starting the crew run.");
      }

      return coordinator.start(request);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationCrewPoll,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<CrewRunView> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationCrewPollInputSchema.parse(input);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while polling the crew run.");
      }

      return coordinator.poll(request);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationCrewStop,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<CrewRunView> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationCrewStopInputSchema.parse(input);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while stopping the crew run.");
      }

      return coordinator.stop(request);
    }
  );
}
