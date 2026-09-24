import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { installResearch, type InstallResearchOptions, type ResearchRunView } from "./research-run-ipc.js";

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
    if (!view.canStop) {
      return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for research run to finish.");
}

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
        return "Supplier charges £10 on net 30 terms with 2% late fee.";
      }
      return "- Found relevant term.";
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

    const ask = vi.fn(async () => "NONE");
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

  it("stops early and reports why when two successive steps produce no notes", async () => {
    const fetchPage = vi.fn(async (url: string) => ({
      html: `<html><head><title>General Info</title></head><body>Nothing related here</body></html>`,
      finalUrl: url
    }));

    // ask returns empty findings to trigger the two-step no-note early stop
    const ask = vi.fn(async () => "NONE");
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
    const ask = vi.fn(async () => "- Relevant link note");
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

    const ask = vi.fn(async () => "- Canonical note");
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

    const ask = vi.fn(async () => "- Good note");
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
});
