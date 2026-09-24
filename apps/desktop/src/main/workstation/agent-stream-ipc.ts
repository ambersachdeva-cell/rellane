import { randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";

export type AgentRunState =
  | "planning"
  | "awaiting-approval"
  | "running"
  | "stopping"
  | "done"
  | "stopped"
  | "failed";

export interface AgentStepView {
  readonly index: number;
  readonly kind: "thought" | "tool" | "answer" | "refusal";
  readonly title: string;
  readonly detail: string;
  readonly toolLabel: string | null;
  readonly at: number;
  readonly durationMs: number | null;
  readonly ok: boolean | null;
}

export interface AgentRunView {
  readonly runId: string;
  readonly caseId: string;
  readonly goal: string;
  readonly state: AgentRunState;
  readonly steps: readonly RawAgentStep[];
  readonly headline: string;
  readonly stepsUsed: number;
  readonly stepsAllowed: number;
  readonly canStop: boolean;
}

/**
 * What the main process actually observed about one step.
 *
 * Deliberately not the shape the screen shows. Deciding that a tool called
 * `rellane_read_source` reads as 'Read "the brief"' is a wording decision, and
 * wording decisions belong next to the screen making them — `agent-run-view` in
 * the renderer owns that, and owning it in one place is why the same step cannot
 * be described two different ways.
 */
export interface RawAgentStep {
  readonly index: number;
  readonly thought: string;
  readonly toolName: string | null;
  readonly toolArgs: string;
  readonly toolResult: string;
  readonly toolFailed: boolean;
  readonly answer: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export const WORKSTATION_AGENT_GOAL_LIMIT = 10_000;
export const WORKSTATION_AGENT_SOURCE_TURNS_LIMIT = 50;
export const MAX_FINISHED_RUNS = 3;

export const WorkstationAgentStartInputSchema = z.object({
  caseId: z.string().min(1),
  goal: z.string().min(1).max(WORKSTATION_AGENT_GOAL_LIMIT),
  sourceTurnIds: z.array(z.string()).max(WORKSTATION_AGENT_SOURCE_TURNS_LIMIT).optional()
});

export type WorkstationAgentStartInput = z.infer<typeof WorkstationAgentStartInputSchema>;

export const WorkstationAgentPollInputSchema = z.object({
  runId: z.string().min(1)
});

export type WorkstationAgentPollInput = z.infer<typeof WorkstationAgentPollInputSchema>;

export const WorkstationAgentStopInputSchema = z.object({
  runId: z.string().min(1)
});

export type WorkstationAgentStopInput = z.infer<typeof WorkstationAgentStopInputSchema>;

export interface WorkstationAgentStartResult {
  readonly runId: string;
}

export interface WorkstationAgentPollResult {
  readonly state: AgentRunState;
  readonly steps: readonly RawAgentStep[];
  readonly answer?: string;
  readonly failure?: string;
}

export interface WorkstationAgentStopResult {
  readonly state: AgentRunState;
}

export interface InstallAgentStreamOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** Starts the actual run. Resolves when it finishes. */
  readonly startRun: (input: {
    readonly runId: string;
    readonly caseId: string;
    readonly goal: string;
    readonly sourceTurnIds: readonly string[];
    readonly onStep: (step: RawAgentStep) => void;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly answer: string; readonly failure?: string }>;
}

interface AgentRunRecord {
  readonly runId: string;
  readonly caseId: string;
  readonly goal: string;
  readonly owner: unknown;
  readonly controller: AbortController;
  state: AgentRunState;
  readonly steps: RawAgentStep[];
  answer?: string;
  failure?: string;
}

export function installAgentStream(options: InstallAgentStreamOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent): unknown => owners(event.sender, event.senderFrame);

  const runs = new Map<string, AgentRunRecord>();
  const finishedRunIds: string[] = [];
  let activeRunId: string | null = null;

  const markRunFinished = (record: AgentRunRecord): void => {
    if (activeRunId === record.runId) {
      activeRunId = null;
    }
    if (!finishedRunIds.includes(record.runId)) {
      finishedRunIds.push(record.runId);
    }
    // Limit memory footprint by keeping only the three most recent finished runs for polling.
    while (finishedRunIds.length > MAX_FINISHED_RUNS) {
      const oldestId = finishedRunIds.shift();
      if (oldestId !== undefined) {
        runs.delete(oldestId);
      }
    }
  };

  ipcMain.handle(
    IPC_CHANNELS.workstationAgentStart,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<WorkstationAgentStartResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationAgentStartInputSchema.parse(input);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while starting the agent run.");
      }

      if (activeRunId !== null) {
        const activeRun = runs.get(activeRunId);
        if (
          activeRun &&
          (activeRun.state === "running" ||
            activeRun.state === "planning" ||
            activeRun.state === "awaiting-approval" ||
            activeRun.state === "stopping")
        ) {
          throw new Error(
            "An agent run is already in progress. Please wait for it to finish or stop it before starting a new one."
          );
        }
      }

      const runId = randomUUID();
      const controller = new AbortController();
      const record: AgentRunRecord = {
        runId,
        caseId: request.caseId,
        goal: request.goal,
        owner,
        controller,
        state: "running",
        steps: []
      };

      runs.set(runId, record);
      activeRunId = runId;

      const sourceTurnIds = request.sourceTurnIds ?? [];

      void options
        .startRun({
          runId,
          caseId: request.caseId,
          goal: request.goal,
          sourceTurnIds,
          onStep: (step: RawAgentStep) => {
            record.steps.push(step);
          },
          signal: controller.signal
        })
        .then(
          (result) => {
            if (record.controller.signal.aborted || record.state === "stopping") {
              record.state = "stopped";
            } else if (result.failure !== undefined) {
              record.state = "failed";
              record.failure = result.failure;
              if (result.answer !== undefined) {
                record.answer = result.answer;
              }
            } else {
              record.state = "done";
              record.answer = result.answer;
            }
            markRunFinished(record);
          },
          (error: unknown) => {
            if (record.controller.signal.aborted || record.state === "stopping") {
              record.state = "stopped";
            } else {
              record.state = "failed";
              const message =
                error instanceof Error ? error.message.split("\n")[0]! : "The agent run failed.";
              record.failure = message.length > 0 ? message : "The agent run failed.";
            }
            markRunFinished(record);
          }
        );

      return { runId };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationAgentPoll,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<WorkstationAgentPollResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationAgentPollInputSchema.parse(input);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while polling the agent run.");
      }

      const record = runs.get(request.runId);
      if (!record) {
        throw new Error("This agent run is unknown. Nothing about a run survives a restart.");
      }

      // Reject polls originating from a different frame or navigation context.
      if (record.owner !== owner) {
        throw new Error("This window changed while polling the agent run.");
      }

      const result: WorkstationAgentPollResult = {
        state: record.state,
        steps: [...record.steps],
        ...(record.answer !== undefined ? { answer: record.answer } : {}),
        ...(record.failure !== undefined ? { failure: record.failure } : {})
      };

      return result;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationAgentStop,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<WorkstationAgentStopResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationAgentStopInputSchema.parse(input);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while stopping the agent run.");
      }

      const record = runs.get(request.runId);
      if (!record) {
        // Unknown or completed runs are reported in their terminal state rather than failing.
        return { state: "stopped" };
      }

      if (
        record.state === "running" ||
        record.state === "planning" ||
        record.state === "awaiting-approval"
      ) {
        record.state = "stopping";
        record.controller.abort();
      }

      return { state: record.state };
    }
  );
}
