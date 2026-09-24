import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { readDecision } from "./phone-approvals.js";
import { readWorkIntent } from "../dispatch/work-intents.js";

/**
 * Upper limit on characters accepted across the Telegram IPC boundary.
 *
 * Prevents runaway payloads while leaving plenty of room for long prompts
 * and detailed instructions from your phone.
 */
export const WORKSTATION_TELEGRAM_INPUT_LIMIT = 10_000;

export const WorkstationTelegramHandleInputSchema = z.object({
  chatId: z.union([z.string(), z.number()]).transform((val) => String(val)),
  text: z.string().max(WORKSTATION_TELEGRAM_INPUT_LIMIT)
});

export type WorkstationTelegramHandleInput = z.infer<typeof WorkstationTelegramHandleInputSchema>;

export const WorkstationTelegramNotifyInputSchema = z.object({
  text: z.string().max(WORKSTATION_TELEGRAM_INPUT_LIMIT)
});

export type WorkstationTelegramNotifyInput = z.infer<typeof WorkstationTelegramNotifyInputSchema>;

export interface WorkstationTelegramStatusResult {
  readonly linked: boolean;
  readonly chatLinked: boolean;
  readonly detail: string;
  readonly mayDo: readonly string[];
  readonly mayNotDo: readonly string[];
}

export interface WorkstationTelegramHandleResult {
  readonly replied: string;
}

export interface WorkstationTelegramNotifyResult {
  readonly sent: boolean;
}

/**
 * Exactly what the phone may do, in plain words, shown on the phone screen.
 *
 * The last line of the second list is the one that matters, and it is stated
 * rather than buried: the owner chose to let the phone run what he can run,
 * knowing this Mac cannot tell him from anyone holding the phone. The lists
 * live here, beside the code that enforces them, because a screen that states
 * them in its own words drifts — and this is the screen where being wrong about
 * it matters most.
 */
export const TELEGRAM_WORK_MAY_DO: readonly string[] = [
  "Start work on your subscriptions, as if you had typed it here",
  "Say yes or no to a single action a session stops to ask about",
  "Work on your files, when you ask for that and answer each action",
  "Check the headline and progress of running work",
  "Stop all running work across your subscriptions",
  "Receive a message when something needs you, or finishes"
];

export const TELEGRAM_WORK_MAY_NOT_DO: readonly string[] = [
  "Grant a standing permission — every action still asks, one at a time",
  "Send a message or publish anything on your behalf",
  "Turn off the asking, from your phone or from this Mac",
  "Be told apart from you: whoever holds your phone holds this"
];

export interface InstallTelegramWorkOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /**
   * Starts the work he asked for, and returns what to say back.
   *
   * This staged instead of starting, into whatever session happened to be
   * running, and refused outright when none was — so from away from the desk,
   * which is the only place a phone is used, it always refused. He decided the
   * phone may run what he could run; each tool call inside the session still
   * asks him first, because that was never the part he was giving up.
   */
  /**
   * Answers the oldest call waiting on a decision. Returns what to say back.
   *
   * One decision, about one named call. There is no verb here for "allow
   * everything from now on", because there is no such thing to allow.
   */
  readonly decidePending: (allow: boolean) => Promise<{ readonly decided: boolean; readonly detail: string }>;
  readonly startWork: (input: {
    readonly request: string; readonly seats: readonly string[];
  }) => Promise<{ readonly started: boolean; readonly detail: string }>;
  /** What is running right now, already in plain words. */
  readonly status: () => Promise<{ readonly headline: string; readonly lines: readonly string[] }>;
  /** Stops everything. Returns what to say back. */
  readonly stopAll: () => Promise<{ readonly detail: string }>;
  /** Sends one plain message back to the owner's own chat. */
  readonly reply: (text: string) => Promise<void>;
  /** Only this chat id is obeyed. Anything else is answered once and ignored. */
  readonly ownerChatId: () => string | null;
  /**
   * Someone who is not the owner just messaged the bot.
   *
   * Recorded so the phone screen can show it and he can say "that one is me".
   * Without it a fresh install is a dead end: it obeys nobody, and nothing on
   * this Mac ever tells him what his own chat id is.
   *
   * Noting a knock grants nothing. The list is a list of strangers until he
   * points at one.
   */
  readonly noteKnock?: (chat: { readonly chatId: string; readonly from: string }) => void;
}

