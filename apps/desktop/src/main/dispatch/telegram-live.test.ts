import { describe, expect, it } from "vitest";
import {
  renderLive,
  worthEditing,
  type LiveState,
} from "./telegram-live.js";

describe("telegram-live", () => {
  it("renders a calm initial state before any trace lines have arrived", () => {
    const state: LiveState = {
      title: "Supplier pricing analysis",
      stage: "Planning",
      lines: [],
      done: false,
      stoppable: true,
      answer: null,
    };

    const message = renderLive(state);

    expect(message.text).toBe("Supplier pricing analysis\n\nPlanning");
    expect(message.buttons).toEqual([[{ text: "Stop", data: "stop" }]]);
  });

  it("omits the stop button when the running task is marked unstoppable", () => {
    const state: LiveState = {
      title: "Quick status lookup",
      stage: "Checking",
      lines: ["Connecting to socket"],
      done: false,
      stoppable: false,
      answer: null,
    };

    const message = renderLive(state);

    expect(message.buttons).toEqual([]);
  });

  it("keeps the newest trace lines and reports dropped count when overflow occurs", () => {
    const longTrace = Array.from({ length: 400 }, (_, i) => `Trace entry number ${i + 1}`);
    const state: LiveState = {
      title: "Deep research turn",
      stage: "Reading sources",
      lines: longTrace,
      done: false,
      stoppable: true,
      answer: null,
    };

    const message = renderLive(state);

    expect(message.text.length).toBeLessThanOrEqual(4096);
    expect(message.text).toContain("earlier lines dropped");
    expect(message.text).toContain("Trace entry number 400");
    expect(message.text).not.toContain("Trace entry number 1\n");
  });

  it("truncates an answer of 20,000 characters and states where the remainder lives", () => {
    const hugeAnswer = "Found 12 viable suppliers in Yorkshire.\n" + "x".repeat(20000);
    const state: LiveState = {
      title: "Packaging search",
      stage: "Finished",
      lines: ["Finished parsing catalogues"],
      done: true,
      stoppable: false,
      answer: hugeAnswer,
    };

    const message = renderLive(state);

    expect(message.text.length).toBeLessThanOrEqual(4096);
    expect(message.text.startsWith("Found 12 viable suppliers in Yorkshire.")).toBe(true);
    expect(message.text).toContain("The rest of this answer is on your Mac.");
    expect(message.buttons).toEqual([
      [
        { text: "Keep this", data: "keep_this" },
        { text: "See the sources", data: "see_sources" },
      ],
      [{ text: "Ask something else", data: "ask_something_else" }],
    ]);
  });

  it("explains when an execution stopped without producing an answer", () => {
    const state: LiveState = {
      title: "Long catalogue scan",
      stage: "Stopped",
      lines: ["Began parsing", "Stop requested"],
      done: true,
      stoppable: false,
      answer: null,
    };

    const message = renderLive(state);

    expect(message.text).toBe("This was stopped before an answer was ready.");
    expect(message.buttons.length).toBe(2);
  });

  it("explains when an execution failed without producing an answer", () => {
    const state: LiveState = {
      title: "Long catalogue scan",
      stage: "Failed",
      lines: ["Began parsing", "Connection dropped"],
      done: true,
      stoppable: false,
      answer: null,
    };

    const message = renderLive(state);

    expect(message.text).toBe("This could not be completed.");
    expect(message.buttons.length).toBe(2);
  });

  it("handles a 500-character title gracefully within the character ceiling", () => {
    const longTitle = "Can we compare all wholesale prices for brown Kraft paper rolls ".repeat(8);
    const state: LiveState = {
      title: longTitle,
      stage: "Evaluating quotes",
      lines: ["Inspecting line 1"],
      done: false,
      stoppable: true,
      answer: null,
    };

    const message = renderLive(state);

    expect(message.text.length).toBeLessThanOrEqual(4096);
    expect(message.text).toContain("Evaluating quotes");
  });

  it("rejects edits between identical states even after 3 seconds", () => {
    const state: LiveState = {
      title: "Inventory check",
      stage: "Thinking",
      lines: ["Scanning shelf A"],
      done: false,
      stoppable: true,
      answer: null,
    };

    const editNeeded = worthEditing(state, state, 3000);

    expect(editNeeded).toBe(false);
  });

  it("rejects edits occurring before the two second throttling interval", () => {
    const prev: LiveState = {
      title: "Inventory check",
      stage: "Thinking",
      lines: ["Scanning shelf A"],
      done: false,
      stoppable: true,
      answer: null,
    };
    const next: LiveState = {
      ...prev,
      lines: ["Scanning shelf A", "Scanning shelf B"],
    };

    const editNeeded = worthEditing(prev, next, 1200);

    expect(editNeeded).toBe(false);
  });

  it("permits edits once the throttling duration has elapsed and text changed", () => {
    const prev: LiveState = {
      title: "Inventory check",
      stage: "Thinking",
      lines: ["Scanning shelf A"],
      done: false,
      stoppable: true,
      answer: null,
    };
    const next: LiveState = {
      ...prev,
      lines: ["Scanning shelf A", "Scanning shelf B"],
    };

    const editNeeded = worthEditing(prev, next, 2100);

    expect(editNeeded).toBe(true);
  });

  it("always allows an edit when done flips to true regardless of timing", () => {
    const prev: LiveState = {
      title: "Inventory check",
      stage: "Thinking",
      lines: ["Scanning shelf A"],
      done: false,
      stoppable: true,
      answer: null,
    };
    const next: LiveState = {
      ...prev,
      stage: "Finished",
      done: true,
      stoppable: false,
      answer: "All items accounted for in stock.",
    };

    const editNeeded = worthEditing(prev, next, 250);

    expect(editNeeded).toBe(true);
  });
});
