/**
 * The six steps of D-111, exercised end to end.
 *
 * These are the first tests in this book about the business Rellane actually
 * sells. Everything in `records.test.ts` is receivables, which the owner cut on
 * 12 September; the loop below — enquiry in, quotation out, outcome recorded —
 * is what replaced it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openBook } from "./database.js";
import {
  addEnquiry,
  addParty,
  addQuotationItem,
  bookIsUntouched,
  closeQuotation,
  deals,
  draftQuotation,
  findOrAddParty,
  openEnquiries,
  pastLines,
  quotationTotalPaise,
  recogniseBy,
  removeQuotationItem,
  readDeal,
  sendQuotation,
  setDealCustomer,
  triageEnquiry,
  waitingQuotations
} from "./records.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-12T10:00:00.000Z");

let dir: string;
let db: DatabaseSync;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-loop-"));
  db = (await openBook(join(dir, "book.sqlite"))).db;
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("an enquiry arriving", () => {
  it("is stored exactly as it came, never cleaned on the way in", () => {
    const text = "need 500 visiting cards  matte lamination\nurgent pls rate batao";
    const id = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: text });
    const [open] = openEnquiries(db, NOW);
    expect(open?.enquiryId).toBe(id);
    // Verbatim. A model reads this; a model does not get to replace it.
    expect(open?.rawText).toBe(text);
  });

  it("polled twice is one enquiry, not two pieces of work", () => {
    // IndiaMART is expected to hand back the same enquiry on the next poll.
    // Two rows would show the owner the same job twice and quote it twice.
    const first = addEnquiry(db, {
      channel: "indiamart",
      receivedAt: NOW,
      rawText: "1000 letterheads",
      externalRef: "IM-88421"
    });
    const second = addEnquiry(db, {
      channel: "indiamart",
      receivedAt: NOW + 60_000,
      rawText: "1000 letterheads",
      externalRef: "IM-88421"
    });
    expect(second).toBe(first);
    expect(openEnquiries(db, NOW)).toHaveLength(1);
  });

  it("keeps the same reference on a different channel apart", () => {
    addEnquiry(db, { channel: "indiamart", receivedAt: NOW, rawText: "a", externalRef: "7" });
    addEnquiry(db, { channel: "email", receivedAt: NOW, rawText: "b", externalRef: "7" });
    expect(openEnquiries(db, NOW)).toHaveLength(2);
  });
});

describe("what is waiting for a price", () => {
  it("includes unsorted, because nothing having looked is not the same as nothing found", () => {
    addEnquiry(db, { channel: "whatsapp", receivedAt: NOW - 2 * DAY, rawText: "banner 6x4" });
    const [open] = openEnquiries(db, NOW);
    expect(open?.triage).toBe("unsorted");
    expect(open?.waitingDays).toBe(2);
  });

  it("drops junk once a reading has been recorded", () => {
    const id = addEnquiry(db, { channel: "indiamart", receivedAt: NOW, rawText: "SEO services?" });
    expect(triageEnquiry(db, id, "junk")).toBe(true);
    expect(openEnquiries(db, NOW)).toHaveLength(0);
  });

  it("stays until a price actually reaches the customer", () => {
    // A draft is the shop's own unfinished work, not a price the customer has
    // had. Treating a draft as handled meant an abandoned one disappeared from
    // here *and* from waitingQuotations at the same time — the work vanished,
    // which is the single failure this product exists to prevent. Found by the
    // critic seat reviewing the first version of today().
    const id = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "2000 flyers" });
    expect(openEnquiries(db, NOW)).toHaveLength(1);

    const quote = draftQuotation(db, id);
    expect(openEnquiries(db, NOW)).toHaveLength(1);

    addQuotationItem(db, quote, { description: "Flyers", quantity: 2000, unitPricePaise: 150 });
    sendQuotation(db, quote, NOW);
    expect(openEnquiries(db, NOW)).toHaveLength(0);
  });

  it("also drops out when a draft is closed across the counter", () => {
    const id = addEnquiry(db, { channel: "walk_in", receivedAt: NOW, rawText: "200 cards" });
    const quote = draftQuotation(db, id);
    addQuotationItem(db, quote, { description: "Cards", quantity: 200, unitPricePaise: 300 });
    closeQuotation(db, quote, "won", "Agreed at the counter", NOW);
    expect(openEnquiries(db, NOW)).toHaveLength(0);
  });

  it("carries the party's name when the sender is known", () => {
    const sharma = addParty(db, { name: "Sharma Printers", phone: "+919812345678" });
    addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: "rate?", partyId: sharma });
    expect(openEnquiries(db, NOW)[0]?.partyName).toBe("Sharma Printers");
  });
});

describe("what a quotation comes to", () => {
  it("is derived from its lines, never stored", () => {
    const enquiry = addEnquiry(db, { channel: "walk_in", receivedAt: NOW, rawText: "cards" });
    const quote = draftQuotation(db, enquiry);
    addQuotationItem(db, quote, { description: "Visiting cards", quantity: 500, unitPricePaise: 240 });
    expect(quotationTotalPaise(db, quote)).toBe(120_000);

    // Add a second line and the total moves with it. A stored total is a number
    // that can disagree with the lines it came from.
    addQuotationItem(db, quote, { description: "Matte lamination", quantity: 500, unitPricePaise: 60 });
    expect(quotationTotalPaise(db, quote)).toBe(150_000);
  });

  it("applies GST in basis points, rounded once over the whole tax", () => {
    const enquiry = addEnquiry(db, { channel: "email", receivedAt: NOW, rawText: "letterheads" });
    const quote = draftQuotation(db, enquiry, { gstRateBp: 1800 });
    // Three lines that each round badly on their own; the tax is taken once.
    addQuotationItem(db, quote, { description: "A", quantity: 3, unitPricePaise: 3_333 });
    expect(quotationTotalPaise(db, quote)).toBe(9_999 + Math.round((9_999 * 1800) / 10_000));
  });

  it("is zero before anything is on it, rather than refusing", () => {
    const enquiry = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "?" });
    expect(quotationTotalPaise(db, draftQuotation(db, enquiry))).toBe(0);
  });

  it("refuses a quotation that does not exist instead of answering zero", () => {
    // An aggregate with no GROUP BY always returns a row, so the first version
    // of this function answered a confident 0 for an unknown id. A total of
    // nothing and a total of a thing that is not there are different answers,
    // and only one of them is safe to print beside a customer's name.
    expect(() => quotationTotalPaise(db, "no-such-quotation")).toThrow(/No quotation/);
  });

  it("leaves the party unassigned when the caller explicitly says null", () => {
    // `null ?? fallback` is the fallback, so the first version silently pulled
    // the enquiry's party back in. Absent and null are different answers.
    const sharma = addParty(db, { name: "Sharma Printers" });
    const enquiry = addEnquiry(db, {
      channel: "whatsapp",
      receivedAt: NOW,
      rawText: "?",
      partyId: sharma
    });
    const quote = draftQuotation(db, enquiry, { partyId: null });
    addQuotationItem(db, quote, { description: "x", quantity: 1, unitPricePaise: 100 });
    sendQuotation(db, quote, NOW);
    expect(waitingQuotations(db, NOW)[0]?.partyName).toBeNull();
  });

  it("refuses a quantity that is not a whole number", () => {
    const enquiry = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "?" });
    const quote = draftQuotation(db, enquiry);
    expect(() =>
      addQuotationItem(db, quote, { description: "Half a card", quantity: 1.5, unitPricePaise: 100 })
    ).toThrow(/whole number above zero/);
  });
});

describe("sending and closing", () => {
  function sentQuote(): string {
    const enquiry = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW - 5 * DAY, rawText: "1000 flyers" });
    const quote = draftQuotation(db, enquiry);
    addQuotationItem(db, quote, { description: "Flyers", quantity: 1000, unitPricePaise: 180 });
    expect(sendQuotation(db, quote, NOW - 4 * DAY)).toBe(true);
    return quote;
  }

  it("will not let a sent quotation grow new lines", () => {
    // The customer is holding this. Editing it would silently change what the
    // shop is on record as having offered.
    const quote = sentQuote();
    expect(() =>
      addQuotationItem(db, quote, { description: "Sneaky extra", quantity: 1, unitPricePaise: 50_000 })
    ).toThrow(/only a draft/);
  });

  it("sends only once", () => {
    const quote = sentQuote();
    expect(sendQuotation(db, quote, NOW)).toBe(false);
  });

  it("closes a sent quotation and records the owner's reason", () => {
    const quote = sentQuote();
    expect(closeQuotation(db, quote, "lost", "Gupta quoted 12% under us", NOW)).toBe(true);
    expect(waitingQuotations(db, NOW)).toHaveLength(0);
  });

  it("closes a draft, because a walk-in is won across the counter", () => {
    // Found by an independent review of this file's first version, which only
    // allowed closing a sent quotation. That left a draft with no exit at all:
    // hidden from openEnquiries because something is quoted against it, absent
    // from waitingQuotations because it was never sent. The work vanished.
    const enquiry = addEnquiry(db, { channel: "walk_in", receivedAt: NOW, rawText: "200 cards" });
    const draft = draftQuotation(db, enquiry);
    addQuotationItem(db, draft, { description: "Cards", quantity: 200, unitPricePaise: 300 });
    expect(closeQuotation(db, draft, "won", "Agreed at the counter", NOW)).toBe(true);
    expect(openEnquiries(db, NOW)).toHaveLength(0);
    expect(waitingQuotations(db, NOW)).toHaveLength(0);
  });

  it("will not close the same quotation twice", () => {
    const quote = sentQuote();
    expect(closeQuotation(db, quote, "won", null, NOW)).toBe(true);
    expect(closeQuotation(db, quote, "lost", "changed my mind", NOW)).toBe(false);
  });

  it("refuses to send a quotation with nothing on it", () => {
    // A sent quotation takes no new lines, so sending an empty one would put the
    // shop on record as having offered nothing, for nothing, permanently.
    const enquiry = addEnquiry(db, { channel: "email", receivedAt: NOW, rawText: "?" });
    const empty = draftQuotation(db, enquiry);
    expect(() => sendQuotation(db, empty, NOW)).toThrow(/nothing to send/);
  });

  it("closes without a reason rather than not closing at all", () => {
    // A close recorded with no explanation is still worth more than one that
    // never happened, because the outcome is the part that teaches.
    expect(closeQuotation(db, sentQuote(), "no_reply", null, NOW)).toBe(true);
  });
});

describe("what is still waiting for an answer", () => {
  it("lists sent quotations longest-wait first, with their total", () => {
    const older = addEnquiry(db, { channel: "indiamart", receivedAt: NOW - 20 * DAY, rawText: "banners" });
    const newer = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW - 3 * DAY, rawText: "cards" });

    const a = draftQuotation(db, older);
    addQuotationItem(db, a, { description: "Banner", quantity: 2, unitPricePaise: 450_000 });
    sendQuotation(db, a, NOW - 18 * DAY);

    const b = draftQuotation(db, newer);
    addQuotationItem(db, b, { description: "Cards", quantity: 500, unitPricePaise: 240 });
    sendQuotation(db, b, NOW - 2 * DAY);

    const waiting = waitingQuotations(db, NOW);
    expect(waiting.map((q) => q.quotationId)).toEqual([a, b]);
    expect(waiting[0]?.waitingDays).toBe(18);
    expect(waiting[0]?.totalPaise).toBe(900_000);
  });

  it("does not count a draft nobody has sent", () => {
    const enquiry = addEnquiry(db, { channel: "email", receivedAt: NOW, rawText: "?" });
    draftQuotation(db, enquiry);
    expect(waitingQuotations(db, NOW)).toHaveLength(0);
  });
});

describe("reading one deal whole", () => {
  it("returns null for an enquiry that is not there", () => {
    expect(readDeal(db, "no-such-enquiry")).toBeNull();
  });

  it("carries the enquiry with no quotation before anything is drafted", () => {
    const id = addEnquiry(db, { channel: "indiamart", receivedAt: NOW, rawText: "1000 flyers, matte" });
    const deal = readDeal(db, id);
    expect(deal?.quotation).toBeNull();
    expect(deal?.rawText).toBe("1000 flyers, matte");
    expect(deal?.triage).toBe("unsorted");
    expect(deal?.partyName).toBeNull();
  });

  it("carries lines in the owner's order, with derived line and grand totals", () => {
    const sharma = addParty(db, { name: "Sharma Printers" });
    const id = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: "cards + lam", partyId: sharma });
    const quote = draftQuotation(db, id, { gstRateBp: 1800 });
    addQuotationItem(db, quote, { description: "Visiting cards", quantity: 500, unitPricePaise: 240, unit: "pcs" });
    addQuotationItem(db, quote, { description: "Matte lamination", quantity: 500, unitPricePaise: 60 });

    const deal = readDeal(db, id);
    expect(deal?.partyName).toBe("Sharma Printers");
    expect(deal?.quotation?.state).toBe("draft");
    // The order the owner entered them is the order the customer reads them in.
    expect(deal?.quotation?.lines.map((l) => l.description)).toEqual([
      "Visiting cards",
      "Matte lamination"
    ]);
    expect(deal?.quotation?.lines[0]?.linePaise).toBe(120_000);
    expect(deal?.quotation?.lines[0]?.unit).toBe("pcs");
    expect(deal?.quotation?.lines[1]?.unit).toBeNull();
    expect(deal?.quotation?.netPaise).toBe(150_000);
    // Tax taken once over the whole, not per line.
    expect(deal?.quotation?.totalPaise).toBe(150_000 + Math.round((150_000 * 1800) / 10_000));
  });

  it("agrees with quotationTotalPaise rather than computing its own answer", () => {
    // Two code paths that both produce a price a customer will read. If they
    // ever disagree, one of them is lying and nobody can tell which.
    const id = addEnquiry(db, { channel: "email", receivedAt: NOW, rawText: "letterheads" });
    const quote = draftQuotation(db, id, { gstRateBp: 1200 });
    addQuotationItem(db, quote, { description: "A", quantity: 7, unitPricePaise: 3_333 });
    addQuotationItem(db, quote, { description: "B", quantity: 3, unitPricePaise: 1_111 });
    expect(readDeal(db, id)?.quotation?.totalPaise).toBe(quotationTotalPaise(db, quote));
  });

  it("keeps the close and its reason where the room can show them", () => {
    const id = addEnquiry(db, { channel: "phone", receivedAt: NOW - 5 * DAY, rawText: "banners" });
    const quote = draftQuotation(db, id);
    addQuotationItem(db, quote, { description: "Banner", quantity: 2, unitPricePaise: 450_000 });
    sendQuotation(db, quote, NOW - 4 * DAY);
    closeQuotation(db, quote, "lost", "Gupta quoted 12% under us", NOW);

    const q = readDeal(db, id)?.quotation;
    expect(q?.state).toBe("lost");
    expect(q?.closedReason).toBe("Gupta quoted 12% under us");
    expect(q?.closedAt).toBe(NOW);
    expect(q?.sentAt).toBe(NOW - 4 * DAY);
  });

  it("shows the latest quotation when a lost deal was re-quoted", () => {
    const id = addEnquiry(db, { channel: "walk_in", receivedAt: NOW - 9 * DAY, rawText: "signage" });
    const first = draftQuotation(db, id);
    addQuotationItem(db, first, { description: "Signage v1", quantity: 1, unitPricePaise: 900_000 });
    sendQuotation(db, first, NOW - 8 * DAY);
    closeQuotation(db, first, "lost", "Too dear", NOW - 7 * DAY);

    const second = draftQuotation(db, id);
    addQuotationItem(db, second, { description: "Signage v2", quantity: 1, unitPricePaise: 750_000 });

    const q = readDeal(db, id)?.quotation;
    expect(q?.quotationId).toBe(second);
    expect(q?.lines[0]?.description).toBe("Signage v2");
  });
});

describe("naming the customer at intake", () => {
  it("reuses the same party rather than making a second one", () => {
    // The owner types the name because that is who wrote to them. The second
    // enquiry from the same shop must not split their history in two.
    const first = findOrAddParty(db, "Sharma Printers");
    expect(findOrAddParty(db, "Sharma Printers")).toBe(first);
  });

  it("matches regardless of case or stray spaces", () => {
    const first = findOrAddParty(db, "Sharma Printers");
    expect(findOrAddParty(db, "  sharma printers  ")).toBe(first);
    expect(findOrAddParty(db, "SHARMA PRINTERS")).toBe(first);
  });

  it("keeps different customers apart", () => {
    expect(findOrAddParty(db, "Sharma Printers")).not.toBe(findOrAddParty(db, "Gupta Offset"));
  });

  it("refuses a name that is only whitespace", () => {
    expect(() => findOrAddParty(db, "   ")).toThrow(/needs a name/);
  });

  it("attaches the enquiry to the party it found", () => {
    const sharma = findOrAddParty(db, "Sharma Printers");
    addEnquiry(db, {
      channel: "phone",
      receivedAt: NOW - 2 * DAY,
      rawText: "500 cards",
      partyId: sharma
    });
    expect(openEnquiries(db, NOW)[0]?.partyName).toBe("Sharma Printers");
  });
});

describe("whether anybody has ever used this book", () => {
  it("is untouched on a book that has just been opened", () => {
    expect(bookIsUntouched(db)).toBe(true);
  });

  it("stops being untouched the moment the first enquiry is recorded", () => {
    addEnquiry(db, { channel: "walk_in", receivedAt: NOW, rawText: "200 flyers" });
    expect(bookIsUntouched(db)).toBe(false);
  });

  it("counts a customer, even with no enquiry against them", () => {
    // The one that was wrong. A shop carrying parties, bills or cases from
    // before the loop existed is not a stranger, and asking only about
    // enquiries would have offered it the first-run tour.
    findOrAddParty(db, "Sharma Traders");
    expect(bookIsUntouched(db)).toBe(false);
  });

  it("stays touched once the work is finished and Today is empty again", () => {
    // Why this asks about the book and not about the day. This shop quoted,
    // sent, won and has nothing waiting — being greeted again would read as the
    // app having forgotten it.
    const enquiry = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: "200 flyers" });
    const party = findOrAddParty(db, "Sharma Traders");
    const quotation = draftQuotation(db, enquiry, { partyId: party });
    addQuotationItem(db, quotation, {
      description: "200 flyers",
      quantity: 200,
      unitPricePaise: 400
    });
    sendQuotation(db, quotation, NOW);
    closeQuotation(db, quotation, "won", null, NOW + DAY);

    expect(openEnquiries(db, NOW + DAY)).toHaveLength(0);
    expect(waitingQuotations(db, NOW + DAY)).toHaveLength(0);
    expect(bookIsUntouched(db)).toBe(false);
  });

  it("counts an enquiry that was marked junk, because somebody was here", () => {
    // Triage is about the enquiry, not about the shop. A person who has sorted
    // one piece of spam has still met the product.
    const id = addEnquiry(db, { channel: "email", receivedAt: NOW, rawText: "SEO services??" });
    triageEnquiry(db, id, "junk");
    expect(openEnquiries(db, NOW)).toHaveLength(0);
    expect(bookIsUntouched(db)).toBe(false);
  });
});

describe("saying an enquiry is not work", () => {
  it("takes it off the list without deleting the words", () => {
    // A shop that marked something junk by mistake has to be able to see what it
    // was. Junk is a claim about whether anybody owes it a price, not an erasure.
    const id = addEnquiry(db, { channel: "email", receivedAt: NOW, rawText: "SEO services??" });
    triageEnquiry(db, id, "junk");

    expect(openEnquiries(db, NOW)).toHaveLength(0);
    expect(readDeal(db, id)?.rawText).toBe("SEO services??");
    expect(readDeal(db, id)?.triage).toBe("junk");
  });

  it("puts it back", () => {
    const id = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: "500 cards" });
    triageEnquiry(db, id, "junk");
    triageEnquiry(db, id, "real");

    expect(openEnquiries(db, NOW)).toHaveLength(1);
    expect(readDeal(db, id)?.triage).toBe("real");
  });

  it("says nothing happened when the enquiry is not there", () => {
    expect(triageEnquiry(db, "no-such-enquiry", "junk")).toBe(false);
  });
});

describe("quoting something that was called junk", () => {
  it("puts it back, because pricing work says it is work", () => {
    // Otherwise the deal is marked "not a real enquiry" and sitting on Today
    // waiting for the customer's answer at the same time: waitingQuotations
    // asks about the quotation, not about the triage.
    const id = addEnquiry(db, { channel: "indiamart", receivedAt: NOW, rawText: "1000 letterheads" });
    triageEnquiry(db, id, "junk");
    expect(readDeal(db, id)?.triage).toBe("junk");

    const quotation = draftQuotation(db, id);

    expect(readDeal(db, id)?.triage).toBe("real");
    expect(openEnquiries(db, NOW)).toHaveLength(1);
    expect(quotationTotalPaise(db, quotation)).toBe(0);
  });

  it("leaves an unsorted enquiry unsorted", () => {
    // Only `junk` is a claim this contradicts. `unsorted` means nobody has
    // looked, and drafting against it is not somebody saying they have.
    const id = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "200 flyers" });
    draftQuotation(db, id);
    expect(readDeal(db, id)?.triage).toBe("unsorted");
  });
});

describe("the list of every deal", () => {
  it("is empty on an empty book", () => {
    expect(deals(db).deals).toHaveLength(0);
  });

  it("shows an enquiry with nothing priced against it as having no total", () => {
    // "₹0" would state a price the shop never offered. No quotation and a
    // quotation of nothing are different facts.
    addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: "500 cards" });
    const [only] = deals(db).deals;
    expect(only?.state).toBeNull();
    expect(only?.totalPaise).toBeNull();
  });

  it("carries the total, tax included, once there are lines", () => {
    const id = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: "500 cards" });
    const quotation = draftQuotation(db, id, { gstRateBp: 1800 });
    addQuotationItem(db, quotation, { description: "500 cards", quantity: 500, unitPricePaise: 200 });
    const [only] = deals(db).deals;
    expect(only?.state).toBe("draft");
    expect(only?.totalPaise).toBe(100_000 + 18_000);
  });

  it("shows a deal quoted twice exactly once", () => {
    // A list whose job is to be countable cannot count one job as two.
    const id = addEnquiry(db, { channel: "email", receivedAt: NOW, rawText: "1000 flyers" });
    draftQuotation(db, id);
    draftQuotation(db, id);
    expect(deals(db).deals).toHaveLength(1);
  });

  it("keeps junk visible here, having taken it off Today", () => {
    // Otherwise "nothing is deleted" is a technicality: there would be no screen
    // in the product where a dismissed enquiry could be found again.
    const id = addEnquiry(db, { channel: "email", receivedAt: NOW, rawText: "SEO services??" });
    triageEnquiry(db, id, "junk");
    expect(openEnquiries(db, NOW)).toHaveLength(0);
    expect(deals(db).deals).toHaveLength(1);
    expect(deals(db).deals[0]?.triage).toBe("junk");
  });

  it("carries how it ended and why, in the owner's own words", () => {
    const id = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "200 flyers" });
    const quotation = draftQuotation(db, id);
    addQuotationItem(db, quotation, { description: "200 flyers", quantity: 200, unitPricePaise: 400 });
    sendQuotation(db, quotation, NOW);
    closeQuotation(db, quotation, "lost", "went with Verma down the road", NOW + DAY);

    const [only] = deals(db).deals;
    expect(only?.state).toBe("lost");
    expect(only?.closedReason).toBe("went with Verma down the road");
    expect(only?.closedAt).toBe(NOW + DAY);
  });

  it("puts the newest first, and breaks a tie without flapping", () => {
    const first = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "a" });
    const second = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "b" });
    // Same millisecond: rowid decides, and decides the same way every read.
    expect(deals(db).deals.map((deal) => deal.enquiryId)).toEqual([second, first]);
  });
});

describe("recognising which job a line is", () => {
  it("skips the greeting on its own line, because 'hi' describes nothing", () => {
    expect(recogniseBy("hi bhai\n\n500 visiting cards chahiye")).toBe(
      "hi bhai 500 visiting cards chahiye"
    );
  });

  it("cuts on a word rather than mid-syllable", () => {
    const long = `${"visiting cards ".repeat(12)}urgent`;
    const said = recogniseBy(long);
    const kept = said.slice(0, -1);

    expect(said.endsWith("…")).toBe(true);
    expect(said.length).toBeLessThanOrEqual(91);
    // What was kept is the start of the message, and what follows it there is a
    // space — so the last word shown is a whole one.
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(" ");
  });

  it("cuts mid-word rather than showing almost nothing", () => {
    // One very long token, so there is no word boundary to cut on after the
    // fortieth character. Forty characters of a filename beats four.
    const said = recogniseBy("x".repeat(200));
    expect(said).toBe(`${"x".repeat(90)}…`);
  });

  it("leaves a short message exactly as it reads", () => {
    expect(recogniseBy("500 cards")).toBe("500 cards");
  });
});

describe("a customer who comes back", () => {
  it("puts a re-quote back on Today rather than losing it between two lists", () => {
    // Found by the Gemini critic seat. `openEnquiries` hid any enquiry that had
    // ever carried a non-draft quotation, and `waitingQuotations` only shows
    // what has been sent — so a fresh draft against a job quoted and lost last
    // month appeared on neither list. The work existed and no screen said so.
    const id = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: "500 cards" });
    const first = draftQuotation(db, id);
    addQuotationItem(db, first, { description: "500 cards", quantity: 500, unitPricePaise: 200 });
    sendQuotation(db, first, NOW);
    closeQuotation(db, first, "lost", "too costly", NOW + DAY);

    // Closed and finished: nothing is waiting.
    expect(openEnquiries(db, NOW + DAY)).toHaveLength(0);
    expect(waitingQuotations(db, NOW + DAY)).toHaveLength(0);

    // They come back a month later and the owner starts a new quotation.
    draftQuotation(db, id);

    expect(openEnquiries(db, NOW + 30 * DAY)).toHaveLength(1);
    expect(waitingQuotations(db, NOW + 30 * DAY)).toHaveLength(0);
  });

  it("takes it off again once the new quotation is sent", () => {
    const id = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: "500 cards" });
    const first = draftQuotation(db, id);
    addQuotationItem(db, first, { description: "500 cards", quantity: 500, unitPricePaise: 200 });
    sendQuotation(db, first, NOW);
    closeQuotation(db, first, "lost", null, NOW + DAY);

    const second = draftQuotation(db, id);
    addQuotationItem(db, second, { description: "500 cards", quantity: 500, unitPricePaise: 180 });
    sendQuotation(db, second, NOW + 30 * DAY);

    expect(openEnquiries(db, NOW + 31 * DAY)).toHaveLength(0);
    expect(waitingQuotations(db, NOW + 31 * DAY)).toHaveLength(1);
  });
});

describe("sending a quotation that is not there", () => {
  it("says it did not send it, rather than that it has no lines", () => {
    // Counting the lines of a quotation that does not exist returns zero, so
    // the caller was told the wrong thing about a different problem — and it
    // contradicted this function's own documented answer.
    expect(sendQuotation(db, "no-such-quotation")).toBe(false);
  });

  it("still refuses to send a real quotation with nothing on it", () => {
    const id = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "flyers" });
    const quotation = draftQuotation(db, id);
    expect(() => sendQuotation(db, quotation, NOW)).toThrow(/no lines/u);
  });
});

/** Read straight from the row: no exported reader exists and none is needed. */
function phoneOf(partyId: string): string | null {
  const row = db.prepare("SELECT phone FROM party WHERE id = ?").get(partyId) as
    | Record<string, unknown>
    | undefined;
  return row?.["phone"] === null || row === undefined ? null : String(row["phone"]);
}

