import { describe, expect, it, vi } from "vitest";
import { dayOf, disagrees, extractBill, extractPrompt, paiseOf } from "./extract.js";
import type { EngineRoomStatus } from "@cadrane/contracts";

const room = (ready = true): EngineRoomStatus => ({
  engines: [
    {
      id: "claude",
      label: "Claude",
      access: "subscription",
      accessLabel: "Your subscription",
      state: ready ? "ready" : "not-installed",
      summary: "s",
      fixHint: null,
      evidence: null,
      models: [
        { id: "haiku", label: "Haiku", tier: "fast", tierLabel: "Quick", note: "n", includedInSubscription: true },
        { id: "opus", label: "Opus", tier: "frontier", tierLabel: "Frontier", note: "n", includedInSubscription: true }
      ]
    }
  ],
  active: null,
  checkedAt: "2026-09-02T00:00:00.000Z",
  allUnavailable: !ready
});

type Ask = NonNullable<Parameters<typeof extractBill>[2]>;
const replying = (text: string): Ask => vi.fn<Ask>(async () => text);

const GOOD = JSON.stringify({
  partyName: { value: "Devgiri Traders", from: "M/s Devgiri Traders" },
  number: { value: "A-114", from: "Bill No. A-114" },
  issuedOn: { value: "2026-07-19", from: "19/07/2026" },
  dueOn: { value: null, from: null },
  subtotal: { value: "8,000.00", from: "Sub Total 8,000.00" },
  tax: { value: "1,440.00", from: "GST 18% 1,440.00" },
  total: { value: "₹9,440", from: "Grand Total ₹9,440" }
});

describe("money as it is actually written on a bill", () => {
  it("reads every form that turns up", () => {
    // A comma in the wrong place is a factor of ten, so these are normalised
    // here rather than trusted from the model.
    expect(paiseOf("₹9,440")).toBe(944_000);
    expect(paiseOf("Rs. 9440/-")).toBe(944_000);
    expect(paiseOf("9440.00")).toBe(944_000);
    expect(paiseOf("9,440")).toBe(944_000);
    // Indian lakh grouping is the same number as any other grouping.
    expect(paiseOf("1,23,456")).toBe(paiseOf("123456"));
  });

  it("treats a bare number as rupees, which is what a person would have typed", () => {
    expect(paiseOf(9440)).toBe(944_000);
  });

  it("refuses what is not an amount rather than guessing zero", () => {
    expect(paiseOf("about nine thousand")).toBeNull();
    expect(paiseOf(null)).toBeNull();
    expect(paiseOf({})).toBeNull();
  });
});

describe("dates on an Indian bill", () => {
  it("reads day-first, because that is what the paper means", () => {
    // `02/09/2026` here is the 2nd of September. Assuming American order would
    // move a due date by months, silently, and nobody notices until it is late.
    expect(dayOf("02/09/2026")).toBe("2026-09-02");
    expect(dayOf("2-9-26")).toBe("2026-09-02");
    expect(dayOf("2026-09-02")).toBe("2026-09-02");
  });

  it("returns null rather than a guess", () => {
    expect(dayOf("last Tuesday")).toBeNull();
    expect(dayOf(null)).toBeNull();
  });
});

describe("reading a pasted bill", () => {
  it("comes back with every figure and what it read it from", async () => {
    // `from` is how a person checks it. A value with no provenance is a number
    // somebody has to take on faith.
    const result = await extractBill("Bill No. A-114 …", room(), replying(GOOD));

    expect(result.ok).toBe(true);
    expect(result.bill?.partyName.value).toBe("Devgiri Traders");
    expect(result.bill?.totalPaise.value).toBe(944_000);
    expect(result.bill?.totalPaise.from).toBe("Grand Total ₹9,440");
  });

  it("says plainly that nothing is stored yet", async () => {
    const result = await extractBill("x", room(), replying(GOOD));

    expect(result.said).toContain("nothing is stored until you do");
  });

  it("uses the cheapest engine, not the best one", async () => {
    // Reading a bill is not frontier work, and a product that spends the best
    // model on data entry teaches its owner not to use it.
    const ask = vi.fn<Ask>(async () => GOOD);
    await extractBill("x", room(), ask);

    expect(ask.mock.calls[0]?.[0]?.modelId).toBe("haiku");
  });

  it("leaves a field null when the bill does not say", async () => {
    const result = await extractBill("x", room(), replying(GOOD));

    expect(result.bill?.dueOn.value).toBeNull();
  });
});

