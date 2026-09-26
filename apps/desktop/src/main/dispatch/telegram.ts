/**
 * Telegram, the channel Mark speaks through first.
 *
 * Telegram before WhatsApp because it works today: no Meta business
 * verification, no 24-hour messaging window, no pre-approved templates. The
 * same queue and the same replies will drive WhatsApp when verification lands.
 *
 * The three things that go wrong in every naive Bot API client, handled here:
 *
 *   1. **Offset.** Updates are acknowledged by asking for the next one.
 *      `offset` must be `highest_update_id + 1` — verified against Telegram's
 *      own documentation. Advance it wrong and you either reprocess every
 *      message forever or silently drop them.
 *   2. **429.** The reply carries `parameters.retry_after` in seconds. Ignoring
 *      it and retrying immediately is how a bot gets throttled harder.
 *   3. **409.** Two pollers on one token terminate each other's connections in
 *      a loop, dropping updates the whole time. That is a configuration
 *      mistake, so it is reported rather than retried into the ground.
 */

export {
  crewMessage,
  crewDigest,
  type CrewEvent
} from "./crew-messages.js";

export {
  BOTS,
  botFor,
  whatIsMissing,
  type BotId,
  type BotNeeds,
  type Bot
} from "./telegram-bots.js";

export {
  renderLive,
  worthEditing,
  type LiveState,
  type LiveMessage
} from "./telegram-live.js";

export {
  MAX_CALLBACK_DATA_BYTES,
  MAX_BUTTONS_PER_ROW,
  packData,
  sendWithKeyboard,
  editMessage,
  acknowledge,
  readButtonPress,
  type Button,
  type Keyboard,
  type ButtonPress
} from "./telegram-ui.js";

const API = "https://api.telegram.org";

/** Telegram's hard limit on a single message. */
import type { Channel } from "./mark.js";
export const MAX_MESSAGE_CHARS = 4096;

/** Long-poll duration. Telegram holds the connection until an update or this. */
const POLL_TIMEOUT_S = 25;

/** Requests are given longer than the poll itself, or every poll would time out. */
const REQUEST_TIMEOUT_MS = (POLL_TIMEOUT_S + 10) * 1_000;

export interface TelegramMessage {
  readonly updateId: number;
  readonly chatId: number;
  readonly from: string;
  readonly text: string;
  readonly messageId: number;
}

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
    /** Present on 429. Seconds the caller must wait. */
    readonly retryAfter?: number
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

/** A second poller is a misconfiguration, not a transient failure. */
export class TelegramConflict extends TelegramError {
  constructor(message: string) {
    super(409, message);
    this.name = "TelegramConflict";
  }
}

type Fetcher = typeof globalThis.fetch;

export interface TelegramOptions {
  readonly token: string;
  /** Injected for tests. */
  readonly fetch?: Fetcher | undefined;
}

interface ApiResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
  readonly parameters?: { readonly retry_after?: number };
}

export class TelegramClient {
  private readonly token: string;
  private readonly doFetch: Fetcher;
  /** Next update id to request. Zero means "whatever is pending". */
  private offset = 0;

