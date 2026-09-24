import { describe, expect, it } from "vitest";
import {
  MAX_RESULT_ROWS,
  runQuery,
  type ParsedTableLike,
  type QuerySpec,
} from "./table-query.js";

describe("table-query", () => {
  it("compares money numerically rather than as text", () => {
    const table: ParsedTableLike = {
      columns: [
        { name: "Invoice", index: 0, type: "text" },
        { name: "Amount", index: 1, type: "money" },
      ],
      rows: [
        ["INV-001", "₹10"],
        ["INV-002", "₹9"],
        ["INV-003", "₹100"],
      ],
    };

    const query: QuerySpec = {
      filters: [{ column: 1, op: "gt", value: "9" }],
      sort: { column: 1, direction: "asc" },
    };

    const result = runQuery(table, query);
    expect(result.matched).toBe(2);
    expect(result.rows).toEqual([
      ["INV-001", "₹10"],
      ["INV-003", "₹100"],
    ]);
  });

  it("compares DD/MM dates chronologically", () => {
    const table: ParsedTableLike = {
      columns: [
        { name: "Milestone", index: 0, type: "text" },
        { name: "Due", index: 1, type: "date" },
      ],
      rows: [
        ["Design Review", "20/02"],
        ["Code Freeze", "05/03"],
        ["Launch", "15/04"],
      ],
    };

    const query: QuerySpec = {
      filters: [{ column: 1, op: "lt", value: "05/03" }],
    };

    const result = runQuery(table, query);
    expect(result.matched).toBe(1);
    expect(result.rows).toEqual([["Design Review", "20/02"]]);
  });

  it("excludes blanks from comparisons and sorts them last in both directions", () => {
    const table: ParsedTableLike = {
      columns: [
        { name: "Task", index: 0, type: "text" },
        { name: "Priority", index: 1, type: "number" },
      ],
      rows: [
        ["Alpha", "10"],
        ["Beta", ""],
        ["Gamma", "5"],
        ["Delta", "  "],
      ],
    };

    const gtResult = runQuery(table, {
      filters: [{ column: 1, op: "gt", value: "0" }],
    });
    expect(gtResult.matched).toBe(2);
    expect(gtResult.rows.map((r) => r[0])).toEqual(["Alpha", "Gamma"]);

    const notEmptyResult = runQuery(table, {
      filters: [{ column: 1, op: "is-not", value: "10" }],
    });
    expect(notEmptyResult.matched).toBe(1);
    expect(notEmptyResult.rows.map((r) => r[0])).toEqual(["Gamma"]);

    const emptyResult = runQuery(table, {
      filters: [{ column: 1, op: "empty", value: "" }],
    });
    expect(emptyResult.matched).toBe(2);
    expect(emptyResult.rows.map((r) => r[0])).toEqual(["Beta", "Delta"]);

    const ascResult = runQuery(table, {
      filters: [],
      sort: { column: 1, direction: "asc" },
    });
    expect(ascResult.rows.map((r) => r[0])).toEqual([
      "Gamma",
      "Alpha",
      "Beta",
      "Delta",
    ]);

    const descResult = runQuery(table, {
      filters: [],
      sort: { column: 1, direction: "desc" },
    });
    expect(descResult.rows.map((r) => r[0])).toEqual([
      "Alpha",
      "Gamma",
      "Beta",
      "Delta",
    ]);
  });

  it("evaluates between inclusively when bounds are reversed", () => {
    const table: ParsedTableLike = {
      columns: [
        { name: "Name", index: 0, type: "text" },
        { name: "Score", index: 1, type: "number" },
      ],
      rows: [
        ["Low", "5"],
        ["Mid1", "10"],
        ["Mid2", "20"],
        ["High", "30"],
      ],
    };

    const result = runQuery(table, {
      filters: [{ column: 1, op: "between", value: "20", value2: "10" }],
    });

    expect(result.matched).toBe(2);
    expect(result.rows.map((r) => r[0])).toEqual(["Mid1", "Mid2"]);
  });

  it("groups, sums, and produces the summary total in the owner's style", () => {
    const table: ParsedTableLike = {
      columns: [
        { name: "Client", index: 0, type: "text" },
        { name: "Amount", index: 1, type: "money" },
      ],
      rows: [
        ["Studio North", "50000"],
        ["Studio North", "74500"],
        ["Studio South", "25000"],
      ],
    };

    const result = runQuery(table, {
      filters: [{ column: 0, op: "contains", value: "North" }],
      groupBy: 0,
      aggregate: { column: 1, fn: "sum" },
    });

    expect(result.matched).toBe(2);
    expect(result.total).toBe(3);
    expect(result.summary).toBe("2 of 3 rows, totalling ₹1,24,500.");
    expect(result.columns).toEqual(["Client", "Amount"]);
    expect(result.rows).toEqual([["Studio North", "₹1,24,500"]]);
  });

  it("records an average on a text column as a problem without throwing", () => {
    const table: ParsedTableLike = {
      columns: [
        { name: "Client", index: 0, type: "text" },
        { name: "Project", index: 1, type: "text" },
      ],
      rows: [
        ["Studio North", "Identity"],
        ["Studio North", "Packaging"],
      ],
    };

    const result = runQuery(table, {
      filters: [],
      aggregate: { column: 1, fn: "avg" },
    });

    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems[0]).toContain("non-numeric");
    expect(result.matched).toBe(2);
  });

  it("skips filters targeting non-existent columns without emptying results", () => {
    const table: ParsedTableLike = {
      columns: [
        { name: "Product", index: 0, type: "text" },
        { name: "Qty", index: 1, type: "number" },
      ],
      rows: [
        ["Pen", "15"],
        ["Pencil", "5"],
      ],
    };

    const result = runQuery(table, {
      filters: [
        { column: 99, op: "is", value: "bogus" },
        { column: 1, op: "gt", value: "10" },
      ],
    });

    expect(result.matched).toBe(1);
    expect(result.rows).toEqual([["Pen", "15"]]);
    expect(result.problems.length).toBe(1);
    expect(result.problems[0]).toContain("99");
  });

  it("caps results at MAX_RESULT_ROWS and records a problem", () => {
    const rows: (readonly string[])[] = [];
    for (let i = 0; i < 2_500; i++) {
      rows.push([`Item ${i}`, `${i}`]);
    }

    const table: ParsedTableLike = {
      columns: [
        { name: "Name", index: 0, type: "text" },
        { name: "Value", index: 1, type: "number" },
      ],
      rows,
    };

    const result = runQuery(table, { filters: [] });
    expect(result.matched).toBe(2_500);
    expect(result.total).toBe(2_500);
    expect(result.rows.length).toBe(MAX_RESULT_ROWS);
    expect(result.problems.length).toBe(1);
    expect(result.problems[0]).toContain("2,000");
  });
});
