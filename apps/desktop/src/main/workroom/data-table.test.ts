/** A checked business figure must survive messy records without guessing money. */
import { describe, expect, it } from "vitest";
import type { CaseDataQuery } from "@cadrane/contracts";
import { calculateDataReview, parseDataTable } from "./data-table.js";
const query: CaseDataQuery = { id: "room", sourceTurnId: "00000000-0000-4000-8000-000000000001", operation: "total", valueColumn: 2, groupColumn: 0, unit: "INR", filter: { column: 1, equals: "Open" } };

describe("CSV records and exact calculations", () => {
  it("preserves quoted separators, escaped quotes, multiline cells and Hindi", () => {
    const table = parseDataTable('\uFEFFName,Note,Amount\r\n"A, B","पहली लाइन\nsecond ""line""",12.50\r\n');
    expect(table.columns).toEqual(["Name", "Note", "Amount"]);
    expect(table.rows).toEqual([["A, B", 'पहली लाइन\nsecond "line"', "12.50"]]);
  });
  it.each([
    ['A,A\n1,2', "different name"], ['A,B\n1', "Data row 1"],
    ['A,B\n"bad,2', "quoted cell"], ['A,B\n"x"no,2', "misplaced quote"],
    [',B\n1,2', "every CSV column"], ['A,B\n', "no data rows"]
  ])("refuses a malformed table: %s", (text, reason) => {
    expect(() => parseDataTable(text)).toThrow(reason);
  });
  it("uses paise, reports missing values and retains exact filtered row lineage", () => {
    const result = calculateDataReview(parseDataTable('Customer,Status,Amount\nA,Open,0.10\nA,Open,0.20\nB,Closed,999.00\nB,Open,\nA,Open,-0.05'), query);
    expect(result.total).toBe("0.25");
    expect(result.sourceRows).toBe(5);
    expect(result.matchedRows).toBe(4);
    expect(result.blankValues).toBe(1);
    expect(result.groups).toEqual([
      { label: "A", count: 3, total: "0.25", rowNumbers: [1, 2, 5] },
      { label: "B", count: 1, total: null, rowNumbers: [4] }
    ]);
    expect(result.previewRows.map(row => row.row)).toEqual([1, 2, 4, 5]);
  });
  it("keeps large totals exact and accepts Indian and international digit groups", () => {
    const table = parseDataTable('Customer,Status,Amount\nA,Open,"₹1,23,456.78"\nA,Open,"1,234,567.89"\nB,Open,999999999999999.99');
    expect(calculateDataReview(table, query).total).toBe("1000000001358024.66");
  });
  it.each(["12,34", "USD 10", "=SUM(A1:A2)", "1e4", "1.001", "not known"])("refuses invalid rupee input %s instead of treating it as zero", value => {
    const table = parseDataTable(`Customer,Status,Amount\nA,Open,"${value}"`);
    expect(() => calculateDataReview(table, query)).toThrow(/Data row 1/u);
  });
  it("counts inert formula cells without executing or parsing them as amounts", () => {
    const table = parseDataTable('Customer,Status,Amount\nA,Open,=1+2');
    expect(table.rows[0]?.[2]).toBe("=1+2");
    expect(calculateDataReview(table, { ...query, operation: "count" }).matchedRows).toBe(1);
  });
  it("reports no matches and does not infer business state from a near-match", () => {
    const table = parseDataTable("Customer,Status,Amount\nA,open,10.00");
    const result = calculateDataReview(table, query);
    expect(result.matchedRows).toBe(0);
    expect(result.groups).toEqual([]);
    expect(result.total).toBe("0.00");
  });
  it("retains exact general decimals, refuses absent columns and limits group growth", () => {
    const table = parseDataTable("Customer,Status,Amount\nA,Open,1.000001\nB,Open,0.000009");
    expect(calculateDataReview(table, { ...query, unit: "number" }).total).toBe("1.00001");
    expect(() => calculateDataReview(table, { ...query, valueColumn: 3 })).toThrow("column");
    const many = parseDataTable("Customer,Status,Amount\n" + Array.from({ length: 26 }, (_, index) => `${index},Open,1`).join("\n"));
    expect(() => calculateDataReview(many, query)).toThrow("25 groups");
  });
});