describe("the check that matters most", () => {
  it("notices when the parts do not add up to the total", async () => {
    // The realistic failure is not garbage — it is a *plausible* wrong number.
    // Subtotal plus tax against the total is the one arithmetic fact the paste
    // itself can prove, and the one a person skimming will not notice.
    const wrong = JSON.stringify({
      ...JSON.parse(GOOD),
      total: { value: "₹9,140", from: "Grand Total ₹9,140" }
    });

    const result = await extractBill("x", room(), replying(wrong));

    expect(result.disagreement).toContain("do not add up");
  });

  it("stays quiet when they agree", async () => {
    expect((await extractBill("x", room(), replying(GOOD))).disagreement).toBeNull();
  });

  it("does not complain when there is nothing to compare", () => {
    const nothing = {
      partyName: { value: null, from: null },
      number: { value: null, from: null },
      issuedOn: { value: null, from: null },
      dueOn: { value: null, from: null },
      subtotalPaise: { value: null, from: null },
      taxPaise: { value: null, from: null },
      totalPaise: { value: null, from: null }
    };

    expect(disagrees(nothing)).toBeNull();
  });
});

describe("when it cannot read one", () => {
  it("says so and never throws", async () => {
    expect((await extractBill("", room(), replying(GOOD))).said).toContain("Paste a bill first");
    expect((await extractBill("x".repeat(20_000), room(), replying(GOOD))).said).toContain(
      "longer than one bill"
    );
    expect((await extractBill("x", room(false), replying(GOOD))).said).toContain(
      "No engine is connected"
    );
    expect((await extractBill("x", room(), replying("sorry"))).said).toContain("Type it instead");
    await expect(
      extractBill("x", room(), vi.fn<Ask>(async () => { throw new Error("CLI died"); }))
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("what the model is asked for", () => {
  it("demands provenance for every field", () => {
    expect(extractPrompt("x")).toContain("the exact words you read it from");
    expect(extractPrompt("x")).toContain("Never guess");
  });
});

describe("a date that is not a date", () => {
  // Found by fuzzing, and both branches were wrong in the same way: they checked
  // the shape of a date and never whether the calendar has one.
  it("refuses the 31st of February even though it is shaped like a date", () => {
    // The silent failure this prevents: Date.parse("2026-02-31") does not throw,
    // it rolls forward to the 3rd of March. The due date moves by days and every
    // reading of what is late after it is quietly wrong.
    expect(dayOf("2026-02-31")).toBeNull();
    expect(dayOf("31/02/2026")).toBeNull();
  });

  it("refuses a month and a day that do not exist", () => {
    // Worse than rolling forward: "2026-13-45" parses to NaN, and a comparison
    // against NaN is false in both directions — so the bill is never late and
    // never not late. It stops appearing rather than appearing wrongly.
    expect(dayOf("2026-13-45")).toBeNull();
    expect(dayOf("2026-00-10")).toBeNull();
    expect(dayOf("45/13/2026")).toBeNull();
  });

  it("refuses a three-digit year rather than guessing a century", () => {
    // `1/1/100` used to return "100-01-01". Two digits is a century short and
    // can be repaired; three is unreadable, and a guess produces a confident
    // date nobody can trace back to the paper it came from.
    expect(dayOf("1/1/100")).toBeNull();
    expect(dayOf("1/1/999")).toBeNull();
  });

  it("refuses a year no bill was ever written in", () => {
    expect(dayOf("1200-01-01")).toBeNull();
    expect(dayOf("9999-01-01")).toBeNull();
  });

  it("still reads the dates that are actually on bills", () => {
    // The guard must not become a reason a real bill will not import.
    expect(dayOf("2026-08-26")).toBe("2026-08-26");
    expect(dayOf("02/09/2026")).toBe("2026-09-02");
    expect(dayOf("2/9/26")).toBe("2026-09-02");
    expect(dayOf("29-02-2024")).toBe("2024-02-29");
  });

  it("refuses the 29th of February in a year that has no leap day", () => {
    expect(dayOf("2026-02-29")).toBeNull();
    expect(dayOf("2024-02-29")).toBe("2024-02-29");
  });
});
