/**
 * Handing Tally a voucher, instead of asking anyone to leave Tally.
 *
 * ## Why this is the wedge and not a feature
 *
 * Every trader's accountant works in Tally. Products that try to replace it
 * lose on the first day — not to a better product, but to a CA who will not
 * reconcile by hand and says no. The research put it plainly: *"If you can't
 * export directly to Tally format, you lose on day one."*
 *
 * So Rellane does not compete for that job. It reads the bill off a photograph,
 * checks the figures with a person, and produces a voucher Tally imports. The
 * trader keeps their accountant, their CA keeps their software, and the retyping
 * — which is the whole tax — disappears.
 *
 * ## Why it is a template literal and not a library
 *
 * Tally's import format is XML in a shape it has published for years:
 * `ENVELOPE` → `HEADER` → `BODY` → `IMPORTDATA`. Generating it is string
 * building, and a dependency for that would add a parser, its transitive tree
 * and somebody else's release cadence to save writing forty lines that are
 * better read than trusted.
 *
 * ## What it will not do
 *
 * Post anything. This writes a file the owner hands to Tally, and Tally's own
 * import screen is what accepts it. There is no path here that reaches their
 * books directly, which is the same rule everything outbound follows (D-035) and
 * the reason a CA can be shown exactly what arrived before it lands.
 */

/**
 * Paise to rupees, for a format that wants a decimal.
 *
 * Written here rather than imported because `money.ts` deliberately exposes no
 * such function: everywhere else in this product an amount is integer paise and
 * a float is a bug. Tally's file format wants `22585.20`, so the conversion
 * happens once, at the boundary, where it can be seen.
 */
function amount(paise: number): string {
  // Negated rather than prefixed with a minus. Writing `-${amount(x)}` produced
  // `-0.00` for a zero total and `--10.00` for a credit note, and Tally rejects
  // both as unparseable numbers.
  return (paise / 100).toFixed(2);
}

/** What Tally calls the two sides of a sales voucher. */
export interface TallyVoucher {
  /** The customer. Tally matches on the ledger name, so it must be theirs. */
  readonly party: string;
  /** The bill number as it appears on the paper. */
  readonly number: string;
  /** Issue date. */
  readonly on: Date;
  readonly subtotalPaise: number;
  readonly taxPaise: number;
  readonly totalPaise: number;
  /** Split tax when both parties are in one state, integrated when not. */
  readonly taxKind: "cgst-sgst" | "igst" | "unknown";
  /** The sales ledger to post against. Tally requires one by name. */
  readonly salesLedger?: string;
}

/** Tally wants `YYYYMMDD` and nothing else. */
export function tallyDate(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
}

/**
 * XML-escapes a value.
 *
 * Applied to every interpolated field without exception. A customer called
 * `Sharma & Sons` is ordinary and would otherwise produce a document Tally
 * refuses to parse — and the failure arrives as "import failed" with no line
 * number, at the accountant's desk rather than here.
 */
export function xml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

/**
 * One sales voucher.
 *
 * Signs are Tally's own convention and they read backwards. On a sales voucher
 * the party ledger carries a **negative** amount with `ISDEEMEDPOSITIVE=Yes`,
 * and the sales and tax ledgers carry **positive** amounts with
 * `ISDEEMEDPOSITIVE=No`. A voucher whose lines do not sum to zero is rejected
 * outright, so this arithmetic is the thing to read twice.
 */
export function voucherXml(voucher: TallyVoucher): string {
  const ledger = voucher.salesLedger ?? "Sales";
  const half = Math.round(voucher.taxPaise / 2);
  // The split has to add back to the whole. Halving an odd number of paise
  // twice loses one, and one paise is enough for Tally to refuse the voucher.
  //
  // `unknown` is treated as integrated rather than split. When the two GSTINs
  // could not be checked, nobody knows which state either party is in — and
  // guessing "split" would post CGST and SGST on an interstate sale, which is
  // the error a return is rejected for. IGST on a same-state sale is visible
  // and correctable; the other way round is not.
  const taxLines =
    voucher.taxPaise === 0
      ? []
      : voucher.taxKind === "cgst-sgst"
        ? [
            { name: "CGST", paise: half },
            { name: "SGST", paise: voucher.taxPaise - half }
          ]
        : [{ name: "IGST", paise: voucher.taxPaise }];

  const entries = [
    `      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${xml(voucher.party)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <AMOUNT>${amount(-voucher.totalPaise)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`,
    `      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${xml(ledger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <AMOUNT>${amount(voucher.subtotalPaise)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`,
    ...taxLines.map(
      (line) => `      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${xml(line.name)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <AMOUNT>${amount(line.paise)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`
    )
  ];

  return `    <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">
      <DATE>${tallyDate(voucher.on)}</DATE>
      <EFFECTIVEDATE>${tallyDate(voucher.on)}</EFFECTIVEDATE>
      <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${xml(voucher.number)}</VOUCHERNUMBER>
      <PARTYLEDGERNAME>${xml(voucher.party)}</PARTYLEDGERNAME>
      <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
${entries.join("\n")}
    </VOUCHER>`;
}

/**
 * A whole import file.
 *
 * Each voucher sits inside its own `TALLYMESSAGE`. That wrapper is not
 * decoration: Tally's import engine **silently ignores** `VOUCHER` elements
 * placed directly under `REQUESTDATA`, so a file without it imports nothing and
 * reports no error — the worst possible failure for something that runs at
 * somebody else's desk.
 *
 * `Vouchers` rather than `All Masters`: this posts transactions and creates no
 * ledgers. A customer Tally has never heard of will be refused by name, which is
 * the right failure — silently inventing a ledger in somebody's accounts is not
 * a thing this product should be able to do.
 */
export function tallyXml(vouchers: readonly TallyVoucher[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
${vouchers
  .map(
    (voucher) => `      <TALLYMESSAGE xmlns:UDF="TallyUDF">
${voucherXml(voucher)}
      </TALLYMESSAGE>`
  )
  .join("\n")}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;
}
