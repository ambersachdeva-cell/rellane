import { randomBytes, randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import type { WorkstationProviderId, WorkstationReview } from "@cadrane/contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { StoredAgentContract } from "./agent-store-ipc.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import {
  nativeAskCompleted,
  nativeAskDetail,
  nativeAskEffectiveReason,
  type NativeAskOutcome
} from "./types.js";

export type AgentRunState =
  | "planning"
  | "awaiting-approval"
  | "running"
  | "stopping"
  | "done"
  | "stopped"
  | "failed"
  | "interrupted";

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
  readonly nativeOutcomes?: readonly NativeAskOutcome[];
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
  }) => Promise<{ readonly answer: string; readonly failure?: string; readonly nativeOutcomes?: readonly NativeAskOutcome[] }>;
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
  nativeOutcomes?: readonly NativeAskOutcome[];
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
            if (result.nativeOutcomes !== undefined) record.nativeOutcomes = result.nativeOutcomes;
            record.answer = result.answer;
            if (record.controller.signal.aborted || record.state === "stopping" || result.nativeOutcomes?.some(outcome => nativeAskEffectiveReason(outcome) === "stopped")) {
              record.state = "stopped";
            } else if (result.failure !== undefined) {
              record.state = "failed";
              record.failure = result.failure;
            } else if (result.answer.trim().length === 0) {
              record.state = "failed";
              record.failure = "The agent finished without an answer.";
            } else {
              record.state = "done";
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
        ...(record.failure !== undefined ? { failure: record.failure } : {}),
        ...(record.nativeOutcomes !== undefined ? { nativeOutcomes: record.nativeOutcomes } : {})
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

export const WorkstationAgentPrepareStepInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(WORKSTATION_AGENT_GOAL_LIMIT).optional(),
  goal: z.string().trim().min(1).max(WORKSTATION_AGENT_GOAL_LIMIT).optional(),
  providerId: z.string().min(1).optional(),
  modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u).optional(),
  sourceTurnIds: z.array(z.string().min(1)).max(WORKSTATION_AGENT_SOURCE_TURNS_LIMIT).optional()
    .refine((ids) => ids === undefined || new Set(ids).size === ids.length, "Choose each source once.")
});

