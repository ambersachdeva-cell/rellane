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
import type { DatabaseSync } from "node:sqlite";
import type {
  WorkstationProvider,
  WorkstationRoutine,
  WorkstationSnapshot
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
    clock: 1_000_000,
    stored: null as WorkstationSessionReceipt | null,
    launches: [{ provider: CODEX, executable: "/usr/local/bin/codex" }] as NativeProviderLaunch[],
    recoveries: 0,
    transactions: 0,
    txDepth: 0,
    omitted: [] as string[],
    packedIds: null as string[] | null
  };
  let tokens = 0;
  let ids = 0;

  const deps: WorkstationHostDeps = {
    book: () => ({}) as DatabaseSync,
    readCase: (_db, caseId) => (state.room !== null && state.room.id === caseId ? state.room : null),
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
    buildContext: ({ prompt, sources }) => ({
      packet: JSON.stringify({ request: prompt, sources }),
      // Deliberately a summary rather than the packet, exactly like the real
      // assembler: the host must not be able to pass this off as the bytes.
      preview: `${prompt} (+${sources.length})`,
      sourceIds: state.packedIds ?? sources.map((source) => source.id),
      sha256: "context-hash",
      omitted: state.omitted
    }),
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
  return { host, deps, owner, request, turns, receipts, receiptDepths, workers, created, state };
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

function drafts(turns: readonly WorkstationTurnRow[]): readonly WorkstationTurnRow[] {
  return turns.filter((turn) => turn.seat.startsWith("Workstation ·"));
}

function receiptsWritten(turns: readonly WorkstationTurnRow[]): readonly WorkstationTurnRow[] {
  return turns.filter((turn) => turn.seat === "workstation" && turn.kind === "receipt");
}

describe("the workstation host", () => {
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
      workspacePath: "/data/workstation/workspaces/case-1"
    };
    const resumed = await kit.host.prepare(kit.request, kit.owner);
    expect(resumed.resumeSessionId).toBe("thread-7");

    kit.state.stored = {
      version: 1,
      event: "finish",
      snapshot,
      workspacePath: "/somewhere/else"
    };
    const fresh = await kit.host.prepare(kit.request, kit.owner);
    expect(fresh.resumeSessionId).toBeNull();
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

describe("the folder a session works in", () => {
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
});
