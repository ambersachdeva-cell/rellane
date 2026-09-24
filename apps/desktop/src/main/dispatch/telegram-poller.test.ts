/**
 * The poller, exercised against the ways a stranger could try to stop it.
 *
 * Every test here is a denial of service against `stop` — the one verb that has
 * to work — dressed up as an ordinary failure.
 */
import { describe, expect, it, vi } from "vitest";
import { startTelegramPoll } from "./telegram-poller.js";
import { TelegramConflict, TelegramError, type TelegramMessage } from "./telegram.js";

function message(id: number, text: string): TelegramMessage {
  return { updateId: id, chatId: 42, from: "amber", text, messageId: id * 10 };
}

/** Answers each scripted batch in turn, then blocks until aborted. */
function poller(batches: (readonly TelegramMessage[] | Error)[]) {
  let at = 0;
  return async (signal: AbortSignal): Promise<readonly TelegramMessage[]> => {
    const next = batches[at++];
    if (next === undefined) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return [];
    }
    if (next instanceof Error) throw next;
    return next;
  };
}

describe("carrying messages across", () => {
  it("hands every message in a batch to Mark", async () => {
    const seen: string[] = [];
    const loop = startTelegramPoll({
      poll: poller([[message(1, "status"), message(2, "stop")]]),
      deliver: async (m) => void seen.push(m.text),
      sleep: async () => {}
    });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    loop.stop();
    await loop.done;
    expect(seen).toEqual(["status", "stop"]);
  });

  it("keeps going when one message cannot be handled", async () => {
    // A malformed message must not take the rest of the batch with it, or a
    // stranger can silence `stop` by sending one thing nothing parses.
    const seen: string[] = [];
    const loop = startTelegramPoll({
      poll: poller([[message(1, "bad"), message(2, "stop")]]),
      deliver: async (m) => {
        if (m.text === "bad") throw new Error("unparseable");
        seen.push(m.text);
      },
      sleep: async () => {}
    });
    await vi.waitFor(() => expect(seen).toEqual(["stop"]));
    loop.stop();
    await loop.done;
  });

  it("does not redeliver a message that made delivery throw", async () => {
    // The offset has already moved past it. Retrying would loop for ever on one
    // message and nothing after it would ever run.
    const attempts: number[] = [];
    const loop = startTelegramPoll({
      poll: poller([[message(1, "bad")]]),
      deliver: async (m) => {
        attempts.push(m.updateId);
        throw new Error("unparseable");
      },
      sleep: async () => {}
    });
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    loop.stop();
    await loop.done;
    expect(attempts).toEqual([1]);
  });
});

describe("surviving the transport", () => {
  it("backs off and carries on after a failed poll", async () => {
    const waits: number[] = [];
    const seen: string[] = [];
    const loop = startTelegramPoll({
      poll: poller([new TelegramError(500, "upstream"), [message(1, "status")]]),
      deliver: async (m) => void seen.push(m.text),
      sleep: async (ms: number) => void waits.push(ms)
    });
    await vi.waitFor(() => expect(seen).toEqual(["status"]));
    loop.stop();
    await loop.done;
    expect(waits.length).toBeGreaterThan(0);
  });

  it("stops for a second poller rather than fighting it for ever", async () => {
    // Two pollers on one token steal each other's updates, and each looks
    // intermittently broken. That is a misconfiguration, not a blip.
    const waits: number[] = [];
    const loop = startTelegramPoll({
      poll: poller([new TelegramConflict("another getUpdates is running")]),
      deliver: async () => {},
      sleep: async (ms: number) => void waits.push(ms)
    });
    await loop.done;
    expect(waits).toEqual([]);
  });
});

describe("the local stop", () => {
  it("ends the loop without going through Telegram", async () => {
    // If the channel can be flooded, the kill switch cannot live inside it.
    const loop = startTelegramPoll({
      poll: poller([]),
      deliver: async () => {},
      sleep: async () => {}
    });
    loop.stop();
    await expect(loop.done).resolves.toBeUndefined();
  });

  it("stops mid-batch rather than finishing it", async () => {
    const seen: string[] = [];
    let loop: ReturnType<typeof startTelegramPoll>;
    loop = startTelegramPoll({
      poll: poller([[message(1, "one"), message(2, "two"), message(3, "three")]]),
      deliver: async (m) => {
        seen.push(m.text);
        if (m.text === "one") loop.stop();
      },
      sleep: async () => {}
    });
    await loop.done;
    expect(seen).toEqual(["one"]);
  });
});

describe("ending cleanly however it goes wrong", () => {
  it("stops during a backoff instead of waiting it out", async () => {
    // `before-quit` calls stop(). A backoff that ignores the signal makes
    // quitting wait out a delay that exists only because Telegram was already
    // unreachable.
    let released: (() => void) | null = null;
    const loop = startTelegramPoll({
      poll: async () => {
        throw new TelegramError(500, "upstream");
      },
      deliver: async () => {},
      sleep: (_ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          released = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        })
    });
    await vi.waitFor(() => expect(released).not.toBeNull());
    loop.stop();
    await expect(loop.done).resolves.toBeUndefined();
  });

  it("resolves rather than rejecting when its own error path throws", async () => {
    // Nothing at the call site awaits `done`. An escaping rejection in the main
    // process takes the app with it, so a broken backoff must stop the poller
    // and not the application.
    const loop = startTelegramPoll({
      poll: async () => {
        throw new TelegramError(500, "upstream");
      },
      deliver: async () => {},
      sleep: async () => {
        throw new Error("the clock is broken");
      }
    });
    await expect(loop.done).resolves.toBeUndefined();
  });
});