export interface TelegramWorkBridge {
  readonly handleStatus: (event: IpcMainInvokeEvent) => Promise<WorkstationTelegramStatusResult>;
  readonly handleInbound: (event: IpcMainInvokeEvent, input: unknown) => Promise<WorkstationTelegramHandleResult>;
  readonly handleNotify: (event: IpcMainInvokeEvent, input: unknown) => Promise<WorkstationTelegramNotifyResult>;
  /** The same answering, for a message that came from the poller rather than a window. */
  readonly answerPhone: (
    chatId: string,
    text: string,
    from?: string
  ) => Promise<WorkstationTelegramHandleResult>;
}

/**
 * Sanitises and bounds replies sent back to Telegram.
 *
 * Keeps replies under 600 characters and strips internal filesystem paths,
 * authentication tokens, stack traces, and chat identifiers so your phone
 * never leaks sensitive host data.
 */
export function sanitiseReply(
  text: string,
  chatIdsToRedact: readonly (string | null | undefined)[] = []
): string {
  let cleaned = text;

  // Stack traces reveal file system internals and line numbers to anyone reading the chat
  cleaned = cleaned.replace(/^\s*at\s+.*$/gm, "");
  cleaned = cleaned.replace(/^[A-Za-z]+Error:.*\n(?:\s*at\s+.*)+/gm, "");

  // File paths belong on your Mac and should not leak to Telegram
  cleaned = cleaned.replace(/(?:\/[\w.-]+){2,}/g, "[file]");
  cleaned = cleaned.replace(/~(?:\/[\w.-]+)+/g, "[file]");
  cleaned = cleaned.replace(/[A-Za-z]:\\(?:[\w.-]+\\)+[\w.-]+/g, "[file]");

  /**
   * Tokens and secrets must never travel across the chat.
   *
   * The bot token is the one credential that must never come back out of this
   * channel: anyone holding it can read every message the bot receives and post
   * as it. The shape here is the same one `telegram-token.ts` accepts — 6 to 19
   * digits, a colon, then 30 to 60 characters — and the optional `bot` prefix is
   * matched explicitly because that is how it appears in an API URL, and a
   * leading word boundary can never match between "bot" and the first digit.
   * That single missing case let a whole token through.
   */
  cleaned = cleaned.replace(/(?:bot)?\d{6,19}:[A-Za-z0-9_-]{30,60}/g, "[redacted token]");
  cleaned = cleaned.replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|Bearer\s+[A-Za-z0-9._-]{20,})\b/gi, "[redacted token]");
  cleaned = cleaned.replace(/\b[0-9a-fA-F]{32,64}\b/g, "[redacted token]");

  for (const id of chatIdsToRedact) {
    if (typeof id === "string" && id.trim().length > 0) {
      cleaned = cleaned.split(id.trim()).join("[redacted]");
    }
  }

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  // Telegram replies must stay compact and fit on a phone screen
  const MAX_REPLY_LENGTH = 580;
  if (cleaned.length > MAX_REPLY_LENGTH) {
    cleaned = cleaned.slice(0, MAX_REPLY_LENGTH).trimEnd() + "…";
  }

  return cleaned;
}

function isApprovalRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\b(approve|approval|approving)\b/i.test(lower) ||
    /\b(grant|give)\s+(a\s+|the\s+)?permission\b/i.test(lower)
  );
}

function isStopCommand(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower === "stop" ||
    lower === "/stop" ||
    lower === "stop all" ||
    lower === "/stopall" ||
    lower === "stop work" ||
    lower.startsWith("stop ") ||
    lower.startsWith("/stop ")
  );
}

function isStatusCommand(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower === "status" ||
    lower === "/status" ||
    lower === "progress" ||
    lower === "/progress"
  );
}

function isHelpCommand(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return lower === "help" || lower === "/help" || lower === "/start";
}

function extractSeats(text: string): readonly string[] {
  const lower = text.toLowerCase();
  const seats: string[] = [];
  if (/\bclaude\b/i.test(lower)) {
    seats.push("claude");
  }
  if (/\bcodex\b/i.test(lower)) {
    seats.push("codex");
  }
  if (/\bgemini\b/i.test(lower)) {
    seats.push("gemini");
  }
  return seats;
}

async function safeReply(options: InstallTelegramWorkOptions, text: string): Promise<void> {
  try {
    await options.reply(text);
  } catch {
    // Delivery back to Telegram may fail over the network, but the IPC caller still needs the result
  }
}

