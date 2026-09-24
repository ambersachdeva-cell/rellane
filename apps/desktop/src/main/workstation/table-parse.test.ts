import { describe, expect, it } from "vitest";
import {
  cellDate,
  cellNumber,
  detectDelimiter,
  parseTable,
} from "./table-parse.js";

describe("table-parse", () => {
  it("parses quoted fields containing the delimiter", () => {
    const csv = 'Name,Description,Price\nWidget,"High quality, durable, sleek",100';
    const table = parseTable(csv);
    expect(table.columns).toHaveLength(3);
    expect(table.columns[0]?.name).toBe("Name");
    expect(table.columns[1]?.name).toBe("Description");
    expect(table.columns[2]?.name).toBe("Price");
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.[1]).toBe("High quality, durable, sleek");
    expect(table.rows[0]?.[2]).toBe("100");
    expect(table.columns[1]?.type).toBe("text");
    expect(table.columns[2]?.type).toBe("number");
  });

  it("handles embedded newlines inside quoted fields", () => {
    const csv = 'Title,Body\nNote,"First line\nSecond line"\nSingle,"One line"';
    const table = parseTable(csv);
    expect(table.rows).toHaveLength(2);
    expect(table.rowCount).toBe(2);
    expect(table.rows[0]?.[1]).toBe("First line\nSecond line");
    expect(table.rows[1]?.[1]).toBe("One line");
  });

  it("handles escaped quotes using double-quote pairs", () => {
    const csv = 'Author,Quote\nAnon,"He said, ""Hello world"""';
    const table = parseTable(csv);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.[1]).toBe('He said, "Hello world"');
  });

  it("handles CRLF line terminators consistently with LF", () => {
    const csv = "Product,Qty\r\nA,10\r\nB,20\r\n";
    const table = parseTable(csv);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toEqual(["A", "10"]);
    expect(table.rows[1]).toEqual(["B", "20"]);
    expect(table.problems).toHaveLength(0);
  });

  it("detects semicolon delimiter even when text columns contain many commas", () => {
    const sample =
      'ID;Item;Ingredients;Price\n' +
      '1;Soup;"Carrots, onions, celery, salt, pepper, garlic";4.50\n' +
      '2;Salad;"Lettuce, tomato, cucumber, dressing";5.00\n' +
      '3;Pie;"Apples, sugar, flour, butter, cinnamon";6.50';
    const delimiter = detectDelimiter(sample);
    expect(delimiter).toBe(";");
    const table = parseTable(sample);
    expect(table.delimiter).toBe(";");
    expect(table.columns).toHaveLength(4);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]?.[2]).toBe("Carrots, onions, celery, salt, pepper, garlic");
  });

  it("recognises Indian lakh-style and Western grouping as money", () => {
    // Quoted, because that is what a real export does and what CSV requires:
    // an unquoted `1,23,456.78` genuinely IS three fields, and a parser that
    // guessed otherwise would corrupt every file with a comma in a text column.
    const csv =
      'Account,LakhBalance,WesternBalance\n' +
      'Primary,"1,23,456.78","1,234,567.89"\n' +
      'Secondary,"50,000.00","50,000.00"';
    const table = parseTable(csv);
    expect(table.columns[1]?.type).toBe("money");
    expect(table.columns[2]?.type).toBe("money");
    expect(cellNumber("1,23,456.78")).toBe(123456.78);
    expect(cellNumber("1,234,567.89")).toBe(1234567.89);
    expect(cellNumber("₹ 1,23,456.78")).toBe(123456.78);
    expect(cellNumber("(1,23,456.78)")).toBe(-123456.78);
  });

  it("interprets DD/MM/YYYY in British order as 3 April not 4 March", () => {
    const csv = "Ref,DueDate\nINV-42,03/04/2026";
    const table = parseTable(csv);
    expect(table.columns[1]?.type).toBe("date");
    const parsed = cellDate("03/04/2026");
    expect(parsed).not.toBeNull();
    expect(parsed?.getDate()).toBe(3);
    expect(parsed?.getMonth()).toBe(3);
    expect(parsed?.getFullYear()).toBe(2026);
  });

  it("pads or trims ragged rows to header width and records line numbers in problems", () => {
    const csv = "Name,Department,Location\nAlice,Design,London\nBob,Engineering\nCharlie,Product,Paris,Floor 3";
    const table = parseTable(csv);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[1]).toEqual(["Bob", "Engineering", ""]);
    expect(table.rows[2]).toEqual(["Charlie", "Product", "Paris"]);
    expect(table.problems).toHaveLength(2);
    expect(table.problems[0]).toContain("Line 3");
    expect(table.problems[0]).toContain("padded");
    expect(table.problems[1]).toContain("Line 4");
    expect(table.problems[1]).toContain("trimmed");
  });

  it("synthesises Column 1..n and records problem when first row contains data", () => {
    const csv = "100,200,300\n400,500,600";
    const table = parseTable(csv);
    expect(table.columns.map((c) => c.name)).toEqual(["Column 1", "Column 2", "Column 3"]);
    expect(table.columns.every((c) => c.type === "number")).toBe(true);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toEqual(["100", "200", "300"]);
    expect(table.problems).toHaveLength(1);
    expect(table.problems[0]).toContain("Column 1 to Column 3");
  });

  it("handles empty or blank input without throwing", () => {
    const empty = parseTable("");
    expect(empty.columns).toHaveLength(0);
    expect(empty.rows).toHaveLength(0);
    expect(empty.rowCount).toBe(0);
    expect(empty.truncated).toBe(false);
    expect(empty.delimiter).toBe(",");
    expect(empty.problems).toHaveLength(0);

    const whitespace = parseTable("   \r\n   ");
    expect(whitespace.columns).toHaveLength(0);
    expect(whitespace.rows).toHaveLength(0);
  });

  it("converts money and number values for arithmetic display while returning null for non-numeric", () => {
    expect(cellNumber("42")).toBe(42);
    expect(cellNumber("-10.5")).toBe(-10.5);
    expect(cellNumber("INR 50,000")).toBe(50000);
    expect(cellNumber("£1,500.50")).toBe(1500.5);
    expect(cellNumber("text")).toBeNull();
    expect(cellNumber("")).toBeNull();
    expect(cellNumber("03/04/2026")).toBeNull();
  });
});
