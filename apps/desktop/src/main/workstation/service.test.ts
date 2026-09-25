/**
 * What the workstation host refuses, and what it writes down.
 *
 * These tests are about consent and evidence rather than about plumbing. A
 * token that can be spent twice, a packet that changed after somebody read it,
 * a window that reloaded between the review and the send, an approval answered
 * for the wrong request, a case erased mid-run — each of those is a way for
 * something to reach a subscription that nobody actually approved, and each one
 * is checked here through the public surface only.
 *
 * Nothing below reimplements the host. The assertions are about observable
 * outcomes: whether a process was created, what prompt it received, what turns
 * landed in the book, and what the snapshot says.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContextSnapshot } from "./context-snapshot-store.js";
import { buildWorkstationContext, type AcceptedConstraint, type AcceptedFinding } from "./context.js";
import { DatabaseSync } from "node:sqlite";
import { openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { LocalCaseRunScope } from "./local-case-run-scope.js";
import { LocalBriefDraftScope } from "./local-brief-draft-scope.js";
import type { LocalWorkroomDeps } from "../workroom/local.js";
import type {
  WorkstationProvider,
  WorkstationRoutine,
  WorkstationSnapshot,
  LocalChatResult
} from "@cadrane/contracts";
import type {
  NativeEvent,
  NativeProviderLaunch,
  NativeWorker,
  NativeWorkerOptions,
  NativeWorkerResult,
  WorkstationSessionReceipt
} from "./types.js";
import {
  WorkstationHost,
  whyWorkspaceUnsuitable,
  workspaceFolderName,
  type WorkstationCaseRow,
  type WorkstationHostDeps,
  type WorkstationTurnRow
} from "./service.js";

interface FakeWorker {
  readonly worker: NativeWorker;
  readonly prompts: string[];
  readonly decisions: { id: string; allow: boolean }[];
  emit(event: NativeEvent): void;
  finish(result: NativeWorkerResult): void;
  fail(error: Error): void;
  interrupts: number;
  disposed: number;
  readonly options: NativeWorkerOptions;
}

function fakeWorker(options: NativeWorkerOptions): FakeWorker {
  const prompts: string[] = [];
  const decisions: { id: string; allow: boolean }[] = [];
  let settle: ((result: NativeWorkerResult) => void) | null = null;
  let blow: ((error: unknown) => void) | null = null;
  const fake: FakeWorker = {
    options,
    prompts,
    decisions,
    interrupts: 0,
    disposed: 0,
    emit: (event) => {
      options.onEvent(event);
    },
    finish: (result) => {
      settle?.(result);
    },
    fail: (error) => {
      blow?.(error);
    },
    worker: {
      run: (prompt: string) => {
        prompts.push(prompt);
        return new Promise<NativeWorkerResult>((resolve, reject) => {
          settle = resolve;
          blow = reject;
        });
      },
      interrupt: async () => {
        fake.interrupts += 1;
        return { acknowledged: true, detail: "asked the session to stop" };
      },
      decide: async (id: string, allow: boolean) => {
        decisions.push({ id, allow });
      },
      dispose: async () => {
        fake.disposed += 1;
      }
    }
  };
  return fake;
}

const CODEX: WorkstationProvider = {
  id: "codex",
  label: "Codex",
  family: "codex",
  state: "detected",
  detail: "Installed.",
  models: [{ id: "gpt-5-codex", label: "Codex" }],
  canResume: true,
  canApproveTools: true
};

const CLAUDE: WorkstationProvider = {
  id: "claude",
  label: "Claude",
  family: "claude",
  state: "detected",
  detail: "Installed.",
  models: [{ id: "sonnet", label: "Sonnet" }],
  canResume: true,
  canApproveTools: true
};

const ROUTINES: readonly WorkstationRoutine[] = [
  {
    id: "write-reply",
    title: "Write a reply",
    description: "Draft an answer from the selected sources.",
    prompt: "Write a reply using only the selected sources.",
    icon: "write",
    sourceHint: "Pick the message you are replying to.",
    outputLabel: "Draft reply"
  }
];

function harness() {
  const turns: WorkstationTurnRow[] = [
    { id: "11111111-1111-4111-8111-111111111111", seat: "owner", kind: "verbatim", body: "The customer asked for ten brackets." },
    { id: "22222222-2222-4222-8222-222222222222", seat: "workstation", kind: "receipt", body: "Workstation op-0 started." }
  ];
  const receipts: WorkstationSessionReceipt[] = [];
  /** Transaction depth at the moment each receipt was written. */
  const receiptDepths: number[] = [];
  const workers: FakeWorker[] = [];
  const created: string[] = [];
  const state = {
    room: { id: "case-1", title: "Brackets", closedAt: null } as WorkstationCaseRow | null,
    otherRoom: null as WorkstationCaseRow | null,
    clock: 1_000_000,
    stored: null as WorkstationSessionReceipt | null,
    launches: [{ provider: CODEX, executable: "/usr/local/bin/codex" }] as NativeProviderLaunch[],
    recoveries: 0,
    transactions: 0,
    txDepth: 0,
    omitted: [] as string[],
    packedIds: null as string[] | null,
    savePreimage: async (_input: Parameters<WorkstationHostDeps["onRunStart"]>[0]): Promise<boolean> => true,
    canonicalPath: async (workspacePath: string): Promise<string> => workspacePath,
    projectId: null as string | null,
    memoryEpoch: 0,
    approvedConstraints: [] as AcceptedConstraint[],
    approvedFindings: [] as AcceptedFinding[]
  };
  const contextSnapshots = new Map<string, ContextSnapshot>();
  let tokens = 0;
  let ids = 0;

  const deps: WorkstationHostDeps = {
    book: () => ({}) as DatabaseSync,
    readCase: (_db, caseId) =>
      state.room?.id === caseId ? state.room : state.otherRoom?.id === caseId ? state.otherRoom : null,
    turnsFor: () => turns,
    appendTurn: (_db, _caseId, turn) => {
      const id = `turn-${turns.length + 1}`;
      turns.push({ id, seat: turn.seat, kind: turn.kind, body: turn.body });
      return id;
    },
    transaction: (_db, work) => {
      state.transactions += 1;
      state.txDepth += 1;
      try {
        work();
      } finally {
        state.txDepth -= 1;
      }
    },
    discoverProviders: async () => state.launches,
    buildContext: ({ prompt, sources, acceptedConstraints, approvedFindings }) => ({
      packet: JSON.stringify({ request: prompt, sources,
        ...(acceptedConstraints?.length ? { constraints: acceptedConstraints } : {}),
        ...(approvedFindings?.length ? { findings: approvedFindings } : {}) }),
      // Deliberately a summary rather than the packet, exactly like the real
      // assembler: the host must not be able to pass this off as the bytes.
      preview: `${prompt} (+${sources.length})`,
      sourceIds: state.packedIds ?? sources.map((source) => source.id),
      sha256: "context-hash",
      omitted: state.omitted,
      ...(acceptedConstraints?.length ? { constraintIds: acceptedConstraints.map((item) => item.id) } : {}),
      ...(approvedFindings ? { findingDecisions: approvedFindings.map((finding) => ({
        id: finding.id, revision: finding.revision,
        included: finding.provenance === "verified",
        reason: finding.provenance === "verified" ? "relevant_approved_finding" as const :
          finding.provenance === "stale" ? "stale_source" as const : "unattributed" as const
      })) } : {})
    }),
    memory: {
      projectForCase: () => state.projectId,
      epoch: () => state.memoryEpoch,
      constraints: () => state.approvedConstraints,
      findings: () => state.approvedFindings,
      saveSnapshot: (_db, input, at) => {
        const saved: ContextSnapshot = {
          ...input,
          packetHash: createHash("sha256").update(input.packet).digest("hex"),
          createdAt: at,
          dispatchAttemptedAt: null,
          redactedAt: null
        };
        contextSnapshots.set(input.id, saved);
        return saved;
      },
      readSnapshot: (_db, id) => contextSnapshots.get(id) ?? null,
      markDispatchAttempt: () => {}
    },
    createWorker: (providerId, options) => {
      created.push(providerId);
      const worker = fakeWorker(options);
      workers.push(worker);
      return worker.worker;
    },
    saveReceipt: (_db, _caseId, receipt) => {
      receipts.push(receipt);
      receiptDepths.push(state.txDepth);
    },
    latestReceipt: () => state.stored,
    recoverInterrupted: () => {
      state.recoveries += 1;
      return 2;
    },
    routines: () => ROUTINES,
    privateWorkspace: async (caseId) => ({
      id: `case:${caseId}`,
      label: "This case's own folder",
      path: `/data/workstation/workspaces/${caseId}`
    }),
    canonicalWorkspacePath: (workspacePath) => state.canonicalPath(workspacePath),
    onRunStart: (input) => state.savePreimage(input),
    extractArtifacts: () => [],
    now: () => state.clock,
    token: () => {
      tokens += 1;
      return tokens.toString(16).padStart(64, "0");
    },
    newId: () => {
      ids += 1;
      return `00000000-0000-4000-8000-00000000000${ids}`;
    }
  };

  const host = new WorkstationHost(deps);
  const owner = { window: "one" };
  const request = {
    caseId: "case-1",
    providerId: "codex" as const,
    modelId: "gpt-5-codex",
    prompt: "Draft the quotation reply.",
    sourceTurnIds: ["11111111-1111-4111-8111-111111111111"]
  };
  return { host, deps, owner, request, turns, receipts, receiptDepths, workers, created, state, contextSnapshots };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function preimageGate() {
  let release!: (saved: boolean) => void;
  let requested = false;
  const promise = new Promise<boolean>((resolve) => { release = resolve; });
  return {
    save: (): Promise<boolean> => { requested = true; return promise; },
    requested: (): boolean => requested,
    release: (saved: boolean): void => { release(saved); }
  };
}