/**
 * Creates pure handler functions for the Telegram workstation bridge.
 *
 * Inbound messages are filtered against the owner's chat ID and routed to
 * ask, status, or stop. No path permits approvals or permission changes from Telegram.
 */
export function createTelegramWorkBridge(options: InstallTelegramWorkOptions): TelegramWorkBridge {
  const ignoredStrangerChats = new Set<string>();

  const handleStatus = async (event: IpcMainInvokeEvent): Promise<WorkstationTelegramStatusResult> => {
    options.assertTrusted(event);

    let ownerId: string | null = null;
    try {
      ownerId = options.ownerChatId();
    } catch {
      ownerId = null;
    }

    const chatLinked = typeof ownerId === "string" && ownerId.trim().length > 0;
    const linked = chatLinked;

    const detail = chatLinked
      ? "Your Telegram chat is connected. You can stage requests, check progress, and stop work from your phone."
      : "No Telegram chat is linked yet. Pair your chat on your Mac first.";

    return {
      linked,
      chatLinked,
      detail,
      mayDo: TELEGRAM_WORK_MAY_DO,
      mayNotDo: TELEGRAM_WORK_MAY_NOT_DO
    };
  };

  const handleInbound = async (
    event: IpcMainInvokeEvent,
    input: unknown
  ): Promise<WorkstationTelegramHandleResult> => {
    options.assertTrusted(event);

    const parsed = WorkstationTelegramHandleInputSchema.safeParse(input);
    if (!parsed.success) {
      return { replied: "Please send a valid message." };
    }

    return answerPhone(parsed.data.chatId, parsed.data.text);
  };

  /**
   * One phone message, answered.
   *
   * Split from the IPC wrapper because the messages that matter do not arrive
   * over IPC — they arrive from the poller, in the main process, with no sender
   * to check. Everything this file exists to enforce is below this line: who is
   * obeyed, what is refused, and what is said back.
   */
  const answerPhone = async (
    chatId: string,
    rawText: string,
    from = ""
  ): Promise<WorkstationTelegramHandleResult> => {
    const rawChatId = chatId.trim();
    const text = rawText.trim();
    const senderName = from.trim();

    if (text.length === 0) {
      return { replied: "Please send a message with what you would like to do." };
    }

    let rawOwnerId: string | null = null;
    try {
      rawOwnerId = options.ownerChatId();
    } catch {
      rawOwnerId = null;
    }

    const cleanOwnerId = typeof rawOwnerId === "string" ? rawOwnerId.trim() : null;

    // Strangers receive one clear refusal and are subsequently dropped to prevent denial of service
    if (cleanOwnerId === null || rawChatId !== cleanOwnerId) {
      options.noteKnock?.({ chatId: rawChatId, from: senderName });
      if (ignoredStrangerChats.has(rawChatId)) {
        return { replied: "" };
      }
      ignoredStrangerChats.add(rawChatId);
      return {
        replied: "This Telegram bot is private to its owner. Unrecognised chats are ignored."
      };
    }

    /**
     * Yes or no, about the call he was just shown.
     *
     * Answered before anything else reads the message, because "no" must never
     * fall through to a branch that starts work. `readDecision` only accepts a
     * message that is nothing but a decision, so a request wearing the word yes
     * is not consent and lands below as an ordinary request.
     */
    const decision = readDecision(text);
    if (decision !== null) {
      let replyText: string;
      try {
        const result = await options.decidePending(decision === "allow");
        replyText = result.detail.trim().length > 0
          ? result.detail.trim()
          : (decision === "allow" ? "Allowed it once." : "Declined it.");
      } catch {
        replyText = "Could not answer that because an error occurred on your Mac.";
      }
      const clean = sanitiseReply(replyText, [rawChatId, cleanOwnerId]);
      await safeReply(options, clean);
      return { replied: clean };
    }

    /**
     * Asking to be granted a standing permission is still refused.
     *
     * Different from answering one named call: this asks for a state in which
     * later calls stop asking, and there is no such state to grant — not from
     * the phone, and not from the Mac either.
     */
    if (isApprovalRequest(text)) {
      const replyText = "There is no permission to grant. Each action asks you here when it happens, and you answer yes or no to that one.";
      await safeReply(options, replyText);
      return { replied: replyText };
    }

    // Stop must succeed even when background status or staging is failing
    /**
     * What the message means, from the table rather than from exact strings.
     *
     * The matchers below started as equality checks, so "STOP." was not a stop
     * and "how's it going" was not a status — which matters most for the one
     * verb that has to work from a phone. `readWorkIntent` is the tested table
     * and it also pulls out which bots he named. The equality checks stay as a
     * second chance, because a verb reaching the wrong branch is worse than
     * asking twice.
     */
    const intent = readWorkIntent(text);

    if (intent?.verb === "stop" || isStopCommand(text)) {
      let replyText: string;
      try {
        const result = await options.stopAll();
        replyText = result.detail.trim().length > 0
          ? result.detail.trim()
          : "All running work has been stopped.";
      } catch {
        replyText = "Could not stop work because an error occurred on your Mac.";
      }
      const clean = sanitiseReply(replyText, [rawChatId, cleanOwnerId]);
      await safeReply(options, clean);
      return { replied: clean };
    }

    if (intent?.verb === "status" || isStatusCommand(text)) {
      let replyText: string;
      try {
        const current = await options.status();
        const headline = current.headline.trim();
        const lines = current.lines.map((line) => line.trim()).filter((line) => line.length > 0);
        if (lines.length > 0) {
          replyText = headline.length > 0
            ? `${headline}\n\n${lines.join("\n")}`
            : lines.join("\n");
        } else if (headline.length > 0) {
          replyText = headline;
        } else {
          replyText = "Nothing is running right now.";
        }
      } catch {
        replyText = "Could not retrieve status right now. Check your Mac.";
      }
      const clean = sanitiseReply(replyText, [rawChatId, cleanOwnerId]);
      await safeReply(options, clean);
      return { replied: clean };
    }

    if (intent?.verb === "help" || isHelpCommand(text)) {
      const replyText =
        "You can check progress with 'status', halt tasks with 'stop', or send a request to stage it for review on your Mac.";
      await safeReply(options, replyText);
      return { replied: replyText };
    }

    const requestPrompt = intent !== null && intent.body.trim().length > 0
      ? intent.body.trim()
      : text.replace(/^(\/)?ask[:\s]*/i, "").trim() || text;
    const seats = intent !== null && intent.seats.length > 0 ? intent.seats : extractSeats(requestPrompt);

    let replyText: string;
    try {
      const result = await options.startWork({
        request: requestPrompt,
        seats
      });
      replyText = result.detail.trim().length > 0
        ? result.detail.trim()
        : (result.started
            ? "Started on your Mac."
            : "Could not start this on your Mac.");
    } catch {
      replyText = "Could not start your request because an error occurred on your Mac.";
    }

    const clean = sanitiseReply(replyText, [rawChatId, cleanOwnerId]);
    await safeReply(options, clean);
    return { replied: clean };
  };

  const handleNotify = async (
    event: IpcMainInvokeEvent,
    input: unknown
  ): Promise<WorkstationTelegramNotifyResult> => {
    options.assertTrusted(event);

    const parsed = WorkstationTelegramNotifyInputSchema.safeParse(input);
    if (!parsed.success) {
      return { sent: false };
    }

    let ownerId: string | null = null;
    try {
      ownerId = options.ownerChatId();
    } catch {
      ownerId = null;
    }

    if (typeof ownerId !== "string" || ownerId.trim().length === 0) {
      return { sent: false };
    }

    try {
      /**
       * Notifications go through the same sieve as replies.
       *
       * This path sent `text` straight out while every other path sanitised,
       * so anything the app chose to tell him about — a failure whose reason
       * carried a path, or a token — left this Mac unredacted. A second door
       * into one channel is how the first door's guard stops mattering.
       */
      await options.reply(sanitiseReply(parsed.data.text, [ownerId]));
      return { sent: true };
    } catch {
      return { sent: false };
    }
  };

  return {
    handleStatus,
    handleInbound,
    handleNotify,
    answerPhone
  };
}

/**
 * There is deliberately no channel for "pretend a phone said this".
 *
 * One existed, and nothing called it. Now that a message from the phone can
 * start a session and answer a call that touches a file, a door letting the
 * renderer inject one is a surface with authority and no user — so it is gone.
 * Real messages arrive at the poller and go through `answerPhone`, which checks
 * the owner chat itself.
 */
export function installTelegramWork(options: InstallTelegramWorkOptions): TelegramWorkBridge {
  const bridge = createTelegramWorkBridge(options);

  ipcMain.handle(
    IPC_CHANNELS.workstationTelegramStatus,
    bridge.handleStatus
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationTelegramNotify,
    bridge.handleNotify
  );

  return bridge;
}
