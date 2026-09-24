/** TypeScript / vitest: observe actual bytes and SQLite receipts, including
 * cancellation, cross-room isolation, no-clobber writes and interrupted records. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS } from "../book/schema.js";
import { closeCase, eraseCase, openCase } from "../book/cases.js";
import { acceptArtifact, saveArtifact } from "./artifacts.js";
import {
  exportArtifactVersion,
  exportReceipts,
  isExporting
} from "./exports.js";

let db: DatabaseSync;
let root: string;
let id: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rellane-export-test-"));
  db = new DatabaseSync(join(root, "book.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  id = openCase(db, { title: "Campaign", question: "Prepare a launch note" });
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});
const save = (body: string, baseVersionId: string | null = null) =>
  saveArtifact(db, { id, body, baseVersionId, sourceTurnId: null });

describe("version-bound export", () => {
  it("exports the chosen historical version with a private file and a durable byte-exact receipt", async () => {
    const first = save("Approved claim ₹12,500");
    acceptArtifact(db, id, first.id);
    save("A later, unaccepted claim", first.id);
    const target = join(root, "proposal.md");
    expect(
      await exportArtifactVersion(db, id, first.id, "md", async () => target)
    ).toEqual({
      written: true,
      fileName: "proposal.md",
      receiptRecorded: true
    });
    const bytes = await readFile(target);
    expect(bytes.toString()).toContain("Approved claim ₹12,500");
    expect(bytes.toString()).not.toContain("later, unaccepted");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    db.close();
    db = new DatabaseSync(join(root, "book.sqlite"));
    db.exec("PRAGMA foreign_keys = ON");
    const receipt = exportReceipts(db, id)[0]!;
    expect(receipt).toMatchObject({
      versionId: first.id,
      revision: 1,
      fileName: "proposal.md",
      state: "written",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
    expect(receipt.acceptedAt).not.toBeNull();
    expect(JSON.stringify(receipt)).not.toContain(root);
  });
  it("refuses another workroom's version before showing any file picker", async () => {
    const first = save("CLIENT_A_CANARY");
    const other = openCase(db, { title: "Other client", question: "Separate" });
    const choose = vi.fn(async () => join(root, "other.docx"));
    await expect(
      exportArtifactVersion(db, other, first.id, "docx", choose)
    ).rejects.toThrow("this workroom");
    expect(choose).not.toHaveBeenCalled();
    expect(exportReceipts(db, other)).toEqual([]);
  });
  it("does no work on cancel and rechecks erasure after the file picker", async () => {
    const first = save("Removed draft");
    expect(
      (await exportArtifactVersion(db, id, first.id, "md", async () => null))
        .written
    ).toBe(false);
    expect(exportReceipts(db, id)).toEqual([]);
    const target = join(root, "removed.md");
    await expect(
      exportArtifactVersion(db, id, first.id, "md", async () => {
        eraseCase(db, id);
        return target;
      })
    ).rejects.toThrow("removed");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(isExporting(db, id)).toBe(false);
  });
  it("serializes a room's picker and never overwrites an existing file", async () => {
    const first = save("New content");
    const target = join(root, "existing.md");
    await writeFile(target, "EXISTING_WORK");
    await expect(
      exportArtifactVersion(db, id, first.id, "md", async () => {
        expect(isExporting(db, id)).toBe(true);
        await expect(
          exportArtifactVersion(db, id, first.id, "md", async () => null)
        ).rejects.toThrow("already open");
        return target;
      })
    ).rejects.toThrow("already exists");
    expect(await readFile(target, "utf8")).toBe("EXISTING_WORK");
    expect(exportReceipts(db, id)[0]?.state).toBe("failed");
    expect(isExporting(db, id)).toBe(false);
  });
  it("requires a start receipt before writing and distinguishes a written file from a missing completion receipt", async () => {
    const first = save("Reviewed copy");
    const target = join(root, "receipt.md");
    db.exec(
      "CREATE TRIGGER reject_start BEFORE INSERT ON case_artifact_export BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END"
    );
    await expect(
      exportArtifactVersion(db, id, first.id, "md", async () => target)
    ).rejects.toThrow("receipt unavailable");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    db.exec("DROP TRIGGER reject_start");
    db.exec(
      "CREATE TRIGGER reject_finish BEFORE UPDATE ON case_artifact_export BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END"
    );
    expect(
      await exportArtifactVersion(db, id, first.id, "md", async () => target)
    ).toEqual({
      written: true,
      fileName: "receipt.md",
      receiptRecorded: false
    });
    expect(await readFile(target, "utf8")).toContain("Reviewed copy");
    expect(exportReceipts(db, id)[0]?.state).toBe("pending");
  });
  it("exports a completed workroom to Word and erases receipts with its room", async () => {
    const first = save("# Proposal\nApproved scope");
    closeCase(db, id, { closedAs: "settled", verdict: "Ready" });
    const target = join(root, "complete.docx");
    await exportArtifactVersion(db, id, first.id, "docx", async () => target);
    expect((await readFile(target)).subarray(0, 2).toString()).toBe("PK");
    expect(exportReceipts(db, id)[0]?.format).toBe("docx");
    eraseCase(db, id);
    expect(exportReceipts(db, id)).toEqual([]);
    // Explicit exports belong to the chosen destination; erasure does not
    // silently delete files the owner may already have edited or shared.
    expect((await stat(target)).isFile()).toBe(true);
  });
});
