import { describe, expect, it } from "vitest";
import {
  notesFromAnswer,
  mergeNotes,
  type CrewNote,
} from "./crew-notes.js";

describe("crew-notes", () => {
  it("merges matching findings with different phrasing into an agreed note", () => {
    const noteA: CrewNote = {
      partId: "p1",
      seatLabel: "Claude",
      finding: "The deposit is 30%",
      confidence: "stated",
      at: 1000,
    };
    const noteB: CrewNote = {
      partId: "p2",
      seatLabel: "Codex",
      finding: "the deposit is thirty per cent of the total",
      confidence: "stated",
      at: 1010,
    };

    const memory = mergeNotes([noteA, noteB]);
    expect(memory.agreed.length).toBe(1);
    expect(memory.contested.length).toBe(0);
    expect(memory.open.length).toBe(0);
    expect(memory.headline).toBe("One thing they agree on.");
  });

  it("marks a finding as contested when one bot negates what another asserted", () => {
    const noteA: CrewNote = {
      partId: "p1",
      seatLabel: "Claude",
      finding: "The contract renews automatically",
      confidence: "stated",
      at: 2000,
    };
    const noteB: CrewNote = {
      partId: "p2",
      seatLabel: "Codex",
      finding: "The contract does not renew automatically",
      confidence: "stated",
      at: 2010,
    };

    const memory = mergeNotes([noteA, noteB]);
    expect(memory.agreed.length).toBe(0);
    expect(memory.contested.length).toBe(1);
    if (memory.contested.length > 0) {
      const item = memory.contested[0]!;
      expect(item.finding).toBe("The contract renews automatically");
      expect(item.bySeat).toContain("Claude");
      expect(item.against).toContain("Codex");
    }
    expect(memory.headline).toBe("One thing they do not agree on.");
  });

  it("produces no notes from pleasantries or restatements", () => {
    const answer = [
      "Hello Amber, thank you for reaching out today!",
      "I hope you are having a pleasant afternoon.",
      "You asked whether the contract renews automatically.",
      "Please let me know if you need anything else.",
    ].join("\n");

    const notes = notesFromAnswer({
      partId: "p1",
      seatLabel: "Claude",
      answer,
      at: 3000,
    });

    expect(notes).toEqual([]);
  });

  it("drops sentences under six words even if they contain numbers", () => {
    const answer = "The fee is £50.";
    const notes = notesFromAnswer({
      partId: "p1",
      seatLabel: "Claude",
      answer,
      at: 4000,
    });
    expect(notes).toEqual([]);
  });

  it("assigns confidence levels based on language markers", () => {
    const answer = [
      "The initial deposit is 30% of the project total.",
      "The supplier probably suggests a delivery window in March.",
      "It is unclear whether the insurance policy covers transport.",
    ].join("\n");

    const notes = notesFromAnswer({
      partId: "p1",
      seatLabel: "Claude",
      answer,
      at: 5000,
    });

    expect(notes.length).toBe(3);
    const stated = notes.find((n) => n.confidence === "stated");
    const inferred = notes.find((n) => n.confidence === "inferred");
    const uncertain = notes.find((n) => n.confidence === "uncertain");

    expect(stated).toBeDefined();
    expect(inferred).toBeDefined();
    expect(uncertain).toBeDefined();
  });

  it("caps findings at eight, placing the most specific first", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 12; i++) {
      lines.push(`Part ${i} requires 25 workers and 10 vehicles by Q${(i % 4) + 1}.`);
    }
    lines.unshift("London Branch 101 recorded £50,000 VAT across 4 accounts in January.");

    const notes = notesFromAnswer({
      partId: "p1",
      seatLabel: "Claude",
      answer: lines.join("\n"),
      at: 6000,
    });

    expect(notes.length).toBe(8);
    if (notes.length > 0) {
      expect(notes[0]!.finding).toContain("London Branch 101");
    }
  });

  it("handles a bulleted list answer without crashing", () => {
    const answer = [
      "- First payment must be made before 1st November.",
      "- Second payment of £1,200 is due in December.",
      "- Final audit will take place in January.",
    ].join("\n");

    const notes = notesFromAnswer({
      partId: "p1",
      seatLabel: "Gemini",
      answer,
      at: 7000,
    });

    expect(notes.length).toBe(3);
  });

  it("keeps everything open when notes arrive from a single bot", () => {
    const notes: readonly CrewNote[] = [
      {
        partId: "p1",
        seatLabel: "Claude",
        finding: "The deposit is 30% of the upfront cost",
        confidence: "stated",
        at: 8000,
      },
      {
        partId: "p2",
        seatLabel: "Claude",
        finding: "VAT registration is mandatory above £90,000",
        confidence: "stated",
        at: 8010,
      },
    ];

    const memory = mergeNotes(notes);
    expect(memory.agreed.length).toBe(0);
    expect(memory.contested.length).toBe(0);
    expect(memory.open.length).toBe(2);
    expect(memory.headline).toBe("Two things noted, none yet confirmed.");
  });

  it("handles empty answers and empty notes gracefully", () => {
    const emptyNotes = notesFromAnswer({
      partId: "p1",
      seatLabel: "Claude",
      answer: "",
      at: 9000,
    });
    expect(emptyNotes).toEqual([]);

    const emptyMemory = mergeNotes([]);
    expect(emptyMemory.agreed).toEqual([]);
    expect(emptyMemory.contested).toEqual([]);
    expect(emptyMemory.open).toEqual([]);
    expect(emptyMemory.headline).toBe("Nothing noted yet.");
  });

  it("formats headline accurately when multiple agreed and contested items exist", () => {
    const notes: readonly CrewNote[] = [
      {
        partId: "p1",
        seatLabel: "Claude",
        finding: "The deposit is 30% upfront",
        confidence: "stated",
        at: 100,
      },
      {
        partId: "p2",
        seatLabel: "Codex",
        finding: "the deposit is 30% upfront",
        confidence: "stated",
        at: 101,
      },
      {
        partId: "p1",
        seatLabel: "Claude",
        finding: "The contract renews automatically",
        confidence: "stated",
        at: 102,
      },
      {
        partId: "p2",
        seatLabel: "Codex",
        finding: "The contract does not renew automatically",
        confidence: "stated",
        at: 103,
      },
    ];

    const memory = mergeNotes(notes);
    expect(memory.agreed.length).toBe(1);
    expect(memory.contested.length).toBe(1);
    expect(memory.headline).toBe("One thing they agree on, one they do not.");
  });
});
