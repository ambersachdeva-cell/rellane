import { describe, expect, it } from "vitest";
import {
  BANNED_WORDS,
  hasBannedWord,
  homeStarters,
  type StarterContext,
} from "./home-starters.js";

describe("homeStarters copy and length rules across contexts", () => {
  const sampleContexts: readonly StarterContext[] = [
    {
      providersDetected: 0,
      hasSources: false,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 1000,
    },
    {
      providersDetected: 1,
      hasSources: false,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 2000,
    },
    {
      providersDetected: 2,
      hasSources: false,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 3000,
    },
    {
      providersDetected: 3,
      hasSources: true,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 4000,
    },
    {
      providersDetected: 3,
      hasSources: true,
      hasTabularSource: true,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 5000,
    },
    {
      providersDetected: 1,
      hasSources: true,
      hasTabularSource: true,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 6000,
    },
    {
      providersDetected: 2,
      hasSources: true,
      hasTabularSource: false,
      hasOutput: true,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 7000,
    },
    {
      providersDetected: 2,
      hasSources: true,
      hasTabularSource: true,
      hasOutput: true,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 8000,
    },
    {
      providersDetected: 0,
      hasSources: false,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: true,
      pairingAvailable: false,
      savedRoutines: [],
      now: 9000,
    },
    {
      providersDetected: 1,
      hasSources: false,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: true,
      savedRoutines: [],
      now: 10000,
    },
    {
      providersDetected: 1,
      hasSources: false,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [
        {
          id: "r-1",
          title: "Daily Briefing",
          description: "Summarise overnight emails and scheduled meetings",
        },
      ],
      now: 11000,
    },
    {
      providersDetected: 1,
      hasSources: false,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [
        {
          id: "r-2",
          title: "Invoices",
          description: "Check outstanding invoices and prepare reminders",
        },
      ],
      now: 12000,
    },
    {
      providersDetected: 1,
      hasSources: false,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [
        {
          id: "r-3",
          title: "Review customer inquiries and assign high priority tasks",
          description: "Very long description explaining how everything works",
        },
      ],
      now: 13000,
    },
    {
      providersDetected: 1,
      hasSources: false,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [
        {
          id: "r-4",
          title: "SQL Agent DuckDB",
          description: "Query the vector store with LLM tools!",
        },
      ],
      now: 14000,
    },
    {
      providersDetected: 3,
      hasSources: true,
      hasTabularSource: true,
      hasOutput: true,
      localModelReady: true,
      pairingAvailable: true,
      savedRoutines: [
        {
          id: "r-5",
          title: "Morning Review",
          description: "Review orders from yesterday",
        },
        {
          id: "r-6",
          title: "Evening Catchup",
          description: "Wrap up open cases",
        },
      ],
      now: 15000,
    },
  ];

  it("enforces banned words, lengths, and slot rules across all sample contexts", () => {
    for (const context of sampleContexts) {
      const starters = homeStarters(context);

      expect(starters.length).toBeLessThanOrEqual(6);
      const unavailable = starters.filter((s) => !s.available);
      expect(unavailable.length).toBeLessThanOrEqual(2);

      for (const starter of starters) {
        // Banned words check
        expect(hasBannedWord(starter.title)).toBe(false);
        expect(hasBannedWord(starter.line)).toBe(false);
        if (starter.unavailableBecause !== null) {
          expect(hasBannedWord(starter.unavailableBecause)).toBe(false);
        }

        for (const banned of BANNED_WORDS) {
          const regex = new RegExp(`\\b${banned}\\b`, "i");
          expect(regex.test(starter.title)).toBe(false);
          expect(regex.test(starter.line)).toBe(false);
          if (starter.unavailableBecause !== null) {
            expect(regex.test(starter.unavailableBecause)).toBe(false);
          }
        }

        // Length caps
        expect(starter.title.length).toBeLessThan(24);
        expect(starter.line.length).toBeLessThan(60);

        // Title word count: 2 to 4 words
        const wordCount = starter.title.trim().split(/\s+/).length;
        expect(wordCount).toBeGreaterThanOrEqual(2);
        expect(wordCount).toBeLessThanOrEqual(4);

        // No exclamation marks or em dashes
        expect(starter.title).not.toContain("!");
        expect(starter.line).not.toContain("!");
        expect(starter.title).not.toContain("—");
        expect(starter.line).not.toContain("—");
        if (starter.unavailableBecause !== null) {
          expect(starter.unavailableBecause).not.toContain("!");
          expect(starter.unavailableBecause).not.toContain("—");
        }

        // exactOptionalPropertyTypes: routineId must be absent on non-routines
        if (starter.id === "routine") {
          expect(typeof starter.routineId).toBe("string");
        } else {
          expect("routineId" in starter).toBe(false);
        }

        // Unavailable state contract
        if (starter.available) {
          expect(starter.unavailableBecause).toBeNull();
        } else {
          expect(typeof starter.unavailableBecause).toBe("string");
          expect(starter.unavailableBecause!.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("contextual ranking behaviour", () => {
  it("ranks 'read my files' above 'ask a spreadsheet' when there are no sources", () => {
    const context: StarterContext = {
      providersDetected: 1,
      hasSources: false,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 1000,
    };

    const starters = homeStarters(context);
    const readFilesIndex = starters.findIndex((s) => s.id === "read-my-files");
    const spreadsheetIndex = starters.findIndex(
      (s) => s.id === "ask-a-spreadsheet"
    );

    expect(readFilesIndex).toBeGreaterThanOrEqual(0);
    expect(spreadsheetIndex).toBeGreaterThanOrEqual(0);
    expect(readFilesIndex).toBeLessThan(spreadsheetIndex);
  });

  it("ranks 'send to several' at the top when two or more subscriptions are detected", () => {
    const context: StarterContext = {
      providersDetected: 2,
      hasSources: false,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 1000,
    };

    const starters = homeStarters(context);
    if (starters.length > 0) {
      expect(starters[0]!.id).toBe("send-to-several");
      expect(starters[0]!.available).toBe(true);
    } else {
      expect.unreachable("Expected starters to be returned");
    }
  });

  it("ranks 'ask a spreadsheet' at the top when a tabular source is present", () => {
    const context: StarterContext = {
      providersDetected: 1,
      hasSources: true,
      hasTabularSource: true,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 1000,
    };

    const starters = homeStarters(context);
    if (starters.length > 0) {
      expect(starters[0]!.id).toBe("ask-a-spreadsheet");
      expect(starters[0]!.available).toBe(true);
    } else {
      expect.unreachable("Expected starters to be returned");
    }
  });

  it("does not show publish when no output has been saved", () => {
    const context: StarterContext = {
      providersDetected: 2,
      hasSources: true,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 1000,
    };

    const starters = homeStarters(context);
    const hasPublish = starters.some((s) => s.id === "publish");
    expect(hasPublish).toBe(false);
  });

  it("shows publish when an output has been saved", () => {
    const context: StarterContext = {
      providersDetected: 1,
      hasSources: true,
      hasTabularSource: false,
      hasOutput: true,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [],
      now: 1000,
    };

    const starters = homeStarters(context);
    const publishStarter = starters.find((s) => s.id === "publish");
    expect(publishStarter).toBeDefined();
    expect(publishStarter!.available).toBe(true);
  });

  it("presents at most one saved routine with its custom title", () => {
    const context: StarterContext = {
      providersDetected: 1,
      hasSources: false,
      hasTabularSource: false,
      hasOutput: false,
      localModelReady: false,
      pairingAvailable: false,
      savedRoutines: [
        {
          id: "rtn-1",
          title: "Daily Briefing",
          description: "Summarise unread client emails",
        },
        {
          id: "rtn-2",
          title: "Weekly Numbers",
          description: "Review weekly sales and cash receipts",
        },
      ],
      now: 1000,
    };

    const starters = homeStarters(context);
    const routineStarters = starters.filter((s) => s.id === "routine");
    expect(routineStarters.length).toBe(1);
    if (routineStarters.length > 0) {
      const firstRoutine = routineStarters[0]!;
      expect(firstRoutine.routineId).toBe("rtn-1");
      expect(firstRoutine.title).toBe("Daily Briefing");
    }
  });
});