describe("the customer's number", () => {
  it("is stored exactly as the owner typed it", () => {
    // Normalising on the way in means the book holds a number nobody wrote.
    // The handoff normalises when it needs a wa.me address and nowhere earlier.
    const id = findOrAddParty(db, "Verma Textiles", "+91 98765 43210");
    expect(phoneOf(id)).toBe("+91 98765 43210");
  });

  it("fills in a blank one, and never overwrites one already on file", () => {
    // A customer who writes in from a different phone this time must not have
    // the number the shop has always used replaced — silently, on a screen that
    // was about an enquiry and said nothing about contacts.
    const id = findOrAddParty(db, "Verma Textiles", null);
    expect(phoneOf(id)).toBeNull();

    expect(findOrAddParty(db, "Verma Textiles", "98765 43210")).toBe(id);
    expect(phoneOf(id)).toBe("98765 43210");

    expect(findOrAddParty(db, "verma textiles", "99999 00000")).toBe(id);
    expect(phoneOf(id)).toBe("98765 43210");
  });

  it("reaches the deal room, which is the only screen that can act on it", () => {
    const party = findOrAddParty(db, "Verma Textiles", "98765 43210");
    const id = addEnquiry(db, {
      channel: "whatsapp",
      receivedAt: NOW,
      rawText: "500 cards",
      partyId: party
    });
    expect(readDeal(db, id)?.partyPhone).toBe("98765 43210");
  });

  it("is null on a deal with no customer named at all", () => {
    const id = addEnquiry(db, { channel: "walk_in", receivedAt: NOW, rawText: "100 prints" });
    expect(readDeal(db, id)?.partyPhone).toBeNull();
  });
});

