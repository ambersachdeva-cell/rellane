/** CSV evidence must use the reviewed file bytes, including after quit/reopen. */
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { MIGRATIONS } from "../book/schema.js";
import { openCase, turnsFor } from "../book/cases.js";
import { WorkroomSourceIntake } from "./sources.js";
import { reviewData } from "./data-review.js";
import { isCaseDataSource } from "../../shared/case-sources.js";
import { readSourceDocument } from "./source-document.js";

it("preserves outer CSV whitespace and a blank final record as data", async () => {
  const root = await mkdtemp(join(tmpdir(), "rellane-csv-spaces-"));
  try {
    const file = join(root, "amounts.csv");
    const original = "Amount\n 1.00 \n\n";
    await writeFile(file, original);
    const source = await readSourceDocument(file);
    expect(source.text).toBe(original);
    expect(source.coverage).toContain("2 data rows");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("imports an entire CSV snapshot, leaves the original alone and recalculates after reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "rellane-data-"));
  let db = new DatabaseSync(join(root, "book.sqlite"));
  const intake = new WorkroomSourceIntake();
  let id = "";
  try {
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    id = openCase(db, { title: "Orders", question: "Review an export" });
    const file = join(root, "orders.csv");
    const original = "Customer,INR\nA,0.10\nB,0.20";
    await writeFile(file, original);
    const preview = (await intake.preview(db, id, async () => file))!;
    expect(preview.coverage).toContain("2 data rows and 2 columns");
    expect(() => intake.add(db, { id, token: preview.token, startOffset: 0, endOffset: 5 })).toThrow("complete CSV snapshot");
    const sourceTurnId = intake.add(db, { id, token: preview.token });
    expect(isCaseDataSource(turnsFor(db, id)[0]!)).toBe(true);
    expect(await readFile(file, "utf8")).toBe(original);
    await writeFile(file, "Customer,INR\nCHANGED,999");
    db.close();
    db = new DatabaseSync(join(root, "book.sqlite"));
    const result = reviewData(db, { id, sourceTurnId, operation: "total", valueColumn: 1, groupColumn: null, unit: "INR", filter: null });
    expect(result.total).toBe("0.30");
    expect(result.sourceRows).toBe(2);
    expect(result.evidence).not.toContain("CHANGED");
  } finally {
    if (id) intake.discard(db, id);
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
