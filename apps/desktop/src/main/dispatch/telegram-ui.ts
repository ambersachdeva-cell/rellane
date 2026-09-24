import { MAX_MESSAGE_CHARS } from "./telegram.js";

// Telegram silently discards callback queries when callback_data exceeds 64 UTF-8 bytes.
export const MAX_CALLBACK_DATA_BYTES = 64;

// Mobile viewports compress rows past three buttons, making labels unreadable.
export const MAX_BUTTONS_PER_ROW = 3;

export interface Button {
  readonly text: string;
  readonly data: string;
}

export interface Keyboard {
  readonly rows: readonly (readonly Button[])[];
}

export interface ButtonPress {
  readonly callbackId: string;
  readonly chatId: string;
  readonly messageId: number;
  readonly data: string;
  readonly from: string;
}

interface TelegramInlineButton {
  readonly text: string;
  readonly callback_data: string;
}

interface TelegramInlineKeyboardMarkup {
  readonly inline_keyboard: readonly (readonly TelegramInlineButton[])[];
}

/**
 * Joins identifiers into a single callback data payload.
 * Returns null when the resulting UTF-8 byte count exceeds Telegram's 64-byte ceiling.
 */
export function packData(parts: readonly string[], separator = ":"): string | null {
  const candidate = parts.join(separator);
  const byteLength = new TextEncoder().encode(candidate).length;
  if (byteLength > MAX_CALLBACK_DATA_BYTES) {
    return null;
  }
  return candidate;
}

function formatKeyboard(keyboard: Keyboard): TelegramInlineKeyboardMarkup {
  const inlineKeyboard = keyboard.rows.map((row) =>
    row.slice(0, MAX_BUTTONS_PER_ROW).map((button) => ({
      text: button.text,
      callback_data: button.data
    }))
  );
  return { inline_keyboard: inlineKeyboard };
}

/** The body for sendMessage with buttons attached. */
export function sendWithKeyboard(
  chatId: string,
  text: string,
  keyboard: Keyboard
): Record<string, unknown> {
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new Error(`Message text cannot exceed ${MAX_MESSAGE_CHARS} characters.`);
  }
  return {
    chat_id: chatId,
    text,
    reply_markup: formatKeyboard(keyboard)
  };
}

/** The body for editMessageText — the live-progress primitive. */
export function editMessage(
  chatId: string,
  messageId: number,
  text: string,
  keyboard?: Keyboard
): Record<string, unknown> {
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new Error(`Message text cannot exceed ${MAX_MESSAGE_CHARS} characters.`);
  }
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text
  };
  if (keyboard !== undefined) {
    payload.reply_markup = formatKeyboard(keyboard);
  }
  return payload;
}

/** The body for answerCallbackQuery, which stops the button spinning. */
export function acknowledge(callbackId: string, toast?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    callback_query_id: callbackId
  };
  if (toast !== undefined && toast.length > 0) {
    payload.text = toast;
  }
  return payload;
}

/** Reads a callback_query out of a raw update, or null when it is not one. */
export function readButtonPress(update: unknown): ButtonPress | null {
  if (typeof update !== "object" || update === null) {
    return null;
  }

  if (!("callback_query" in update)) {
    return null;
  }

  const rawCb = (update as { readonly callback_query: unknown }).callback_query;
  if (typeof rawCb !== "object" || rawCb === null) {
    return null;
  }

  const cb = rawCb as {
    readonly id?: unknown;
    readonly data?: unknown;
    readonly message?: unknown;
    readonly from?: unknown;
  };

  if (typeof cb.id !== "string" || cb.id.length === 0) {
    return null;
  }

  // Telegram callback queries from inline query results lack a concrete chat message.
  if (typeof cb.message !== "object" || cb.message === null) {
    return null;
  }

  const msg = cb.message as {
    readonly message_id?: unknown;
    readonly chat?: unknown;
  };

  if (typeof msg.message_id !== "number" || !Number.isSafeInteger(msg.message_id)) {
    return null;
  }

  if (typeof msg.chat !== "object" || msg.chat === null) {
    return null;
  }

  const chat = msg.chat as { readonly id?: unknown };
  let chatId: string;
  if (typeof chat.id === "number" && Number.isSafeInteger(chat.id)) {
    chatId = String(chat.id);
  } else if (typeof chat.id === "string" && chat.id.length > 0) {
    chatId = chat.id;
  } else {
    return null;
  }

  // A button press must carry callback data; empty or missing data indicates an unhandled action.
  if (typeof cb.data !== "string" || cb.data.length === 0) {
    return null;
  }

  let from = chatId;
  if (typeof cb.from === "object" && cb.from !== null) {
    const user = cb.from as {
      readonly username?: unknown;
      readonly first_name?: unknown;
      readonly id?: unknown;
    };
    if (typeof user.username === "string" && user.username.length > 0) {
      from = user.username;
    } else if (typeof user.first_name === "string" && user.first_name.length > 0) {
      from = user.first_name;
    } else if (typeof user.id === "number" && Number.isSafeInteger(user.id)) {
      from = String(user.id);
    } else if (typeof user.id === "string" && user.id.length > 0) {
      from = user.id;
    }
  }

  return {
    callbackId: cb.id,
    chatId,
    messageId: msg.message_id,
    data: cb.data,
    from
  };
}
