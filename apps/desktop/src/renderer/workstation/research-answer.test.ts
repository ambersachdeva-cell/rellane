import { describe, expect, it } from "vitest";
import { writeCitedAnswer, Note, SourceRef, CitedAnswer } from "./research-answer.js";

describe("writeCitedAnswer", () => {
  const fixedNow = 1726410000000;

  it("handles empty note lists honestly without generating an empty document", () => {
    const result = writeCitedAnswer({
      question: "What are the operating hours?",
      notes: [],
      subQuestions: [{ id: "sq1", question: "When do you open?" }],
      cutShort: false,
      now: fixedNow
    });

    expect(result.confidence).toBe("thin");
    expect(result.sources).toEqual([]);
    expect(result.uncited).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.gaps).toEqual(["When do you open?"]);
    expect(result.markdown).toContain("# What are the operating hours?");
    expect(result.markdown).toContain("No findings were recorded for this question.");
    expect(result.markdown).toContain("When do you open?");
  });

  it("cites a single note with marker and produces structured sources", () => {
    const source: SourceRef = {
      id: "src-manual",
      kind: "file",
      label: "Operations Manual",
      url: "file:///docs/ops.md",
      readAt: fixedNow
    };
    const notes: Note[] = [
      {
        finding: "Opening hours are Monday to Friday from 09:00 to 17:00",
        source,
        quote: "Open weekdays 9am to 5pm",
        confidence: "stated"
      }
    ];

    const result = writeCitedAnswer({
      question: "What are the operating hours?",
      notes,
      subQuestions: [{ id: "sq1", question: "Operating hours and schedule" }],
      cutShort: false,
      now: fixedNow
    });

    expect(result.confidence).toBe("well-sourced");
    expect(result.sources.length).toBe(1);
    expect(result.sources[0]).toEqual({
      marker: 1,
      label: "Operations Manual",
      url: "file:///docs/ops.md"
    });
    expect(result.uncited).toEqual([]);
    expect(result.markdown).toContain("[1]");
    expect(result.markdown).toContain("## Sources");
    expect(result.markdown).toContain("[1] Operations Manual: file:///docs/ops.md");
  });

  it("handles notes whose source has no url", () => {
    const source: SourceRef = {
      id: "src-local",
      kind: "file",
      label: "Local inventory ledger",
      url: null,
      readAt: fixedNow
    };
    const notes: Note[] = [
      {
        finding: "Current stock of widgets is 45 units",
        source,
        quote: "Widget count: 45",
        confidence: "stated"
      }
    ];

    const result = writeCitedAnswer({
      question: "How many widgets are in stock?",
      notes,
      subQuestions: [],
      cutShort: false,
      now: fixedNow
    });

    expect(result.sources.length).toBe(1);
    expect(result.sources[0]?.url).toBeNull();
    expect(result.markdown).toContain("[1] Local inventory ledger");
    expect(result.markdown).not.toContain("null");
  });

  it("places unverified claims without source in uncited and does not give them a marker", () => {
    const validSource: SourceRef = {
      id: "src-doc",
      kind: "page",
      label: "Pricing Page",
      url: "https://example.com/pricing",
      readAt: fixedNow
    };
    const emptySource: SourceRef = {
      id: "",
      kind: "subscription",
      label: "",
      url: null,
      readAt: fixedNow
    };
    const notes: Note[] = [
      {
        finding: "Subscription costs 500 paise per turn",
        source: validSource,
        quote: "500 paise per turn",
        confidence: "stated"
      },
      {
        finding: "Bulk discounts might apply in future quarters",
        source: emptySource,
        quote: "",
        confidence: "uncertain"
      }
    ];

    const result = writeCitedAnswer({
      question: "What is the pricing model?",
      notes,
      subQuestions: [],
      cutShort: false,
      now: fixedNow
    });

    expect(result.sources.length).toBe(1);
    expect(result.sources[0]?.label).toBe("Pricing Page");
    expect(result.uncited).toEqual(["Bulk discounts might apply in future quarters"]);
    expect(result.markdown).toContain("Bulk discounts might apply in future quarters.");
    expect(result.markdown).toContain("500 paise per turn [1].");
  });

  it("identifies conflicting claims between different sources and names both sides", () => {
    const sourceA: SourceRef = {
      id: "src-a",
      kind: "page",
      label: "Official Guide",
      url: "https://example.com/guide",
      readAt: fixedNow
    };
    const sourceB: SourceRef = {
      id: "src-b",
      kind: "page",
      label: "Community Forum",
      url: "https://example.com/forum",
      readAt: fixedNow
    };
    const notes: Note[] = [
      {
        finding: "The monthly subscription is 500 paise.",
        source: sourceA,
        quote: "500 paise monthly",
        confidence: "stated"
      },
      {
        finding: "The monthly subscription is 750 paise.",
        source: sourceB,
        quote: "750 paise monthly",
        confidence: "stated"
      }
    ];

    const result = writeCitedAnswer({
      question: "What does the monthly subscription cost?",
      notes,
      subQuestions: [{ id: "q1", question: "Monthly subscription fee" }],
      cutShort: false,
      now: fixedNow
    });

    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]).toContain("Official Guide");
    expect(result.conflicts[0]).toContain("Community Forum");
    expect(result.conflicts[0]).toContain("500 paise");
    expect(result.conflicts[0]).toContain("750 paise");
    expect(result.markdown).toContain("## Disagreements between sources");
  });

  it("detects negation conflicts between sources on capability statements", () => {
    const sourceA: SourceRef = {
      id: "src-a",
      kind: "file",
      label: "Release Notes",
      url: null,
      readAt: fixedNow
    };
    const sourceB: SourceRef = {
      id: "src-b",
      kind: "page",
      label: "Support Desk",
      url: "https://example.com/support",
      readAt: fixedNow
    };
    const notes: Note[] = [
      {
        finding: "Exporting data to CSV format is supported.",
        source: sourceA,
        quote: "CSV export supported",
        confidence: "stated"
      },
      {
        finding: "Exporting data to CSV format is not supported.",
        source: sourceB,
        quote: "CSV export not supported",
        confidence: "stated"
      }
    ];

    const result = writeCitedAnswer({
      question: "Can data be exported to CSV?",
      notes,
      subQuestions: [],
      cutShort: false,
      now: fixedNow
    });

    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]).toContain("Release Notes");
    expect(result.conflicts[0]).toContain("Support Desk");
  });

  it("records gaps and cutShort notices near the top of the markdown", () => {
    const source: SourceRef = {
      id: "src-1",
      kind: "page",
      label: "Terms Page",
      url: "https://example.com/terms",
      readAt: fixedNow
    };
    const notes: Note[] = [
      {
        finding: "Refunds are issued within 14 business days",
        source,
        quote: "Refunds take 14 days",
        confidence: "stated"
      }
    ];

    const result = writeCitedAnswer({
      question: "Refund and delivery timelines",
      notes,
      subQuestions: [
        { id: "q1", question: "Refund timeline" },
        { id: "q2", question: "International delivery timeline" }
      ],
      cutShort: true,
      now: fixedNow
    });

    expect(result.gaps).toEqual(["International delivery timeline"]);
    const lines = result.markdown.split("\n");
    const headerIndex = lines.findIndex(l => l.includes("# Refund and delivery timelines"));
    const cutShortIndex = lines.findIndex(l => l.includes("stopped early before checking all sources"));
    const gapNoticeIndex = lines.findIndex(l => l.includes("International delivery timeline"));
    const detailsIndex = lines.findIndex(l => l.includes("## Details"));

    expect(cutShortIndex).toBeGreaterThan(headerIndex);
    expect(cutShortIndex).toBeLessThan(detailsIndex);
    expect(gapNoticeIndex).toBeGreaterThan(headerIndex);
    expect(gapNoticeIndex).toBeLessThan(detailsIndex);
  });

  it("derives confidence as thin when most claims come from subscription knowledge", () => {
    const subSource: SourceRef = {
      id: "src-sub",
      kind: "subscription",
      label: "Assistant Memory",
      url: null,
      readAt: fixedNow
    };
    const notes: Note[] = [
      {
        finding: "The app runs on macOS Sonoma and above",
        source: subSource,
        quote: "",
        confidence: "inferred"
      }
    ];

    const result = writeCitedAnswer({
      question: "What are the system requirements?",
      notes,
      subQuestions: [{ id: "sq1", question: "macOS versions supported" }],
      cutShort: false,
      now: fixedNow
    });

    expect(result.confidence).toBe("thin");
  });

  it("derives confidence as partly-sourced when only some sub-questions have page or file notes", () => {
    const pageSource: SourceRef = {
      id: "src-page",
      kind: "page",
      label: "Doc Page",
      url: "https://example.com/doc",
      readAt: fixedNow
    };
    const notes: Note[] = [
      {
        finding: "Storage limit is 10 gigabytes",
        source: pageSource,
        quote: "10GB limit",
        confidence: "stated"
      }
    ];

    const result = writeCitedAnswer({
      question: "Limits and security",
      notes,
      subQuestions: [
        { id: "q1", question: "Storage limit" },
        { id: "q2", question: "Encryption protocol standard" }
      ],
      cutShort: false,
      now: fixedNow
    });

    expect(result.confidence).toBe("partly-sourced");
    expect(result.gaps).toEqual(["Encryption protocol standard"]);
  });

  it("stays readable and deduplicates with hundreds of notes", () => {
    const source: SourceRef = {
      id: "src-bulk",
      kind: "file",
      label: "Telemetry dump",
      url: null,
      readAt: fixedNow
    };
    const notes: Note[] = [];
    for (let i = 0; i < 500; i++) {
      notes.push({
        finding: `Telemetry check entry ${i % 5}`,
        source,
        quote: `sample quote ${i % 5}`,
        confidence: "stated"
      });
    }

    const result = writeCitedAnswer({
      question: "Telemetry health",
      notes,
      subQuestions: [],
      cutShort: false,
      now: fixedNow
    });

    expect(result.sources.length).toBe(1);
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(result.confidence).toBe("well-sourced");
  });
});
