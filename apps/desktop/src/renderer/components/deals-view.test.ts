/**
 * What a row says about a deal, which is the whole of this screen.
 *
 * The list exists so that "say what happened" is worth the ten seconds it
 * costs — a record nobody can look at afterwards is a chore. So the thing held
 * to a standard here is the wording of an outcome and the date beside it.
 */
import { describe, expect, it } from "vitest";
import type { DealSummary } from "@cadrane/contracts";
import { on, standing } from "./DealsView.js";

const deal = (over: Partial<DealSummary> = {}): DealSummary => ({
  enquiryId: "e1",
  channel: "whatsapp",
  receivedAt: Date.parse("2026-09-10T09:00:00.000Z"),
  partyName: "Verma Textiles",
  triage: "unsorted",
  excerpt: "500 visiting cards",
  state: null,
  totalPaise: null,
  closedAt: null,
  closedReason: null,
  ...over
});

describe("what a row says has happened", () => {
  it("names the three endings in the owner's words, not the database's", () => {
    expect(standing(deal({ state: "won" })).said).toBe("Won");
    expect(standing(deal({ state: "lost" })).said).toBe("Lost");
    expect(standing(deal({ state: "no_reply" })).said).toBe("No reply");
  });

  it("distinguishes nothing priced from a price nobody has answered", () => {
    // Two different states of the same job, and the second is the one the owner
    // can do nothing about. Collapsing them would hide which is which.
    expect(standing(deal()).said).toBe("No price yet");
    expect(standing(deal({ state: "draft" })).said).toBe("Draft");
    expect(standing(deal({ state: "sent" })).said).toBe("Waiting for an answer");
  });

  it("says junk over whatever the quotation says, because it is the later fact", () => {
    expect(standing(deal({ triage: "junk", state: "sent" })).said).toBe("Not a real enquiry");
  });

  it("gives colour only to an ending", () => {
    // DESIGN.md §1.3: one saturated thing. Waiting is the commonest state in
    // the list, and a column of amber would highlight nothing at all.
    expect(standing(deal({ state: "sent" })).tone).toBe("open");
    expect(standing(deal()).tone).toBe("open");
    expect(standing(deal({ state: "won" })).tone).toBe("won");
    expect(standing(deal({ state: "lost" })).tone).toBe("lost");
  });
});

describe("the date beside a row", () => {
  const NOW = Date.parse("2026-09-13T10:00:00.000Z");

  it("leaves this year off, because a column of 2026 teaches nothing", () => {
    expect(on(Date.parse("2026-09-10T09:00:00.000Z"), NOW)).toBe("10 Sep");
  });

  it("keeps every month three letters wide", () => {
    // The reason the months are written out rather than formatted: en-IN gives
    // "Sept", so one row in twelve was a character wider than the column.
    for (let month = 0; month < 12; month += 1) {
      const said = on(new Date(2026, month, 5).getTime(), NOW);
      expect(said.split(" ")[1]).toHaveLength(3);
    }
  });

  it("says the year when it is not this one", () => {
    expect(on(Date.parse("2025-12-02T09:00:00.000Z"), NOW)).toBe("2 Dec 2025");
  });
});
