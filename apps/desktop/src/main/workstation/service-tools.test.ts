/**
 * What the host will and will not grant a model, and when it takes it away.
 *
 * The broker itself is tested next door; none of that is repeated here. These
 * tests are about the host's half of the bargain: that an opt-in is never
 * silently dropped, that the review describes the scope before the token is
 * spent, that the scope is built from the sources that were actually
 * re-checked at start rather than the ones shown at review, and that it stops
 * answering the moment anything it was bound to changes.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { ContextSnapshot } from "./context-snapshot-store.js";
import type { DatabaseSync } from "node:sqlite";
import type { WorkstationProvider, WorkstationRoutine } from "@cadrane/contracts";
import type {
  NativeEvent,
  NativeProviderLaunch,
  NativeWorker,
  NativeWorkerOptions,
  NativeWorkerResult,
  WorkstationSessionReceipt
} from "./types.js";
import type { NativeToolSession, NativeToolSessionOptions } from "./native-tools.js";
import {
  WorkstationHost,
  type WorkstationCaseRow,
  type WorkstationHostDeps,
  type WorkstationTurnRow
} from "./service.js";

interface FakeWorker {
  readonly worker: NativeWorker;
  readonly options: NativeWorkerOptions;
  finish(result: NativeWorkerResult): void;
  interrupts: number;
}

function fakeWorker(options: NativeWorkerOptions): FakeWorker {
  let settle: ((result: NativeWorkerResult) => void) | null = null;
  const fake: FakeWorker = {
    options,
    interrupts: 0,
    finish: (result) => {
      settle?.(result);
    },
    worker: {
      run: () =>
        new Promise<NativeWorkerResult>((resolve) => {
          settle = resolve;
        }),
      interrupt: async () => {
        fake.interrupts += 1;
        return { acknowledged: true, detail: "asked the session to stop" };
      },
      decide: async () => undefined,
      dispose: async () => undefined
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

const ROUTINES: readonly WorkstationRoutine[] = [];

const SOURCE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_B = "33333333-3333-4333-8333-333333333333";

interface FakeToolSession extends NativeToolSession {
  readonly built: NativeToolSessionOptions;
  disposals: number;
}

function harness(options?: { readonly withTools?: boolean }) {
  const turns: WorkstationTurnRow[] = [
    { id: SOURCE_A, seat: "Source · quote.md", kind: "verbatim", body: "Ten brackets, delivered Tuesday." },
    { id: SOURCE_B, seat: "owner", kind: "verbatim", body: "Confirm the price before replying." }
  ];
  const workers: FakeWorker[] = [];
  const sessions: FakeToolSession[] = [];
  const receipts: WorkstationSessionReceipt[] = [];
  const contextSnapshots = new Map<string, ContextSnapshot>();
  const state = {
    room: { id: "case-1", title: "Brackets", closedAt: null } as WorkstationCaseRow | null,
    clock: 1_000_000,
    stored: null as WorkstationSessionReceipt | null,
    launches: [
      { provider: CODEX, executable: "/usr/local/bin/codex" },
      { provider: CLAUDE, executable: "/usr/local/bin/claude" }
    ] as NativeProviderLaunch[],
    projectId: null as string | null,
    memoryEpoch: 0
  };
  let tokens = 0;
  let ids = 0;

  const toolDeps: WorkstationHostDeps["tools"] = {
    create: (created) => {
      const session: FakeToolSession = {
        built: created,
        disposals: 0,
        definitions: [],
        execute: async () => ({ contentItems: [], success: false }),
        dispose: () => {
          session.disposals += 1;
        }
      };
      sessions.push(session);
      return session;
    },
    names: () => ["rellane_list_sources", "rellane_read_source", "hermes_check_citations"],
    skillIds: () => ["hermes/document-to-action-items"],
    // Never settles: this suite asserts what was handed over, not what the
    // pinned checker answers. Its result shape is the checker's business.
    checkCitations: () => new Promise(() => undefined)
  };

  const deps: WorkstationHostDeps = {
    book: () => ({}) as DatabaseSync,
    readCase: (_db, caseId) => {
      if (state.room !== null && state.room.id === caseId) return state.room;
      // A second open work, so genuinely disjoint sessions can be exercised.
      if (caseId === "case-2") return { id: "case-2", title: "Other work", closedAt: null };
      return null;
    },
    turnsFor: () => turns,
    appendTurn: (_db, _caseId, turn) => {
      const id = `turn-${turns.length + 1}`;
      turns.push({ id, seat: turn.seat, kind: turn.kind, body: turn.body });
      return id;
    },
    transaction: (_db, work) => {
      work();
    },
    discoverProviders: async () => state.launches,
    buildContext: ({ prompt, sources }) => ({
      packet: JSON.stringify({ request: prompt, sources }),
      preview: `${prompt} (+${sources.length})`,
      sourceIds: sources.map((source) => source.id),
      sha256: "context-hash",
      omitted: []
    }),
    memory: {
      projectForCase: () => state.projectId,
      epoch: () => state.memoryEpoch,
      constraints: () => [],
      findings: () => [],
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
    createWorker: (_providerId, workerOptions) => {
      const worker = fakeWorker(workerOptions);
      workers.push(worker);
      return worker.worker;
    },
    saveReceipt: (_db, _caseId, receipt) => {
      receipts.push(receipt);
    },
    latestReceipt: () => state.stored,
    recoverInterrupted: () => 0,
    routines: () => ROUTINES,
    privateWorkspace: async (caseId) => ({
      id: `case:${caseId}`,
      label: "This case's own folder",
      path: `/data/workstation/workspaces/${caseId}`
    }),
    canonicalWorkspacePath: async (workspacePath) => workspacePath,
    onRunStart: async () => true,
    extractArtifacts: () => [],
    now: () => state.clock,
    token: () => {
      tokens += 1;
      return tokens.toString(16).padStart(64, "0");
    },
    newId: () => {
      ids += 1;
      return `00000000-0000-4000-8000-00000000000${ids}`;
    },
    ...(options?.withTools === false ? {} : { tools: toolDeps })
  };

  const host = new WorkstationHost(deps);
  const owner = { window: "one" };
  const request = {
    caseId: "case-1",
    providerId: "codex" as const,
    modelId: "gpt-5-codex",
    prompt: "Draft the quotation reply.",
    sourceTurnIds: [SOURCE_A, SOURCE_B]
  };
  return { host, owner, request, turns, workers, sessions, receipts, state, contextSnapshots };
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

describe("workstation host: the reviewed tool scope", () => {
  it("grants nothing unless somebody asked for it", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    expect(review.tools).toBeUndefined();

    await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.workers.length === 1, "the worker");
    expect(kit.sessions).toHaveLength(0);
    expect(kit.workers[0]!.options.tools).toBeUndefined();
  });

  it("describes the whole scope, and the reach, before the token is spent", async () => {
    const kit = harness();
    const review = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);

    expect(review.tools?.enabled).toBe(true);
    expect(review.tools?.toolNames).toEqual([
      "rellane_list_sources",
      "rellane_read_source",
      "hermes_check_citations"
    ]);
    expect(review.tools?.skillIds).toEqual(["hermes/document-to-action-items"]);
    // Named the way the owner sees them elsewhere, not by the assembler's
    // internal "Source 1 · seat" label.
    expect(review.tools?.sources).toEqual([
      { label: "quote.md", chars: "Ten brackets, delivered Tuesday.".length },
      { label: "owner", chars: "Confirm the price before replying.".length }
    ]);
    expect(review.tools?.totalSourceChars).toBe(
      "Ten brackets, delivered Tuesday.".length + "Confirm the price before replying.".length
    );
    expect(review.tools?.reachNote).toContain("in full");
    expect(review.tools?.freshSessionNote.length).toBeGreaterThan(0);
  });

  it("starts a new session rather than continuing a saved one", async () => {
    const kit = harness();
    const seed = await kit.host.prepare(kit.request, kit.owner);
    const prior = kit.contextSnapshots.get(seed.contextSnapshotId!)!;
    kit.contextSnapshots.set(seed.contextSnapshotId!, { ...prior, dispatchAttemptedAt: 1 });
    kit.state.stored = {
      version: 1,
      event: "finish",
      workspacePath: "/data/workstation/workspaces/case-1",
      contextSnapshotId: seed.contextSnapshotId!,
      projectId: null,
      snapshot: {
        caseId: "case-1",
        operationId: "old-op",
        providerId: "codex",
        modelId: "gpt-5-codex",
        sessionId: "saved-session",
        status: "completed",
        startedAt: 1,
        updatedAt: 2,
        text: "",
        activity: [],
        permission: null,
        detail: "done"
      }
    };

    const ordinary = await kit.host.prepare(kit.request, kit.owner);
    expect(ordinary.resumeSessionId).toBe("saved-session");

    const withTools = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);
    expect(withTools.resumeSessionId).toBeNull();

    await kit.host.start({ token: withTools.token }, kit.owner);
    await until(() => kit.workers.length === 1, "the worker");
    expect(kit.workers[0]!.options.resumeId).toBeUndefined();
  });

  it("builds the scope from the sources it re-read at start, and hands it to the adapter", async () => {
    const kit = harness();
    const review = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.workers.length === 1, "the worker");

    expect(kit.sessions).toHaveLength(1);
    const built = kit.sessions[0]!.built;
    expect(built.caseId).toBe("case-1");
    expect(built.sources.map((source) => source.id)).toEqual([SOURCE_A, SOURCE_B]);
    expect(built.sources.map((source) => source.text)).toEqual([
      "Ten brackets, delivered Tuesday.",
      "Confirm the price before replying."
    ]);
    expect(built.sources.map((source) => source.label)).toEqual(["quote.md", "owner"]);
    expect(kit.workers[0]!.options.tools).toBe(kit.sessions[0]);
  });

  it("refuses a provider that cannot review each call, and mints no token", async () => {
    const kit = harness();
    await expect(
      kit.host.prepare({ ...kit.request, providerId: "claude", modelId: "sonnet", enableTools: true }, kit.owner)
    ).rejects.toThrow(/only available with Codex/);

    // Nothing was staged, so nothing can be sent.
    const review = await kit.host.prepare(kit.request, kit.owner);
    await expect(
      kit.host.start({ token: "0".repeat(63) + "9" }, kit.owner)
    ).rejects.toThrow(/already been used or is no longer valid/);
    expect(review.tools).toBeUndefined();
  });

  it("refuses rather than quietly dropping the opt-in when this build has no tools", async () => {
    const kit = harness({ withTools: false });
    await expect(
      kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner)
    ).rejects.toThrow(/cannot offer tools/);
  });

  it("refuses a scope the broker would reject anyway", async () => {
    const kit = harness();
    const wide = "x".repeat(150_000);
    kit.turns[0] = { id: SOURCE_A, seat: "Source · big.md", kind: "verbatim", body: wide };
    kit.turns[1] = { id: SOURCE_B, seat: "Source · also-big.md", kind: "verbatim", body: wide };
    await expect(
      kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner)
    ).rejects.toThrow(/larger than tools can cover/);
  });

  it("builds no scope when the case changed between the review and the send", async () => {
    const kit = harness();
    const review = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);
    kit.turns[0] = { id: SOURCE_A, seat: "Source · quote.md", kind: "verbatim", body: "Twelve brackets now." };

    await expect(kit.host.start({ token: review.token }, kit.owner)).rejects.toThrow(/changed after that review/);
    expect(kit.sessions).toHaveLength(0);
    expect(kit.workers).toHaveLength(0);
  });

  it("stops answering when a source is edited underneath a running session", async () => {
    const kit = harness();
    const review = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.sessions.length === 1, "the scope");

    expect(kit.sessions[0]!.built.isActive()).toBe(true);
    kit.turns[1] = { id: SOURCE_B, seat: "owner", kind: "verbatim", body: "Actually, do not mention price." };
    expect(kit.sessions[0]!.built.isActive()).toBe(false);
  });

  it("closes the tool disclosure scope when project memory is superseded", async () => {
    const kit = harness();
    kit.state.projectId = "project-1";
    kit.state.memoryEpoch = 4;
    const review = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.sessions.length === 1, "the scope");
    expect(kit.sessions[0]!.built.isActive()).toBe(true);
    kit.state.memoryEpoch = 5;
    expect(kit.sessions[0]!.built.isActive()).toBe(false);
  });

  it("stops answering when the work is closed underneath a running session", async () => {
    const kit = harness();
    const review = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.sessions.length === 1, "the scope");

    expect(kit.sessions[0]!.built.isActive()).toBe(true);
    kit.state.room = { id: "case-1", title: "Brackets", closedAt: 2_000_000 };
    expect(kit.sessions[0]!.built.isActive()).toBe(false);
  });

  it("treats a book it cannot read as closed rather than open", async () => {
    const kit = harness();
    const review = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.sessions.length === 1, "the scope");

    kit.state.room = null;
    expect(kit.sessions[0]!.built.isActive()).toBe(false);
  });

  it("closes the scope before the provider is even asked to stop", async () => {
    const kit = harness();
    const review = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);
    const snapshot = await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.workers.length === 1, "the worker");

    const stopping = kit.host.stop("case-1", snapshot.operationId, kit.owner);
    expect(kit.sessions[0]!.disposals).toBe(1);
    expect(kit.sessions[0]!.built.isActive()).toBe(false);
    await stopping;
    kit.workers[0]!.finish({ sessionId: "s1", text: "partial", finishReason: "stopped" });
  });

  it("closes the scope when the window that started it goes away", async () => {
    const kit = harness();
    const review = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.workers.length === 1, "the worker");

    kit.host.invalidate(kit.owner);
    await until(() => kit.sessions[0]!.disposals === 1, "the scope to close");
    expect(kit.sessions[0]!.built.isActive()).toBe(false);
    kit.workers[0]!.finish({ sessionId: "s1", text: "", finishReason: "stopped" });
  });

  it("closes the scope when the turn simply finishes", async () => {
    const kit = harness();
    const review = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.workers.length === 1, "the worker");

    kit.workers[0]!.finish({ sessionId: "s1", text: "Here is the reply.", finishReason: "completed" });
    await until(() => kit.sessions[0]!.disposals === 1, "the scope to close");
  });

  it("writes down what was granted, where the record will outlive the app", async () => {
    const kit = harness();
    const review = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.workers.length === 1, "the worker");

    const receipt = kit.turns.find(
      (turn) => turn.seat === "workstation" && turn.kind === "receipt" && turn.body.includes("Tools granted")
    );
    expect(receipt).toBeDefined();
    expect(receipt!.body).toContain("2 reviewed sources");
    expect(receipt!.body).toContain("in a new session");
  });

  it("writes every decided call into the case receipt, declines included", async () => {
    const kit = harness();
    const review = await kit.host.prepare({ ...kit.request, enableTools: true }, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.workers.length === 1, "the worker");

    const emit = kit.workers[0]!.options.onEvent;
    emit({
      type: "tool",
      callId: "call-1",
      tool: "rellane_read_source",
      outcome: "ran",
      argumentSummary: '{"sourceId":"quote"}',
      resultBytes: 1_204,
      detail: ""
    });
    emit({
      type: "tool",
      callId: "call-2",
      tool: "hermes_check_citations",
      outcome: "declined",
      argumentSummary: '{"draft":"…"}',
      resultBytes: 0,
      detail: "You declined this call."
    });
    kit.workers[0]!.finish({ sessionId: "s1", text: "Done.", finishReason: "completed" });
    await until(
      () => kit.turns.some((turn) => turn.kind === "receipt" && turn.body.includes("Tools:")),
      "the finish receipt"
    );

    const receipt = kit.turns.filter((turn) => turn.kind === "receipt").at(-1)!;
    expect(receipt.body).toContain("rellane_read_source");
    // The declined call is in the record exactly as loudly as the one that ran.
    expect(receipt.body).toContain("hermes_check_citations");
    expect(receipt.body).toContain("declined");
    expect(receipt.body).toContain("1,204");
  });

  it("leaves an ordinary session's receipt exactly as it was", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.workers.length === 1, "the worker");
    kit.workers[0]!.finish({ sessionId: "s1", text: "Done.", finishReason: "completed" });
    await until(
      () => kit.turns.some((turn) => turn.kind === "receipt" && turn.body.includes("completed")),
      "the finish receipt"
    );

    const receipt = kit.turns.filter((turn) => turn.kind === "receipt").at(-1)!;
    expect(receipt.body).not.toContain("Tools:");
  });

  it("runs two disjoint sessions at once, and refuses one that would collide", async () => {
    const kit = harness();
    const first = await kit.host.prepare(kit.request, kit.owner);
    await kit.host.start({ token: first.token }, kit.owner);
    await until(() => kit.workers.length === 1, "the first worker");

    // Different work, different folder, different subscription. Nothing about
    // this can collide with the first, and the old rule refused it anyway.
    const second = await kit.host.prepare(
      { ...kit.request, caseId: "case-2", providerId: "claude", modelId: "sonnet" },
      kit.owner
    );
    await kit.host.start({ token: second.token }, kit.owner);
    await until(() => kit.workers.length === 2, "the second worker");

    // Both are live, and each case reports its own.
    expect(kit.host.state("case-1")?.status).not.toBe("completed");
    expect(kit.host.state("case-2")?.status).not.toBe("completed");
    expect(kit.host.state("case-1")?.operationId).not.toBe(kit.host.state("case-2")?.operationId);

    // A third against a subscription already in use is still refused.
    await expect(
      kit.host.prepare({ ...kit.request, caseId: "case-2", providerId: "codex" }, kit.owner)
    ).rejects.toThrow();

    // Stopping one leaves the other working — the property that makes this
    // usable rather than merely permitted.
    const running = kit.host.state("case-1");
    await kit.host.stop("case-1", running!.operationId, kit.owner);
    expect(kit.host.state("case-2")?.status).not.toBe("stopped");

    kit.workers[0]!.finish({ sessionId: "s1", text: "", finishReason: "stopped" });
    kit.workers[1]!.finish({ sessionId: "s2", text: "Done.", finishReason: "completed" });
  });

  it("says plainly in the receipt when no tools were granted", async () => {
    const kit = harness();
    const review = await kit.host.prepare(kit.request, kit.owner);
    await kit.host.start({ token: review.token }, kit.owner);
    await until(() => kit.workers.length === 1, "the worker");

    const receipt = kit.turns.find(
      (turn) => turn.seat === "workstation" && turn.kind === "receipt" && turn.body.includes("No tools were granted")
    );
    expect(receipt).toBeDefined();
  });
});