function drafts(turns: readonly WorkstationTurnRow[]): readonly WorkstationTurnRow[] {
  return turns.filter((turn) => turn.seat.startsWith("Workstation ·"));
}

function receiptsWritten(turns: readonly WorkstationTurnRow[]): readonly WorkstationTurnRow[] {
  return turns.filter((turn) => turn.seat === "workstation" && turn.kind === "receipt");
}

describe("the workstation host", () => {
  it("keeps remote-visible live and finished snapshots within the exact owner", async () => {
    const kit = harness();
    const otherOwner = { window: "two" };
    kit.state.otherRoom = { id: "case-2", title: "Other work", closedAt: null };
    kit.state.launches.push({ provider: CLAUDE, executable: "/usr/local/bin/claude" });
    const otherRequest = { ...kit.request, caseId: "case-2", providerId: "claude" as const, modelId: "sonnet" };
    const first = await kit.host.prepare(kit.request, kit.owner);
    const second = await kit.host.prepare(otherRequest, otherOwner);
    const firstRun = await kit.host.start({ token: first.token }, kit.owner);
    const secondRun = await kit.host.start({ token: second.token }, otherOwner);

    expect(kit.host.snapshotsForOwner(kit.owner).map((item) => item.operationId)).toEqual([firstRun.operationId]);
    expect(kit.host.snapshotsForOwner(otherOwner).map((item) => item.operationId)).toEqual([secondRun.operationId]);
    expect(kit.host.snapshotsForOwner({ window: "one" })).toEqual([]);

    kit.workers[0]!.finish({ text: "First answer", sessionId: null, finishReason: "completed" });
    await kit.host.awaitTerminal("case-1", firstRun.operationId, kit.owner);
    expect(kit.host.snapshotsForOwner(kit.owner).map((item) => item.operationId)).toEqual([firstRun.operationId]);
    expect(kit.host.snapshotsForOwner(otherOwner).map((item) => item.operationId)).toEqual([secondRun.operationId]);
    await kit.host.stop("case-2", secondRun.operationId, otherOwner);
    kit.workers[1]!.finish({ text: "", sessionId: null, finishReason: "stopped" });
    await kit.host.awaitTerminal("case-2", secondRun.operationId, otherOwner);
  });

  it("returns the complete native ask outcome and keeps a stopped partial result", async () => {
    const kit = harness();
    const controller = new AbortController();
    const pending = kit.host.askOnce({
      providerId: "codex", prompt: "Draft a response", cwd: "/tmp/ask-test",
      modelId: "gpt-5-codex", signal: controller.signal
    });
    await until(() => kit.workers.length === 1, "ask worker");
    kit.workers[0]!.finish({
      text: "Useful partial", sessionId: "native-42", finishReason: "denied",
      detail: "File access declined.", modelId: "adapter-choice", reportedModelId: "provider-choice"
    });
    await expect(pending).resolves.toMatchObject({
      text: "Useful partial", sessionId: "native-42", finishReason: "denied",
      detail: "File access declined.", requestedModelId: "gpt-5-codex",
      modelId: "adapter-choice", reportedModelId: "provider-choice",
      cancellationRequested: false, resultSource: "worker"
    });

    const stopped = kit.host.askOnce({ providerId: "codex", prompt: "Second ask", cwd: "/tmp/ask-test", signal: controller.signal });
    await until(() => kit.workers.length === 2, "second ask worker");
    controller.abort();
    kit.workers[1]!.finish({ text: "Stopped draft", sessionId: "native-43", finishReason: "completed", detail: "Provider finished after stop." });
    await expect(stopped).resolves.toMatchObject({ text: "Stopped draft", sessionId: "native-43", finishReason: "completed", detail: "Provider finished after stop.", cancellationRequested: true, resultSource: "worker", requestedModelId: null });

    const rejected = kit.host.askOnce({ providerId: "codex", prompt: "Third ask", cwd: "/tmp/ask-test", signal: new AbortController().signal });
    await until(() => kit.workers.length === 3, "third ask worker");
    kit.workers[2]!.emit({ type: "session", sessionId: "native-44" });
    kit.workers[2]!.emit({ type: "text", text: "Streamed fragment" });
    kit.workers[2]!.fail(new Error("Quota exhausted"));
    await expect(rejected).resolves.toMatchObject({
      text: "Streamed fragment", sessionId: "native-44", finishReason: "failed",
      detail: "Quota exhausted", requestedModelId: null,
      cancellationRequested: false, resultSource: "transport"
    });
  });

  it.each(["failed", "denied"] as const)("keeps the provider's %s reason after cancellation", async (finishReason) => {
    const kit = harness();
    const controller = new AbortController();
    const pending = kit.host.askOnce({ providerId: "codex", prompt: "Draft", cwd: "/tmp/ask-test", signal: controller.signal });
    await until(() => kit.workers.length === 1, "cancelled ask worker");
    controller.abort();
    kit.workers[0]!.finish({ text: "Partial bytes", sessionId: "native-race", finishReason, detail: "Provider's own detail." });
    await expect(pending).resolves.toMatchObject({
      text: "Partial bytes", sessionId: "native-race", finishReason,
      detail: "Provider's own detail.", cancellationRequested: true, resultSource: "worker"
    });
  });
  it("shows the exact packet, then runs it once the token is spent", async () => {
    const kit = harness();
    const before = kit.turns.length;
    const review = await kit.host.prepare(kit.request, kit.owner);

    // Reviewing dispatches nothing.
    expect(kit.created).toEqual([]);
    expect(kit.turns.length).toBe(before);
    expect(review.sourceIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(review.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(review.workspace.path).toBe("/data/workstation/workspaces/case-1");
    expect(review.expiresAt).toBe(1_000_000 + 5 * 60_000);

    const snapshot = await kit.host.start({ token: review.token }, kit.owner);
    expect(snapshot.status).toBe("running");
    expect(kit.created).toEqual(["codex"]);

    // The prompt and the start receipt are durable before the process was told
    // anything, and the packet it received is the packet that was reviewed.
    const worker = kit.workers[0];
    if (worker === undefined) throw new Error("no worker was created");
    expect(kit.turns.filter((turn) => turn.seat === "owner" && turn.body === kit.request.prompt)).toHaveLength(1);
    const start = receiptsWritten(kit.turns).at(-1);
    expect(start?.body).toContain(review.sourceHash);
    expect(start?.body).toContain("A start is not a completed answer");
    expect(worker.prompts).toHaveLength(1);
    expect(worker.prompts[0]).toContain("The customer asked for ten brackets.");
    expect(worker.options.cwd).toBe("/data/workstation/workspaces/case-1");
    expect(worker.options.modelId).toBe("gpt-5-codex");

    worker.emit({ type: "session", sessionId: "thread-9" });
    worker.emit({ type: "text", text: "Here is the reply." });
    worker.finish({ sessionId: "thread-9", text: "", finishReason: "completed" });
    await until(() => kit.host.state("case-1")?.status === "completed", "the session to complete");

    const saved = drafts(kit.turns);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.body).toBe("Here is the reply.");
    expect(receiptsWritten(kit.turns).at(-1)?.body).toContain("Saved draft:");
    expect(kit.receipts.map((receipt) => receipt.event)).toEqual(["start", "finish"]);
    expect(kit.receipts.at(-1)?.workspacePath).toBe("/data/workstation/workspaces/case-1");
    expect(worker.disposed).toBe(1);
  });

  it("waits for a durable start and saved preimage before creating a worker", async () => {
    const kit = harness();
    const gate = preimageGate();
    kit.state.savePreimage = gate.save;
    const review = await kit.host.prepare(kit.request, kit.owner);
    const pending = kit.host.start({ token: review.token }, kit.owner);
    await until(gate.requested, "the preimage request");

    expect(kit.created).toEqual([]);
    expect(kit.receipts.map((receipt) => receipt.event)).toEqual(["start"]);
    expect(kit.host.state("case-1")?.status).toBe("starting");
    expect(() => kit.host.assertIdle("case-1")).toThrow(/Stop the workstation session/u);
    gate.release(true);

    const started = await pending;
    expect(started.status).toBe("running");
    expect(kit.created).toEqual(["codex"]);
    kit.workers[0]?.finish({ sessionId: null, text: "Done", finishReason: "completed" });
    await until(() => kit.host.state("case-1")?.status === "completed", "the session to complete");
  });

  it.each(["false", "rejection"] as const)("blocks launch and releases admission when the preimage returns %s", async (failure) => {
    const kit = harness();
    kit.state.savePreimage = failure === "false"
      ? async () => false
      : async () => { throw new Error("Snapshot store unavailable."); };
    const review = await kit.host.prepare(kit.request, kit.owner);

    await expect(kit.host.start({ token: review.token }, kit.owner)).rejects.toThrow(
      failure === "false" ? /Could not cover this workspace.*Choose a narrower folder/u : /Snapshot store unavailable/u
    );
    expect(kit.created).toEqual([]);
    expect(kit.host.state("case-1")?.status).toBe("failed");
    expect(kit.receipts.map((receipt) => receipt.event)).toEqual(["start", "interrupted"]);
    expect(receiptsWritten(kit.turns).at(-1)?.body).toMatch(/failed|Snapshot store unavailable|Could not cover this workspace/iu);
    expect(() => kit.host.assertIdle("case-1")).not.toThrow();

    kit.state.savePreimage = async () => true;
    const nextReview = await kit.host.prepare(kit.request, kit.owner);
    const started = await kit.host.start({ token: nextReview.token }, kit.owner);
    expect(started.status).toBe("running");
    expect(kit.created).toEqual(["codex"]);
    kit.workers[0]?.finish({ sessionId: null, text: "Done", finishReason: "completed" });
    await until(() => kit.host.state("case-1")?.status === "completed", "the retry to complete");
  });

  it.each(["stop", "window", "shutdown"] as const)("never launches after %s during the preimage wait", async (ending) => {
    const kit = harness();
    const gate = preimageGate();
    kit.state.savePreimage = gate.save;
    const review = await kit.host.prepare(kit.request, kit.owner);
    const pending = kit.host.start({ token: review.token }, kit.owner);
    await until(gate.requested, "the preimage request");
    const operationId = kit.host.state("case-1")?.operationId;
    if (operationId === undefined) throw new Error("The pending run is not visible.");

    if (ending === "stop") {
      expect((await kit.host.stop("case-1", operationId, kit.owner)).status).toBe("stopping");
    } else if (ending === "window") {
      kit.host.invalidate(kit.owner);
    } else {
      await kit.host.shutdown();
    }
    gate.release(true);

    await expect(pending).rejects.toThrow(/Stopped before the provider was asked/u);
    expect(kit.created).toEqual([]);
    expect(kit.host.state("case-1")?.status).toBe("stopped");
    expect(kit.receipts.map((receipt) => receipt.event)).toEqual(["start", "interrupted"]);
    expect(() => kit.host.assertIdle("case-1")).not.toThrow();
  });

  it("rechecks the reviewed sources after the preimage wait", async () => {
    const kit = harness();
    const gate = preimageGate();
    kit.state.savePreimage = gate.save;
    const review = await kit.host.prepare(kit.request, kit.owner);
    const pending = kit.host.start({ token: review.token }, kit.owner);
    await until(gate.requested, "the preimage request");
    const source = kit.turns[0];
    if (source === undefined) throw new Error("The reviewed source is missing.");
    kit.turns[0] = { ...source, body: "The order changed before dispatch." };
    gate.release(true);

    await expect(pending).rejects.toThrow(/changed while its folder was being saved/u);
    expect(kit.created).toEqual([]);
    expect(kit.host.state("case-1")?.status).toBe("failed");
    expect(kit.receipts.map((receipt) => receipt.event)).toEqual(["start", "interrupted"]);
  });

  it.each(["same", "nested"] as const)("reserves a %s canonical workspace while its preimage is pending", async (overlap) => {
    const kit = harness();
    kit.state.otherRoom = { id: "case-2", title: "Second case", closedAt: null };
    kit.state.launches.push({ provider: CLAUDE, executable: "/usr/local/bin/claude" });
    kit.state.canonicalPath = async (workspacePath) =>
      workspacePath.endsWith("/case-2")
        ? `/data/workstation/workspaces/case-1${overlap === "nested" ? "/nested" : ""}`
        : workspacePath;
    const gate = preimageGate();
    kit.state.savePreimage = gate.save;
    const firstReview = await kit.host.prepare(kit.request, kit.owner);
    const secondReview = await kit.host.prepare({
      ...kit.request,
      caseId: "case-2",
      providerId: "claude",
      modelId: "sonnet"
    }, kit.owner);

    const first = kit.host.start({ token: firstReview.token }, kit.owner);
    await until(gate.requested, "the first preimage request");
    expect(kit.created).toEqual([]);
    await expect(kit.host.start({ token: secondReview.token }, kit.owner)).rejects.toThrow(/case-1/u);
    expect(kit.created).toEqual([]);
    gate.release(true);
    expect((await first).status).toBe("running");
    expect(kit.created).toEqual(["codex"]);
    kit.workers[0]?.finish({ sessionId: null, text: "Done", finishReason: "completed" });
    await until(() => kit.host.state("case-1")?.status === "completed", "the first session to complete");
  });

  it("refuses to spend the same review twice", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    const worker = kit.workers[0];
    if (worker === undefined) throw new Error("no worker was created");
    worker.finish({ sessionId: null, text: "done", finishReason: "completed" });
    await until(() => kit.host.state("case-1")?.status === "completed", "the session to complete");

    await expect(kit.host.start({ token: review.token }, kit.owner)).rejects.toThrow(
      /already been used|no longer valid/u
    );
    expect(kit.created).toEqual(["codex"]);
  });

  it("refuses a review whose window has changed, and burns the token doing it", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);

    await expect(kit.host.start({ token: review.token }, { window: "two" })).rejects.toThrow(
      /This window changed/u
    );
    expect(kit.created).toEqual([]);
    // The original window cannot rescue a token another document tried to use.
    await expect(kit.host.start({ token: review.token }, kit.owner)).rejects.toThrow(
      /already been used|no longer valid/u
    );
  });

  it("refuses to send a packet whose sources changed after the review", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    const source = kit.turns[0];
    if (source === undefined) throw new Error("no source turn");
    kit.turns[0] = { ...source, body: "The customer asked for ten thousand brackets." };

    await expect(kit.host.start({ token: review.token }, kit.owner)).rejects.toThrow(
      /changed after that review/u
    );
    expect(kit.created).toEqual([]);
  });

  it("refuses an expired review", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    kit.state.clock += 5 * 60_000 + 1;
    await expect(kit.host.start({ token: review.token }, kit.owner)).rejects.toThrow(/expired/u);
    expect(kit.created).toEqual([]);
  });

  it("refuses a source that is not a source turn", async () => {
    const kit = harness();
    await expect(
      kit.host.prepare(
        { ...kit.request, sourceTurnIds: ["22222222-2222-4222-8222-222222222222"] },
        kit.owner
      )
    ).rejects.toThrow(/no longer in this case/u);
  });

  it("refuses a model the provider never offered", async () => {
    const kit = harness();
    await expect(
      kit.host.prepare({ ...kit.request, modelId: "gpt-5-codex; rm -rf /" }, kit.owner)
    ).rejects.toThrow(/does not offer the model/u);
  });

  it("refuses an omitted model before a review or worker is created", async () => {
    const kit = harness();
    await expect(kit.host.prepare({ ...kit.request, modelId: "" }, kit.owner))
      .rejects.toThrow(/Choose a model/u);
    expect(kit.created).toEqual([]);
    expect(kit.contextSnapshots.size).toBe(0);
  });

  it("refuses a second session that would collide, and says why", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);

    // This test used to assert "one at a time". That rule is gone, and what
    // replaced it must still refuse everything the old sentence protected: the
    // same work, the same folder, the same subscription. Asking again for the
    // identical request is all three at once.
    // The refusal has to be actionable, not just correct: it names which
    // subscription, which folder, and what to do about it.
    const refusal = await kit.host.prepare(kit.request, kit.owner).then(
      () => null,
      (problem: unknown) => (problem instanceof Error ? problem.message : String(problem))
    );
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("Codex");
    expect(refusal).toContain("/data/workstation/workspaces/case-1");
    expect(refusal).toMatch(/Stop|choose another/iu);
    expect(() => kit.host.assertIdle("case-1")).toThrow(/Stop the workstation session/u);
    expect(kit.created).toEqual(["codex"]);
  });

  it("keeps the partial answer when a session is stopped", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    const started = await kit.host.start({ token: review.token }, kit.owner);
    const worker = kit.workers[0];
    if (worker === undefined) throw new Error("no worker was created");
    worker.emit({ type: "text", text: "Half an answer" });

    // A stale operation id stops nothing.
    await expect(
      kit.host.stop("case-1", "00000000-0000-4000-8000-000000000099", kit.owner)
    ).rejects.toThrow(/no longer running/u);
    // Nor does another window.
    await expect(
      kit.host.stop("case-1", started.operationId, { window: "two" })
    ).rejects.toThrow(/This window changed/u);

    const stopping = await kit.host.stop("case-1", started.operationId, kit.owner);
    expect(stopping.status).toBe("stopping");
    expect(worker.interrupts).toBe(1);

    worker.finish({ sessionId: null, text: "", finishReason: "stopped" });
    await until(() => kit.host.state("case-1")?.status === "stopped", "the session to stop");

    const saved = drafts(kit.turns);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.body).toContain("Half an answer");
    expect(saved[0]?.body).toContain("This is a partial answer.");
    expect(kit.host.state("case-1")?.text).toBe("Half an answer");
  });

  it("rebinds only one settled live run while denying stale, foreign and old-owner Stop", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    const started = await kit.host.start({ token: review.token }, kit.owner);
    const secondOwner = { window: "newly paired" };
    const worker = kit.workers[0]!;

    expect(() => kit.host.handoverActiveRun("case-1", started.operationId, {}, secondOwner))
      .toThrow(/window changed/u);
    expect(() => kit.host.handoverActiveRun("wrong-case", started.operationId, kit.owner, secondOwner))
      .toThrow(/no longer running/u);
    expect(() => kit.host.handoverActiveRun("case-1", started.operationId, kit.owner, kit.owner))
      .toThrow(/distinct/u);
    expect(worker.interrupts).toBe(0);

    expect(kit.host.handoverActiveRun("case-1", started.operationId, kit.owner, secondOwner))
      .toMatchObject({ operationId: started.operationId, status: "running" });
    expect(kit.host.snapshotsForOwner(kit.owner)).toEqual([]);
    expect(kit.host.snapshotsForOwner(secondOwner)).toMatchObject([{ operationId: started.operationId }]);
    await expect(kit.host.stop("case-1", started.operationId, kit.owner)).rejects.toThrow(/window changed/u);
    await expect(kit.host.prepare(kit.request, kit.owner)).rejects.toThrow(/authority ended/u);
    kit.host.invalidate(kit.owner);
    expect(worker.interrupts).toBe(0);
    expect(() => kit.host.handoverActiveRun("case-1", started.operationId, kit.owner, {}))
      .toThrow(/not distinct and current/u);
    expect((await kit.host.stop("case-1", started.operationId, secondOwner)).status).toBe("stopping");
    expect(worker.interrupts).toBe(1);
    worker.finish({ sessionId: null, text: "Partial", finishReason: "stopped" });
    await until(() => kit.host.state("case-1")?.status === "stopped", "the handover run to stop");
    expect(() => kit.host.handoverActiveRun("case-1", started.operationId, secondOwner, {}))
      .toThrow(/no longer running/u);
  });

  it("refuses handover during a pending permission without transferring decision authority", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    const started = await kit.host.start({ token: review.token }, kit.owner);
    const worker = kit.workers[0]!;
    worker.emit({ type: "permission", id: "write-1", title: "Write file", detail: "Write a draft" });
    const newOwner = {};
    expect(() => kit.host.handoverActiveRun("case-1", started.operationId, kit.owner, newOwner))
      .toThrow(/awaiting authority/u);
    expect(kit.host.snapshotsForOwner(newOwner)).toEqual([]);
    expect(worker.interrupts).toBe(0);
    await kit.host.stop("case-1", started.operationId, kit.owner);
    worker.finish({ sessionId: null, text: "", finishReason: "stopped" });
    await until(() => kit.host.state("case-1")?.status === "stopped", "the permission run to stop");
  });

  it("answers one waiting approval, for the operation that asked", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    const started = await kit.host.start({ token: review.token }, kit.owner);
    const worker = kit.workers[0];
    if (worker === undefined) throw new Error("no worker was created");
    worker.emit({ type: "permission", id: "exec-1", title: "Run npm test", detail: "In the chosen folder." });
    await until(() => kit.host.state("case-1")?.status === "needs-approval", "an approval to wait");
    expect(kit.host.state("case-1")?.permission).toEqual({
      id: "exec-1",
      title: "Run npm test",
      detail: "In the chosen folder."
    });

    await expect(
      kit.host.decide(started.operationId, "exec-2", true, kit.owner)
    ).rejects.toThrow(/no longer waiting/u);
    await expect(
      kit.host.decide("00000000-0000-4000-8000-000000000099", "exec-1", true, kit.owner)
    ).rejects.toThrow(/no longer running/u);
    await expect(
      kit.host.decide(started.operationId, "exec-1", true, { window: "two" })
    ).rejects.toThrow(/This window changed/u);
    expect(worker.decisions).toEqual([]);

    const after = await kit.host.decide(started.operationId, "exec-1", true, kit.owner);
    expect(worker.decisions).toEqual([{ id: "exec-1", allow: true }]);
    expect(after.status).toBe("running");
    expect(after.permission).toBeNull();
    expect(receiptsWritten(kit.turns).at(-1)?.body).toContain("allowed once Run npm test");
    expect(receiptsWritten(kit.turns).at(-1)?.body).toContain("that one request only");
  });

  it("keeps the next review when the previous decision is withdrawn while being applied", async () => {
    const kit = harness(); const prepared = await kit.host.prepare(kit.request, kit.owner);
    const started = await kit.host.start({ token: prepared.token }, kit.owner); const worker = kit.workers[0]!;
    let finishDecision!: () => void;
    worker.worker.decide = () => new Promise<void>(resolve => { finishDecision = resolve; });
    worker.emit({ type: "permission", id: "first", title: "Read first", detail: "First exact text" });
    worker.emit({ type: "permission", id: "second", title: "Read second", detail: "Second exact text" });
    const deciding = kit.host.decide(started.operationId, "first", false, kit.owner);
    await expect(kit.host.decide(started.operationId, "first", true, kit.owner)).rejects.toThrow(/already applying/);
    worker.emit({ type: "permission-cleared", id: "first" }); finishDecision();
    const result = await deciding;
    expect(result.permission?.id).toBe("second"); expect(result.status).toBe("needs-approval");
    worker.finish({ sessionId: null, text: "Done", finishReason: "completed" });
  });

  it("a cancelled approval never revives a stopping run or accepts a late approval", async () => {
    const kit = harness(); const prepared = await kit.host.prepare(kit.request, kit.owner);
    const started = await kit.host.start({ token: prepared.token }, kit.owner); const worker = kit.workers[0]!;
    worker.emit({ type: "permission", id: "first", title: "Read first", detail: "Exact text" });
    await kit.host.stop("case-1", started.operationId, kit.owner);
    worker.emit({ type: "permission-cleared", id: "first" });
    expect(kit.host.state("case-1")?.status).toBe("stopping"); expect(kit.host.state("case-1")?.permission).toBeNull();
    await expect(kit.host.decide(started.operationId, "first", true, kit.owner)).rejects.toThrow(/stopping/);
    expect(worker.decisions).toEqual([]);
    worker.finish({ sessionId: null, text: "Partial", finishReason: "stopped" });
  });

  it("a decision callback cannot reset a finished operation to running during process cleanup", async () => {
    const kit = harness(); const prepared = await kit.host.prepare(kit.request, kit.owner);
    const started = await kit.host.start({ token: prepared.token }, kit.owner); const worker = kit.workers[0]!;
    let finishDecision!: () => void;
    worker.worker.decide = () => new Promise<void>(resolve => { finishDecision = resolve; });
    worker.emit({ type: "permission", id: "first", title: "Read first", detail: "Exact text" });
    const deciding = kit.host.decide(started.operationId, "first", false, kit.owner);
    let releaseCleanup!: () => void;
    worker.worker.dispose = () => new Promise<void>(resolve => { releaseCleanup = resolve; });
    worker.finish({ sessionId: null, text: "Completed answer", finishReason: "completed" });
    await until(() => kit.host.state("case-1")?.status === "completed", "the operation to finish");
    finishDecision(); const result = await deciding;
    releaseCleanup();
    expect(result.status).toBe("completed"); expect(result.text).toBe("Completed answer");
  });

  it("keeps the requested model separate from native reported identity in the final receipt", async () => {
    const kit = harness(); const prepared = await kit.host.prepare(kit.request, kit.owner);
    await kit.host.start({ token: prepared.token }, kit.owner);
    kit.workers[0]!.finish({ sessionId: "native-session", text: "Done", finishReason: "completed", reportedModelId: "gpt-6-example" });
    await until(() => kit.host.state("case-1")?.status === "completed", "the result");
    expect(kit.host.state("case-1")).toMatchObject({ modelId: "gpt-5-codex", reportedModelId: "gpt-6-example" });
    expect(kit.receipts.at(-1)?.snapshot.reportedModelId).toBe("gpt-6-example");
  });

  it("writes nothing into a case that was erased while the session ran", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    const worker = kit.workers[0];
    if (worker === undefined) throw new Error("no worker was created");
    const written = kit.turns.length;
    kit.state.room = null;

    worker.finish({ sessionId: null, text: "An answer nobody can file.", finishReason: "completed" });
    await until(() => kit.host.state("case-1")?.status === "completed", "the session to finish");

    expect(kit.turns.length).toBe(written);
    expect(kit.host.state("case-1")?.detail).toContain("closed or erased");
  });

  it("calls a success with nothing in it a failure", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    const worker = kit.workers[0];
    if (worker === undefined) throw new Error("no worker was created");
    worker.finish({ sessionId: null, text: "   ", finishReason: "completed" });
    await until(() => kit.host.state("case-1")?.status === "failed", "the empty answer to fail");

    expect(drafts(kit.turns)).toHaveLength(0);
    expect(kit.host.state("case-1")?.detail).toContain("without writing an answer");
  });

  it("keeps a partial answer when the provider fails outright", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    const worker = kit.workers[0];
    if (worker === undefined) throw new Error("no worker was created");
    worker.emit({ type: "text", text: "As far as I got" });
    worker.fail(new Error("The provider is not signed in; run its own login first."));
    await until(() => kit.host.state("case-1")?.status === "failed", "the session to fail");

    expect(drafts(kit.turns)[0]?.body).toContain("As far as I got");
    expect(kit.receipts.map((receipt) => receipt.event)).toEqual(["start", "interrupted"]);

    // A real attempt is what changes a provider's row — never a version probe,
    // and never anything that looked at a credential.
    const providers = await kit.host.providers();
    expect(providers[0]?.state).toBe("blocked");
    expect(providers[0]?.detail).toContain("sign in");
    expect(providers[0]?.detail).toContain("never reads or stores your credentials");
  });

  it("resumes only into the same provider and the same folder", async () => {
    const kit = harness();
    kit.state.projectId = "project-1";
    kit.state.memoryEpoch = 3;
    const seed = await kit.host.prepare(kit.request, kit.owner);
    const priorContext = kit.contextSnapshots.get(seed.contextSnapshotId!)!;
    kit.contextSnapshots.set(seed.contextSnapshotId!, { ...priorContext, dispatchAttemptedAt: 1 });
    const snapshot: WorkstationSnapshot = {
      operationId: "00000000-0000-4000-8000-00000000000f",
      caseId: "case-1",
      providerId: "codex",
      modelId: "gpt-5-codex",
      sessionId: "thread-7",
      status: "completed",
      startedAt: 1,
      updatedAt: 2,
      text: "earlier",
      activity: [],
      permission: null,
      detail: "done"
    };
    kit.state.stored = {
      version: 1,
      event: "finish",
      snapshot,
      contextSnapshotId: seed.contextSnapshotId!,
      projectId: "project-1",
      workspacePath: "/data/workstation/workspaces/case-1"
    };
    const resumed = await kit.host.prepare(kit.request, kit.owner);
    expect(resumed.resumeSessionId).toBe("thread-7");

    // A coordinator's narrower child must not inherit hidden conversation or
    // source context from the same case/model's earlier Solo session.
    const narrower = { ...kit.request, sourceTurnIds: [] };
    expect((await kit.host.prepare(narrower, kit.owner)).resumeSessionId).toBe("thread-7");
    const independentChild = await kit.host.prepare(narrower, kit.owner, { freshSession: true });
    expect(independentChild.resumeSessionId).toBeNull();
    const childRun = await kit.host.start({ token: independentChild.token }, kit.owner);
    await until(() => kit.workers.length === 1, "fresh coordinator worker");
    expect(kit.workers[0]?.options.resumeId).toBeUndefined();
    kit.workers[0]?.finish({ sessionId: "new-thread", text: "Independent answer", finishReason: "completed" });
    await until(() => kit.host.state(childRun.caseId)?.status === "completed", "fresh coordinator result");

    kit.state.stored = {
      version: 1,
      event: "finish",
      snapshot,
      contextSnapshotId: seed.contextSnapshotId!,
      projectId: "project-1",
      workspacePath: "/somewhere/else"
    };
    const fresh = await kit.host.prepare(kit.request, kit.owner);
    expect(fresh.resumeSessionId).toBeNull();

    kit.state.stored = { ...kit.state.stored!, workspacePath: "/data/workstation/workspaces/case-1" };
    kit.state.memoryEpoch = 4;
    expect((await kit.host.prepare(kit.request, kit.owner)).resumeSessionId).toBeNull();
    kit.state.memoryEpoch = 3;
    kit.state.projectId = null;
    expect((await kit.host.prepare(kit.request, kit.owner)).resumeSessionId).toBeNull();
    kit.state.projectId = "project-1";
    kit.contextSnapshots.set(seed.contextSnapshotId!, { ...priorContext, packet: null, manifest: null, redactedAt: 10 });
    expect((await kit.host.prepare(kit.request, kit.owner)).resumeSessionId).toBeNull();
    kit.contextSnapshots.set(seed.contextSnapshotId!, { ...priorContext, dispatchAttemptedAt: 1 });
    kit.state.stored = { ...kit.state.stored!, snapshot: { ...snapshot, modelId: "different-selected-model" } };
    expect((await kit.host.prepare(kit.request, kit.owner)).resumeSessionId).toBeNull();
  });

  it("drops a window's reviews when it navigates away", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    kit.host.invalidate(kit.owner);
    await expect(kit.host.start({ token: review.token }, kit.owner)).rejects.toThrow(
      /already been used|no longer valid/u
    );
    expect(kit.created).toEqual([]);
  });

  it("settles what a crash left behind exactly once", () => {
    const kit = harness();
    expect(kit.host.recover()).toBe(2);
    expect(kit.host.recover()).toBe(0);
    expect(kit.state.recoveries).toBe(1);
  });

  it("refuses to send a packet that silently lost a source", async () => {
    const kit = harness();
    kit.state.omitted = ["11111111-1111-4111-8111-111111111111"];
    await expect(kit.host.prepare(kit.request, kit.owner)).rejects.toThrow(/would not fit/u);
  });

  it("returns the fixed routine catalogue", () => {
    const kit = harness();
    expect(kit.host.routines()).toBe(ROUTINES);
  });

  it("shows the packet itself, and a hash of those exact bytes", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    const worker = kit.workers[0];
    if (worker === undefined) throw new Error("no worker was created");

    // What was reviewed is what was sent, byte for byte — not a summary of it.
    // A hash over bytes nobody saw attests to nothing.
    expect(review.contextPreview).toBe(worker.prompts[0]);
    expect(review.sourceHash).toBe(
      createHash("sha256").update(worker.prompts[0] ?? "", "utf8").digest("hex")
    );
    expect(review.contextPreview).toContain("The customer asked for ten brackets.");
  });

  it("refuses a packet that carries a different set of sources than was chosen", async () => {
    const kit = harness();
    // The assembler reports a source the owner did not select. Nothing was
    // omitted, so the earlier check would have let this through.
    kit.state.packedIds = ["99999999-9999-4999-8999-999999999999"];
    await expect(kit.host.prepare(kit.request, kit.owner)).rejects.toThrow(
      /does not match the sources you selected/u
    );
    expect(kit.created).toEqual([]);
  });

  it("commits the prompt, the start receipt and the durable record together", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);

    expect(kit.receipts[0]?.event).toBe("start");
    // Inside the transaction, not after it: a durable session record that
    // survived a rolled-back prompt would describe a session about nothing.
    expect(kit.receiptDepths[0]).toBeGreaterThan(0);
  });

  it("never reports completed for a session that was stopped", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    const started = await kit.host.start({ token: review.token }, kit.owner);
    const worker = kit.workers[0];
    if (worker === undefined) throw new Error("no worker was created");
    worker.emit({ type: "text", text: "Most of an answer" });

    await kit.host.stop("case-1", started.operationId, kit.owner);
    // The provider finishes anyway, a moment after the stop. Somebody who
    // pressed Stop must not be told their session ran to the end.
    worker.finish({ sessionId: null, text: "", finishReason: "completed" });
    await until(() => kit.host.state("case-1")?.status === "stopped", "the late answer to land as stopped");

    const snapshot = kit.host.state("case-1");
    expect(snapshot?.status).toBe("stopped");
    expect(snapshot?.text).toBe("Most of an answer");
    expect(kit.receipts.at(-1)?.event).toBe("interrupted");
  });

  it("recovers the session and its file location after restart without restoring a tool grant", async () => {
    const kit = harness();
    kit.state.stored = {
      version: 1,
      event: "finish",
      workspacePath: "/data/workstation/workspaces/case-1",
      snapshot: {
        operationId: "00000000-0000-4000-8000-0000000000aa",
        caseId: "case-1",
        providerId: "codex",
        modelId: "gpt-5-codex",
        sessionId: "thread-7",
        status: "completed",
        startedAt: 10,
        updatedAt: 20,
        text: "From before the restart",
        activity: [],
        permission: null,
        detail: "Finished."
      }
    };

    // A fresh host: nothing in memory, exactly as after a relaunch.
    const restarted = new WorkstationHost(kit.deps);
    const snapshot = restarted.state("case-1");
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.text).toBe("From before the restart");
    expect(restarted.state("case-unknown")).toBeNull();
    await expect(restarted.filesWorkspace("case-1", undefined, kit.owner)).resolves.toMatchObject({
      path: "/data/workstation/workspaces/case-1"
    });
    await expect(restarted.filesWorkspace("case-unknown", undefined, kit.owner)).rejects.toThrow("no longer exists");
    expect(kit.created).toEqual([]);
    expect(kit.receipts).toEqual([]);
  });
});