describe("a price typed wrong", () => {
  it("comes off again, and the total follows", () => {
    // The reason this verb exists: pricing is the step most likely to be got
    // wrong, and it could only be got wrong once. ₹450 where ₹45 was meant was
    // on the quotation for good.
    const id = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: "500 cards" });
    const quotation = draftQuotation(db, id);
    const wrong = addQuotationItem(db, quotation, {
      description: "500 visiting cards",
      quantity: 500,
      unitPricePaise: 45_000
    });
    expect(quotationTotalPaise(db, quotation)).toBe(22_500_000);

    expect(removeQuotationItem(db, quotation, wrong)).toBe(true);
    expect(quotationTotalPaise(db, quotation)).toBe(0);

    addQuotationItem(db, quotation, {
      description: "500 visiting cards",
      quantity: 500,
      unitPricePaise: 4_500
    });
    expect(quotationTotalPaise(db, quotation)).toBe(2_250_000);
  });

  it("does not renumber the lines that stay", () => {
    // A line that silently changes place under the owner is a different kind of
    // wrong from a price, and harder to notice.
    const id = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "three things" });
    const quotation = draftQuotation(db, id);
    const first = addQuotationItem(db, quotation, { description: "A", quantity: 1, unitPricePaise: 100 });
    const second = addQuotationItem(db, quotation, { description: "B", quantity: 1, unitPricePaise: 200 });
    addQuotationItem(db, quotation, { description: "C", quantity: 1, unitPricePaise: 300 });

    removeQuotationItem(db, quotation, second);
    const after = readDeal(db, id)?.quotation?.lines ?? [];

    expect(after.map((line) => line.description)).toEqual(["A", "C"]);
    expect(after[0]?.id).toBe(first);
    // And a new line still goes on the end rather than into the gap.
    addQuotationItem(db, quotation, { description: "D", quantity: 1, unitPricePaise: 400 });
    expect((readDeal(db, id)?.quotation?.lines ?? []).map((l) => l.description)).toEqual(["A", "C", "D"]);
  });

  it("refuses once the customer is holding it", () => {
    // The same rule addQuotationItem has. Quietly changing what the shop is on
    // record as having offered is worse than the mistake it would fix.
    const id = addEnquiry(db, { channel: "email", receivedAt: NOW, rawText: "letterheads" });
    const quotation = draftQuotation(db, id);
    const line = addQuotationItem(db, quotation, { description: "A", quantity: 1, unitPricePaise: 100 });
    sendQuotation(db, quotation, NOW);

    expect(() => removeQuotationItem(db, quotation, line)).toThrow(/only a draft/u);
    expect(quotationTotalPaise(db, quotation)).toBe(100);
  });

  it("will not take a line off a quotation it does not belong to", () => {
    const a = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "a" });
    const b = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "b" });
    const qa = draftQuotation(db, a);
    const qb = draftQuotation(db, b);
    const line = addQuotationItem(db, qa, { description: "A", quantity: 1, unitPricePaise: 100 });

    expect(removeQuotationItem(db, qb, line)).toBe(false);
    expect(quotationTotalPaise(db, qa)).toBe(100);
  });
});

