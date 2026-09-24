import { describe, expect, it } from "vitest";
import { readWorkIntent } from "./work-intents.js";

describe("work-intents parser", () => {
  it("returns null only for empty or whitespace messages", () => {
    expect(readWorkIntent("")).toBeNull();
    expect(readWorkIntent("   \n\t  ")).toBeNull();
  });

  it("recognises STOP. as stop and does not trigger on stopwatch", () => {
    const stopIntent = readWorkIntent("STOP.");
    expect(stopIntent).toEqual({
      verb: "stop",
      body: "",
      seats: [],
      because: "you asked to stop"
    });

    const reviewIntent = readWorkIntent("stopwatch review");
    expect(reviewIntent?.verb).not.toBe("stop");
  });

  it("ensures stop outranks questions and recognizes cancellation keywords", () => {
    const questionStop = readWorkIntent("can you please stop the run?");
    expect(questionStop?.verb).toBe("stop");

    expect(readWorkIntent("/stop@mybot")?.verb).toBe("stop");
    expect(readWorkIntent("cancel")?.verb).toBe("stop");
    expect(readWorkIntent("abort")?.verb).toBe("stop");
    expect(readWorkIntent("halt.")?.verb).toBe("stop");
    expect(readWorkIntent("stop everything")?.verb).toBe("stop");
  });

  it("extracts target bot and specific task from stop requests", () => {
    const stopBot = readWorkIntent("stop claude");
    expect(stopBot).toEqual({
      verb: "stop",
      body: "",
      seats: ["claude"],
      because: "you asked to stop"
    });

    const stopTask = readWorkIntent("stop task 2");
    expect(stopTask?.body).toBe("task 2");
  });

  it("extracts status requests", () => {
    expect(readWorkIntent("/status")?.verb).toBe("status");
    expect(readWorkIntent("how's it going")?.verb).toBe("status");
    expect(readWorkIntent("hows it going")?.verb).toBe("status");
    expect(readWorkIntent("what's happening")?.verb).toBe("status");
    expect(readWorkIntent("any update?")?.verb).toBe("status");
    expect(readWorkIntent("done yet")?.verb).toBe("status");
    expect(readWorkIntent("status of part A")?.body).toBe("of part A");
  });

  it("extracts agents requests", () => {
    expect(readWorkIntent("/agents")?.verb).toBe("agents");
    expect(readWorkIntent("which bots")?.verb).toBe("agents");
    expect(readWorkIntent("list bots")?.verb).toBe("agents");
    expect(readWorkIntent("what agents")?.verb).toBe("agents");
    expect(readWorkIntent("who can draft this")?.body).toBe("draft this");
  });

  it("handles help and short unrecognized messages", () => {
    expect(readWorkIntent("/help")?.verb).toBe("help");
    expect(readWorkIntent("what can you do")?.verb).toBe("help");
    expect(readWorkIntent("?")?.verb).toBe("help");
    expect(readWorkIntent("👍")?.verb).toBe("help");
    expect(readWorkIntent("hello")?.verb).toBe("help");
  });

  it("handles /ask@mybot help me by stripping the bot mention and retaining help me as request body", () => {
    const intent = readWorkIntent("/ask@mybot help me");
    expect(intent).toEqual({
      verb: "ask",
      body: "help me",
      seats: [],
      because: "you asked to start work"
    });
  });

  it("extracts seats and strips naming phrase for Claude and Gemini quote request", () => {
    const intent = readWorkIntent("ask Claude and Gemini to draft the quote");
    expect(intent).toEqual({
      verb: "ask",
      body: "draft the quote",
      seats: ["claude", "gemini"],
      because: "you asked to start work"
    });
    expect(intent?.body.includes("ask Claude and Gemini")).toBe(false);
  });

  it("extracts seats and strips naming phrase for Claude and Codex comparison request", () => {
    const intent = readWorkIntent("ask claude and codex to compare these");
    expect(intent).toEqual({
      verb: "ask",
      body: "compare these",
      seats: ["claude", "codex"],
      because: "you asked to start work"
    });
  });

  it("maps chatgpt to codex and handles numeric Gemini subscriptions", () => {
    const chatgptIntent = readWorkIntent("ask chatgpt to review the code");
    expect(chatgptIntent?.seats).toEqual(["codex"]);

    const geminiIntent = readWorkIntent("ask Gemini 1 and Gemini 3 to summarize");
    expect(geminiIntent?.seats).toEqual(["gemini 1", "gemini 3"]);
  });

  it("handles trailing and parenthesised bot designations", () => {
    const trailing = readWorkIntent("draft the quote with Claude and Gemini");
    expect(trailing?.seats).toEqual(["claude", "gemini"]);
    expect(trailing?.body).toBe("draft the quote");
  });

  it("treats questions longer than four words as ask intents", () => {
    const question = readWorkIntent("Why did the build fail on the main branch?");
    expect(question?.verb).toBe("ask");
    expect(question?.because).toBe("you asked a question");
  });

  it("caps lengthy message bodies at 4,000 characters", () => {
    const longText = `draft an overview of all operations: ${"A".repeat(10000)}`;
    const intent = readWorkIntent(longText);
    expect(intent?.verb).toBe("ask");
    expect(intent?.body.length).toBeLessThanOrEqual(4000);
  });
});
