import { describe, expect, it } from "vitest";
import {
  acknowledge,
  editMessage,
  packData,
  readButtonPress,
  sendWithKeyboard,
  type Keyboard
} from "./telegram-ui.js";
import { MAX_MESSAGE_CHARS } from "./telegram.js";

describe("packData", () => {
  it("joins components under sixty-four bytes", () => {
    const result = packData(["case", "102", "stop"]);
    expect(result).toBe("case:102:stop");
  });

  it("returns null when joined data exceeds sixty-four bytes", () => {
    const longId = "a".repeat(65);
    expect(packData(["job", longId])).toBeNull();
  });

  it("measures byte count for multibyte characters", () => {
    // Each symbol is four UTF-8 bytes; sixteen symbols equals sixty-four bytes.
    const exactSixtyFour = "\u{1F4E6}".repeat(16);
    expect(packData([exactSixtyFour])).toBe(exactSixtyFour);

    const overSixtyFour = "\u{1F4E6}".repeat(17);
    expect(packData([overSixtyFour])).toBeNull();
  });
});

describe("sendWithKeyboard", () => {
  it("creates message payload with formatted inline keyboard", () => {
    const keyboard: Keyboard = {
      rows: [[{ text: "Stop Run", data: "run:stop" }]]
    };
    const body = sendWithKeyboard("987654", "Job running", keyboard);
    expect(body).toEqual({
      chat_id: "987654",
      text: "Job running",
      reply_markup: {
        inline_keyboard: [[{ text: "Stop Run", callback_data: "run:stop" }]]
      }
    });
  });

  it("caps a row with eight buttons to three", () => {
    const buttons = Array.from({ length: 8 }, (_, i) => ({
      text: `Option ${i + 1}`,
      data: `opt:${i + 1}`
    }));
    const keyboard: Keyboard = { rows: [buttons] };
    const body = sendWithKeyboard("100", "Pick one", keyboard);
    const markup = body.reply_markup as { inline_keyboard: unknown[][] };
    if (markup.inline_keyboard.length > 0) {
      const firstRow = markup.inline_keyboard[0]!;
      expect(firstRow.length).toBe(3);
    }
  });

  it("preserves an empty keyboard with no rows", () => {
    const keyboard: Keyboard = { rows: [] };
    const body = sendWithKeyboard("100", "Status update", keyboard);
    expect(body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("refuses text exceeding maximum character limit", () => {
    const tooLong = "x".repeat(MAX_MESSAGE_CHARS + 1);
    const keyboard: Keyboard = { rows: [] };
    expect(() => sendWithKeyboard("100", tooLong, keyboard)).toThrow(
      `Message text cannot exceed ${MAX_MESSAGE_CHARS} characters.`
    );
  });

  it("permits text of exactly maximum characters", () => {
    const exact = "x".repeat(MAX_MESSAGE_CHARS);
    const keyboard: Keyboard = { rows: [] };
    const body = sendWithKeyboard("100", exact, keyboard);
    expect(body.text).toBe(exact);
  });
});

describe("editMessage", () => {
  it("constructs edit message body without keyboard when omitted", () => {
    const body = editMessage("456", 12, "Updated content");
    expect(body).toEqual({
      chat_id: "456",
      message_id: 12,
      text: "Updated content"
    });
    expect("reply_markup" in body).toBe(false);
  });

  it("attaches keyboard when provided and handles negative group chat id", () => {
    const keyboard: Keyboard = {
      rows: [[{ text: "Resume", data: "resume:1" }]]
    };
    const body = editMessage("-100123456789", 55, "Paused", keyboard);
    expect(body).toEqual({
      chat_id: "-100123456789",
      message_id: 55,
      text: "Paused",
      reply_markup: {
        inline_keyboard: [[{ text: "Resume", callback_data: "resume:1" }]]
      }
    });
  });

  it("refuses text exceeding maximum character limit", () => {
    const overLimit = "y".repeat(MAX_MESSAGE_CHARS + 1);
    expect(() => editMessage("100", 1, overLimit)).toThrow(
      `Message text cannot exceed ${MAX_MESSAGE_CHARS} characters.`
    );
  });
});

describe("acknowledge", () => {
  it("builds acknowledgment payload without toast", () => {
    expect(acknowledge("query_123")).toEqual({
      callback_query_id: "query_123"
    });
  });

  it("includes toast text when provided", () => {
    expect(acknowledge("query_123", "Request processed.")).toEqual({
      callback_query_id: "query_123",
      text: "Request processed."
    });
  });
});

describe("readButtonPress", () => {
  it("parses a well-formed button press update", () => {
    const update = {
      update_id: 101,
      callback_query: {
        id: "cb_99",
        data: "stop:case_1",
        from: { username: "amber" },
        message: {
          message_id: 42,
          chat: { id: 707 }
        }
      }
    };
    expect(readButtonPress(update)).toEqual({
      callbackId: "cb_99",
      chatId: "707",
      messageId: 42,
      data: "stop:case_1",
      from: "amber"
    });
  });

  it("preserves negative group chat identifiers", () => {
    const update = {
      update_id: 102,
      callback_query: {
        id: "cb_100",
        data: "approve",
        from: { first_name: "Colleague" },
        message: {
          message_id: 88,
          chat: { id: -100987654321 }
        }
      }
    };
    expect(readButtonPress(update)).toEqual({
      callbackId: "cb_100",
      chatId: "-100987654321",
      messageId: 88,
      data: "approve",
      from: "Colleague"
    });
  });

  it("returns null for regular text messages", () => {
    const update = {
      update_id: 103,
      message: {
        message_id: 12,
        chat: { id: 707 },
        text: "hello"
      }
    };
    expect(readButtonPress(update)).toBeNull();
  });

  it("returns null when callback query lacks a message", () => {
    const update = {
      update_id: 104,
      callback_query: {
        id: "cb_104",
        data: "action"
      }
    };
    expect(readButtonPress(update)).toBeNull();
  });

  it("returns null when callback data is empty or missing", () => {
    const emptyDataUpdate = {
      update_id: 105,
      callback_query: {
        id: "cb_105",
        data: "",
        message: { message_id: 1, chat: { id: 100 } }
      }
    };
    expect(readButtonPress(emptyDataUpdate)).toBeNull();

    const missingDataUpdate = {
      update_id: 106,
      callback_query: {
        id: "cb_106",
        message: { message_id: 1, chat: { id: 100 } }
      }
    };
    expect(readButtonPress(missingDataUpdate)).toBeNull();
  });

  it("returns null for malformed shapes and primitives", () => {
    expect(readButtonPress(null)).toBeNull();
    expect(readButtonPress(undefined)).toBeNull();
    expect(readButtonPress("raw string")).toBeNull();
    expect(readButtonPress({})).toBeNull();
    expect(readButtonPress({ callback_query: null })).toBeNull();
    expect(readButtonPress({ callback_query: { id: "" } })).toBeNull();
    expect(
      readButtonPress({
        callback_query: {
          id: "cb_1",
          data: "test",
          message: { message_id: "invalid", chat: { id: 1 } }
        }
      })
    ).toBeNull();
  });
});