export const WorkstationAgentPrepareInputSchema = z.strictObject({
  caseId: z.string().min(1),
  prompt: z.string().trim().min(1).max(WORKSTATION_AGENT_GOAL_LIMIT).optional(),
  goal: z.string().trim().min(1).max(WORKSTATION_AGENT_GOAL_LIMIT).optional(),
  providerId: z.string().min(1).optional(),
  modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u).optional(),
  sourceTurnIds: z.array(z.string().min(1)).max(WORKSTATION_AGENT_SOURCE_TURNS_LIMIT).optional()
    .refine((ids) => ids === undefined || new Set(ids).size === ids.length, "Choose each source once."),
  savedAgent: z.strictObject({
    id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/u),
    origin: z.enum(["bundled", "user"]),
    expectedRevision: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedOutput: z.string().trim().min(1).max(2000),
    requestedToolScopes: z.array(z.enum(["none", "review-each-call"])).min(1).max(1).optional()
  }).optional(),
  steps: z.array(WorkstationAgentPrepareStepInputSchema).min(1).max(10).optional()
}).superRefine((data, ctx) => {
  if (data.savedAgent && data.steps) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A saved agent invocation cannot also supply generated steps." });
  }
  if (data.steps && data.steps.length > 0) {
    for (let i = 0; i < data.steps.length; i++) {
      const s = data.steps[i]!;
      const text = s.prompt ?? s.goal;
      if (!text || text.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Step ${i} requires a prompt or goal.` });
      }
      const providerId = s.providerId ?? data.providerId;
      if (!providerId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Step ${i} requires a providerId.` });
      }
      const modelId = s.modelId ?? data.modelId;
      if (!modelId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Step ${i} requires a modelId.` });
      }
    }
  } else {
    const text = data.prompt ?? data.goal;
    if (!text || text.trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A prompt or goal is required." });
    }
    if (!data.providerId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "providerId is required." });
    }
    if (!data.modelId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "modelId is required." });
    }
  }
});

export type WorkstationAgentPrepareInput = z.infer<typeof WorkstationAgentPrepareInputSchema>;

export const WorkstationAgentStartReviewedInputSchema = z.strictObject({
  token: z.string().regex(/^[0-9a-f]{64}$/u)
});

export type WorkstationAgentStartReviewedInput = z.infer<typeof WorkstationAgentStartReviewedInputSchema>;

export interface WorkstationAgentPrepareResult {
  readonly token: string;
  readonly expiresAt: number;
  readonly reviews: readonly Omit<WorkstationReview, "token">[];
}

export interface InstallReviewedAgentStreamOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly ownerFor: (event: IpcMainInvokeEvent) => object;
  readonly resolveSavedAgent?: (input: {
    readonly id: string;
    readonly origin: "bundled" | "user";
    readonly expectedRevision: string;
    readonly task: string;
    readonly expectedOutput: string;
    readonly requestedToolScopes: readonly ("none" | "review-each-call")[];
  }) => Promise<StoredAgentContract>;
  readonly prepareChild: (input: {
    readonly caseId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly prompt: string;
    readonly sourceTurnIds: readonly string[];
    readonly owner: object;
  }) => Promise<WorkstationReview>;
  readonly runChild: (input: {
    readonly review: WorkstationReview;
    readonly owner: object;
    readonly signal: AbortSignal;
    readonly onActivity?: (line: string) => void;
    readonly onStep?: (step: RawAgentStep) => void;
  }) => Promise<NativeAskOutcome & { readonly turnId: string | null }>;
  readonly persistParent: (input: {
    readonly event: "parent";
    readonly runId: string;
    readonly caseId: string;
    readonly prompt: string;
    readonly brief?: string;
    readonly agentContract?: Omit<StoredAgentContract, "fullPrompt">;
    readonly at: number;
    readonly children: readonly {
      readonly providerId: string;
      readonly label: string;
      readonly modelId: string;
      readonly contextSnapshotId: string;
      readonly sourceHash: string;
    }[];
  }) => Promise<void>;
  readonly persistChild: (
    caseId: string,
    input: {
      readonly event: "child";
      readonly runId: string;
      readonly index: number;
      readonly state: "starting" | "answered" | "stopped" | "failed" | "interrupted";
      readonly at: number;
      readonly line: string;
      readonly answerTurnId: string | null;
      readonly draftTurnId: string | null;
      readonly chars: number;
      readonly attempt?: {
        attemptId: string;
        contextSnapshotId: string;
        sourceHash: string;
        providerId: WorkstationProviderId;
        modelId: string;
      };
    }
  ) => Promise<void>;
  readonly recover?: (runId: string) => Promise<WorkstationAgentPollResult | null>;
  readonly now?: () => number;
}

interface PendingReviewedManifest {
  readonly owner: object;
  readonly caseId: string;
  readonly prompt: string;
  readonly reviews: readonly WorkstationReview[];
  readonly expiresAt: number;
  readonly sourceTurnIds: readonly string[];
  readonly agentContract?: Omit<StoredAgentContract, "fullPrompt">;
}

interface InternalReviewedRun {
  readonly runId: string;
  readonly caseId: string;
  readonly prompt: string;
  readonly owner: object;
  readonly controller: AbortController;
  state: AgentRunState;
  readonly steps: RawAgentStep[];
  readonly reviews: readonly WorkstationReview[];
  answer?: string;
  failure?: string;
  readonly nativeOutcomes: NativeAskOutcome[];
}

function requiredReviewBinding(review: WorkstationReview): {
  providerId: WorkstationProviderId;
  modelId: string;
  contextSnapshotId: string;
  sourceHash: string;
} {
  const { providerId, modelId, contextSnapshotId, sourceHash } = review;
  if (!providerId || !modelId || !contextSnapshotId || !sourceHash) {
    throw new Error("An agent step has no saved context or chosen model. Nothing was sent.");
  }
  return { providerId, modelId, contextSnapshotId, sourceHash };
}

export function installReviewedAgentStream(options: InstallReviewedAgentStreamOptions): {
  readonly cancelOwner: (owner: object) => Promise<void>;
  readonly shutdown: () => Promise<void>;
  readonly stopActive: () => Promise<boolean>;
} {
  const clock = options.now ?? (() => Date.now());
  const pending = new Map<string, PendingReviewedManifest>();
  const revokedOwners = new WeakSet<object>();
  const runs = new Map<string, InternalReviewedRun>();
  const finishedRunIds: string[] = [];
  let activeRun: InternalReviewedRun | null = null;

  const ownerFor = options.ownerFor;

  const markRunFinished = (record: InternalReviewedRun): void => {
    if (activeRun?.runId === record.runId) {
      activeRun = null;
    }
    if (!finishedRunIds.includes(record.runId)) {
      finishedRunIds.push(record.runId);
    }
    while (finishedRunIds.length > MAX_FINISHED_RUNS) {
      const oldestId = finishedRunIds.shift();
      if (oldestId !== undefined && oldestId !== activeRun?.runId) {
        runs.delete(oldestId);
      }
    }
  };

  const stopActive = async (): Promise<boolean> => {
    if (
      !activeRun ||
      (activeRun.state !== "running" &&
        activeRun.state !== "planning" &&
        activeRun.state !== "awaiting-approval" &&
        activeRun.state !== "stopping")
    ) {
      return false;
    }
    if (activeRun.state === "stopping") return false;
    activeRun.state = "stopping";
    activeRun.controller.abort();
    return true;
  };

  ipcMain.handle(
    IPC_CHANNELS.workstationAgentPrepare,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<WorkstationAgentPrepareResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);
      if (revokedOwners.has(owner)) {
        throw new Error("That agent window is no longer active.");
      }

      const request = WorkstationAgentPrepareInputSchema.parse(input);
      if (ownerFor(event) !== owner || revokedOwners.has(owner)) {
        throw new Error("That agent window is no longer active.");
      }

      let agentContract: StoredAgentContract | undefined;
      if (request.savedAgent) {
        if (!options.resolveSavedAgent) throw new Error("Saved agent invocation is unavailable.");
        const task = (request.prompt ?? request.goal)!;
        const scopes = request.savedAgent.requestedToolScopes ?? ["none"];
        if (scopes.length !== 1 || scopes[0] !== "none") {
          throw new Error("Saved agent tool requests need a separate reviewed tool call and cannot run here.");
        }
        agentContract = await options.resolveSavedAgent({
          id: request.savedAgent.id,
          origin: request.savedAgent.origin,
          expectedRevision: request.savedAgent.expectedRevision,
          task,
          expectedOutput: request.savedAgent.expectedOutput,
          requestedToolScopes: scopes
        });
        if (agentContract.agentId !== request.savedAgent.id ||
            agentContract.origin !== request.savedAgent.origin ||
            agentContract.revision !== request.savedAgent.expectedRevision ||
            agentContract.fullPrompt.length > WORKSTATION_AGENT_GOAL_LIMIT) {
          throw new Error("Saved agent contract changed or exceeds this run's limit. Review it again.");
        }
        if (ownerFor(event) !== owner || revokedOwners.has(owner)) {
          throw new Error("That agent window is no longer active.");
        }
      }

      const rawSteps =
        request.steps && request.steps.length > 0
          ? request.steps.map((s) => ({
              prompt: (s.prompt ?? s.goal)!,
              providerId: (s.providerId ?? request.providerId)!,
              modelId: (s.modelId ?? request.modelId)!,
              sourceTurnIds: s.sourceTurnIds ?? request.sourceTurnIds ?? []
            }))
          : [
              {
                prompt: agentContract?.fullPrompt ?? (request.prompt ?? request.goal)!,
                providerId: request.providerId!,
                modelId: request.modelId!,
                sourceTurnIds: request.sourceTurnIds ?? []
              }
            ];

      const reviews: WorkstationReview[] = [];
      for (const step of rawSteps) {
        const review = await options.prepareChild({
          caseId: request.caseId,
          providerId: step.providerId,
          modelId: step.modelId,
          prompt: step.prompt,
          sourceTurnIds: step.sourceTurnIds,
          owner
        });
        if (
          review.caseId !== request.caseId ||
          review.providerId !== step.providerId ||
          review.modelId !== step.modelId
        ) {
          throw new Error("An agent step review did not match its selected connection and model.");
        }
        reviews.push(review);
      }

      if (revokedOwners.has(owner)) {
        throw new Error("That agent window is no longer active.");
      }

      const token = randomBytes(32).toString("hex");
      const expiresAt = Math.min(...reviews.map((r) => r.expiresAt));

      for (const [key, value] of pending) {
        if (value.expiresAt < clock()) {
          pending.delete(key);
        }
      }
      if (pending.size >= 8) {
        const oldestKey = pending.keys().next().value;
        if (oldestKey !== undefined) {
          pending.delete(oldestKey);
        }
      }

      pending.set(token, {
        owner,
        caseId: request.caseId,
        prompt: rawSteps[0]!.prompt,
        reviews,
        expiresAt,
        sourceTurnIds: rawSteps[0]!.sourceTurnIds,
        ...(agentContract ? { agentContract: {
          agentId: agentContract.agentId,
          origin: agentContract.origin,
          revision: agentContract.revision,
          contractHash: agentContract.contractHash,
          expectedOutput: agentContract.expectedOutput,
          requestedToolScopes: agentContract.requestedToolScopes
        } } : {})
      });

      return {
        token,
        expiresAt,
        reviews: reviews.map(({ token: _childToken, ...shown }) => shown)
      };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationAgentStart,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<WorkstationAgentStartResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationAgentStartReviewedInputSchema.parse(input);
      const manifest = pending.get(request.token);
      pending.delete(request.token);

      if (
        manifest === undefined ||
        manifest.owner !== owner ||
        revokedOwners.has(manifest.owner) ||
        clock() > manifest.expiresAt
      ) {
        throw new Error("That agent review expired or belongs to another window. Review it again.");
      }

      if (activeRun !== null && (activeRun.state === "running" || activeRun.state === "stopping")) {
        throw new Error(
          "An agent run is already in progress. Please wait for it to finish or stop it before starting a new one."
        );
      }

      for (const review of manifest.reviews) requiredReviewBinding(review);

      const runId = randomUUID();
      const controller = new AbortController();
      const runRecord: InternalReviewedRun = {
        runId,
        caseId: manifest.caseId,
        prompt: manifest.prompt,
        owner: manifest.owner,
        controller,
        state: "running",
        steps: [],
        reviews: manifest.reviews,
        nativeOutcomes: []
      };
      runs.set(runId, runRecord);
      activeRun = runRecord;

      try {
        await options.persistParent({
          event: "parent",
          runId,
          caseId: manifest.caseId,
          prompt: manifest.prompt,
          brief: manifest.prompt,
          ...(manifest.agentContract ? { agentContract: manifest.agentContract } : {}),
          at: clock(),
          children: manifest.reviews.map((review) => ({
            ...requiredReviewBinding(review),
            label: review.providerLabel ?? review.providerId,
          }))
        });
      } catch (error) {
        runRecord.state = "failed";
        runRecord.failure = "Could not save the parent manifest. Nothing was sent.";
        markRunFinished(runRecord);
        throw error;
      }

      if (
        controller.signal.aborted ||
        runRecord.state === "stopping" ||
        revokedOwners.has(manifest.owner)
      ) {
        runRecord.state = "stopped";
        for (let j = 0; j < manifest.reviews.length; j++) {
          try {
            await options.persistChild(runRecord.caseId, {
              event: "child",
              runId,
              index: j,
              state: "stopped",
              at: clock(),
              line: "Stopped before provider dispatch.",
              answerTurnId: null,
              draftTurnId: null,
              chars: 0
            });
          } catch {
            // Receipt remains
          }
        }
        markRunFinished(runRecord);
        if (revokedOwners.has(manifest.owner)) {
          throw new Error("That agent window closed before dispatch. No provider was started.");
        }
        return { runId };
      }

      void (async () => {
        for (let i = 0; i < manifest.reviews.length; i++) {
          const review = manifest.reviews[i]!;
          if (
            controller.signal.aborted ||
            revokedOwners.has(manifest.owner)
          ) {
            runRecord.state = "stopped";
            for (let j = i; j < manifest.reviews.length; j++) {
              try {
                await options.persistChild(runRecord.caseId, {
                  event: "child",
                  runId,
                  index: j,
                  state: "stopped",
                  at: clock(),
                  line: "Stopped before provider dispatch.",
                  answerTurnId: null,
                  draftTurnId: null,
                  chars: 0
                });
              } catch {
                // Receipt remains
              }
            }
            markRunFinished(runRecord);
            return;
          }

          const attempt = {
            attemptId: randomUUID(),
            ...requiredReviewBinding(review)
          };

          try {
            await options.persistChild(runRecord.caseId, {
              event: "child",
              runId,
              index: i,
              state: "starting",
              at: clock(),
              line: "Host admission pending.",
              answerTurnId: null,
              draftTurnId: null,
              chars: 0,
              attempt
            });
          } catch {
            runRecord.state = "failed";
            runRecord.failure = "Could not save the child intent. Nothing was sent.";
            markRunFinished(runRecord);
            return;
          }

          if (
            controller.signal.aborted ||
            runRecord.state === "stopping" ||
            revokedOwners.has(manifest.owner)
          ) {
            runRecord.state = "stopped";
            for (let j = i; j < manifest.reviews.length; j++) {
              try {
                await options.persistChild(runRecord.caseId, {
                  event: "child",
                  runId,
                  index: j,
                  state: "stopped",
                  at: clock(),
                  line: "Stopped before provider dispatch.",
                  answerTurnId: null,
                  draftTurnId: null,
                  chars: 0,
                  ...(j === i ? { attempt } : {})
                });
              } catch {
                // Receipt remains
              }
            }
            markRunFinished(runRecord);
            return;
          }

          const stepStartedAt = clock();
          try {
            const result = await options.runChild({
              review,
              owner: manifest.owner,
              signal: controller.signal
            });

            runRecord.nativeOutcomes.push(result);
            const completed = nativeAskCompleted(result);
            const stopped = result.finishReason === "stopped";
            const stepEndedAt = clock();

            const stepRecord: RawAgentStep = {
              index: i,
              thought: review.contextPreview ?? manifest.prompt,
              toolName: null,
              toolArgs: "",
              toolResult: "",
              toolFailed: !completed && !stopped,
              answer: result.text,
              startedAt: stepStartedAt,
              endedAt: stepEndedAt
            };
            runRecord.steps.push(stepRecord);

            const childState = completed ? "answered" : stopped ? "stopped" : "failed";
            const line = completed
              ? result.text.trim().split(/\r?\n/u)[0] ?? "Answer received."
              : nativeAskDetail(result);

            await options.persistChild(runRecord.caseId, {
              event: "child",
              runId,
              index: i,
              state: childState,
              at: stepEndedAt,
              line,
              answerTurnId: completed ? result.turnId : null,
              draftTurnId: completed ? null : result.turnId,
              chars: result.text.length,
              attempt
            });

            if (completed) {
              runRecord.answer = result.text;
              if (
                controller.signal.aborted ||
                revokedOwners.has(manifest.owner)
              ) {
                runRecord.state = "stopped";
                for (let j = i + 1; j < manifest.reviews.length; j++) {
                  try {
                    await options.persistChild(runRecord.caseId, {
                      event: "child",
                      runId,
                      index: j,
                      state: "stopped",
                      at: stepEndedAt,
                      line: "Stopped before provider dispatch.",
                      answerTurnId: null,
                      draftTurnId: null,
                      chars: 0
                    });
                  } catch {
                    // Receipt remains
                  }
                }
                markRunFinished(runRecord);
                return;
              }
            } else if (stopped) {
              runRecord.state = "stopped";
              runRecord.answer = result.text;
              for (let j = i + 1; j < manifest.reviews.length; j++) {
                try {
                  await options.persistChild(runRecord.caseId, {
                    event: "child",
                    runId,
                    index: j,
                    state: "stopped",
                    at: stepEndedAt,
                    line: "Stopped before provider dispatch.",
                    answerTurnId: null,
                    draftTurnId: null,
                    chars: 0
                  });
                } catch {
                  // Receipt remains
                }
              }
              markRunFinished(runRecord);
              return;
            } else {
              runRecord.state = "failed";
              runRecord.failure = nativeAskDetail(result);
              for (let j = i + 1; j < manifest.reviews.length; j++) {
                try {
                  await options.persistChild(runRecord.caseId, {
                    event: "child",
                    runId,
                    index: j,
                    state: "stopped",
                    at: stepEndedAt,
                    line: "Stopped before provider dispatch.",
                    answerTurnId: null,
                    draftTurnId: null,
                    chars: 0
                  });
                } catch {
                  // Receipt remains
                }
              }
              markRunFinished(runRecord);
              return;
            }
          } catch (error) {
            const stepEndedAt = clock();
            const partialTurnId =
              error && typeof error === "object"
                ? ((error as { turnId?: unknown }).turnId ?? (error as { draftTurnId?: unknown }).draftTurnId)
                : null;
            const draftTurnId =
              typeof partialTurnId === "string" && partialTurnId.length > 0 ? partialTurnId : null;

            const hostProvedStopped =
              error &&
              typeof error === "object" &&
              (("finishReason" in error && (error as { finishReason?: unknown }).finishReason === "stopped") ||
                ("terminalStopped" in error && (error as { terminalStopped?: unknown }).terminalStopped === true) ||
                ("stopped" in error && (error as { stopped?: unknown }).stopped === true));

            if (hostProvedStopped) {
              runRecord.state = "stopped";
              const stepRecord: RawAgentStep = {
                index: i,
                thought: review.contextPreview ?? manifest.prompt,
                toolName: null,
                toolArgs: "",
                toolResult: "",
                toolFailed: false,
                answer: "",
                startedAt: stepStartedAt,
                endedAt: stepEndedAt
              };
              runRecord.steps.push(stepRecord);

              try {
                await options.persistChild(runRecord.caseId, {
                  event: "child",
                  runId,
                  index: i,
                  state: "stopped",
                  at: stepEndedAt,
                  line: "Provider stopped.",
                  answerTurnId: null,
                  draftTurnId,
                  chars: 0,
                  attempt
                });
              } catch {
                // Receipt remains
              }
            } else {
              runRecord.state = "interrupted";
              const msg =
                error instanceof Error && error.message.trim().length > 0
                  ? error.message.trim()
                  : "The host result needs inspection.";
              runRecord.failure = `The host result needs inspection: ${msg}`;
              const stepRecord: RawAgentStep = {
                index: i,
                thought: review.contextPreview ?? manifest.prompt,
                toolName: null,
                toolArgs: "",
                toolResult: "",
                toolFailed: true,
                answer: "",
                startedAt: stepStartedAt,
                endedAt: stepEndedAt
              };
              runRecord.steps.push(stepRecord);

              try {
                await options.persistChild(runRecord.caseId, {
                  event: "child",
                  runId,
                  index: i,
                  state: "interrupted",
                  at: stepEndedAt,
                  line: `The host result needs inspection: ${msg}`,
                  answerTurnId: null,
                  draftTurnId,
                  chars: 0,
                  attempt
                });
              } catch {
                // Host receipt remains authoritative
              }
            }

            for (let j = i + 1; j < manifest.reviews.length; j++) {
              try {
                await options.persistChild(runRecord.caseId, {
                  event: "child",
                  runId,
                  index: j,
                  state: "stopped",
                  at: stepEndedAt,
                  line: "Stopped before provider dispatch.",
                  answerTurnId: null,
                  draftTurnId: null,
                  chars: 0
                });
              } catch {
                // Receipt remains
              }
            }

            markRunFinished(runRecord);
            return;
          }
        }

        if (
          controller.signal.aborted ||
          runRecord.state === "stopping" ||
          revokedOwners.has(manifest.owner)
        ) {
          runRecord.state = "stopped";
        } else if (runRecord.state === "running") {
          runRecord.state = "done";
        }
        markRunFinished(runRecord);
      })();

      return { runId };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationAgentPoll,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<WorkstationAgentPollResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationAgentPollInputSchema.parse(input);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while polling the agent run.");
      }

      const run = runs.get(request.runId);
      if (!run) {
        if (options.recover) {
          const recovered = await options.recover(request.runId);
          if (recovered !== null) {
            return recovered;
          }
        }
        throw new Error("This agent run is unknown. Nothing about a run survives a restart.");
      }

      if (run.owner !== owner) {
        throw new Error("This window changed while polling the agent run.");
      }

      const result: WorkstationAgentPollResult = {
        state: run.state,
        steps: [...run.steps],
        ...(run.answer !== undefined ? { answer: run.answer } : {}),
        ...(run.failure !== undefined ? { failure: run.failure } : {}),
        ...(run.nativeOutcomes.length > 0 ? { nativeOutcomes: run.nativeOutcomes } : {})
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
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while stopping the agent run.");
      }

      const run = runs.get(request.runId);
      if (!run || run.owner !== owner) {
        return { state: "stopped" };
      }

      if (
        run.state === "running" ||
        run.state === "planning" ||
        run.state === "awaiting-approval"
      ) {
        run.state = "stopping";
        run.controller.abort();
      }

      return { state: run.state };
    }
  );

  const cancelOwner = async (owner: object): Promise<void> => {
    revokedOwners.add(owner);
    for (const [token, review] of pending) {
      if (review.owner === owner) {
        pending.delete(token);
      }
    }
    const changes: Promise<void>[] = [];
    for (const run of runs.values()) {
      if (run.owner !== owner) continue;
      if (
        run.state === "running" ||
        run.state === "planning" ||
        run.state === "awaiting-approval"
      ) {
        run.state = "stopping";
        run.controller.abort();
      }
    }
    await Promise.allSettled(changes);
  };

  return {
    cancelOwner,
    stopActive,
    shutdown: async () => {
      const owners = new Set([...runs.values()].map((r) => r.owner));
      await Promise.allSettled([...owners].map((owner) => cancelOwner(owner)));
    }
  };
}
