import { fakeIpcEvent } from "./fake-ipc-event.js";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  installUsage,
  parseUsageReceipt,
  type InstallUsageOptions,
  type UsageReceiptView,
  type WorkstationUsageResult
} from "./usage-ipc.js";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}));

function getInstalledHandler(): (
  event: IpcMainInvokeEvent,
  input: unknown
) => Promise<WorkstationUsageResult> {
  const handleMock = vi.mocked(ipcMain.handle);
  // The *last* registration, not the first. A test that installs twice to swap
  // the options was getting the original handler back, so the second set of
  // options was never used and the thing it was checking never happened.
  const calls = handleMock.mock.calls.filter(
    (c) => c[0] === IPC_CHANNELS.workstationUsage
  );
  const call = calls[calls.length - 1];
  if (!call || typeof call[1] !== "function") {
    throw new Error("IPC handler was not registered for workstationUsage");
  }
  return call[1] as (
    event: IpcMainInvokeEvent,
    input: unknown
  ) => Promise<WorkstationUsageResult>;
}

function createFakeEvent(senderId = 1): IpcMainInvokeEvent {
  return fakeIpcEvent(senderId).event;
}

describe("usage-ipc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns two rows and a skipped count of one for two good receipts and one invalid string", async () => {
    const receipts = [
      {
        body: JSON.stringify({
          providerId: "claude",
          providerLabel: "Claude",
          modelId: "claude-3-5-sonnet",
          status: "completed",
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_000_005_000,
          caseId: "case-alpha",
          title: "Confidential Client Alpha",
          prompt: "Classified business prompt"
        }),
        at: 1_700_000_005_000
      },
      {
        body: "not json",
        at: 1_700_000_006_000
      },
      {
        body: JSON.stringify({
          providerId: "codex",
          modelId: null,
          status: "completed",
          startedAt: 1_700_000_010_000,
          endedAt: 1_700_000_020_000,
          caseId: "case-beta",
          body: "Internal case body that must not leak"
        }),
        at: 1_700_000_020_000
      }
    ];

    const options: InstallUsageOptions = {
      assertTrusted: () => {},
      receipts: () => receipts,
      known: async () => [
        { id: "claude", label: "Claude" },
        { id: "codex", label: "Codex" }
      ]
    };

    installUsage(options);
    const handler = getInstalledHandler();
    const event = createFakeEvent();

    const result = await handler(event, { window: "today" });

    expect(result.receipts.length).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.capped).toBe(false);

    const first: UsageReceiptView = result.receipts[0]!;
    expect(first.providerId).toBe("claude");
    expect(first.providerLabel).toBe("Claude");
    expect(first.modelId).toBe("claude-3-5-sonnet");
    expect(first.status).toBe("completed");
    expect(first.caseId).toBe("case-alpha");

    const second: UsageReceiptView = result.receipts[1]!;
    expect(second.providerId).toBe("codex");
    expect(second.providerLabel).toBe("Codex");
    expect(second.modelId).toBeNull();
    expect(second.status).toBe("completed");
    expect(second.caseId).toBe("case-beta");

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Confidential Client Alpha");
    expect(serialized).not.toContain("Classified business prompt");
    expect(serialized).not.toContain("Internal case body that must not leak");
  });

  it("maps unknown or malformed statuses to failed rather than completed", async () => {
    const receipts = [
      {
        body: JSON.stringify({
          providerId: "claude",
          caseId: "case-1",
          startedAt: 1000,
          endedAt: 2000,
          status: "weird-status"
        }),
        at: 2000
      },
      {
        body: JSON.stringify({
          providerId: "claude",
          caseId: "case-2",
          startedAt: 1000,
          endedAt: 2000
        }),
        at: 2000
      },
      {
        body: JSON.stringify({
          providerId: "claude",
          caseId: "case-3",
          startedAt: 1000,
          endedAt: 2000,
          status: "interrupted"
        }),
        at: 2000
      }
    ];

    const options: InstallUsageOptions = {
      assertTrusted: () => {},
      receipts: () => receipts,
      known: async () => [{ id: "claude", label: "Claude" }]
    };

    installUsage(options);
    const handler = getInstalledHandler();
    const event = createFakeEvent();

    const result = await handler(event, { window: "week" });

    expect(result.receipts.length).toBe(3);
    expect(result.skipped).toBe(0);

    const first = result.receipts[0]!;
    expect(first.status).toBe("failed");

    const second = result.receipts[1]!;
    expect(second.status).toBe("failed");

    const third = result.receipts[2]!;
    expect(third.status).toBe("interrupted");
  });

  it("caps receipts at 5,000 rows and flags capped in the result", async () => {
    const count = 5_050;
    const receipts = Array.from({ length: count }, (_, i) => ({
      body: JSON.stringify({
        providerId: "claude",
        caseId: `case-${i}`,
        startedAt: 1000,
        endedAt: 2000,
        status: "completed"
      }),
      at: 2000
    }));

    const options: InstallUsageOptions = {
      assertTrusted: () => {},
      receipts: () => receipts,
      known: async () => [{ id: "claude", label: "Claude" }]
    };

    installUsage(options);
    const handler = getInstalledHandler();
    const event = createFakeEvent();

    const result = await handler(event, { window: "month" });

    expect(result.receipts.length).toBe(5_000);
    expect(result.capped).toBe(true);
    expect(result.skipped).toBe(0);
  });

  it("validates the window input with Zod and rejects invalid values", async () => {
    const options: InstallUsageOptions = {
      assertTrusted: () => {},
      receipts: () => [],
      known: async () => []
    };

    installUsage(options);
    const handler = getInstalledHandler();
    const event = createFakeEvent();

    await expect(handler(event, { window: "year" })).rejects.toThrow();
    await expect(handler(event, { window: 123 })).rejects.toThrow();
    await expect(handler(event, null)).rejects.toThrow();

    const validResult = await handler(event, { window: "today" });
    expect(validResult.receipts.length).toBe(0);
    expect(validResult.skipped).toBe(0);
    expect(validResult.capped).toBe(false);
  });

  it("enforces trusted sender verification and aborts if window owner changes", async () => {
    let trusted = false;
    const options: InstallUsageOptions = {
      assertTrusted: () => {
        if (!trusted) {
          throw new Error("Untrusted sender");
        }
      },
      receipts: () => [],
      known: async () => []
    };

    installUsage(options);
    const handler = getInstalledHandler();
    const event = createFakeEvent();

    await expect(handler(event, { window: "today" })).rejects.toThrow("Untrusted sender");

    trusted = true;
    let triggerWindowChange = false;
    const mutating = fakeIpcEvent(1);
    const mutatingEvent = mutating.event;

    const windowChangeOptions: InstallUsageOptions = {
      assertTrusted: () => {},
      receipts: () => [],
      known: async () => {
        if (triggerWindowChange) mutating.navigate();
        return [];
      }
    };

    installUsage(windowChangeOptions);
    const handler2 = getInstalledHandler();
    triggerWindowChange = true;

    await expect(handler2(mutatingEvent, { window: "today" })).rejects.toThrow(
      "This window changed while reading usage."
    );
  });

  it("skips non-object bodies and receipts lacking provider or case identity", () => {
    const knownLabels = new Map<string, string>([["claude", "Claude"]]);

    expect(parseUsageReceipt({ body: "123", at: 1000 }, knownLabels)).toBeNull();
    expect(parseUsageReceipt({ body: "[]", at: 1000 }, knownLabels)).toBeNull();
    expect(parseUsageReceipt({ body: JSON.stringify({ providerId: "claude" }), at: 1000 }, knownLabels)).toBeNull();
    expect(parseUsageReceipt({ body: JSON.stringify({ caseId: "case-1" }), at: 1000 }, knownLabels)).toBeNull();
  });
});
