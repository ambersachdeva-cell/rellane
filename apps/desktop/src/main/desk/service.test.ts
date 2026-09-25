/**
 * The front door.
 *
 * Two things matter here and they pull against each other: it must answer
 * almost anything, and it must not be able to do more than the buttons it
 * replaces. Most of these tests are the second one.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRoomStatus } from "@cadrane/contracts";
import { openBook } from "../book/database.js";
import { addInvoice, addParty, addPayment } from "../book/records.js";
import { answerFromBook, deskPrompt, say } from "./service.js";

const NOW = Date.parse("2026-09-03T10:00:00.000Z");
const DAY = 86_400_000;

let dir: string;
let db: DatabaseSync;

const room: EngineRoomStatus = {
  engines: [
    {
      id: "claude",
      label: "Claude",
      access: "subscription",
      accessLabel: "Your subscription",
      state: "ready",
      summary: "s",
      fixHint: null,
      evidence: null,
      models: [
        {
          id: "haiku",
          label: "Haiku",
          tier: "fast",
          tierLabel: "Quick",
          note: "n",
          includedInSubscription: true
        }
      ]
    }
  ],
  active: null,
  checkedAt: "2026-09-03T00:00:00.000Z",
  allUnavailable: false
};

const agents = [{ id: "filing-clerk", name: "Filing clerk" }];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-desk-"));
  db = (await openBook(join(dir, "book.sqlite"))).db;
  const devgiri = addParty(db, { name: "Devgiri Traders" });
  addInvoice(db, {
    partyId: devgiri,
    number: "A-114",
    issuedOn: NOW - 60 * DAY,
    dueOn: NOW - 15 * DAY,
    subtotalPaise: 800_000,
    totalPaise: 944_000
  });
  const paid = addParty(db, { name: "Settled Up" });
  addInvoice(db, {
    partyId: paid,
    issuedOn: NOW - 60 * DAY,
    dueOn: NOW - 30 * DAY,
    subtotalPaise: 100_000,
    totalPaise: 100_000
  });
  addPayment(db, { partyId: paid, receivedOn: NOW - 20 * DAY, amountPaise: 100_000 });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("what the book can answer for nothing", () => {
  it("answers without asking any engine at all", async () => {
    // Spending a subscription call to read a ledger is slower, costs something,
    // and risks a rounded figure in the one place figures must be exact.
    const ask = vi.fn();

    const answer = await say("who owes me money", {
      book: db,
      agents,
      ask: ask as never,
      room: async () => room
    });

    expect(ask).not.toHaveBeenCalled();
    expect(answer.kind).toBe("book");
    expect(answer.said).toContain("Devgiri Traders");
    expect(answer.said).toContain("₹9,440");
  });

  it("names who is late and by how many days", async () => {
    // The old home screen said "2 bills past the date agreed" and named nobody,
    // which is the most actionable fact on the screen withheld.
    const said = answerFromBook(db, "overdue", NOW);

    expect(said).toContain("Devgiri Traders");
    expect(said).toContain("15 days late");
    expect(said).toContain("A-114");
  });

  it("does not chase a customer who has paid", async () => {
    expect(answerFromBook(db, "overdue", NOW)).not.toContain("Settled Up");
  });
});

describe("what it opens rather than describes", () => {
  it("sends a pasted bill to the form, and stores nothing", async () => {
    const bill = `TAX INVOICE
GSTIN: 27AAAPL1234C1ZV
Invoice No: A-200
HSN 7308 MS Angle Qty 10 Rate 78.50
CGST 9% 848.00
Total Rs. 11,116.00/-`;

    const answer = await say(bill, { book: db, agents, room: async () => room });

    expect(answer.open).toEqual({ what: "bill" });
    expect(answer.said).toContain("nothing is stored until you do");
  });

  it("sends a request for two opinions to the Bench", async () => {
    const answer = await say("ask both whether this quote is fair", {
      book: db,
      agents,
      room: async () => room
    });

    expect(answer.open).toEqual({ what: "bench" });
  });

  it("runs the agent the owner named", async () => {
    const answer = await say("Filing clerk, tidy up", {
      book: db,
      agents,
      room: async () => room
    });

    expect(answer.open).toEqual({ what: "agent", id: "filing-clerk" });
    expect(answer.said).toContain("you can stop it");
  });
});

describe("anything else", () => {
  it("does not silently choose a ready subscription or send the book", async () => {
    const ask = vi.fn(async () => "Sharma usually pays in the third week.");
    const roomProbe = vi.fn(async () => room);

    const answer = await say("what do you think about the Sharma job", {
      book: db,
      agents,
      ask: ask as never,
      room: roomProbe
    });

    expect(answer.kind).toBe("refused");
    expect(answer.said).toContain("review");
    expect(ask).not.toHaveBeenCalled();
    expect(roomProbe).not.toHaveBeenCalled();
  });

  it("tells a model never to invent a figure", () => {
    // The one instruction that matters on a screen about somebody's money.
    expect(deskPrompt(db)).toContain("never estimate one");
    expect(deskPrompt(db)).toContain("Never invent a customer");
  });

  it("refuses without probing even when no model is known", async () => {
    const roomProbe = vi.fn(async () => ({ ...room, engines: [], allUnavailable: true }));
    const answer = await say("what do you think", {
      book: db,
      agents,
      room: roomProbe
    });

    expect(answer.kind).toBe("refused");
    expect(answer.said).toContain("review");
    expect(roomProbe).not.toHaveBeenCalled();
  });

  it("never invokes an injected failing CLI adapter", async () => {
    const ask = vi.fn(async () => {
      throw new Error("the CLI fell over");
    });
    const answer = await say("what do you think", {
      book: db,
      agents,
      ask: ask as never,
      room: async () => room
    });

    expect(answer.kind).toBe("refused");
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("what the desk cannot do", () => {
  it("never returns a route that writes anything", async () => {
    // The property that makes a conversational front door safe: every route
    // ends at a door that already exists and still asks what it always asked.
    // If typing a sentence could do more than pressing a button, the sentence
    // would be a way around the button.
    for (const text of [
      "pay Devgiri 9440",
      "delete Devgiri Traders",
      "send Devgiri a reminder now",
      "mark A-114 as paid"
    ]) {
      const answer = await say(text, {
        book: db,
        agents,
        ask: (async () => "I cannot do that.") as never,
        room: async () => room
      });
      expect(["book", "ask", "refused"]).toContain(answer.kind);
      expect(answer.open).toBeNull();
    }
  });
});

describe("chasing one customer", () => {
  it("writes the reminder, and cannot send it", async () => {
    // The whole outbound rule, at the one moment somebody would most want it
    // skipped. Three strings come back; nothing here reaches a phone.
    const answer = await say("chase Devgiri Traders", {
      book: db,
      agents,
      trading: { name: "Sachdeva Digital", upiId: "amber@okhdfcbank" },
      room: async () => room,
      now: () => NOW
    });

    expect(answer.kind).toBe("chase");
    expect(answer.draft?.text).toContain("₹9,440");
    expect(answer.draft?.text).toContain("A-114");
    expect(answer.draft?.text).toContain("Sachdeva Digital");
    expect(answer.draft?.pay).toContain("upi://pay");
    expect(answer.said).toContain("Rellane cannot send anything itself");
  });

  it("refuses to chase somebody who has paid", async () => {
    // The worst thing this product could do to a working relationship, and the
    // Desk is where somebody would ask for it fastest.
    const answer = await say("chase Settled Up", {
      book: db,
      agents,
      trading: { name: "S", upiId: "a@bank" },
      room: async () => room,
      now: () => NOW
    });

    expect(answer.draft).toBeNull();
    expect(answer.said).toContain("does not owe you anything");
  });

  it("says why there is no payment link rather than omitting one silently", async () => {
    const answer = await say("chase Devgiri Traders", {
      book: db,
      agents,
      trading: { name: "S", upiId: "" },
      room: async () => room,
      now: () => NOW
    });

    expect(answer.draft?.pay).toBeNull();
    expect(answer.said).toContain("UPI id is not set");
  });

  it("needs both a chasing word and a name", async () => {
    // "Chase" alone is not a customer, and a name alone is a question about
    // them rather than an instruction to write to them.
    const vague = await say("chase someone", {
      book: db,
      agents,
      ask: (async () => "Who did you mean?") as never,
      room: async () => room
    });

    expect(vague.kind).not.toBe("chase");
  });
});
