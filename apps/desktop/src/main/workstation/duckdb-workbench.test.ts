import { describe, expect, it } from "vitest";
import { createTabularWorkbench } from "./duckdb-workbench.js";

describe("TabularWorkbench", () => {
  it("infers schema types accurately from CSV data", () => {
    const wb = createTabularWorkbench();
    const csv = `id,name,score,is_active,joined_at
1,Alice,95.5,true,2025-01-15
2,Bob,82.0,false,2025-02-01
3,Charlie,88.25,true,2025-02-10`;

    const schema = wb.createTableFromCsv("students", csv);
    expect(schema).toHaveLength(5);
    expect(schema[0]!).toEqual({ name: "id", type: "integer", nullable: false });
    expect(schema[1]!).toEqual({ name: "name", type: "text", nullable: false });
    expect(schema[2]!).toEqual({ name: "score", type: "real", nullable: false });
    expect(schema[3]!).toEqual({ name: "is_active", type: "boolean", nullable: false });
    expect(schema[4]!).toEqual({ name: "joined_at", type: "date", nullable: false });
    expect(wb.listTables()).toEqual(["students"]);
    expect(wb.getTableSchema("students")).toEqual(schema);
  });

  it("executes SELECT with comparison, LIKE, and range filters", () => {
    const wb = createTabularWorkbench();
    wb.createTableFromRecords("ledger", [
      { id: 1, account: "sales", amount_paise: 50000, status: "posted" },
      { id: 2, account: "refunds", amount_paise: -12000, status: "pending" },
      { id: 3, account: "fees", amount_paise: 3500, status: "posted" },
      { id: 4, account: "sales_direct", amount_paise: 80000, status: "posted" }
    ]);

    const filtered = wb.execute(
      "SELECT id, account, amount_paise FROM ledger WHERE status = 'posted' AND amount_paise > 4000 ORDER BY amount_paise DESC"
    );
    expect(filtered.rowCount).toBe(2);
    expect(filtered.rows[0]!).toEqual([4, "sales_direct", 80000]);
    expect(filtered.rows[1]!).toEqual([1, "sales", 50000]);

    const likeQuery = wb.execute("SELECT account FROM ledger WHERE account LIKE 'sales%' ORDER BY account ASC");
    expect(likeQuery.rowCount).toBe(2);
    expect(likeQuery.rows[0]!).toEqual(["sales"]);
    expect(likeQuery.rows[1]!).toEqual(["sales_direct"]);
  });

  it("executes aggregation queries with GROUP BY, SUM, and AVG", () => {
    const wb = createTabularWorkbench();
    wb.createTableFromRecords("orders", [
      { dept: "engineering", cost: 1000 },
      { dept: "engineering", cost: 3000 },
      { dept: "design", cost: 1500 },
      { dept: "design", cost: 2500 }
    ]);

    const grouped = wb.execute(
      "SELECT dept, COUNT(*) AS items, SUM(cost) AS total, AVG(cost) AS average FROM orders GROUP BY dept ORDER BY dept ASC"
    );
    expect(grouped.rowCount).toBe(2);
    expect(grouped.rows[0]!).toEqual(["design", 2, 4000, 2000]);
    expect(grouped.rows[1]!).toEqual(["engineering", 2, 4000, 2000]);

    const grandTotal = wb.execute("SELECT COUNT(*) AS total_count, SUM(cost) AS grand_total FROM orders");
    expect(grandTotal.rowCount).toBe(1);
    expect(grandTotal.rows[0]!).toEqual([4, 8000]);
  });

  it("computes comprehensive column statistics for numeric and text columns", () => {
    const wb = createTabularWorkbench();
    wb.createTableFromRecords("metrics", [
      { city: "London", latency_ms: 20 },
      { city: "Paris", latency_ms: 40 },
      { city: "London", latency_ms: 60 },
      { city: null, latency_ms: null }
    ]);

    const stats = wb.calculateStats("metrics");
    expect(stats).toHaveLength(2);

    const cityStats = stats.find(s => s.name === "city")!;
    expect(cityStats.type).toBe("text");
    expect(cityStats.count).toBe(4);
    expect(cityStats.nullCount).toBe(1);
    expect(cityStats.distinctCount).toBe(2);
    expect(cityStats.min).toBe("London");
    expect(cityStats.max).toBe("Paris");
    expect(cityStats.mean).toBeUndefined();

    const latencyStats = stats.find(s => s.name === "latency_ms")!;
    expect(latencyStats.type).toBe("integer");
    expect(latencyStats.count).toBe(4);
    expect(latencyStats.nullCount).toBe(1);
    expect(latencyStats.distinctCount).toBe(3);
    expect(latencyStats.min).toBe(20);
    expect(latencyStats.max).toBe(60);
    expect(latencyStats.mean).toBe(40);
  });

  it("exports query results and tables to CSV and Markdown formats", () => {
    const wb = createTabularWorkbench();
    wb.createTableFromRecords("products", [
      { id: 1, title: 'Widget, "Standard"', price: 100 },
      { id: 2, title: "Gadget", price: null }
    ]);

    const csv = wb.exportToCsv("products");
    expect(csv).toBe('id,title,price\n1,"Widget, ""Standard""",100\n2,Gadget,');

    const md = wb.exportToMarkdown("products");
    expect(md).toContain("| id | title | price |");
    expect(md).toContain("| --- | --- | --- |");
    expect(md).toContain('| 1 | Widget, "Standard" | 100 |');
    expect(md).toContain("| 2 | Gadget | NULL |");
  });

  it("handles non-existent tables and bad queries gracefully without throwing", () => {
    const wb = createTabularWorkbench();

    const missingRes = wb.execute("SELECT * FROM non_existent_table");
    expect(missingRes.rowCount).toBe(0);
    expect(missingRes.rows).toEqual([]);
    expect(missingRes.error).toBeDefined();

    const syntaxRes = wb.execute("SELECT FROM WHERE");
    expect(syntaxRes.rowCount).toBe(0);
    expect(syntaxRes.rows).toEqual([]);
    expect(syntaxRes.error).toBeDefined();

    expect(wb.getTableSchema("unknown")).toBeUndefined();
    expect(wb.calculateStats("unknown")).toEqual([]);
    expect(wb.exportToCsv("unknown")).toBe("");
    expect(wb.exportToMarkdown("unknown")).toBe("");
  });
});