  constructor(options: TelegramOptions) {
    this.token = options.token;
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  /** Confirms the bot's token and returns its username. */
  async whoAmI(signal?: AbortSignal): Promise<{ id: number; username: string }> {
    const me = await this.call<{ id: number; username: string }>("getMe", {}, signal);
    return { id: me.id, username: me.username };
  }

  /**
   * One long poll. Returns messages and advances the offset past them.
   *
   * The offset moves only after the caller has the messages in hand, so a crash
   * mid-poll replays them rather than losing them. At-least-once is the right
   * trade here: a repeated "organise my downloads" is recoverable, a dropped
   * one is invisible.
   */
  async poll(signal?: AbortSignal): Promise<readonly TelegramMessage[]> {
    const updates = await this.call<RawUpdate[]>(
      "getUpdates",
      {
        ...(this.offset > 0 ? { offset: this.offset } : {}),
        timeout: POLL_TIMEOUT_S,
        allowed_updates: ["message"]
      },
      signal
    );

    const messages: TelegramMessage[] = [];
    let highest = this.offset - 1;

    for (const update of updates) {
      highest = Math.max(highest, update.update_id);
      const text = update.message?.text;
      if (text === undefined || update.message === undefined) {
        continue;
      }
      messages.push({
        updateId: update.update_id,
        chatId: update.message.chat.id,
        messageId: update.message.message_id,
        from:
          update.message.from?.username ??
          update.message.from?.first_name ??
          String(update.message.chat.id),
        text
      });
    }

    if (updates.length > 0) {
      // "Must be greater by one than the highest among the identifiers of
      // previously received updates" — Telegram's wording, and the whole
      // acknowledgement mechanism.
      this.offset = highest + 1;
    }
    return messages;
  }

  /**
   * Sends a reply, splitting anything over the limit.
   *
   * Splitting on line boundaries rather than mid-word, because a receipt cut
   * through the middle of a filename is worse than one extra message.
   */
  async send(chatId: number, text: string, signal?: AbortSignal): Promise<void> {
    for (const part of splitMessage(text)) {
      await this.call(
        "sendMessage",
        { chat_id: chatId, text: part, disable_web_page_preview: true },
        signal
      );
    }
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.doFetch(`${API}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const payload = (await response.json()) as ApiResponse<T>;

      if (payload.ok && payload.result !== undefined) {
        return payload.result;
      }

      const code = payload.error_code ?? response.status;
      const description = payload.description ?? `Telegram returned ${code}.`;

      if (code === 409) {
        throw new TelegramConflict(
          "Another Rellane is already polling this bot token. Only one can run at a time — close the other, or use a second bot."
        );
      }
      if (code === 401) {
        throw new TelegramError(401, "That bot token is not valid. Check it with BotFather.");
      }
      if (code === 429) {
        throw new TelegramError(429, description, payload.parameters?.retry_after ?? 1);
      }
      throw new TelegramError(code, description);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

interface RawUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly text?: string;
    readonly chat: { readonly id: number };
    readonly from?: { readonly username?: string; readonly first_name?: string };
  };
}

/** Splits on line boundaries, falling back to a hard cut for one huge line. */
export function splitMessage(text: string, limit = MAX_MESSAGE_CHARS): readonly string[] {
  if (text.length <= limit) {
    return [text];
  }
  const parts: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    if (line.length > limit) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      for (let index = 0; index < line.length; index += limit) {
        parts.push(line.slice(index, index + limit));
      }
      continue;
    }
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length > limit) {
      parts.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

/**
 * How long to wait before polling again after a failure.
 *
 * A 429 states its own wait and that is honoured exactly. Everything else backs
 * off exponentially to a ceiling, so a network outage does not become a
 * request flood the moment it recovers.
 */
export function backoffMs(error: unknown, consecutiveFailures: number): number {
  if (error instanceof TelegramError && error.retryAfter !== undefined) {
    return error.retryAfter * 1_000;
  }
  if (error instanceof TelegramConflict) {
    // Retrying a conflict just prolongs the fight between the two pollers.
    return 60_000;
  }
  return Math.min(1_000 * 2 ** Math.min(consecutiveFailures, 6), 60_000);
}

/**
 * Telegram as a Mark `Channel` — the adapter that was missing.
 *
 * `TelegramClient` and `splitMessage` have existed and been tested since
 * September and nothing ever constructed them: `index.ts` registered only the
 * WhatsApp and email handoffs, so 263 tested lines sat unreachable. This is the
 * ten lines between them and the running app.
 *
 * `delivery` is `"sends"`, and it is the only channel here that says so. The
 * WhatsApp and email handoffs stage a message for a person to tap send on
 * (D-033); Telegram genuinely leaves the Mac. That is correct and intended
 * rather than a loosening: this channel exists so **Mark can answer its owner**
 * on one pinned chat id, not so the product can message customers. Who may be
 * contacted at all is still the outbound lock's decision, enforced inside
 * Mark's single reply path (D-035) rather than here.
 *
 * Long replies are split rather than truncated. Telegram refuses anything over
 * 4,096 characters, and a status reply that silently loses its last line is
 * worse than two messages.
 */
export function telegramChannel(client: TelegramClient): Channel {
  return {
    name: "telegram",
    delivery: "sends",
    async send(to: string, text: string): Promise<void> {
      const chatId = Number(to);
      if (!Number.isSafeInteger(chatId)) {
        // A configuration mistake, not an API failure — so not a TelegramError,
        // which carries an HTTP code and would claim Telegram said something it
        // never said. Refusing beats posting into whatever `NaN` resolves to.
        throw new Error(`"${to}" is not a Telegram chat id.`);
      }
      for (const part of splitMessage(text)) {
        await client.send(chatId, part);
      }
    }
  };
}