describe("saying who an enquiry is from, afterwards", () => {
  it("is how a number learned on the phone gets written down", () => {
    // The hole this closes: intake makes both fields optional because an
    // enquiry almost always arrives before anybody has asked for a number — and
    // there was then no way to add it, so the handoff could only be used on the
    // enquiries least likely to need it.
    const id = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: "500 cards" });
    expect(readDeal(db, id)?.partyName).toBeNull();

    expect(setDealCustomer(db, id, { name: "Verma Textiles", phone: "98765 43210" })).toBe(true);

    expect(readDeal(db, id)?.partyName).toBe("Verma Textiles");
    expect(readDeal(db, id)?.partyPhone).toBe("98765 43210");
  });

  it("attaches to the customer the shop already has, rather than making a second", () => {
    const known = findOrAddParty(db, "Verma Textiles", "98765 43210");
    const id = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "200 flyers" });
    setDealCustomer(db, id, { name: "verma textiles", phone: "98765 43210" });

    const row = db.prepare("SELECT party_id AS id FROM enquiry WHERE id = ?").get(id) as
      Record<string, unknown>;
    expect(String(row["id"])).toBe(known);
    expect(db.prepare("SELECT COUNT(*) AS n FROM party").get()).toEqual({ n: 1 });
  });

  it("overwrites, because the owner is looking at the field they typed in", () => {
    // findOrAddParty fills a blank and never replaces — it runs during intake,
    // where nobody asked to be editing contacts. This is the opposite case.
    const id = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "flyers" });
    setDealCustomer(db, id, { name: "Verma Textiles", phone: "98765 43210" });
    setDealCustomer(db, id, { name: "Verma Textiles", phone: "99999 00000" });
    expect(readDeal(db, id)?.partyPhone).toBe("99999 00000");
  });

  it("clears the number when the owner empties the box", () => {
    // An empty field in front of somebody who is editing means "I do not have
    // this", not "keep whatever was there".
    const id = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "flyers" });
    setDealCustomer(db, id, { name: "Verma Textiles", phone: "98765 43210" });
    setDealCustomer(db, id, { name: "Verma Textiles", phone: null });
    expect(readDeal(db, id)?.partyPhone).toBeNull();
  });

  it("refuses a customer with no name", () => {
    const id = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "flyers" });
    expect(() => setDealCustomer(db, id, { name: "   ", phone: "98765 43210" })).toThrow(/needs a name/u);
  });

  it("says nothing happened when the enquiry is not there", () => {
    expect(setDealCustomer(db, "no-such-enquiry", { name: "Verma", phone: null })).toBe(false);
  });
});