describe("canonical project memory in reviewed sessions", () => {
  const accepted: AcceptedConstraint = {
    id: "memory-1", revision: 2, kind: "exclusion",
    text: "Never send the customer's secret phrase 🐤.\nKeep this line verbatim.",
    approvedBy: "local-owner", approvedAt: "2026-09-24T00:00:00.000Z"
  };

  it("pins explicit context role in the exact packet and selects findings without narrowing authority", async () => {
    const kit = harness();
    kit.state.projectId = "project-1";
    kit.state.memoryEpoch = 12;
    kit.state.approvedConstraints = [accepted];
    const sourceRefs = [{
      caseId: "case-1", turnId: kit.request.sourceTurnIds[0]!, sha256: "a".repeat(64)
    }];
    const finding = (id: string, roleTags: readonly string[]): AcceptedFinding => ({
      id, revision: 2, text: "The quotation reply needs source evidence.",
      approvedBy: "local-owner", approvedAt: "2026-09-24T00:00:00.000Z",
      sourceRefs, provenance: "verified", roleTags
    });
    kit.state.approvedFindings = [
      finding("design-finding", ["design"]),
      finding("finance-finding", ["finance"]),
      finding("general-finding", [])
    ];
    const host = new WorkstationHost({ ...kit.deps, buildContext: buildWorkstationContext });
    const design = await host.prepare({ ...kit.request, contextRoleId: "design" }, kit.owner, { freshSession: true });
    const finance = await host.prepare({ ...kit.request, contextRoleId: "finance" }, kit.owner, { freshSession: true });
    const solo = await host.prepare(kit.request, kit.owner, { freshSession: true });
    const read = (packet: string) => JSON.parse(packet) as {
      policy: { contextRoleId?: string };
      constraints: { id: string; kind: string }[];
      findings: { id: string; inclusionReason: string }[];
      sources: { id: string }[];
    };
    expect(read(design.contextPreview).policy.contextRoleId).toBe("design");
    expect(read(finance.contextPreview).policy.contextRoleId).toBe("finance");
    expect(read(solo.contextPreview).policy.contextRoleId).toBeUndefined();
    expect(read(design.contextPreview).constraints).toMatchObject([{ id: accepted.id, kind: "exclusion" }]);
    expect(read(finance.contextPreview).constraints).toMatchObject([{ id: accepted.id, kind: "exclusion" }]);
    expect(read(design.contextPreview).findings.map((one) => one.id))
      .toEqual(["design-finding", "general-finding"]);
    expect(read(finance.contextPreview).findings.map((one) => one.id))
      .toEqual(["finance-finding", "general-finding"]);
    expect(read(solo.contextPreview).findings.map((one) => one.id))
      .toEqual(["design-finding", "finance-finding", "general-finding"]);
    expect(read(design.contextPreview).sources.map((one) => one.id)).toEqual(kit.request.sourceTurnIds);
    expect(design.sourceHash).not.toBe(finance.sourceHash);
    expect(kit.contextSnapshots.get(design.contextSnapshotId!)?.packet).toBe(design.contextPreview);
    kit.state.memoryEpoch += 1;
    await expect(host.start({ token: design.token }, kit.owner)).rejects.toThrow(/Project memory changed/u);
    expect(kit.created).toEqual([]);
  });

  it("rejects noncanonical context roles before creating a review", async () => {
    const kit = harness();
    await expect(kit.host.prepare({ ...kit.request, contextRoleId: "Lead Analyst" }, kit.owner))
      .rejects.toThrow();
    expect(kit.contextSnapshots.size).toBe(0);
    expect(kit.created).toEqual([]);
  });

  it("refuses a scoped review if a context builder drops the selected role", async () => {
    const kit = harness();
    await expect(kit.host.prepare({ ...kit.request, contextRoleId: "design" }, kit.owner))
      .rejects.toThrow(/did not bind the selected role/u);
    expect(kit.contextSnapshots.size).toBe(0);
    expect(kit.created).toEqual([]);
  });

  it("reviews attributed findings as evidence and rechecks their source before Start", async () => {
    const kit = harness();
    kit.state.projectId = "project-1";
    kit.state.memoryEpoch = 3;
    const finding: AcceptedFinding = {
      id: "finding-1", revision: 2,
      text: "The quotation reply should mention ten brackets.",
      approvedBy: "local-owner", approvedAt: "2026-09-24T00:00:00.000Z",
      sourceRefs: [{ caseId: "case-1", turnId: kit.request.sourceTurnIds[0]!, sha256: "a".repeat(64) }],
      provenance: "verified"
    };
    kit.state.approvedFindings = [finding];
    const host = new WorkstationHost({ ...kit.deps, buildContext: buildWorkstationContext });
    const review = await host.prepare(kit.request, kit.owner);
    const packet = JSON.parse(review.contextPreview) as {
      findings: { id: string; evidenceRole: string; sourceRefs: unknown[] }[];
      sources: { id: string }[];
    };
    expect(packet.findings).toMatchObject([{
      id: finding.id, evidenceRole: "attributed_evidence",
      sourceRefs: finding.sourceRefs
    }]);
    expect(packet.sources.map((source) => source.id)).toEqual(kit.request.sourceTurnIds);
    kit.state.approvedFindings = [{ ...finding, provenance: "stale" }];
    await expect(host.start({ token: review.token }, kit.owner))
      .rejects.toThrow(/approved finding's source changed/u);
    expect(kit.created).toEqual([]);
  });

  it("pins exact approved bytes, provenance, epoch and snapshot receipt", async () => {
    const kit = harness();
    kit.state.projectId = "project-1";
    kit.state.memoryEpoch = 7;
    kit.state.approvedConstraints = [accepted];
    const review = await kit.host.prepare(kit.request, kit.owner);
    expect(review).toMatchObject({ projectId: "project-1", memoryEpoch: 7 });
    const packet = JSON.parse(review.contextPreview) as { constraints: readonly AcceptedConstraint[] };
    expect(packet.constraints[0]?.text).toBe(accepted.text);
    expect(packet.constraints[0]?.approvedBy).toBe(accepted.approvedBy);
    const saved = kit.contextSnapshots.get(review.contextSnapshotId!);
    expect(saved?.packet).toBe(review.contextPreview);
    expect(saved?.manifest?.constraints).toEqual([{ id: "memory-1", revision: 2 }]);
    await kit.host.start({ token: review.token }, kit.owner);
    expect(kit.receipts[0]?.contextSnapshotId).toBe(review.contextSnapshotId);
    expect(kit.workers[0]?.prompts[0]).toBe(review.contextPreview);
    expect(() => kit.host.assertProjectIdle("project-1")).toThrow(/Stop this project's workstation session/u);
  });

  it("invalidates pending reviews and blocks project or epoch drift before launch", async () => {
    const kit = harness();
    kit.state.projectId = "project-1";
    const review = await kit.host.prepare(kit.request, kit.owner);
    kit.host.invalidateProjectReviews("project-1");
    await expect(kit.host.start({ token: review.token }, kit.owner)).rejects.toThrow(/no longer valid/u);
    const second = await kit.host.prepare(kit.request, kit.owner);
    kit.state.memoryEpoch += 1;
    await expect(kit.host.start({ token: second.token }, kit.owner)).rejects.toThrow(/Project memory changed/u);
    const third = await kit.host.prepare(kit.request, kit.owner);
    kit.state.projectId = null;
    await expect(kit.host.start({ token: third.token }, kit.owner)).rejects.toThrow(/changed projects/u);
    expect(kit.created).toEqual([]);
  });

  it("rechecks the memory epoch after the deferred preimage and never launches stale context", async () => {
    const kit = harness();
    kit.state.projectId = "project-1";
    let release!: (saved: boolean) => void;
    kit.state.savePreimage = () => new Promise<boolean>((resolve) => { release = resolve; });
    const review = await kit.host.prepare(kit.request, kit.owner);
    const starting = kit.host.start({ token: review.token }, kit.owner);
    expect(kit.created).toEqual([]);
    kit.state.memoryEpoch += 1;
    release(true);
    await expect(starting).rejects.toThrow(/Project memory changed/u);
    expect(kit.created).toEqual([]);
    expect(kit.host.state("case-1")?.status).toBe("failed");
  });
});

describe("the folder a session works in", () => {
  it("canonicalizes symlinked restore roots before cross-case overlap admission", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rellane-restore-lease-"));
    try {
      const actual = path.join(root, "actual");
      const alias = path.join(root, "alias");
      await mkdir(actual);
      await symlink(actual, alias);
      const kit = harness();
      kit.state.otherRoom = { id: "case-2", title: "Second", closedAt: null };
      kit.state.canonicalPath = realpath;
      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      let reserved = false;
      const first = kit.host.withFileRestoreLease("case-1", actual, kit.owner,
        async () => { reserved = true; await hold; });
      await until(() => reserved, "canonical restore lease");
      await expect(kit.host.withFileRestoreLease("case-2", alias, kit.owner,
        async () => true)).rejects.toThrow(/folder|session/u);
      release();
      await first;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("holds restore admission through preimage and blocks native start in the same canonical folder", async () => {
    const kit = harness();
    const reviewed = await kit.host.prepare(kit.request, kit.owner);
    let release!: () => void;
    const preimage = new Promise<void>((resolve) => { release = resolve; });
    let reserved = false;
    kit.state.canonicalPath = async (folder) => folder === "/alias/case-1"
      ? "/data/workstation/workspaces/case-1" : folder;
    const restoring = kit.host.withFileRestoreLease(
      "case-1", "/alias/case-1", kit.owner,
      async () => { reserved = true; await preimage; return true; }
    );
    await until(() => reserved, "restore lease");
    expect(() => kit.host.assertIdle("case-1")).toThrow();
    await expect(kit.host.start({ token: reviewed.token }, kit.owner)).rejects.toThrow(/folder|session/u);
    expect(kit.created).toEqual([]);
    release();
    await expect(restoring).resolves.toBe(true);
    await expect(kit.host.prepare(kit.request, kit.owner)).resolves.toBeDefined();
  });

  it("blocks cross-case parent and child restores while a native session is starting", async () => {
    const kit = harness();
    kit.state.otherRoom = { id: "case-2", title: "Second", closedAt: null };
    const gate = preimageGate();
    kit.state.savePreimage = gate.save;
    const reviewed = await kit.host.prepare(kit.request, kit.owner);
    const starting = kit.host.start({ token: reviewed.token }, kit.owner);
    await until(gate.requested, "native preimage");
    await expect(kit.host.withFileRestoreLease(
      "case-2", "/data/workstation/workspaces", kit.owner, async () => true
    )).rejects.toThrow(/folder|session/u);
    await expect(kit.host.withFileRestoreLease(
      "case-2", "/data/workstation/workspaces/case-1/nested", kit.owner, async () => true
    )).rejects.toThrow(/folder|session/u);
    gate.release(false);
    await expect(starting).rejects.toThrow();
    expect(kit.created).toEqual([]);
  });

  it("reveals only the current window's chosen folder and drops that choice on reload", async () => {
    const kit = harness();
    const chosen = await kit.host.chooseWorkspace(kit.owner, async () => "/data/client-work");
    await expect(kit.host.filesWorkspace("case-1", chosen!.id, kit.owner)).resolves.toEqual(chosen);
    await expect(kit.host.filesWorkspace("case-1", chosen!.id, {})).rejects.toThrow("no longer available");
    kit.host.invalidate(kit.owner);
    await expect(kit.host.filesWorkspace("case-1", chosen!.id, kit.owner)).rejects.toThrow("no longer available");
    await expect(kit.host.filesWorkspace("case-1", undefined, {})).resolves.toMatchObject({path: "/data/workstation/workspaces/case-1"});
    expect(kit.created).toEqual([]);
  });
  it("refuses a blanket grant wearing a workspace's clothes", () => {
    expect(whyWorkspaceUnsuitable("/")).not.toBeNull();
    expect(whyWorkspaceUnsuitable("/Users")).not.toBeNull();
    expect(whyWorkspaceUnsuitable("/Users/amber")).toMatch(/whole home directory/u);
    expect(whyWorkspaceUnsuitable("/Volumes/Work")).toMatch(/whole disk/u);
    expect(whyWorkspaceUnsuitable("relative/path")).toMatch(/does not accept a typed path/u);
    expect(whyWorkspaceUnsuitable("/Users/amber/Projects/brackets")).toBeNull();
  });

  it("turns a case id into one folder name and never a path", () => {
    expect(workspaceFolderName("9f1c0b2a-0000-4000-8000-000000000001")).toBe(
      "9f1c0b2a-0000-4000-8000-000000000001"
    );
    expect(workspaceFolderName("../../etc/passwd")).toBe("etc-passwd");
    expect(() => workspaceFolderName("../..")).toThrow(/private workspace folder/u);
  });

  it("holds bundled Case drafts in the same workspace admission lane as file restore", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    const caseId = openCase(db, { title: "Bundled", question: "Draft" });
    const kit = harness();
    const scope = new LocalCaseRunScope();
    const host = new WorkstationHost({ ...kit.deps, localCaseScope: scope });
    const folder = `/data/workstation/workspaces/${caseId}`;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    try {
      const local = host.runLocalCase({
        kind: "case-draft", db, caseId, operationId: "11111111-1111-4111-8111-111111111111",
        modelId: "qwen", sourceTurnIds: [], owner: kit.owner,
        stop: async () => { release(); return { stopped: true }; },
        work: () => hold
      });
      await until(() => scope.sessions().length === 1, "local admission");
      await expect(host.withFileRestoreLease("case-1", folder, kit.owner, async () => true))
        .rejects.toThrow(/session|folder/u);
      expect(() => host.assertIdle(caseId)).toThrow(/local/u);
      await host.stopLocalCase(caseId, "11111111-1111-4111-8111-111111111111", kit.owner);
      await local;
      expect(scope.sessions()).toHaveLength(0);

      let freeRestore!: () => void;
      const restoreHold = new Promise<void>((resolve) => { freeRestore = resolve; });
      const restoring = host.withFileRestoreLease("case-1", folder, kit.owner, () => restoreHold);
      await Promise.resolve();
      await expect(host.runLocalCase({
        kind: "case-draft", db, caseId, operationId: "22222222-2222-4222-8222-222222222222",
        modelId: "qwen", sourceTurnIds: [], owner: kit.owner,
        stop: async () => ({ stopped: false }), work: async () => undefined
      })).rejects.toThrow(/session|folder/u);
      freeRestore();
      await restoring;
    } finally {
      release();
      db.close();
    }
  });

  it("cannot admit a local draft after its window is invalidated during workspace resolution", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    const caseId = openCase(db, { title: "Bundled", question: "Draft" });
    const kit = harness();
    const scope = new LocalCaseRunScope();
    let release!: (path: string) => void;
    let resolving = false;
    const canonical = new Promise<string>((resolve) => { release = resolve; });
    kit.state.canonicalPath = async () => { resolving = true; return canonical; };
    const host = new WorkstationHost({ ...kit.deps, localCaseScope: scope });
    try {
      const attempt = host.runLocalCase({
        kind: "case-draft", db, caseId, operationId: "33333333-3333-4333-8333-333333333333",
        modelId: "qwen", sourceTurnIds: [], owner: kit.owner,
        stop: async () => ({ stopped: false }),
        work: async () => { throw new Error("The daemon must not be reached."); }
      });
      await until(() => resolving, "local workspace resolution");
      host.invalidate(kit.owner);
      release(`/data/workstation/workspaces/${caseId}`);
      await expect(attempt).rejects.toThrow(/window changed/u);
      expect(scope.sessions()).toHaveLength(0);
    } finally {
      release(`/data/workstation/workspaces/${caseId}`);
      db.close();
    }
  });

  it("shares local admission and global Stop with the projectless brief draft", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    const scope = new LocalBriefDraftScope();
    scope.recover(db);
    const kit = harness();
    const host = new WorkstationHost({ ...kit.deps, book: () => db,
      localBriefScope: scope, localCaseScope: new LocalCaseRunScope() });
    let rejectChat!: (error: Error) => void;
    let calls = 0;
    const runtime: LocalWorkroomDeps = {
      discover: async () => [{ id: "cadrane-local-loopback", name: "Bundled", kind: "lm-studio",
        baseUrl: "http://127.0.0.1:12340", state: "available", version: null,
        detail: "Synthetic", checkedAt: "2026-09-24T00:00:00Z",
        models: [{ id: "local-model", displayName: "Local", loaded: true, sizeBytes: 100 }] }],
      chat: async () => { calls += 1; return new Promise<LocalChatResult>((_resolve, reject) => { rejectChat = reject; }); },
      cancel: async () => { rejectChat(new Error("Synthetic runtime cancellation")); }
    };
    try {
      const pending = host.runLocalBrief({ db, handle: "44444444-4444-4444-8444-444444444444",
        sentence: "Make a file reader", folders: [], owner: kit.owner,
        assertOwner: () => undefined, grantedFolders: () => [], runtime });
      const stopped = expect(pending).rejects.toThrow(/Stopped/);
      await until(() => calls === 1, "brief dispatch");
      await expect(host.runLocalCase({ db, kind: "case-draft", caseId: "case-1",
        operationId: "55555555-5555-4555-8555-555555555555", modelId: "local-model",
        sourceTurnIds: [], owner: kit.owner, stop: async () => ({ stopped: false }),
        work: async () => { throw new Error("Concurrent local work must not dispatch"); }
      })).rejects.toThrow(/Bundled-local/);
      expect((await host.stopAllFromPhone()).sessions).toBe(1);
      await stopped;
      expect(scope.sessions()).toHaveLength(0);
      expect(db.prepare("SELECT event FROM workstation_local_brief_receipt ORDER BY sequence DESC LIMIT 1").get())
        .toEqual({ event: "interrupted" });
      const history = host.localBriefHistory();
      expect(history.count).toBe(1);
      expect(host.forgetLocalBriefHistory(history.reviewSha256)).toEqual({ removed: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM work_case").get()).toEqual({ count: 0 });
    } finally { await host.shutdown(); db.close(); }
  });

  it("global Host Stop reaches the active bundled Agent child", async () => {
    const kit = harness();
    const scope = new LocalCaseRunScope();
    const host = new WorkstationHost({ ...kit.deps, localCaseScope: scope });
    let release!: () => void;
    let stops = 0;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const pending = host.runLocalAgent({
      db: {} as DatabaseSync, agentId: "reader", owner: kit.owner,
      stop: () => { stops += 1; release(); return true; },
      work: async () => {
        await hold;
        return { id: "", agentId: "reader", agentName: "Reader", outcome: "stopped",
          summary: "Stop requested", answer: "", problem: "Stop requested",
          substituted: null, ranOnLabel: null, read: [], elapsedMs: 0, approxTokens: 0 };
      }
    });
    await until(() => scope.sessions().length === 1, "Agent admission");
    expect((await host.stopAllFromPhone()).sessions).toBe(1);
    expect(stops).toBe(1);
    expect((await pending).outcome).toBe("stopped");
    expect(scope.sessions()).toHaveLength(0);
  });
});
