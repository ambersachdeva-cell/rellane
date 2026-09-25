import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import type { WorkstationReview } from "@cadrane/contracts";
import { ipcMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  createTelegramWorkBridge,
  exactPhoneReview,
  installTelegramWork,
  sanitiseReply,
  type InstallTelegramWorkOptions
} from "./telegram-work-ipc.js";

const registeredHandlers = new Map<string, (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Promise<unknown>>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Promise<unknown>) => {
      registeredHandlers.set(channel, listener);
    }),
    removeHandler: vi.fn((channel: string) => {
      registeredHandlers.delete(channel);
    })
  }
}));

// The owner registry calls `isDestroyed()` and subscribes to navigation on the
// sender, so a bare object throws before the handler under test is reached.
const fakeEvent = {
  sender: Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false }),
  senderFrame: { routingId: 1 },
  frameId: 1,
  processId: 1
} as unknown as IpcMainInvokeEvent;

function createMockOptions(overrides: Partial<InstallTelegramWorkOptions> = {}): InstallTelegramWorkOptions {
  return {
    assertTrusted: vi.fn(),
    decidePending: vi.fn().mockResolvedValue({
      decided: true,
      detail: "Allowed once: Write notes.md."
    }),
    startWork: vi.fn().mockResolvedValue({
      started: true,
      detail: "Started on Codex. Say stop to halt it."
    }),
    status: vi.fn().mockResolvedValue({
      headline: "Two bots, one job each",
      lines: ["Part A: Claude is working", "Part B: Codex is waiting"]
    }),
    stopAll: vi.fn().mockResolvedValue({
      detail: "All running work has been stopped."
    }),
    reply: vi.fn().mockResolvedValue(undefined),
    ownerChatId: vi.fn().mockReturnValue("owner-42"),
    ...overrides
  };
}