describe("a list that has to stop somewhere", () => {
  it("says nothing is missing when nothing is", () => {
    addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "a" });
    expect(deals(db).more).toBe(false);
  });

  it("says so when it is leaving older ones out", () => {
    // A list that quietly stops is a list that lies, and a shop quoting eight
    // jobs a day passes the ceiling inside the month it is being judged over.
    for (let n = 0; n < 5; n += 1) {
      addEnquiry(db, { channel: "phone", receivedAt: NOW - n * 1000, rawText: `job ${n}` });
    }
    const page = deals(db, 3);
    expect(page.deals).toHaveLength(3);
    expect(page.more).toBe(true);
  });

  it("does not claim there are more when the count lands exactly on the limit", () => {
    // The off-by-one that makes the notice cry wolf for ever: it reads one row
    // past the limit rather than counting the table, so exactly-full is full.
    for (let n = 0; n < 3; n += 1) {
      addEnquiry(db, { channel: "phone", receivedAt: NOW - n * 1000, rawText: `job ${n}` });
    }
    const page = deals(db, 3);
    expect(page.deals).toHaveLength(3);
    expect(page.more).toBe(false);
  });
});

describe("a draft nobody has priced yet", () => {
  it("shows no total rather than a price the shop never offered", () => {
    // Caught by looking at the shipped app: a walk-in job drafted and left sat
    // in the list reading "₹0.00". The guard asked whether a quotation existed
    // when the question is whether anything has been priced.
    const id = addEnquiry(db, { channel: "walk_in", receivedAt: NOW, rawText: "100 photo prints" });
    draftQuotation(db, id);

    const [only] = deals(db).deals;
    expect(only?.state).toBe("draft");
    expect(only?.totalPaise).toBeNull();
  });

  it("has a total the moment it has a line", () => {
    const id = addEnquiry(db, { channel: "walk_in", receivedAt: NOW, rawText: "100 photo prints" });
    const quotation = draftQuotation(db, id);
    addQuotationItem(db, quotation, { description: "100 4x6 glossy", quantity: 100, unitPricePaise: 800 });

    expect(deals(db).deals[0]?.totalPaise).toBe(80_000);
  });

  it("shows no total again if every line is taken back off", () => {
    const id = addEnquiry(db, { channel: "walk_in", receivedAt: NOW, rawText: "100 photo prints" });
    const quotation = draftQuotation(db, id);
    const line = addQuotationItem(db, quotation, {
      description: "100 4x6 glossy",
      quantity: 100,
      unitPricePaise: 800
    });
    removeQuotationItem(db, quotation, line);

    expect(deals(db).deals[0]?.totalPaise).toBeNull();
  });
});

