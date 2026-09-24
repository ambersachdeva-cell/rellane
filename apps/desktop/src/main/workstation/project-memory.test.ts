import { describe, expect, it } from "vitest";
import {
  learnFrom,
  recall,
  STALE_AGE_MS,
  MAX_RECALL_LINES,
  type Learned,
} from "./project-memory.js";

describe("project-memory", () => {
  it("confirms the same fact across two pieces of work rather than duplicating it", () => {
    const marchTime = 1710000000000;
    const aprilTime = 1712678400000;

    const initial = learnFrom({
      existing: [],
      newFindings: [
        {
          finding: "We offer free delivery on orders over £50.",
          fromTitle: "Shipping Guide",
        },
      ],
      now: marchTime,
    });

    expect(initial.facts.length).toBe(1);
    const firstFact = initial.facts[0];
    expect(firstFact).toBeDefined();
    if (firstFact) {
      expect(firstFact.timesSeen).toBe(1);
      expect(firstFact.firstSeenAt).toBe(marchTime);
      expect(firstFact.lastConfirmedAt).toBe(marchTime);
    }

    const updated = learnFrom({
      existing: initial.facts,
      newFindings: [
        {
          finding: "Free delivery on orders over £50 is offered.",
          fromTitle: "Customer FAQ",
        },
      ],
      now: aprilTime,
    });

    expect(updated.facts.length).toBe(1);
    const confirmedFact = updated.facts[0];
    expect(confirmedFact).toBeDefined();
    if (confirmedFact) {
      expect(confirmedFact.timesSeen).toBe(2);
      expect(confirmedFact.firstSeenAt).toBe(marchTime);
      expect(confirmedFact.lastConfirmedAt).toBe(aprilTime);
    }
  });

  it("replaces a contradicted decision with the newer winning and the older stating what changed", () => {
    const marchTime = 1710500000000; // 15 March 2024
    const septTime = 1726400000000;  // 15 September 2024

    const memoryWithOldDecision = learnFrom({
      existing: [],
      newFindings: [
        {
          finding: "We decided to use Stripe for payment processing.",
          fromTitle: "Billing Architecture",
        },
      ],
      now: marchTime,
    });

    expect(memoryWithOldDecision.facts.length).toBe(1);

    const updated = learnFrom({
      existing: memoryWithOldDecision.facts,
      newFindings: [
        {
          finding: "We decided to use Adyen for payment processing.",
          fromTitle: "September Gateway Review",
        },
      ],
      now: septTime,
    });

    expect(updated.facts.length).toBe(2);

    const older = updated.facts.find((f) => f.fact.startsWith("Superseded:"));
    const newer = updated.facts.find((f) => f.fact.includes("Adyen"));

    expect(older).toBeDefined();
    expect(newer).toBeDefined();

    if (older) {
      expect(older.fact).toContain("We decided to use Stripe for payment processing.");
      expect(older.fact).toContain("We decided to use Adyen for payment processing.");
      expect(older.fact).toContain("September Gateway Review");
      expect(older.fact).toContain("15 September 2024");
    }

    if (newer) {
      expect(newer.kind).toBe("a-decision");
      expect(newer.timesSeen).toBe(1);
    }

    // In recall, the newer winning decision appears first.
    const recalled = recall(updated, "What is our payment processing setup?", 500);
    expect(recalled.length).toBeGreaterThanOrEqual(1);
    const firstLine = recalled[0];
    expect(firstLine).toBeDefined();
    if (firstLine) {
      expect(firstLine).toContain("Adyen");
    }
  });

  it("never recalls a fact marked hidden", () => {
    const now = 1720000000000;
    const baseFact: Learned = {
      id: "mem-hidden-1",
      fact: "Our private backup server is hosted at 192.168.1.50.",
      learnedFrom: "Infrastructure Audit",
      firstSeenAt: now,
      lastConfirmedAt: now,
      timesSeen: 3,
      kind: "about-the-business",
      pinned: false,
      hidden: true,
    };

    const memory = {
      facts: [baseFact],
      headline: "1 fact remembered.",
      stale: [],
    };

    const results = recall(memory, "Where is the private backup server hosted?", 500);
    expect(results).toEqual([]);
  });

  it("flags facts older than thirty days as stale unless pinned", () => {
    const marchTime = 1710000000000;
    const futureTime = marchTime + STALE_AGE_MS + 1000;

    const unpinnedFact: Learned = {
      id: "fact-unpinned",
      fact: "Old temporary discount code was SPRING24.",
      learnedFrom: "Marketing Campaign",
      firstSeenAt: marchTime,
      lastConfirmedAt: marchTime,
      timesSeen: 1,
      kind: "about-the-business",
      pinned: false,
      hidden: false,
    };

    const pinnedFact: Learned = {
      id: "fact-pinned",
      fact: "Company registration number is 12345678.",
      learnedFrom: "Company Setup",
      firstSeenAt: marchTime,
      lastConfirmedAt: marchTime,
      timesSeen: 1,
      kind: "about-the-business",
      pinned: true,
      hidden: false,
    };

    const memory = learnFrom({
      existing: [unpinnedFact, pinnedFact],
      newFindings: [],
      now: futureTime,
    });

    expect(memory.stale.length).toBe(1);
    const staleItem = memory.stale[0];
    expect(staleItem).toBeDefined();
    if (staleItem) {
      expect(staleItem.id).toBe("fact-unpinned");
    }
  });

  it("bounds recall tightly by character budget and line ceiling without dumping", () => {
    const now = 1720000000000;
    const facts: Learned[] = [];
    for (let i = 0; i < 20; i++) {
      facts.push({
        id: `fact-${i}`,
        fact: `London customer requirement rule number ${i} is active.`,
        learnedFrom: `Case ${i}`,
        firstSeenAt: now,
        lastConfirmedAt: now,
        timesSeen: i + 1,
        kind: "a-constraint",
        pinned: false,
        hidden: false,
      });
    }

    const memory = {
      facts,
      headline: "20 facts remembered.",
      stale: [],
    };

    const recalledMaxLines = recall(memory, "London customer requirement rules", 5000);
    expect(recalledMaxLines.length).toBeLessThanOrEqual(MAX_RECALL_LINES);

    // Most confirmed facts rank first.
    const topRecalled = recalledMaxLines[0];
    expect(topRecalled).toBeDefined();
    if (topRecalled) {
      expect(topRecalled).toContain("rule number 19");
    }

    // Tight character bounds are strictly honoured.
    const tightRecalled = recall(memory, "London customer requirement rules", 120);
    const joinedLength = tightRecalled.join("\n").length;
    expect(joinedLength).toBeLessThanOrEqual(120);

    // Unrelated queries return an empty list rather than dumping defaults.
    const emptyRecalled = recall(memory, "What is our recipe for sourdough bread?", 1000);
    expect(emptyRecalled).toEqual([]);
  });

  it("handles messy edge cases gracefully including large inputs and distinct dates", () => {
    const now = 1720000000000;
    const hugeFinding = "We operate our primary warehouse in Bristol. ".repeat(200);

    const memory = learnFrom({
      existing: [],
      newFindings: [
        {
          finding: hugeFinding,
          fromTitle: "Warehouse Logistics",
        },
      ],
      now,
    });

    expect(memory.facts.length).toBe(1);
    const firstFact = memory.facts[0];
    expect(firstFact).toBeDefined();
    if (firstFact) {
      expect(firstFact.fact.length).toBeLessThanOrEqual(250);
      expect(firstFact.fact).toContain("Bristol");
    }

    // Two facts that share text but specify different years remain distinct.
    const dateMemory = learnFrom({
      existing: [
        {
          id: "date-1",
          fact: "The business was incorporated in 2020.",
          learnedFrom: "Articles of Association",
          firstSeenAt: now,
          lastConfirmedAt: now,
          timesSeen: 1,
          kind: "about-the-business",
          pinned: false,
          hidden: false,
        },
      ],
      newFindings: [
        {
          finding: "The business was incorporated in 2024.",
          fromTitle: "Annual Filing",
        },
      ],
      now,
    });

    expect(dateMemory.facts.length).toBe(2);
  });
});
