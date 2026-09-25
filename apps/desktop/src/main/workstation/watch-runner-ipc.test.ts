import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  capRememberedText,
  installWatch,
  isDue,
  judgeChange,
  MAX_REMEMBER_BYTES,
  type ChangeVerdict,
  type Watch
} from "./watch-runner-ipc.js";

const ipcHandlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
const ownerState = vi.hoisted(() => ({ current: {} as object }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
      ipcHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
    })
  }
}));

vi.mock("../agents/source-owner.js", () => ({
  createAgentSourceOwners: () => () => ownerState.current
}));

vi.mock("../../shared/ipc-channels.js", () => ({
  IPC_CHANNELS: {
    workstationWatchList: "workstation-watch:list",
    workstationWatchSave: "workstation-watch:save",
    workstationWatchRemove: "workstation-watch:remove",
    workstationWatchNow: "workstation-watch:now"
  }
}));

function createMockEvent(): IpcMainInvokeEvent {
  return {
    sender: {} as IpcMainInvokeEvent["sender"],
    senderFrame: {} as IpcMainInvokeEvent["senderFrame"]
  } as unknown as IpcMainInvokeEvent;
}

function createWatch(overrides: Partial<Watch> = {}): Watch {
  return {
    id: "watch-1",
    target: { kind: "page", url: "https://example.com/status", label: "Status Page" },
    cadence: "hourly",
    tellMeWhen: "anything-changes",
    quietHours: false,
    lastCheckedAt: null,
    lastChangedAt: null,
    paused: false,
    ...overrides
  };
}

describe("isDue", () => {
  it("reports due when never checked and not paused", () => {
    const watch = createWatch({ lastCheckedAt: null, paused: false });
    expect(isDue(watch, 100_000)).toBe(true);
  });

  it("reports not due when paused", () => {
    const watch = createWatch({ lastCheckedAt: null, paused: true });
    expect(isDue(watch, 100_000)).toBe(false);
  });

  it("respects hourly cadence boundary", () => {
    const watch = createWatch({ cadence: "hourly", lastCheckedAt: 1_000_000 });
    expect(isDue(watch, 1_000_000 + 3_599_999)).toBe(false);
    expect(isDue(watch, 1_000_000 + 3_600_000)).toBe(true);
  });

  it("respects daily cadence boundary", () => {
    const watch = createWatch({ cadence: "daily", lastCheckedAt: 10_000_000 });
    expect(isDue(watch, 10_000_000 + 86_399_999)).toBe(false);
    expect(isDue(watch, 10_000_000 + 86_400_000)).toBe(true);
  });
});

describe("judgeChange", () => {
  it("reports no change when texts match", () => {
    const watch = createWatch({ tellMeWhen: "anything-changes" });
    const verdict = judgeChange({ watch, before: "hello", after: "hello", now: 1000 });
    expect(verdict.changed).toBe(false);
    expect(verdict.worthTelling).toBe(false);
  });

  it("alerts on number modifications only when numbers-change is chosen", () => {
    const watch = createWatch({ tellMeWhen: "numbers-change" });
    const textOnly = judgeChange({ watch, before: "Price: 10", after: "Cost: 10", now: 1000 });
    expect(textOnly.changed).toBe(true);
    expect(textOnly.worthTelling).toBe(false);

    const numberDiff = judgeChange({ watch, before: "Price: 10", after: "Price: 12", now: 1000 });
    expect(numberDiff.changed).toBe(true);
    expect(numberDiff.worthTelling).toBe(true);
  });

  it("alerts on newly introduced lines only when something-new-appears is chosen", () => {
    const watch = createWatch({ tellMeWhen: "something-new-appears" });
    /**
     * A line going missing is told too, in its own words. Staying quiet about it
     * means a folder can lose an invoice and the thing watching that folder says
     * nothing — so the option is named "something is added or removed", and it
     * does both.
     */
    const removed = judgeChange({ watch, before: "alpha\nbeta", after: "alpha", now: 1000 });
    expect(removed.changed).toBe(true);
    expect(removed.worthTelling).toBe(true);
    expect(removed.detail).toEqual(["- beta"]);

    const added = judgeChange({ watch, before: "alpha", after: "alpha\nbeta", now: 1000 });
    expect(added.changed).toBe(true);
    expect(added.worthTelling).toBe(true);
    expect(added.detail.length).toBe(1);
  });
});