describe("naming a customer after the quotation was drafted", () => {
  it("reaches Today, which asks the question from the quotation's side", () => {
    // The commonest order of events: the enquiry arrives from a number nobody
    // recognises, a price goes out, and the name is learned on the call after.
    // `waitingQuotations` joins the party through quotation.party_id, so
    // naming only the enquiry left Today saying "Somebody has had the quote for
    // 9 days" about a customer the owner had just written down.
    const id = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: "500 cards" });
    const quotation = draftQuotation(db, id);
    addQuotationItem(db, quotation, { description: "500 cards", quantity: 500, unitPricePaise: 200 });
    sendQuotation(db, quotation, NOW);

    expect(waitingQuotations(db, NOW + 9 * DAY)[0]?.partyName).toBeNull();

    setDealCustomer(db, id, { name: "Verma Textiles", phone: "98765 43210" });

    expect(waitingQuotations(db, NOW + 9 * DAY)[0]?.partyName).toBe("Verma Textiles");
    expect(deals(db).deals[0]?.partyName).toBe("Verma Textiles");
    expect(readDeal(db, id)?.partyName).toBe("Verma Textiles");
  });
});

describe("two columns that hold a party", () => {
  it("names the customer on every screen, not only the one that was told", () => {
    // `openEnquiries` and `deals` read the enquiry's party; `waitingQuotations`
    // reads the quotation's. A caller naming one and not the other produced a
    // deal with a customer on one screen and nobody on the others.
    const party = findOrAddParty(db, "Verma Textiles", "98765 43210");
    const id = addEnquiry(db, { channel: "indiamart", receivedAt: NOW, rawText: "1000 flyers" });
    const quotation = draftQuotation(db, id, { partyId: party });
    addQuotationItem(db, quotation, { description: "1000 flyers", quantity: 1000, unitPricePaise: 300 });
    sendQuotation(db, quotation, NOW);

    expect(deals(db).deals[0]?.partyName).toBe("Verma Textiles");
    expect(waitingQuotations(db, NOW + DAY)[0]?.partyName).toBe("Verma Textiles");
    expect(readDeal(db, id)?.partyName).toBe("Verma Textiles");
  });

  it("does not overwrite a customer the enquiry already had", () => {
    const arrived = findOrAddParty(db, "Verma Textiles", null);
    const other = findOrAddParty(db, "Gupta Sweets", null);
    const id = addEnquiry(db, {
      channel: "phone",
      receivedAt: NOW,
      rawText: "flyers",
      partyId: arrived
    });
    draftQuotation(db, id, { partyId: other });
    expect(readDeal(db, id)?.partyName).toBe("Verma Textiles");
  });
});

