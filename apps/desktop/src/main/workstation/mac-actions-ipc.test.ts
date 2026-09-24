import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { ActionDescription, ActionOutcome } from "./mac-actions.js";
import { installWorkstationMacActions } from "./mac-actions-ipc.js";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>(),
  mockRunAction: vi.fn(),
  mockDescribeAction: vi.fn(),
  mockWhyRefused: vi.fn()
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => {
      f.handlers.set(name, handler);
    }
  }
}));

vi.mock("./mac-actions.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./mac-actions.js")>();
  return {
    ...mod,
    runAction: f.mockRunAction,
    describeAction: f.mockDescribeAction,
    whyRefused: f.mockWhyRefused
  };
});


/**
 * Waits until the handler has actually reached the stub.
 *
 * The resolver is only assigned when the mock is called, and the handler gets
 * there asynchronously — releasing it straight after `invoke` fires the no-op
 * default and the promise never settles, so the test hangs to its timeout
 * instead of failing with a reason. Same for an in-flight guard: asking for a
 * second operation before the first has reached the stub races it.
 */
async function untilCalled(mock: { readonly mock: { readonly calls: readonly unknown[] } }): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (mock.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The handler never reached the stub.");
}

describe("Workstation Mac actions IPC", () => {
  let caseId: string;
  let event: IpcMainInvokeEvent;
  let sender: EventEmitter;
  let trusted: boolean;
  let allowedRoot: string | null;

  const invoke = (channel: string, input: unknown): Promise<unknown> => {
    const handler = f.handlers.get(channel);
    if (!handler) {
      throw new Error(`No IPC handler registered for channel: ${channel}`);
    }
    return Promise.resolve().then(() => handler(event, input));
  };

  beforeEach(() => {
    vi.resetAllMocks();
    f.handlers.clear();
    trusted = true;
    caseId = "case-alpha-12";
    allowedRoot = "/allowed/workspace";
    sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;

    f.mockWhyRefused.mockReturnValue(null);
    f.mockRunAction.mockResolvedValue({
      status: "done",
      detail: 'Revealed "doc.txt" in Finder.'
    } satisfies ActionOutcome);
    f.mockDescribeAction.mockReturnValue({
      title: 'Reveal "doc.txt" in Finder',
      detail: 'Shows "doc.txt" in folder "/allowed/workspace".',
      reversible: true
    } satisfies ActionDescription);

    installWorkstationMacActions({
      assertTrusted: () => {
        if (!trusted) {
          throw new Error("Untrusted sender");
        }
      },
      allowedRootFor: async (id: string) => {
        if (id === caseId) {
          return allowedRoot;
        }
        return null;
      }
    });
  });

  it("rejects untrusted sender before any validation or action execution", async () => {
    trusted = false;
    await expect(
      invoke(IPC_CHANNELS.workstationMacDescribe, {
        caseId,
        action: { kind: "reveal", path: "/allowed/workspace/doc.txt" }
      })
    ).rejects.toThrow("Untrusted sender");

    await expect(
      invoke(IPC_CHANNELS.workstationMacRun, {
        caseId,
        action: { kind: "reveal", path: "/allowed/workspace/doc.txt" }
      })
    ).rejects.toThrow("Untrusted sender");

    expect(f.mockDescribeAction).not.toHaveBeenCalled();
    expect(f.mockRunAction).not.toHaveBeenCalled();
  });

  it("refuses actions when the case has no permitted folder", async () => {
    allowedRoot = null;

    const outcome = (await invoke(IPC_CHANNELS.workstationMacRun, {
      caseId,
      action: { kind: "reveal", path: "/allowed/workspace/doc.txt" }
    })) as ActionOutcome;

    expect(outcome).toEqual({
      status: "refused",
      reason: "This case has no permitted folder."
    });
    expect(f.mockRunAction).not.toHaveBeenCalled();
  });

  it("refuses an action outside the root even when describe was never called", async () => {
    f.mockWhyRefused.mockReturnValueOnce(
      'The path is outside the permitted folder "/allowed/workspace".'
    );

    const outcome = (await invoke(IPC_CHANNELS.workstationMacRun, {
      caseId,
      action: { kind: "reveal", path: "/etc/shadow" }
    })) as ActionOutcome;

    expect(outcome).toEqual({
      status: "refused",
      reason: 'The path is outside the permitted folder "/allowed/workspace".'
    });
    expect(f.mockDescribeAction).not.toHaveBeenCalled();
    expect(f.mockRunAction).not.toHaveBeenCalled();
  });

  it("refuses a second concurrent run while an action is already in flight", async () => {
    let finishFirst: (value: ActionOutcome) => void = () => {};
    f.mockRunAction.mockImplementationOnce(
      () =>
        new Promise<ActionOutcome>((resolve) => {
          finishFirst = resolve;
        })
    );

    const firstRunPromise = invoke(IPC_CHANNELS.workstationMacRun, {
      caseId,
      action: { kind: "reveal", path: "/allowed/workspace/first.txt" }
    });

    // The guard is set by the handler, not by `invoke` returning. Asking for a
    // second action before the first has reached the stub races it.
    await untilCalled(f.mockRunAction);

    await expect(
      invoke(IPC_CHANNELS.workstationMacRun, {
        caseId,
        action: { kind: "reveal", path: "/allowed/workspace/second.txt" }
      })
    ).rejects.toThrow("An action is already running. Wait for it to finish.");

    finishFirst({ status: "done", detail: 'Revealed "first.txt" in Finder.' });
    await firstRunPromise;
  });

  it("refuses when the window owner changes mid-operation", async () => {
    f.mockRunAction.mockImplementationOnce(async () => {
      // Simulate frame navigation occurring while the child process was running.
      // Reassigning the test's `event` would change nothing: the handler already
      // holds the object it was invoked with. Navigation is what actually
      // retires the owner, and the owner registry is listening for it.
      sender.emit("did-start-navigation", { isMainFrame: true });
      return { status: "done", detail: "Done" };
    });

    await expect(
      invoke(IPC_CHANNELS.workstationMacRun, {
        caseId,
        action: { kind: "reveal", path: "/allowed/workspace/file.txt" }
      })
    ).rejects.toThrow("This window changed while running the action.");
  });

  it("ensures no error string carries a stack trace", async () => {
    trusted = false;
    try {
      await invoke(IPC_CHANNELS.workstationMacRun, {
        caseId,
        action: { kind: "reveal", path: "/allowed/workspace/doc.txt" }
      });
      expect.fail("Invocation should have thrown for untrusted sender");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).not.toMatch(/\s+at\s+/);
      expect(message).not.toContain("\n");
      expect(message).toBe("Untrusted sender");
    }
  });

  it("describes an action without executing it", async () => {
    const description = (await invoke(IPC_CHANNELS.workstationMacDescribe, {
      caseId,
      action: { kind: "reveal", path: "/allowed/workspace/doc.txt" }
    })) as ActionDescription;

    expect(description).toEqual({
      title: 'Reveal "doc.txt" in Finder',
      detail: 'Shows "doc.txt" in folder "/allowed/workspace".',
      reversible: true
    });
    expect(f.mockDescribeAction).toHaveBeenCalledWith({
      kind: "reveal",
      path: "/allowed/workspace/doc.txt"
    });
    expect(f.mockRunAction).not.toHaveBeenCalled();
  });

  it("executes a shortcut action with bounded input", async () => {
    f.mockRunAction.mockResolvedValueOnce({
      status: "done",
      detail: "Shortcut completed."
    });

    const outcome = (await invoke(IPC_CHANNELS.workstationMacRun, {
      caseId,
      action: { kind: "shortcut", name: "Format Text", input: "Sample input" }
    })) as ActionOutcome;

    expect(outcome).toEqual({
      status: "done",
      detail: "Shortcut completed."
    });
    expect(f.mockRunAction).toHaveBeenCalledWith(
      { kind: "shortcut", name: "Format Text", input: "Sample input" },
      "/allowed/workspace"
    );
  });

  it("rejects malformed payloads before checking folder permissions", async () => {
    await expect(
      invoke(IPC_CHANNELS.workstationMacRun, {
        caseId,
        action: { kind: "unknown_kind" }
      })
    ).rejects.toThrow();

    expect(f.mockRunAction).not.toHaveBeenCalled();
  });
});