describe("capRememberedText", () => {
  it("leaves text within 256 KB unaltered", () => {
    const text = "plain body text";
    expect(capRememberedText(text)).toBe(text);
  });

  it("truncates text exceeding 256 KB to the byte limit", () => {
    const largeText = "a".repeat(300 * 1024);
    const capped = capRememberedText(largeText);
    expect(Buffer.byteLength(capped, "utf8")).toBe(MAX_REMEMBER_BYTES);
  });
});

describe("installWatch execution loop", () => {
  it("admits one due sweep synchronously while its first look is pending", async () => {
    const lookGate = deferred<string | null>();
    const lookStarted = deferred<void>();
    let looks = 0;
    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => [createWatch()],
      save: async () => {},
      look: async () => { looks++; lookStarted.resolve(); return await lookGate.promise; },
      lastSeen: async () => "prior",
      remember: async () => {},
      tell: async () => {}
    });

    try {
      const first = installed.checkDue();
      const duplicate = installed.checkDue();
      await lookStarted.promise;
      lookGate.resolve("current");
      await Promise.all([first, duplicate]);
      expect(looks).toBe(1);
    } finally {
      installed.stop();
    }
  });

  it("does not save or deliver after stop during a pending remembered read", async () => {
    const lastSeenGate = deferred<string | null>();
    const lastSeenStarted = deferred<void>();
    const save = vi.fn(async () => {});
    const remember = vi.fn(async () => {});
    const tell = vi.fn(async () => {});
    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => [createWatch()],
      save,
      look: async () => "changed",
      lastSeen: async () => { lastSeenStarted.resolve(); return await lastSeenGate.promise; },
      remember,
      tell
    });

    const run = installed.checkDue();
    await lastSeenStarted.promise;
    installed.stop();
    lastSeenGate.resolve("prior");
    await run;
    expect(remember).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(tell).not.toHaveBeenCalled();
  });

  it("handles a rejected periodic load without an unhandled timer rejection", async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => { throw new Error("load failed"); },
      save: async () => {},
      look: async () => null,
      lastSeen: async () => null,
      remember: async () => {},
      tell: async () => {}
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(errorLog).toHaveBeenCalledWith("Watch check failed:", expect.any(Error));
    } finally {
      installed.stop();
      errorLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it("abandons a queued save when its owner changes during load", async () => {
    const loadGate = deferred<readonly Watch[]>();
    const loadStarted = deferred<void>();
    const save = vi.fn(async () => {});
    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => { loadStarted.resolve(); return await loadGate.promise; },
      save,
      look: async () => null,
      lastSeen: async () => null,
      remember: async () => {},
      tell: async () => {}
    });

    try {
      const saving = ipcHandlers.get("workstation-watch:save")!(createMockEvent(), { watch: createWatch() });
      await loadStarted.promise;
      ownerState.current = {};
      loadGate.resolve([]);
      await expect(saving).rejects.toThrow("This window changed");
      expect(save).not.toHaveBeenCalled();
    } finally {
      installed.stop();
    }
  });

  it("reads the current watch when a manual check reaches the queue", async () => {
    let currentWatches: readonly Watch[] = [createWatch({ paused: true })];
    const firstLoad = deferred<readonly Watch[]>();
    const loadStarted = deferred<void>();
    let loads = 0;
    const inspected: string[] = [];
    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => {
        loads++;
        if (loads === 1) { loadStarted.resolve(); return await firstLoad.promise; }
        return currentWatches;
      },
      save: async (watches) => { currentWatches = watches; },
      look: async (target) => { inspected.push(target.label); return "new"; },
      lastSeen: async () => "old",
      remember: async () => {},
      tell: async () => {}
    });

    try {
      const event = createMockEvent();
      const save = ipcHandlers.get("workstation-watch:save")!;
      const now = ipcHandlers.get("workstation-watch:now")!;
      const changed = createWatch({ paused: true, target: { kind: "page", url: "https://example.com/new", label: "New target" } });
      const savePromise = save(event, { watch: changed });
      await loadStarted.promise;
      const manualPromise = now(event, { id: changed.id });
      firstLoad.resolve(currentWatches);
      await savePromise;
      await manualPromise;
      expect(inspected).toEqual(["New target"]);
    } finally {
      installed.stop();
    }
  });

  it("serializes save then remove without restoring a removed watch", async () => {
    let currentWatches: readonly Watch[] = [];
    const loadGate = deferred<readonly Watch[]>();
    const loadStarted = deferred<void>();
    let loads = 0;
    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => {
        loads++;
        if (loads === 1) { loadStarted.resolve(); return await loadGate.promise; }
        return currentWatches;
      },
      save: async (watches) => { currentWatches = watches; },
      look: async () => null,
      lastSeen: async () => null,
      remember: async () => {},
      tell: async () => {}
    });

    try {
      const event = createMockEvent();
      const savePromise = ipcHandlers.get("workstation-watch:save")!(event, { watch: createWatch() });
      await loadStarted.promise;
      const removePromise = ipcHandlers.get("workstation-watch:remove")!(event, { id: "watch-1" });
      loadGate.resolve(currentWatches);
      await Promise.all([savePromise, removePromise]);
      expect(currentWatches).toEqual([]);
    } finally {
      installed.stop();
    }
  });

  it("does not commit a manual result after its owner changes during look", async () => {
    const lookGate = deferred<string | null>();
    const lookStarted = deferred<void>();
    const save = vi.fn(async () => {});
    const remember = vi.fn(async () => {});
    const tell = vi.fn(async () => {});
    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => [createWatch({ paused: true })],
      save,
      look: async () => { lookStarted.resolve(); return await lookGate.promise; },
      lastSeen: async () => "old",
      remember,
      tell
    });

    try {
      const manual = ipcHandlers.get("workstation-watch:now")!(createMockEvent(), { id: "watch-1" });
      await lookStarted.promise;
      ownerState.current = {};
      lookGate.resolve("new");
      await expect(manual).rejects.toThrow("This window changed");
      expect(remember).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(tell).not.toHaveBeenCalled();
    } finally {
      installed.stop();
    }
  });

  it("drops a quiet-hours message when its watch is edited or removed", async () => {
    let currentWatches: readonly Watch[] = [createWatch({ quietHours: true })];
    let currentTime = new Date(2026, 8, 15, 3, 0, 0).getTime();
    const tell = vi.fn(async () => {});
    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => currentWatches,
      save: async (watches) => { currentWatches = watches; },
      look: async () => "changed",
      lastSeen: async () => "old",
      remember: async () => {},
      tell,
      now: () => currentTime
    });

    try {
      const event = createMockEvent();
      await installed.checkDue();
      await ipcHandlers.get("workstation-watch:save")!(event, {
        watch: createWatch({ quietHours: true, paused: true, target: { kind: "page", url: "https://example.com/new", label: "Edited" } })
      });
      currentTime = new Date(2026, 8, 15, 7, 0, 0).getTime();
      await installed.checkDue();
      expect(tell).not.toHaveBeenCalled();

      currentTime = new Date(2026, 8, 16, 3, 0, 0).getTime();
      await ipcHandlers.get("workstation-watch:save")!(event, { watch: createWatch({ quietHours: true }) });
      await installed.checkDue();
      await ipcHandlers.get("workstation-watch:remove")!(event, { id: "watch-1" });
      currentTime = new Date(2026, 8, 16, 7, 0, 0).getTime();
      await installed.checkDue();
      expect(tell).not.toHaveBeenCalled();
    } finally {
      installed.stop();
    }
  });

  it("runs twenty due watches sequentially, never concurrently", async () => {
    const watches: Watch[] = [];
    for (let i = 0; i < 20; i++) {
      watches.push(
        createWatch({
          id: `watch-${i}`,
          target: { kind: "page", url: `https://example.com/${i}`, label: `Target ${i}` }
        })
      );
    }

    let concurrentCount = 0;
    let peakConcurrentCount = 0;
    const inspectedLabels: string[] = [];

    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => watches,
      save: async () => {},
      look: async (target) => {
        concurrentCount++;
        if (concurrentCount > peakConcurrentCount) {
          peakConcurrentCount = concurrentCount;
        }
        await new Promise((resolve) => setTimeout(resolve, 3));
        inspectedLabels.push(target.label);
        concurrentCount--;
        return "sample text";
      },
      lastSeen: async () => "baseline",
      remember: async () => {},
      tell: async () => {}
    });

    try {
      await installed.checkDue();
      expect(peakConcurrentCount).toBe(1);
      expect(inspectedLabels.length).toBe(20);
    } finally {
      installed.stop();
    }
  });

  it("produces exactly one message and pauses the watch after three consecutive failures", async () => {
    let currentWatches: readonly Watch[] = [
      createWatch({ id: "flaky-page", target: { kind: "page", url: "https://err.test", label: "Err Page" } })
    ];
    const messages: string[] = [];
    // Hourly, so the clock has to move or the next two checks are not due.
    let currentTime = new Date(2026, 8, 15, 9, 0, 0).getTime();
    const anHour = 60 * 60 * 1000;

    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => currentWatches,
      save: async (watches) => {
        currentWatches = watches;
      },
      look: async () => null,
      lastSeen: async () => null,
      remember: async () => {},
      tell: async (msg) => {
        messages.push(msg);
      },
      now: () => currentTime
    });

    try {
      // Check 1: unreachable target recorded, no message sent
      await installed.checkDue();
      expect(messages.length).toBe(0);
      if (currentWatches.length > 0) {
        expect(currentWatches[0]!.paused).toBe(false);
      }

      // Check 2: unreachable target recorded, no message sent
      currentTime += anHour;
      await installed.checkDue();
      expect(messages.length).toBe(0);
      if (currentWatches.length > 0) {
        expect(currentWatches[0]!.paused).toBe(false);
      }

      // Check 3: third failure notifies once and pauses future attempts
      currentTime += anHour;
      await installed.checkDue();
      expect(messages.length).toBe(1);
      if (currentWatches.length > 0) {
        expect(currentWatches[0]!.paused).toBe(true);
      }
      if (messages.length > 0) {
        expect(messages[0]!).toContain("after three attempts could not reach it");
      }

      // Check 4: watch is now paused, loop remains silent
      currentTime += anHour;
      await installed.checkDue();
      expect(messages.length).toBe(1);
    } finally {
      installed.stop();
    }
  });

  it("never sends a message on the initial baseline check", async () => {
    const watch = createWatch({ id: "fresh-watch" });
    let currentWatches: readonly Watch[] = [watch];
    let storedText: string | null = null;
    const sentMessages: string[] = [];

    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => currentWatches,
      save: async (watches) => {
        currentWatches = watches;
      },
      look: async () => "new baseline content",
      lastSeen: async () => null,
      remember: async (_id, text) => {
        storedText = text;
      },
      tell: async (msg) => {
        sentMessages.push(msg);
      }
    });

    try {
      await installed.checkDue();
      expect(storedText).toBe("new baseline content");
      expect(sentMessages.length).toBe(0);
      if (currentWatches.length > 0) {
        expect(currentWatches[0]!.lastCheckedAt).not.toBeNull();
      }
    } finally {
      installed.stop();
    }
  });

  it("aborts an in-flight look when stop is called", async () => {
    let lookAborted = false;
    let notifyStarted: (() => void) | null = null;
    const lookStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });

    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => [createWatch()],
      save: async () => {},
      look: async (_target, signal) => {
        notifyStarted?.();
        return await new Promise<string | null>((resolve) => {
          signal.addEventListener("abort", () => {
            lookAborted = true;
            resolve(null);
          });
        });
      },
      lastSeen: async () => "prior",
      remember: async () => {},
      tell: async () => {}
    });

    const runPromise = installed.checkDue();
    await lookStarted;
    installed.stop();
    await runPromise;

    expect(lookAborted).toBe(true);
  });

  it("holds quiet hours notifications until daytime and notes when found", async () => {
    let currentWatches: readonly Watch[] = [createWatch({ quietHours: true })];
    const messages: string[] = [];
    let currentTime = new Date(2026, 8, 15, 3, 0, 0).getTime();
    // A real store, because one that forgets reports the same change every pass.
    let remembered: string | null = "original text";

    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => currentWatches,
      save: async (watches) => {
        currentWatches = watches;
      },
      look: async () => "modified text",
      lastSeen: async () => remembered,
      remember: async (_id, text) => {
        remembered = text;
      },
      tell: async (msg) => {
        messages.push(msg);
      },
      now: () => currentTime
    });

    try {
      await installed.checkDue();
      expect(messages.length).toBe(0);

      currentTime = new Date(2026, 8, 15, 7, 0, 0).getTime();
      await installed.checkDue();

      expect(messages.length).toBe(1);
      if (messages.length > 0) {
        expect(messages[0]!).toContain("(Found at 03:00)");
      }
    } finally {
      installed.stop();
    }
  });
});

