/**
 * Handing Tally a voucher.
 *
 * The failure mode this guards is remote and silent: a malformed file fails at
 * the accountant's desk, days later, as "import failed" with no line number.
 * Nobody can debug that from here, so it has to be right when it leaves.
 */

import { describe, expect, it } from "vitest";
import { tallyDate, tallyXml, voucherXml, xml, type TallyVoucher } from "./tally.js";

const ON = new Date("2026-09-02T12:00:00");

const voucher = (over: Partial<TallyVoucher> = {}): TallyVoucher => ({
  party: "Devgiri Traders",
  number: "VS/2026/0418",
  on: ON,
  subtotalPaise: 1_914_000,
  taxPaise: 344_520,
  totalPaise: 2_258_520,
  taxKind: "cgst-sgst",
  ...over
});

/** Every AMOUNT in the document, as a number. */
const amounts = (document: string): number[] =>
  [...document.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/gu)].map((match) => Number(match[1]));

describe("a voucher Tally will accept", () => {
  it("balances to zero, which is the thing Tally checks", () => {
    // A voucher whose lines do not sum to zero is rejected outright, and the
    // rejection arrives at somebody else's desk.
    const total = amounts(voucherXml(voucher())).reduce((sum, value) => sum + value, 0);

    expect(Math.abs(total)).toBeLessThan(0.005);
  });

  it("splits tax in halves that add back to the whole", () => {
    // Halving an odd number of paise twice loses one, and one paise is enough
    // for Tally to refuse the voucher.
    const odd = voucherXml(voucher({ taxPaise: 344_521, totalPaise: 2_258_521 }));
    const [, , cgst, sgst] = amounts(odd);

    expect(Math.round(((cgst ?? 0) + (sgst ?? 0)) * 100)).toBe(344_521);
  });

  it("writes one integrated tax line when the states differ", () => {
    const across = voucherXml(voucher({ taxKind: "igst" }));

    expect(across).toContain("<LEDGERNAME>IGST</LEDGERNAME>");
    expect(across).not.toContain("CGST");
  });

  it("writes no tax line at all when there is no tax", () => {
    const untaxed = voucherXml(
      voucher({ taxPaise: 0, subtotalPaise: 1_000_000, totalPaise: 1_000_000 })
    );

    expect(untaxed).not.toContain("CGST");
    expect(untaxed).not.toContain("IGST");
    expect(amounts(untaxed).reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it("posts integrated tax when the states are unknown", () => {
    // Guessing "split" would put CGST and SGST on an interstate sale, which is
    // what a return gets rejected for. IGST on a same-state sale is visible and
    // correctable; the other way round is not.
    const unsure = voucherXml(voucher({ taxKind: "unknown" }));

    expect(unsure).toContain("IGST");
    expect(unsure).not.toContain("CGST");
  });

  it("writes a zero total as 0.00 rather than -0.00", () => {
    const nothing = voucherXml(
      voucher({ subtotalPaise: 0, taxPaise: 0, totalPaise: 0 })
    );

    expect(nothing).not.toContain("-0.00");
    expect(nothing).not.toContain("--");
  });

  it("uses the date format Tally wants and no other", () => {
    expect(tallyDate(ON)).toBe("20260902");
  });
});

describe("a customer whose name has punctuation in it", () => {
  it("does not produce a document Tally refuses to parse", () => {
    // "Sharma & Sons" is an ordinary trading name and a broken XML document.
    const document = voucherXml(voucher({ party: "Sharma & Sons <Steel>" }));

    expect(document).toContain("Sharma &amp; Sons &lt;Steel&gt;");
    expect(document).not.toMatch(/<LEDGERNAME>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/u);
  });

  it("escapes every character that would break the file", () => {
    expect(xml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &apos;");
  });
});

describe("the file as a whole", () => {
  it("asks Tally to import vouchers and nothing else", () => {
    // "Vouchers" rather than "All Masters": this posts transactions and creates
    // no ledgers. Silently inventing a ledger in somebody's accounts is not a
    // thing this product should be able to do.
    const file = tallyXml([voucher()]);

    expect(file).toContain("<REPORTNAME>Vouchers</REPORTNAME>");
    expect(file).not.toContain("All Masters");
    expect(file.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("wraps each voucher in a TALLYMESSAGE, without which Tally ignores it", () => {
    // Not decoration: Tally silently ignores VOUCHER elements placed directly
    // under REQUESTDATA. A file without this imports nothing and reports no
    // error, at somebody else's desk.
    const file = tallyXml([voucher()]);

    expect(file).toContain('<TALLYMESSAGE xmlns:UDF="TallyUDF">');
    expect(file.indexOf("<TALLYMESSAGE")).toBeLessThan(file.indexOf("<VOUCHER "));
  });

  it("carries every voucher it was given", () => {
    const file = tallyXml([voucher(), voucher({ number: "VS/2026/0419" })]);

    expect([...file.matchAll(/<VOUCHER /gu)]).toHaveLength(2);
  });
});
