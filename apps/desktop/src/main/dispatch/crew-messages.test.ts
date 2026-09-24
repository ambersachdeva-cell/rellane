import { describe, expect, it } from "vitest";
import { crewDigest, crewMessage, type CrewEvent } from "./crew-messages.js";

describe("crewMessage", () => {
  const now = 1773576000000;

  it("explains clearly that staged work has not been sent and is reviewed on the Mac", () => {
    const message = crewMessage(
      {
        kind: "staged",
        request: "Summarise customer accounts for Q3 and draft the email responses",
        seatLabels: ["Claude", "Codex"],
      },
      now
    );

    expect(message).toContain("Nothing has been sent yet");
    expect(message).toContain("review it on your Mac");
    expect(message).toContain("Claude and Codex");
    expect(message).not.toContain("!");
  });

  it("truncates a 5,000 character staged request on a word boundary with an ellipsis", () => {
    const hugeRequest = "This is a long customer case about business logistics and shipping terms. ".repeat(80);
    const message = crewMessage(
      {
        kind: "staged",
        request: hugeRequest,
        seatLabels: [],
      },
      now
    );

    expect(message.length).toBeLessThan(600);
    expect(message).toContain("...");
    expect(message).toContain("Nothing has been sent yet, and you review it on your Mac.");
  });

  it("formats started events with word counts below ten and never outputs '1 parts'", () => {
    const onePart = crewMessage(
      {
        kind: "started",
        partCount: 1,
        seatLabels: ["Claude"],
      },
      now
    );
    expect(onePart).toBe("Work has started on one part with Claude.");
    expect(onePart).not.toContain("1 parts");

    const twoParts = crewMessage(
      {
        kind: "started",
        partCount: 2,
        seatLabels: ["Claude", "Codex"],
      },
      now
    );
    expect(twoParts).toBe("Work has started in two parts with Claude and Codex.");

    const zeroParts = crewMessage(
      {
        kind: "started",
        partCount: 0,
        seatLabels: [],
      },
      now
    );
    expect(zeroParts).toBe("Work has started.");
  });

  it("formats part-done events calmly with correct word plurals", () => {
    const multiWord = crewMessage(
      {
        kind: "part-done",
        partTitle: "Market research",
        seatLabel: "Claude",
        words: 340,
      },
      now
    );
    expect(multiWord).toBe("Claude finished Market research (340 words).");

    const singleWord = crewMessage(
      {
        kind: "part-done",
        partTitle: "Market research",
        seatLabel: "Claude",
        words: 1,
      },
      now
    );
    expect(singleWord).toBe("Claude finished Market research (one word).");
  });

  it("informs that approvals are waiting on the Mac and do not happen on the phone", () => {
    const message = crewMessage(
      {
        kind: "needs-you",
        what: "send invoice #1024 to the client",
      },
      now
    );

    expect(message).toContain("Waiting on your Mac: send invoice #1024 to the client.");
    expect(message).toContain("Approvals cannot be done from your phone.");
  });

  it("formats finished runs accurately and replaces 0 contested with 'differ on none'", () => {
    const exactExample = crewMessage(
      {
        kind: "finished",
        partCount: 2,
        agreed: 4,
        contested: 1,
      },
      now
    );
    expect(exactExample).toBe("Both finished. They agreed on 4 points and differ on 1.");

    const noneContested = crewMessage(
      {
        kind: "finished",
        partCount: 2,
        agreed: 4,
        contested: 0,
      },
      now
    );
    expect(noneContested).toBe("Both finished. They agreed on 4 points and differ on none.");
    expect(noneContested).not.toContain("differ on 0");

    const singlePart = crewMessage(
      {
        kind: "finished",
        partCount: 1,
        agreed: 1,
        contested: 0,
      },
      now
    );
    expect(singlePart).toBe("One part finished. They agreed on 1 point and differ on none.");
  });

  it("sanitizes file paths, secret file names, and stack traces on failed runs", () => {
    const message = crewMessage(
      {
        kind: "failed",
        partTitle: "Part A",
        reason: "Permission denied accessing /Users/amber/secret/file.ts at Runtime.exec (/app/index.js:12:4)",
      },
      now
    );

    expect(message).not.toContain("/Users/amber/secret/file.ts");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("file.ts");
    expect(message).not.toContain("Runtime.exec");
    expect(message).toBe("Part A failed: Permission denied accessing a file.");
  });

  it("replaces technical internal implementation terms with plain English equivalents", () => {
    const message = crewMessage(
      {
        kind: "failed",
        partTitle: "Data sync",
        reason: "DuckDB failed running HMAC verification on vector database store for Hermes agent loop",
      },
      now
    );

    expect(message).not.toContain("DuckDB");
    expect(message).not.toContain("HMAC");
    expect(message).not.toContain("vector");
    expect(message).not.toContain("Hermes");
    expect(message).not.toContain("agent loop");
    expect(message).toBe("Data sync failed: the database failed running the security check verification on search store for the assistant the run.");
  });

  it("handles stopped events with proper part wording", () => {
    expect(crewMessage({ kind: "stopped", partCount: 1 }, now)).toBe("Work was stopped on one part.");
    expect(crewMessage({ kind: "stopped", partCount: 2 }, now)).toBe("Work was stopped across two parts.");
    expect(crewMessage({ kind: "stopped", partCount: 0 }, now)).toBe("Work was stopped.");
  });

  it("handles refused events cleanly without exclamation marks", () => {
    const message = crewMessage(
      {
        kind: "refused",
        reason: "Cannot overwrite protected system configuration! Danger!",
      },
      now
    );
    expect(message).not.toContain("!");
    expect(message).toBe("Request refused: Cannot overwrite protected system configuration. Danger.");
  });

  it("never emits an exclamation mark across any kind of event", () => {
    const events: readonly CrewEvent[] = [
      { kind: "staged", request: "Urgent! Important!", seatLabels: ["Claude!"] },
      { kind: "started", partCount: 2, seatLabels: ["Claude!"] },
      { kind: "part-done", partTitle: "Drafting!", seatLabel: "Claude!", words: 15 },
      { kind: "needs-you", what: "Approve invoice!" },
      { kind: "finished", partCount: 2, agreed: 2, contested: 0 },
      { kind: "failed", partTitle: "Compile!", reason: "Fatal! Boom!" },
      { kind: "stopped", partCount: 1 },
      { kind: "refused", reason: "Denied! Stop!" },
    ];

    for (const event of events) {
      const rendered = crewMessage(event, now);
      expect(rendered).not.toContain("!");
      expect(rendered.length).toBeLessThan(600);
    }
  });
});

describe("crewDigest", () => {
  const now = 1773576000000;

  it("returns a plain sentence when the event list is empty", () => {
    const digest = crewDigest([], now);
    expect(digest).toBe("Nothing has happened yet.");
  });

  it("summarises events in chronological order and stays strictly under 600 characters", () => {
    const events: readonly CrewEvent[] = [
      {
        kind: "started",
        partCount: 2,
        seatLabels: ["Claude", "Codex"],
      },
      {
        kind: "part-done",
        partTitle: "Part A",
        seatLabel: "Claude",
        words: 120,
      },
      {
        kind: "finished",
        partCount: 2,
        agreed: 3,
        contested: 0,
      },
    ];

    const digest = crewDigest(events, now);
    const lines = digest.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Work has started in two parts with Claude and Codex.");
    expect(lines[1]).toBe("Claude finished Part A (120 words).");
    expect(lines[2]).toBe("Both finished. They agreed on 3 points and differ on none.");
    expect(digest.length).toBeLessThan(600);
  });
});