describe("a reference that is only whitespace", () => {
  it("is not a reference, so two enquiries do not become one", () => {
    // A feed whose id field is sometimes blank would otherwise dedupe every one
    // of its enquiries onto the first, and the second customer never appears.
    const first = addEnquiry(db, {
      channel: "indiamart", receivedAt: NOW, rawText: "1000 letterheads", externalRef: ""
    });
    const second = addEnquiry(db, {
      channel: "indiamart", receivedAt: NOW + 1000, rawText: "500 visiting cards", externalRef: "  "
    });

    expect(second).not.toBe(first);
    expect(openEnquiries(db, NOW + DAY)).toHaveLength(2);
  });
});

describe("sending something that cannot be sent", () => {
  it("says so, rather than complaining about its lines", () => {
    // An unpriced draft closed as lost. The line count was checked before the
    // state, so the caller was told "it has no lines" about a quotation whose
    // actual problem is that it is finished.
    const id = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "flyers" });
    const quotation = draftQuotation(db, id);
    closeQuotation(db, quotation, "lost", "changed their mind", NOW);

    expect(sendQuotation(db, quotation, NOW)).toBe(false);
  });

  it("still refuses a draft with nothing on it", () => {
    const id = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "flyers" });
    const quotation = draftQuotation(db, id);
    expect(() => sendQuotation(db, quotation, NOW)).toThrow(/no lines/u);
  });
});

