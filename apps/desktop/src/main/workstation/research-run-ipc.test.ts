import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { WorkstationProviderId, WorkstationReview } from "@cadrane/contracts";
import type { NativeAskOutcome } from "./types.js";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  installResearch,
  installReviewedResearchRun,
  type InstallResearchOptions,
  type ResearchRunView
} from "./research-run-ipc.js";

type IpcHandler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;
const registeredHandlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      registeredHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      registeredHandlers.delete(channel);
    })
  }
}));

vi.mock("../../shared/ipc-channels.js", () => ({
  IPC_CHANNELS: {
    workstationResearchPrepare: "workstation:research-prepare",
    workstationResearchStart: "workstation:research-start",
    workstationResearchPoll: "workstation:research-poll",
    workstationResearchStop: "workstation:research-stop"
  }
}));

vi.mock("../agents/source-owner.js", () => ({
  createAgentSourceOwners: () => () => "trusted-owner-token"
}));

const mockEvent = {
  sender: {},
  senderFrame: {}
} as unknown as IpcMainInvokeEvent;

async function invokeChannel<T>(channel: string, input: unknown): Promise<T> {
  const handler = registeredHandlers.get(channel);
  if (!handler) {
    throw new Error(`No registered handler for channel: ${channel}`);
  }
  return (await handler(mockEvent, input)) as T;
}

async function pollUntilFinished(runId: string, timeoutMs = 4000): Promise<ResearchRunView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await invokeChannel<ResearchRunView>(IPC_CHANNELS.workstationResearchPoll, { runId });
    if (view.state === "done" || view.state === "stopped" || view.state === "failed" || view.state === "interrupted") {
      return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for research run to finish.");
}

const native = (text: string): NativeAskOutcome => ({ text, sessionId: "session-test", finishReason: "completed", requestedModelId: null, cancellationRequested: false, resultSource: "worker", reportedModelId: "test-model" });