describe("IPC channels", () => {
  it("exposes list, save, remove, and now handlers", async () => {
    let currentWatches: readonly Watch[] = [createWatch({ id: "item-1" })];

    const installed = installWatch({
      assertTrusted: () => {},
      load: async () => currentWatches,
      save: async (w) => {
        currentWatches = w;
      },
      look: async () => "current state",
      lastSeen: async () => "past state",
      remember: async () => {},
      tell: async () => {}
    });

    try {
      const listHandler = ipcHandlers.get("workstation-watch:list");
      expect(listHandler).toBeDefined();
      if (listHandler) {
        const result = (await listHandler(createMockEvent(), {})) as {
          watches: readonly Watch[];
          checking: boolean;
        };
        expect(result.watches.length).toBe(1);
        expect(result.checking).toBe(false);
      }

      const saveHandler = ipcHandlers.get("workstation-watch:save");
      expect(saveHandler).toBeDefined();
      if (saveHandler) {
        const newWatch = createWatch({ id: "item-2" });
        const result = (await saveHandler(createMockEvent(), { watch: newWatch })) as {
          watches: readonly Watch[];
        };
        expect(result.watches.length).toBe(2);
      }

      const removeHandler = ipcHandlers.get("workstation-watch:remove");
      expect(removeHandler).toBeDefined();
      if (removeHandler) {
        const result = (await removeHandler(createMockEvent(), { id: "item-2" })) as {
          watches: readonly Watch[];
        };
        expect(result.watches.length).toBe(1);
      }

      const nowHandler = ipcHandlers.get("workstation-watch:now");
      expect(nowHandler).toBeDefined();
      if (nowHandler) {
        const result = (await nowHandler(createMockEvent(), { id: "item-1" })) as {
          verdict: ChangeVerdict | null;
        };
        expect(result.verdict?.changed).toBe(true);
      }
    } finally {
      installed.stop();
    }
  });
});