describe("telegram-work-ipc", () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
  });

  it("registers the three expected IPC channels on installation", () => {
    const options = createMockOptions();
    installTelegramWork(options);

    expect(ipcMain.handle).toHaveBeenCalledWith(
      IPC_CHANNELS.workstationTelegramStatus,
      expect.any(Function)
    );
    expect(ipcMain.handle).toHaveBeenCalledWith(
      IPC_CHANNELS.workstationTelegramNotify,
      expect.any(Function)
    );
    // No channel for injecting a phone message: it had no caller, and it would
    // now be a way to start a session and approve a file write from a window.
    // The name is gone from the shared list too, so this asserts on the string.
    const registered = (ipcMain.handle as unknown as { mock: { calls: readonly (readonly unknown[])[] } }).mock.calls;
    expect(registered.some((call) => String(call[0]).includes("telegram-handle"))).toBe(false);
  });

  it("asserts caller trust before executing any IPC handler", async () => {
    const assertTrusted = vi.fn().mockImplementation(() => {
      throw new Error("Untrusted frame");
    });
    const options = createMockOptions({ assertTrusted });
    const bridge = createTelegramWorkBridge(options);

    await expect(bridge.handleStatus(fakeEvent)).rejects.toThrow("Untrusted frame");
    await expect(bridge.handleInbound(fakeEvent, { chatId: "owner-42", text: "status" })).rejects.toThrow("Untrusted frame");
    await expect(bridge.handleNotify(fakeEvent, { text: "finished" })).rejects.toThrow("Untrusted frame");
  });

  it("never acts on a stranger's chat id, replies once plainly, and ignores subsequent messages", async () => {
    const options = createMockOptions();
    const bridge = createTelegramWorkBridge(options);

    const firstAttempt = await bridge.handleInbound(fakeEvent, {
      chatId: "stranger-99",
      text: "Please do my taxes"
    });

    expect(options.startWork).not.toHaveBeenCalled();
    expect(options.stopAll).not.toHaveBeenCalled();
    expect(options.status).not.toHaveBeenCalled();
    expect(options.reply).not.toHaveBeenCalled();
    expect(firstAttempt.replied).toBe("This Telegram bot is private to its owner. Unrecognised chats are ignored.");

    const secondAttempt = await bridge.handleInbound(fakeEvent, {
      chatId: "stranger-99",
      text: "Are you there?"
    });

    expect(secondAttempt.replied).toBe("");
    expect(options.startWork).not.toHaveBeenCalled();
  });

  /**
   * The owner decided the phone answers these, after being told plainly that
   * anyone holding the phone then holds this. What he moved is who may answer
   * the question about one named call. What he did not ask for — and what has
   * never existed — is a standing permission that stops later calls asking.
   */
  it("answers yes about the call that is waiting", async () => {
    const options = createMockOptions();
    const bridge = createTelegramWorkBridge(options);

    const result = await bridge.handleInbound(fakeEvent, {
      chatId: "owner-42",
      text: "yes 123456"
    });

    expect(options.decidePending).toHaveBeenCalledWith(true, "123456");
    expect(options.startWork).not.toHaveBeenCalled();
    expect(result.replied).toBe("Allowed once: Write notes.md.");
  });

  it("answers no without letting it fall through to starting work", async () => {
    const options = createMockOptions({
      decidePending: vi.fn().mockResolvedValue({ decided: true, detail: "Declined: Write notes.md." })
    });
    const bridge = createTelegramWorkBridge(options);

    const result = await bridge.handleInbound(fakeEvent, { chatId: "owner-42", text: "no 123456" });

    expect(options.decidePending).toHaveBeenCalledWith(false, "123456");
    expect(options.startWork).not.toHaveBeenCalled();
    expect(result.replied).toBe("Declined: Write notes.md.");
  });

  it("accepts uppercase action-bound decisions", async () => {
    const options = createMockOptions();
    const bridge = createTelegramWorkBridge(options);
    await bridge.handleInbound(fakeEvent, { chatId: "owner-42", text: "YES 123456" });
    await bridge.handleInbound(fakeEvent, { chatId: "owner-42", text: "NO 123456" });
    expect(options.decidePending).toHaveBeenNthCalledWith(1, true, "123456");
    expect(options.decidePending).toHaveBeenNthCalledWith(2, false, "123456");
    expect(options.startWork).not.toHaveBeenCalled();
  });

  it("delivers a meaningful exact phone packet or refuses it without truncating", () => {
    const prompt = "Describe the implementation constraints. ".repeat(35);
    const review: WorkstationReview = {
      token: "secret", caseId: "case-1", providerId: "gemini2", providerLabel: "Gemini profile 2",
      modelId: "gemini-3.8-flash-high", prompt, contextPreview: JSON.stringify({ prompt }),
      sourceIds: [], sourceHash: "hash", workspace: { id: "ws", label: "New work", path: "/private/tmp/new-work" },
      expiresAt: Date.now() + 300_000, resumeSessionId: null
    };
    const message = exactPhoneReview(review, "123456", "owner-42");
    expect(message).toContain(review.contextPreview);
    expect(message).toContain("send 123456");
    expect(message).not.toContain("secret");
    expect(message).not.toContain(review.workspace.path);
    expect(exactPhoneReview({ ...review, contextPreview: "x".repeat(4000) }, "123456", "owner-42")).toBeNull();
    expect(exactPhoneReview({ ...review, contextPreview: "/private/tmp/secret.txt" }, "123456", "owner-42")).toBeNull();
  });

  it("refuses a bare approval and parses an explicit phone model choice", async () => {
    const options = createMockOptions();
    const bridge = createTelegramWorkBridge(options);
    const bare = await bridge.handleInbound(fakeEvent, { chatId: "owner-42", text: "yes" });
    expect(bare.replied).toContain("six-digit code");
    expect(options.decidePending).not.toHaveBeenCalled();
    expect(options.startWork).not.toHaveBeenCalled();

    await bridge.handleInbound(fakeEvent, {
      chatId: "owner-42", text: "/ask gemini2/gemini-3.8-flash-high: Summarise the brief"
    });
    expect(options.startWork).toHaveBeenCalledWith({
      request: "Summarise the brief",
      seats: expect.any(Array),
      selection: { providerId: "gemini2", modelId: "gemini-3.8-flash-high" }
    });
  });

  /**
   * A message that begins with yes and then asks for something else is a new
   * request wearing the word yes. Reading it as consent would approve a call he
   * was never shown.
   */
  it("does not read consent out of a message carrying a second request", async () => {
    const options = createMockOptions();
    const bridge = createTelegramWorkBridge(options);

    await bridge.handleInbound(fakeEvent, {
      chatId: "owner-42",
      text: "yes and also delete the old folder"
    });

    expect(options.decidePending).not.toHaveBeenCalled();
    expect(options.startWork).toHaveBeenCalled();
  });

  it("still refuses to grant a standing permission, because there is none to grant", async () => {
    const options = createMockOptions();
    const bridge = createTelegramWorkBridge(options);

    const result = await bridge.handleInbound(fakeEvent, {
      chatId: "owner-42",
      text: "grant the permission to delete old runs"
    });

    expect(options.startWork).not.toHaveBeenCalled();
    expect(options.decidePending).not.toHaveBeenCalled();
    expect(result.replied).toBe("There is no permission to grant. Each action asks you here when it happens, and you answer yes or no to that one.");
  });

  it("calls stopAll when receiving stop even when status is rejecting", async () => {
    const options = createMockOptions({
      status: vi.fn().mockRejectedValue(new Error("Database locked"))
    });
    const bridge = createTelegramWorkBridge(options);

    const result = await bridge.handleInbound(fakeEvent, {
      chatId: "owner-42",
      text: "stop"
    });

    expect(options.stopAll).toHaveBeenCalledTimes(1);
    expect(options.status).not.toHaveBeenCalled();
    expect(result.replied).toBe("All running work has been stopped.");
  });

  it("answers stop with plain words even if stopAll throws", async () => {
    const options = createMockOptions({
      stopAll: vi.fn().mockRejectedValue(new Error("Process supervisor unreachable"))
    });
    const bridge = createTelegramWorkBridge(options);

    const result = await bridge.handleInbound(fakeEvent, {
      chatId: "owner-42",
      text: "/stopall"
    });

    expect(result.replied).toBe("Could not stop work because an error occurred on your Mac.");
  });

  it("formats status headline and lines cleanly for the phone", async () => {
    const options = createMockOptions();
    const bridge = createTelegramWorkBridge(options);

    const result = await bridge.handleInbound(fakeEvent, {
      chatId: "owner-42",
      text: "status"
    });

    expect(options.status).toHaveBeenCalledTimes(1);
    expect(result.replied).toContain("Two bots, one job each");
    expect(result.replied).toContain("Part A: Claude is working");
    expect(result.replied).toContain("Part B: Codex is waiting");
  });

  it("handles status failures calmly without throwing", async () => {
    const options = createMockOptions({
      status: vi.fn().mockRejectedValue(new Error("SQLite disk I/O error"))
    });
    const bridge = createTelegramWorkBridge(options);

    const result = await bridge.handleInbound(fakeEvent, {
      chatId: "owner-42",
      text: "/progress"
    });

    expect(result.replied).toBe("Could not retrieve status right now. Check your Mac.");
  });

  it("starts work and extracts mentioned model seats", async () => {
    const options = createMockOptions();
    const bridge = createTelegramWorkBridge(options);

    const result = await bridge.handleInbound(fakeEvent, {
      chatId: "owner-42",
      text: "ask Claude and Codex to review the Q3 profit sheet"
    });

    expect(options.startWork).toHaveBeenCalledWith({
      request: // The bots' own names are taken out: they should not be told to ask themselves.
        "review the Q3 profit sheet",
      seats: ["claude", "codex"]
    });
    expect(result.replied).toBe("Started on Codex. Say stop to halt it.");
  });

  it("answers help requests with plain instructions", async () => {
    const options = createMockOptions();
    const bridge = createTelegramWorkBridge(options);

    const result = await bridge.handleInbound(fakeEvent, {
      chatId: "owner-42",
      text: "help"
    });

    expect(options.startWork).not.toHaveBeenCalled();
    expect(result.replied).toContain("You can check progress with 'status'");
  });

  it("sanitises file paths, tokens, stack traces, and chat ids, clamping length under 600", () => {
    const rawResponse =
      "Failed task at /Users/amber/secret/passwords.txt with token bot1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789 for chat owner-42\n" +
      "Error: crash\n    at Object.run (/Users/amber/app/index.ts:40:12)\n" +
      "a".repeat(800);

    const sanitised = sanitiseReply(rawResponse, ["owner-42"]);

    expect(sanitised).not.toContain("/Users/amber");
    expect(sanitised).not.toContain("bot1234567890");
    expect(sanitised).not.toContain("at Object.run");
    expect(sanitised).not.toContain("owner-42");
    expect(sanitised.length).toBeLessThan(600);
    expect(sanitised.endsWith("…")).toBe(true);
  });

  it("reports workstation telegram status with capability lists", async () => {
    const options = createMockOptions();
    const bridge = createTelegramWorkBridge(options);

    const status = await bridge.handleStatus(fakeEvent);

    expect(status.linked).toBe(true);
    expect(status.chatLinked).toBe(true);
    expect(status.detail).toContain("Your Telegram chat is connected");
    expect(status.mayDo.length).toBeGreaterThan(0);
    expect(status.mayNotDo.length).toBeGreaterThan(0);
  });

  it("reports workstation status as unlinked when ownerChatId returns null", async () => {
    const options = createMockOptions({
      ownerChatId: () => null
    });
    const bridge = createTelegramWorkBridge(options);

    const status = await bridge.handleStatus(fakeEvent);

    expect(status.linked).toBe(false);
    expect(status.chatLinked).toBe(false);
    expect(status.detail).toBe("No Telegram chat is linked yet. Pair your chat on your Mac first.");
  });

  it("forwards notifications to the owner and reports delivery state", async () => {
    const options = createMockOptions();
    const bridge = createTelegramWorkBridge(options);

    const notifyResult = await bridge.handleNotify(fakeEvent, {
      text: "Case synthesis completed on your Mac."
    });

    expect(options.reply).toHaveBeenCalledWith("Case synthesis completed on your Mac.");
    expect(notifyResult.sent).toBe(true);
  });

  it("returns sent false from notify when reply fails or no owner is linked", async () => {
    const failingReplyOptions = createMockOptions({
      reply: vi.fn().mockRejectedValue(new Error("Network timeout"))
    });
    const bridge = createTelegramWorkBridge(failingReplyOptions);

    const result = await bridge.handleNotify(fakeEvent, {
      text: "Synthesis ready"
    });

    expect(result.sent).toBe(false);
  });
});