describe("research-run-ipc", () => {
  beforeEach(() => {
    registeredHandlers.clear();
  });

  it("reads both urls, names them in plain words, and stops at step limit with cut-short notice", async () => {
    const pages: Record<string, { readonly html: string; readonly finalUrl: string }> = {
      "https://supplier.example.com/prices": {
        html: `<html><head><title>Supplier price list</title></head><body><p>Rates: £10</p><a href="/sub1">Sub 1</a><a href="/sub2">Sub 2</a></body></html>`,
        finalUrl: "https://supplier.example.com/prices"
      },
      "https://supplier.example.com/terms": {
        html: `<html><head><title>Contract terms</title></head><body><p>Net 30</p><a href="/sub3">Sub 3</a><a href="/sub4">Sub 4</a></body></html>`,
        finalUrl: "https://supplier.example.com/terms"
      },
      "https://supplier.example.com/sub1": {
        html: `<html><head><title>Subpage 1</title></head><body><p>Discount available</p><a href="/sub5">Sub 5</a></body></html>`,
        finalUrl: "https://supplier.example.com/sub1"
      },
      "https://supplier.example.com/sub2": {
        html: `<html><head><title>Subpage 2</title></head><body><p>Standard delivery</p></body></html>`,
        finalUrl: "https://supplier.example.com/sub2"
      },
      "https://supplier.example.com/sub3": {
        html: `<html><head><title>Subpage 3</title></head><body><p>Late fee 2%</p></body></html>`,
        finalUrl: "https://supplier.example.com/sub3"
      },
      "https://supplier.example.com/sub4": {
        html: `<html><head><title>Subpage 4</title></head><body><p>Arbitration clause</p></body></html>`,
        finalUrl: "https://supplier.example.com/sub4"
      }
    };

    const fetchPage = vi.fn(async (url: string) => pages[url] ?? null);
    const ask = vi.fn(async ({ prompt }: { readonly prompt: string }) => {
      if (prompt.includes("Write a calm, direct summary")) {
        return native("Supplier charges £10 on net 30 terms with 2% late fee.");
      }
      return native("- Found relevant term.");
    });
    const record = vi.fn(async () => "rec-123");
    const files = vi.fn(async () => []);
    const assertTrusted = vi.fn();

    const options: InstallResearchOptions = {
      assertTrusted,
      fetchPage,
      ask,
      record,
      files
    };

    installResearch(options);

    const startResult = await invokeChannel<{ readonly runId: string }>(
      IPC_CHANNELS.workstationResearchStart,
      {
        caseId: "case-supplier-1",
        question: "What are the agreed pricing terms?",
        urls: ["https://supplier.example.com/prices", "https://supplier.example.com/terms"],
        depth: "quick"
      }
    );

    expect(startResult.runId).toBeDefined();
    const finished = await pollUntilFinished(startResult.runId);

    expect(fetchPage).toHaveBeenCalledWith("https://supplier.example.com/prices", expect.anything());
    expect(fetchPage).toHaveBeenCalledWith("https://supplier.example.com/terms", expect.anything());

    // Quick depth caps at 6 steps
    expect(finished.steps.length).toBe(6);
    expect(finished.state).toBe("done");
    expect(finished.canStop).toBe(false);

    // Steps must name the sources in words, never displaying raw URLs
    expect(finished.steps[0]!.title).toBe('Reading "Supplier price list"');
    expect(finished.steps[1]!.title).toBe('Reading "Contract terms"');

    // The answer must state plainly that it was cut short by the step limit
    expect(finished.answer).toContain("Research was cut short after reaching the limit of 6 steps.");
    expect(finished.headline).toContain("Research reached the step limit of 6 steps.");
    expect(finished.unanswered.length).toBeGreaterThan(0);
    expect(record).toHaveBeenCalledWith({
      caseId: "case-supplier-1",
      body: expect.stringContaining("Research was cut short after reaching the limit of 6 steps.")
    });
  });

  it("aborts in-flight fetch when stopped mid-run", async () => {
    // Undefined rather than null: a variable only ever assigned inside a
    // closure stays narrowed to its initialiser, so `if (x) x(...)` does not
    // widen it back to callable. An optional call sidesteps the analysis.
    let resolvePendingFetch: ((val: { readonly html: string; readonly finalUrl: string } | null) => void) | undefined;
    let signalObserved: AbortSignal | null = null;

    const fetchPage = vi.fn((_url: string, signal: AbortSignal) => {
      signalObserved = signal;
      return new Promise<{ readonly html: string; readonly finalUrl: string } | null>((resolve) => {
        resolvePendingFetch = resolve;
        signal.addEventListener("abort", () => {
          resolve(null);
        });
      });
    });

    const ask = vi.fn(async () => native("NONE"));
    const record = vi.fn(async () => "rec-abort");
    const files = vi.fn(async () => []);
    const assertTrusted = vi.fn();

    installResearch({
      assertTrusted,
      fetchPage,
      ask,
      record,
      files
    });

    const { runId } = await invokeChannel<{ readonly runId: string }>(
      IPC_CHANNELS.workstationResearchStart,
      {
        caseId: "case-stop",
        question: "Do they accept card payments?",
        urls: ["https://slow.example.com/checkout"],
        depth: "quick"
      }
    );

    // Await fetch entry
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalled());
    expect(signalObserved).not.toBeNull();
    expect(signalObserved!.aborted).toBe(false);

    const stoppedView = await invokeChannel<ResearchRunView>(
      IPC_CHANNELS.workstationResearchStop,
      { runId }
    );

    expect(stoppedView.state).toBe("stopped");
    expect(stoppedView.canStop).toBe(false);
    expect(signalObserved!.aborted).toBe(true);

    resolvePendingFetch?.(null);
  });

  it("keeps an in-flight provider's partial Research text after Stop without completing the run", async () => {
    let finishAsk!: (outcome: NativeAskOutcome) => void;
    let signalObserved: AbortSignal | null = null;
    const ask = vi.fn(({ signal }: { readonly signal: AbortSignal }) => {
      signalObserved = signal;
      return new Promise<NativeAskOutcome>(resolve => { finishAsk = resolve; });
    });
    const record = vi.fn(async () => "partial-turn");
    installResearch({
      assertTrusted: () => {},
      fetchPage: async () => null,
      files: async () => [{ id: "source-1", label: "Owner source", text: "Facts to inspect." }],
      ask,
      record
    });

    const { runId } = await invokeChannel<{ readonly runId: string }>(
      IPC_CHANNELS.workstationResearchStart,
      { caseId: "case-partial", question: "What do the facts show?", depth: "quick" }
    );
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await invokeChannel<ResearchRunView>(IPC_CHANNELS.workstationResearchStop, { runId });
    expect(signalObserved!.aborted).toBe(true);
    finishAsk({
      ...native("Half a note, still useful."), finishReason: "failed", detail: "Provider disconnected.",
      sessionId: "native-research-7", cancellationRequested: true
    });

    await vi.waitFor(async () => {
      const view = await invokeChannel<ResearchRunView>(IPC_CHANNELS.workstationResearchPoll, { runId });
      expect(view.state).toBe("stopped");
      expect(view.answer).toBe("Half a note, still useful.");
      expect(view.nativeOutcomes).toEqual([expect.objectContaining({
        text: "Half a note, still useful.", finishReason: "failed", detail: "Provider disconnected.",
        sessionId: "native-research-7", cancellationRequested: true
      })]);
    });
    expect(record).toHaveBeenCalledWith({
      caseId: "case-partial", body: expect.stringContaining("Partial research draft (stopped)")
    });
  });

  it("stops early and reports why when two successive steps produce no notes", async () => {
    const fetchPage = vi.fn(async (url: string) => ({
      html: `<html><head><title>General Info</title></head><body>Nothing related here</body></html>`,
      finalUrl: url
    }));

    // ask returns empty findings to trigger the two-step no-note early stop
    const ask = vi.fn(async () => native("NONE"));
    const record = vi.fn(async () => "rec-early");
    const files = vi.fn(async () => []);
    const assertTrusted = vi.fn();

    installResearch({
      assertTrusted,
      fetchPage,
      ask,
      record,
      files
    });

    const { runId } = await invokeChannel<{ readonly runId: string }>(
      IPC_CHANNELS.workstationResearchStart,
      {
        caseId: "case-empty",
        question: "What is the direct telephone line for billing?",
        urls: [
          "https://example.com/page1",
          "https://example.com/page2",
          "https://example.com/page3"
        ],
        depth: "quick"
      }
    );

    const finished = await pollUntilFinished(runId);

    // Must stop after page 2 without reading page 3 to protect subscription quota
    expect(finished.steps.length).toBe(2);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(finished.headline).toBe("Research stopped early: the last two sources added no new notes.");
    expect(finished.answer).toContain("Research stopped early because the last two sources added no new notes.");
  });

  it("only follows links when parent yields notes and honours host boundaries", async () => {
    const pages: Record<string, { readonly html: string; readonly finalUrl: string }> = {
      "https://alpha.example.com/start": {
        html: `<html><head><title>Alpha</title></head><body><a href="https://beta.external.com/info">Beta External</a></body></html>`,
        finalUrl: "https://alpha.example.com/start"
      },
      "https://beta.external.com/info": {
        html: `<html><head><title>Beta</title></head><body><a href="https://gamma.untrusted.com/leak">Untrusted</a><a href="https://alpha.example.com/end">Alpha Return</a></body></html>`,
        finalUrl: "https://beta.external.com/info"
      },
      "https://alpha.example.com/end": {
        html: `<html><head><title>Alpha Return</title></head><body>Done</body></html>`,
        finalUrl: "https://alpha.example.com/end"
      }
    };

    const fetchPage = vi.fn(async (url: string) => pages[url] ?? null);
    const ask = vi.fn(async () => native("- Relevant link note"));
    const record = vi.fn(async () => "rec-bound");
    const files = vi.fn(async () => []);
    const assertTrusted = vi.fn();

    installResearch({
      assertTrusted,
      fetchPage,
      ask,
      record,
      files
    });

    const { runId } = await invokeChannel<{ readonly runId: string }>(
      IPC_CHANNELS.workstationResearchStart,
      {
        caseId: "case-boundary",
        question: "Trace supplier lineage",
        urls: ["https://alpha.example.com/start"],
        depth: "quick"
      }
    );

    await pollUntilFinished(runId);

    // Level 1 from user-supplied page may visit beta.external.com
    expect(fetchPage).toHaveBeenCalledWith("https://beta.external.com/info", expect.anything());
    // Secondary link back to user-named host alpha.example.com is permitted
    expect(fetchPage).toHaveBeenCalledWith("https://alpha.example.com/end", expect.anything());
    // But secondary link to un-named host gamma.untrusted.com must never be followed
    expect(fetchPage).not.toHaveBeenCalledWith("https://gamma.untrusted.com/leak", expect.anything());
  });

  it("deduplicates pages by final landing url rather than initial query", async () => {
    const fetchPage = vi.fn(async (url: string) => ({
      html: `<html><head><title>Same Destination</title></head><body>Content</body></html>`,
      finalUrl: "https://example.com/canonical-pricing"
    }));

    const ask = vi.fn(async () => native("- Canonical note"));
    const record = vi.fn(async () => "rec-dedup");
    const files = vi.fn(async () => []);
    const assertTrusted = vi.fn();

    installResearch({
      assertTrusted,
      fetchPage,
      ask,
      record,
      files
    });

    const { runId } = await invokeChannel<{ readonly runId: string }>(
      IPC_CHANNELS.workstationResearchStart,
      {
        caseId: "case-dedup",
        question: "What is the base price?",
        urls: ["https://example.com/pricing-alias-1", "https://example.com/pricing-alias-2"],
        depth: "quick"
      }
    );

    const finished = await pollUntilFinished(runId);

    expect(finished.sourcesRead).toBe(1);
    expect(finished.steps[1]!.detail).toBe("Page already read under another address.");
  });

  it("records step with ok: false when fetch fails without crashing the run", async () => {
    const fetchPage = vi.fn(async (url: string) => {
      if (url.includes("broken")) {
        return null;
      }
      return {
        html: "<html><head><title>Healthy</title></head><body>Working</body></html>",
        finalUrl: url
      };
    });

    const ask = vi.fn(async () => native("- Good note"));
    const record = vi.fn(async () => "rec-err");
    const files = vi.fn(async () => []);
    const assertTrusted = vi.fn();

    installResearch({
      assertTrusted,
      fetchPage,
      ask,
      record,
      files
    });

    const { runId } = await invokeChannel<{ readonly runId: string }>(
      IPC_CHANNELS.workstationResearchStart,
      {
        caseId: "case-resilient",
        question: "Test resilience",
        urls: ["https://example.com/broken", "https://example.com/good"],
        depth: "quick"
      }
    );

    const finished = await pollUntilFinished(runId);

    expect(finished.steps[0]!.ok).toBe(false);
    expect(finished.steps[0]!.detail).toBe("Could not open this page.");
    expect(finished.steps[1]!.ok).toBe(true);
    expect(finished.state).toBe("done");
  });

  describe("reviewed research route", () => {
    const createMockReview = (overrides?: Partial<WorkstationReview>): WorkstationReview => ({
      token: "child-lane-token",
      caseId: "case-rev-1",
      providerId: "claude",
      providerLabel: "Anthropic Claude",
      modelId: "claude-3-opus",
      contextPreview: "Snapshotted context preview",
      contextSnapshotId: "snapshot-123",
      sourceHash: "hash-abc-456",
      prompt: "Reviewed research question",
      sourceIds: [],
      workspace: { id: "case:case-rev-1", label: "Private work folder", path: "/tmp/research-test" },
      resumeSessionId: null,
      expiresAt: Date.now() + 60_000,
      ...overrides
    });

    it("prepares exact review and runs child to terminal outcome only upon explicit token start", async () => {
      const pages: Record<string, { readonly html: string; readonly finalUrl: string }> = {
        "https://supplier.example.com/pricing": {
          html: `<html><head><title>Pricing Sheet</title></head><body><p>Rates: £100/hr</p></body></html>`,
          finalUrl: "https://supplier.example.com/pricing"
        }
      };
      const fetchPage = vi.fn(async (url: string) => pages[url] ?? null);
      const prepareChild = vi.fn(async (input: { caseId: string; providerId: WorkstationProviderId; modelId: string; prompt: string; sourceTurnIds: readonly string[]; owner: object | string }) => {
        return createMockReview({
          caseId: input.caseId,
          providerId: input.providerId,
          modelId: input.modelId
        });
      });
      const runChild = vi.fn(async () => ({
        ...native("Consulting rate is £100/hr."),
        turnId: "turn-answer-1"
      }));
      const persistParent = vi.fn(async () => {});
      const persistChild = vi.fn(async () => {});
      const record = vi.fn(async () => "rec-answer");
      const assertTrusted = vi.fn();

      installReviewedResearchRun({
        assertTrusted,
        ownerFor: () => "trusted-owner-token",
        fetchPage,
        prepareChild,
        runChild,
        persistParent,
        persistChild,
        record
      });

      // Prepare returns review manifest and token without auto-starting child
      const prepareResult = await invokeChannel<{ readonly token: string; readonly expiresAt: number; readonly review: WorkstationReview }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-rev-1",
          question: "What is the hourly rate?",
          providerId: "claude",
          modelId: "claude-3-opus",
          urls: ["https://supplier.example.com/pricing"],
          sourceTurnIds: ["turn-ref-1"]
        }
      );

      expect(prepareResult.token).toBeDefined();
      expect(prepareResult.review.providerId).toBe("claude");
      expect(prepareResult.review.modelId).toBe("claude-3-opus");
      expect(prepareChild).toHaveBeenCalledWith(expect.objectContaining({
        caseId: "case-rev-1",
        providerId: "claude",
        modelId: "claude-3-opus",
        sourceTurnIds: ["turn-ref-1"],
        freshSession: true
      }));
      expect(prepareChild.mock.calls[0]![0].prompt).toContain("What is the hourly rate?");
      expect(prepareChild.mock.calls[0]![0].prompt).toContain("Rates: £100/hr");

      // prepareChild does not auto-dispatch child
      expect(runChild).not.toHaveBeenCalled();

      // Explicit token approval initiates child execution
      const startResult = await invokeChannel<{ readonly runId: string }>(
        IPC_CHANNELS.workstationResearchStart,
        { token: prepareResult.token }
      );
      expect(startResult.runId).toBeDefined();

      expect(persistParent).toHaveBeenCalledWith(expect.objectContaining({
        event: "parent",
        runId: startResult.runId,
        caseId: "case-rev-1",
        children: [expect.objectContaining({
          providerId: "claude",
          modelId: "claude-3-opus",
          contextSnapshotId: "snapshot-123",
          sourceHash: "hash-abc-456"
        })]
      }));

      expect(persistChild).toHaveBeenCalledWith("case-rev-1", expect.objectContaining({
        event: "child",
        runId: startResult.runId,
        state: "starting"
      }));

      const finished = await pollUntilFinished(startResult.runId);
      expect(runChild).toHaveBeenCalledTimes(1);
      expect(finished.state).toBe("done");
      expect(finished.answer).toBe("Consulting rate is £100/hr.");
      expect(finished.canStop).toBe(false);

      expect(persistChild).toHaveBeenCalledWith("case-rev-1", expect.objectContaining({
        event: "child",
        runId: startResult.runId,
        state: "answered",
        answerTurnId: "turn-answer-1"
      }));
      expect(record).toHaveBeenCalledWith({
        caseId: "case-rev-1",
        body: "Consulting rate is £100/hr."
      });
    });

    it("enforces one-use owner-bound token and denies token replay or wrong owner", async () => {
      const prepareChild = vi.fn(async (input: { caseId: string; prompt: string }) => createMockReview({ caseId: input.caseId, prompt: input.prompt }));
      const runChild = vi.fn(async () => ({
        ...native("Done."),
        turnId: "turn-1"
      }));
      const persistParent = vi.fn(async () => {});
      const persistChild = vi.fn(async () => {});

      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prep = await invokeChannel<{ readonly token: string }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-rev-1",
          question: "Question?",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-1"]
        }
      );

      const start1 = await invokeChannel<{ readonly runId: string }>(
        IPC_CHANNELS.workstationResearchStart,
        { token: prep.token }
      );
      expect(start1.runId).toBeDefined();

      // Denies token replay
      await expect(
        invokeChannel(IPC_CHANNELS.workstationResearchStart, { token: prep.token })
      ).rejects.toThrow("That research review expired or belongs to another window. Review it again.");
    });

    it("rejects preparation without explicit model or source (no implicit model/source)", async () => {
      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        prepareChild: vi.fn(),
        runChild: vi.fn(),
        persistParent: vi.fn(),
        persistChild: vi.fn()
      });

      // Rejects missing model
      await expect(
        invokeChannel(IPC_CHANNELS.workstationResearchPrepare, {
          caseId: "case-1",
          question: "Question?",
          providerId: "claude",
          urls: ["https://example.com"]
        })
      ).rejects.toThrow();

      // Rejects missing provider
      await expect(
        invokeChannel(IPC_CHANNELS.workstationResearchPrepare, {
          caseId: "case-1",
          question: "Question?",
          modelId: "claude-3",
          urls: ["https://example.com"]
        })
      ).rejects.toThrow();

      // Rejects missing sources (no implicit sources allowed)
      await expect(
        invokeChannel(IPC_CHANNELS.workstationResearchPrepare, {
          caseId: "case-1",
          question: "Question?",
          providerId: "claude",
          modelId: "claude-3"
        })
      ).rejects.toThrow();
    });

    it("cancels active child host work on Stop and records stopped receipt", async () => {
      let finishChild!: (val: NativeAskOutcome & { turnId: string | null }) => void;
      let signalObserved: AbortSignal | null = null;
      const runChild = vi.fn(({ signal }: { readonly signal: AbortSignal }) => {
        signalObserved = signal;
        return new Promise<NativeAskOutcome & { turnId: string | null }>((resolve) => {
          finishChild = resolve;
        });
      });
      const persistParent = vi.fn(async () => {});
      const persistChild = vi.fn(async () => {});

      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        prepareChild: async () => createMockReview(),
        runChild,
        persistParent,
        persistChild
      });

      const prep = await invokeChannel<{ readonly token: string }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-rev-1",
          question: "Question?",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-1"]
        }
      );

      const { runId } = await invokeChannel<{ readonly runId: string }>(
        IPC_CHANNELS.workstationResearchStart,
        { token: prep.token }
      );

      await vi.waitFor(() => expect(runChild).toHaveBeenCalledTimes(1));
      expect(signalObserved).not.toBeNull();
      expect(signalObserved!.aborted).toBe(false);

      const stoppedView = await invokeChannel<ResearchRunView>(
        IPC_CHANNELS.workstationResearchStop,
        { runId }
      );

      expect(stoppedView.state).toBe("working");
      expect(stoppedView.canStop).toBe(false);
      expect(signalObserved!.aborted).toBe(true);

      finishChild({
        ...native("Partial text."),
        finishReason: "stopped",
        cancellationRequested: true,
        turnId: "draft-turn-1"
      });

      await vi.waitFor(async () => {
        const view = await invokeChannel<ResearchRunView>(IPC_CHANNELS.workstationResearchPoll, { runId });
        expect(view.state).toBe("stopped");
        expect(persistChild).toHaveBeenCalledWith("case-rev-1", expect.objectContaining({
          event: "child",
          runId,
          state: "stopped"
        }));
      });
    });

    it("records interrupted receipt on host crash and never silently replays", async () => {
      const runChild = vi.fn(async () => {
        throw new Error("Worker process disconnected abruptly.");
      });
      const persistParent = vi.fn(async () => {});
      const persistChild = vi.fn(async () => {});

      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        prepareChild: async () => createMockReview(),
        runChild,
        persistParent,
        persistChild
      });

      const prep = await invokeChannel<{ readonly token: string }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-rev-1",
          question: "Question?",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-1"]
        }
      );

      const { runId } = await invokeChannel<{ readonly runId: string }>(
        IPC_CHANNELS.workstationResearchStart,
        { token: prep.token }
      );

      await vi.waitFor(async () => {
        const view = await invokeChannel<ResearchRunView>(IPC_CHANNELS.workstationResearchPoll, { runId });
        expect(view.state).toBe("failed");
        expect(view.headline).toContain("The host result needs inspection: Worker process disconnected abruptly.");
      });

      expect(persistChild).toHaveBeenCalledWith("case-rev-1", expect.objectContaining({
        event: "child",
        runId,
        state: "interrupted",
        line: expect.stringContaining("Worker process disconnected abruptly.")
      }));
      expect(runChild).toHaveBeenCalledTimes(1);
    });

    it("fails prepare with named missing source when URL fetch fails", async () => {
      const fetchPage = vi.fn(async () => null);
      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        fetchPage,
        prepareChild: vi.fn(async () => createMockReview()),
        runChild: vi.fn(),
        persistParent: vi.fn(),
        persistChild: vi.fn()
      });

      await expect(
        invokeChannel(IPC_CHANNELS.workstationResearchPrepare, {
          caseId: "case-rev-missing",
          question: "Check missing url",
          providerId: "claude",
          modelId: "claude-3-opus",
          urls: ["https://unreachable.example.com/page"]
        })
      ).rejects.toThrow("Failed to retrieve source URL: https://unreachable.example.com/page");
    });

    it("fails prepare with named missing source when requested file is not found", async () => {
      const files = vi.fn(async () => [
        { id: "file-available", label: "Available Doc", text: "Some facts." }
      ]);
      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        files,
        prepareChild: vi.fn(async () => createMockReview()),
        runChild: vi.fn(),
        persistParent: vi.fn(),
        persistChild: vi.fn()
      });

      await expect(
        invokeChannel(IPC_CHANNELS.workstationResearchPrepare, {
          caseId: "case-rev-missing-file",
          question: "Check missing file",
          providerId: "claude",
          modelId: "claude-3-opus",
          fileIds: ["file-missing"]
        })
      ).rejects.toThrow("Missing source file: file-missing");
    });

    it("includes explicit bounded omission when source content exceeds limit instead of silent truncation", async () => {
      const longText = "A".repeat(15_000);
      const files = vi.fn(async () => [
        { id: "file-large", label: "Large Document", text: longText }
      ]);
      const prepareChild = vi.fn(async (input: { caseId: string; prompt: string }) => createMockReview({ caseId: input.caseId, prompt: input.prompt }));
      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        files,
        prepareChild,
        runChild: vi.fn(),
        persistParent: vi.fn(),
        persistChild: vi.fn()
      });

      const prep = await invokeChannel<{ readonly token: string; readonly omissions?: readonly string[] }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-rev-large",
          question: "Summarize large doc",
          providerId: "claude",
          modelId: "claude-3-opus",
          fileIds: ["file-large"]
        }
      );

      expect(prep.token).toBeDefined();
      expect(prepareChild).toHaveBeenCalledTimes(1);
      const promptPassed = prepareChild.mock.calls[0]![0].prompt;
      expect(promptPassed).toContain('[Omission: 3000 characters truncated from file "Large Document" exceeding 12000 character limit]');
    });

    it("rejects depth 'thorough' plainly so thorough cannot falsely imply deeper research", async () => {
      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        prepareChild: vi.fn(async () => createMockReview()),
        runChild: vi.fn(),
        persistParent: vi.fn(),
        persistChild: vi.fn()
      });

      await expect(
        invokeChannel(IPC_CHANNELS.workstationResearchPrepare, {
          caseId: "case-rev-depth",
          question: "Question with thorough depth",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-1"],
          depth: "thorough"
        })
      ).rejects.toThrow("The 'thorough' depth mode is not supported for reviewed research. Use 'quick'.");
    });

    it("binds identical attempt UUID, snapshot, hash, and model across starting and terminal receipts, and gives distinct children distinct attempt IDs", async () => {
      const recordedReceipts: { readonly state: string; readonly attempt?: unknown }[] = [];
      const persistChild = vi.fn(async (_caseId: string, input: { readonly state: string; readonly attempt?: unknown }) => {
        recordedReceipts.push({ state: input.state, attempt: input.attempt });
      });
      const prepareChild = vi.fn(async (input: { caseId: string; providerId: WorkstationProviderId; modelId: string }) => {
        return createMockReview({
          caseId: input.caseId,
          providerId: input.providerId,
          modelId: input.modelId,
          contextSnapshotId: `snap-${input.modelId}`,
          sourceHash: `hash-${input.modelId}`
        });
      });
      const runChild = vi.fn(async () => ({
        ...native("Child outcome."),
        turnId: "turn-terminal"
      }));

      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        prepareChild,
        runChild,
        persistParent: vi.fn(async () => {}),
        persistChild
      });

      const prep1 = await invokeChannel<{ readonly token: string }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-rev-child-1",
          question: "First child?",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-1"]
        }
      );
      const start1 = await invokeChannel<{ readonly runId: string }>(
        IPC_CHANNELS.workstationResearchStart,
        { token: prep1.token }
      );
      await pollUntilFinished(start1.runId);

      expect(recordedReceipts.length).toBe(2);
      const startReceipt1 = recordedReceipts[0]!;
      const terminalReceipt1 = recordedReceipts[1]!;
      expect(startReceipt1.state).toBe("starting");
      expect(terminalReceipt1.state).toBe("answered");
      expect(startReceipt1.attempt).toBeDefined();
      expect(startReceipt1.attempt).toEqual(terminalReceipt1.attempt);
      const attempt1 = startReceipt1.attempt as {
        attemptId: string;
        contextSnapshotId: string;
        sourceHash: string;
        providerId: WorkstationProviderId;
        modelId: string;
      };
      expect(attempt1.attemptId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(attempt1.contextSnapshotId).toBe("snap-claude-3-opus");
      expect(attempt1.sourceHash).toBe("hash-claude-3-opus");
      expect(attempt1.providerId).toBe("claude");
      expect(attempt1.modelId).toBe("claude-3-opus");

      recordedReceipts.length = 0;
      const prep2 = await invokeChannel<{ readonly token: string }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-rev-child-2",
          question: "Second child?",
          providerId: "claude",
          modelId: "claude-3-haiku",
          sourceTurnIds: ["turn-2"]
        }
      );
      const start2 = await invokeChannel<{ readonly runId: string }>(
        IPC_CHANNELS.workstationResearchStart,
        { token: prep2.token }
      );
      await pollUntilFinished(start2.runId);

      expect(recordedReceipts.length).toBe(2);
      const startReceipt2 = recordedReceipts[0]!;
      const terminalReceipt2 = recordedReceipts[1]!;
      expect(startReceipt2.attempt).toEqual(terminalReceipt2.attempt);
      const attempt2 = startReceipt2.attempt as typeof attempt1;
      expect(attempt2.attemptId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(attempt2.contextSnapshotId).toBe("snap-claude-3-haiku");
      expect(attempt2.sourceHash).toBe("hash-claude-3-haiku");
      expect(attempt2.modelId).toBe("claude-3-haiku");
      expect(attempt2.attemptId).not.toBe(attempt1.attemptId);
    });

    it("leaves queued unstarted child unbound on Stop without minting attempt", async () => {
      let releaseStarting!: () => void;
      const childCalls: { readonly state: string; readonly attempt?: unknown }[] = [];
      const persistChild = vi.fn(async (_caseId: string, input: { readonly state: string; readonly attempt?: unknown }) => {
        childCalls.push({ state: input.state, attempt: input.attempt });
        if (input.state === "starting") {
          await new Promise<void>((resolve) => {
            releaseStarting = resolve;
          });
        }
      });

      const runChild = vi.fn();
      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        prepareChild: async (input: { caseId: string }) => createMockReview({ caseId: input.caseId }),
        runChild,
        persistParent: vi.fn(async () => {}),
        persistChild
      });

      const prep = await invokeChannel<{ readonly token: string }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-rev-queued",
          question: "Queued question?",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-1"]
        }
      );

      const { runId } = await invokeChannel<{ readonly runId: string }>(
        IPC_CHANNELS.workstationResearchStart,
        { token: prep.token }
      );

      await vi.waitFor(() => expect(childCalls.some((c) => c.state === "starting")).toBe(true));
      await invokeChannel(IPC_CHANNELS.workstationResearchStop, { runId });
      releaseStarting();

      await vi.waitFor(() => expect(childCalls.some((c) => c.state === "stopped")).toBe(true));
      const startingReceipt = childCalls.find((c) => c.state === "starting")!;
      const stoppedReceipt = childCalls.find((c) => c.state === "stopped")!;
      expect(startingReceipt.attempt).toBeDefined();
      expect(stoppedReceipt.attempt).toEqual(startingReceipt.attempt);
      expect(runChild).not.toHaveBeenCalled();
    });

    it("preserves actual attempt in interrupted receipt when host throws", async () => {
      const childCalls: { readonly state: string; readonly attempt?: unknown }[] = [];
      const persistChild = vi.fn(async (_caseId: string, input: { readonly state: string; readonly attempt?: unknown }) => {
        childCalls.push({ state: input.state, attempt: input.attempt });
      });

      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        prepareChild: async (input: { caseId: string }) => createMockReview({ caseId: input.caseId }),
        runChild: vi.fn(async () => {
          throw new Error("Worker abruptly terminated.");
        }),
        persistParent: vi.fn(async () => {}),
        persistChild
      });

      const prep = await invokeChannel<{ readonly token: string }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-rev-throw",
          question: "Throw question?",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-1"]
        }
      );

      const { runId } = await invokeChannel<{ readonly runId: string }>(
        IPC_CHANNELS.workstationResearchStart,
        { token: prep.token }
      );

      await vi.waitFor(async () => {
        const view = await invokeChannel<ResearchRunView>(IPC_CHANNELS.workstationResearchPoll, { runId });
        expect(view.state).toBe("failed");
      });

      const startingReceipt = childCalls.find((c) => c.state === "starting")!;
      const interruptedReceipt = childCalls.find((c) => c.state === "interrupted")!;
      expect(startingReceipt.attempt).toBeDefined();
      expect(interruptedReceipt.attempt).toEqual(startingReceipt.attempt);
    });

    it("rejects mismatched terminal binding in callback without claiming success", async () => {
      let startingAttemptId = "";
      const persistChild = vi.fn(async (_caseId: string, input: { readonly state: string; readonly attempt?: { readonly attemptId: string } }) => {
        if (input.state === "starting") {
          startingAttemptId = input.attempt?.attemptId ?? "";
        }
        if (input.state === "answered") {
          if (input.attempt?.attemptId === startingAttemptId) {
            throw new Error("Rejected mismatched terminal binding.");
          }
        }
      });
      const record = vi.fn(async () => "rec-123");

      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        prepareChild: async (input: { caseId: string }) => createMockReview({ caseId: input.caseId }),
        runChild: vi.fn(async () => ({
          ...native("Tentative answer."),
          turnId: "turn-answer-mismatch"
        })),
        persistParent: vi.fn(async () => {}),
        persistChild,
        record
      });

      const prep = await invokeChannel<{ readonly token: string }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-rev-reject",
          question: "Question?",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-1"]
        }
      );

      const { runId } = await invokeChannel<{ readonly runId: string }>(
        IPC_CHANNELS.workstationResearchStart,
        { token: prep.token }
      );

      await vi.waitFor(async () => {
        const view = await invokeChannel<ResearchRunView>(IPC_CHANNELS.workstationResearchPoll, { runId });
        expect(view.state).toBe("failed");
        expect(view.headline).toContain("Rejected mismatched terminal binding.");
        expect(view.answer).toBeNull();
      });

      expect(record).not.toHaveBeenCalled();
    });

    it("preserves proven completed outcome if late parent Stop arrives after child completion", async () => {
      let completeChild!: (outcome: NativeAskOutcome & { readonly turnId: string | null }) => void;
      const runChild = vi.fn(async () => new Promise<NativeAskOutcome & { readonly turnId: string | null }>((resolve) => {
        completeChild = resolve;
      }));

      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        prepareChild: async (input: { caseId: string }) => createMockReview({ caseId: input.caseId }),
        runChild,
        persistParent: vi.fn(async () => {}),
        persistChild: vi.fn(async () => {})
      });

      const prep = await invokeChannel<{ readonly token: string }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-rev-late-stop",
          question: "Late stop question?",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-1"]
        }
      );

      const { runId } = await invokeChannel<{ readonly runId: string }>(
        IPC_CHANNELS.workstationResearchStart,
        { token: prep.token }
      );

      await vi.waitFor(() => expect(runChild).toHaveBeenCalledTimes(1));

      // Parent Stop arrives late while child was processing
      await invokeChannel(IPC_CHANNELS.workstationResearchStop, { runId });

      // Child finishes with a proven completed outcome
      completeChild({
        ...native("Definitive completed answer."),
        turnId: "turn-proven"
      });

      const view = await pollUntilFinished(runId);
      expect(view.state).toBe("done");
      expect(view.answer).toBe("Definitive completed answer.");
      expect(view.headline).toBe("Research complete.");
    });

    it("blocks launch when review metadata is missing", async () => {
      const persistChild = vi.fn(async () => {});
      installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        prepareChild: async (input: { caseId: string }) => createMockReview({ caseId: input.caseId, sourceHash: "" }),
        runChild: vi.fn(),
        persistParent: vi.fn(async () => {}),
        persistChild
      });

      await expect(
        invokeChannel(IPC_CHANNELS.workstationResearchPrepare, {
          caseId: "case-rev-missing-meta",
          question: "Missing metadata?",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-1"]
        })
      ).rejects.toThrow("A research child has no saved context or chosen model.");
      expect(persistChild).not.toHaveBeenCalled();
    });

    it("stopActive cancels current active parent without revoking owner or future reviews", async () => {
      let finishChild!: (val: NativeAskOutcome & { turnId: string | null }) => void;
      const runChild = vi.fn(() => new Promise<NativeAskOutcome & { turnId: string | null }>((resolve) => {
        finishChild = resolve;
      }));
      const prepareChild = vi.fn(async (input: { caseId: string }) => createMockReview({ caseId: input.caseId }));
      const persistParent = vi.fn(async () => {});
      const persistChild = vi.fn(async () => {});

      const { stopActive } = installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => "trusted-owner-token",
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      // When idle, stopActive returns false
      expect(await stopActive()).toBe(false);

      const prep1 = await invokeChannel<{ readonly token: string }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-stop-active",
          question: "Run 1",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-1"]
        }
      );

      const { runId } = await invokeChannel<{ readonly runId: string }>(
        IPC_CHANNELS.workstationResearchStart,
        { token: prep1.token }
      );

      await vi.waitFor(() => expect(runChild).toHaveBeenCalledTimes(1));

      // With active work, stopActive returns true and cancels
      expect(await stopActive()).toBe(true);

      finishChild({
        ...native("Aborted text."),
        finishReason: "stopped",
        cancellationRequested: true,
        turnId: null
      });

      await vi.waitFor(async () => {
        const view = await invokeChannel<ResearchRunView>(IPC_CHANNELS.workstationResearchPoll, { runId });
        expect(view.state).toBe("stopped");
      });

      // Subsequent call when idle returns false
      expect(await stopActive()).toBe(false);

      // Future reviews still work because owner was not revoked
      const prep2 = await invokeChannel<{ readonly token: string }>(
        IPC_CHANNELS.workstationResearchPrepare,
        {
          caseId: "case-stop-active",
          question: "Run 2 after non-revoking stopActive",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-2"]
        }
      );
      expect(prep2.token).toBeDefined();
    });

    it("cancelOwner revokes owner and blocks future reviews and starts", async () => {
      const owner = "trusted-owner-token";
      const { cancelOwner } = installReviewedResearchRun({
        assertTrusted: () => {},
        ownerFor: () => owner,
        prepareChild: vi.fn(async () => createMockReview()),
        runChild: vi.fn(),
        persistParent: vi.fn(),
        persistChild: vi.fn()
      });

      await cancelOwner(owner);

      await expect(
        invokeChannel(IPC_CHANNELS.workstationResearchPrepare, {
          caseId: "case-revoked",
          question: "Should fail",
          providerId: "claude",
          modelId: "claude-3-opus",
          sourceTurnIds: ["turn-1"]
        })
      ).rejects.toThrow("That research window is no longer active.");
    });
  });
});