describe("what this shop charged before", () => {
  function quoted(who: string, description: string, quantity: number, paise: number, at: number): string {
    const party = findOrAddParty(db, who, null);
    const enquiry = addEnquiry(db, { channel: "phone", receivedAt: at, rawText: description, partyId: party });
    const quotation = draftQuotation(db, enquiry, { partyId: party });
    addQuotationItem(db, quotation, { description, quantity, unitPricePaise: paise });
    sendQuotation(db, quotation, at);
    return quotation;
  }

  it("recalls the rate with everything needed to judge whether it applies", () => {
    // The same job at a different quantity is a different price, so the figure
    // alone is not an answer — the quantity, the date and the customer are what
    // make it one.
    quoted("Verma Textiles", "500 visiting cards, 300 gsm matte", 500, 450, NOW - 12 * DAY);

    const [past] = pastLines(db, "visiting cards");
    expect(past?.unitPricePaise).toBe(450);
    expect(past?.quantity).toBe(500);
    expect(past?.partyName).toBe("Verma Textiles");
    expect(past?.at).toBe(NOW - 12 * DAY);
  });

  it("puts the most recent first, because a rate from last year is a warning", () => {
    quoted("A", "500 visiting cards", 500, 400, NOW - 90 * DAY);
    quoted("B", "500 visiting cards", 500, 480, NOW - 5 * DAY);

    expect(pastLines(db, "visiting cards").map((line) => line.unitPricePaise)).toEqual([480, 400]);
  });

  it("does not recall a draft, which is a price nobody stood behind", () => {
    const party = findOrAddParty(db, "Verma Textiles", null);
    const enquiry = addEnquiry(db, { channel: "phone", receivedAt: NOW, rawText: "cards" });
    const quotation = draftQuotation(db, enquiry, { partyId: party });
    addQuotationItem(db, quotation, {
      description: "500 visiting cards",
      quantity: 500,
      unitPricePaise: 9999
    });

    expect(pastLines(db, "visiting cards")).toHaveLength(0);
  });

  it("recalls one that was quoted and lost, because the price was still offered", () => {
    const quotation = quoted("A", "500 visiting cards", 500, 400, NOW - 5 * DAY);
    closeQuotation(db, quotation, "lost", "too costly", NOW);
    expect(pastLines(db, "visiting cards")).toHaveLength(1);
  });

  it("is not case-sensitive, because nobody typing quickly is", () => {
    quoted("A", "500 Visiting Cards", 500, 400, NOW - 5 * DAY);
    expect(pastLines(db, "VISITING")).toHaveLength(1);
    expect(pastLines(db, "visiting")).toHaveLength(1);
  });

  it("treats % and _ as characters, not as a search that matches everything", () => {
    // Descriptions are the customer's words: "100% cotton" and "A4_final" turn
    // up, and an unescaped one would match most of the book.
    quoted("A", "500 visiting cards", 500, 400, NOW - 5 * DAY);
    quoted("B", "200 bags, 100% cotton", 200, 9000, NOW - 4 * DAY);

    expect(pastLines(db, "100%")).toHaveLength(1);
    expect(pastLines(db, "%")).toHaveLength(0);
    expect(pastLines(db, "___")).toHaveLength(0);
  });

  it("says nothing at all for two characters", () => {
    quoted("A", "500 visiting cards", 500, 400, NOW - 5 * DAY);
    expect(pastLines(db, "ca")).toHaveLength(0);
    expect(pastLines(db, "   ")).toHaveLength(0);
  });
});
