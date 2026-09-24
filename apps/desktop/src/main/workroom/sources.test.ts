/** Selection, review and durable import must refer to the same scoped snapshot. */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCaseReference } from "../../shared/case-sources.js";
import { MIGRATIONS } from "../book/schema.js";
import { closeCase, eraseCase, openCase, turnsFor } from "../book/cases.js";
import { WorkroomSourceIntake } from "./sources.js";
let db: DatabaseSync;
let root: string;
let file: string;
let id: string;
let intake: WorkroomSourceIntake;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rellane-intake-"));
  db = new DatabaseSync(join(root, "book.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  id = openCase(db, { title: "Campaign", question: "Use reviewed facts" });
  file = join(root, "brief.txt");
  await writeFile(file, "Launch in Pune. Budget ₹25,000. 🚀");
  intake = new WorkroomSourceIntake();
});
afterEach(async () => {
  intake.discard(db, id);
  vi.useRealTimers();
  db.close();
  await rm(root, { recursive: true, force: true });
});
describe("reviewed source intake", () => {
  it("stores nothing at preview and imports the reviewed snapshot even when the file changes", async () => {
    const preview = await intake.preview(db, id, async () => file);
    expect(preview?.text).toContain("₹25,000");
    expect(turnsFor(db, id)).toEqual([]);
    await writeFile(file, "CHANGED_AFTER_PREVIEW");
    const turnId = intake.add(db, { id, token: preview!.token });
    const turns = turnsFor(db, id);
    expect(turns[0]?.id).toBe(turnId);
    expect(turns[0]?.body).toBe(preview!.text);
    expect(isCaseReference(turns[0]!)).toBe(true);
    expect(turns[1]?.kind).toBe("receipt");
    expect(turns[1]?.body).toContain(preview!.fileSha256);
    expect(turns[1]?.body).toContain(preview!.textSha256);
    expect(turns[1]?.body).not.toContain(root);
    expect(() => intake.add(db, { id, token: preview!.token })).toThrow(
      "no longer available",
    );
    db.close();
    db = new DatabaseSync(join(root, "book.sqlite"));
    expect(turnsFor(db, id)[0]?.body).toBe(preview!.text);
  });
  it("saves an exact selected excerpt and rejects invalid or split-character ranges", async () => {
    const preview = (await intake.preview(db, id, async () => file))!;
    expect(() =>
      intake.add(db, {
        id,
        token: preview.token,
        startOffset: 5,
        endOffset: 2,
      }),
    ).toThrow("valid excerpt");
    expect(() =>
      intake.add(db, {
        id,
        token: preview.token,
        startOffset: preview.text.length - 1,
        endOffset: preview.text.length,
      }),
    ).toThrow("complete characters");
    expect(() =>
      intake.add(db, { id, token: preview.token, startOffset: 1 }),
    ).toThrow("complete text range");
    const start = preview.text.indexOf("Budget");
    const end = preview.text.indexOf(". 🚀");
    intake.add(db, {
      id,
      token: preview.token,
      startOffset: start,
      endOffset: end,
    });
    expect(turnsFor(db, id)[0]?.body).toBe("Budget ₹25,000");
    expect(turnsFor(db, id)[1]?.body).toContain(`Saved range: ${start}–${end}`);
  });
  it("rejects foreign, missing, closed and erased room imports", async () => {
    const preview = (await intake.preview(db, id, async () => file))!;
    const other = openCase(db, { title: "Other", question: "Foreign client" });
    expect(() => intake.add(db, { id: other, token: preview.token })).toThrow(
      "no longer available",
    );
    expect(() => intake.add(db, { id, token: randomUUID() })).toThrow(
      "no longer available",
    );
    closeCase(db, id, { closedAs: "settled", verdict: "Done" });
    expect(() => intake.add(db, { id, token: preview.token })).toThrow(
      "Open this workroom",
    );
    eraseCase(db, id);
    expect(() => intake.add(db, { id, token: preview.token })).toThrow(
      "Open this workroom",
    );
    expect(turnsFor(db, other)).toEqual([]);
  });
  it("handles cancellation, withdrawal during a picker and overlapping previews without a write", async () => {
    expect(await intake.preview(db, id, async () => null)).toBeNull();
    let choose: (file: string) => void = () => {
      throw new Error("Picker not started");
    };
    const pending = intake.preview(
      db,
      id,
      () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
    );
    await expect(intake.preview(db, id, async () => file)).rejects.toThrow(
      "already being opened",
    );
    expect(intake.discard(db, id)).toBe(true);
    choose(file);
    expect(await pending).toBeNull();
    expect(turnsFor(db, id)).toEqual([]);
    await expect(
      intake.preview(db, id, async () => {
        eraseCase(db, id);
        return file;
      }),
    ).rejects.toThrow("Open this workroom");
  });
  it("expires a preview and rejects stale tokens after replacement or discard", async () => {
    vi.useFakeTimers();
    const first = (await intake.preview(db, id, async () => file))!;
    const second = (await intake.preview(db, id, async () => file))!;
    expect(() => intake.add(db, { id, token: first.token })).toThrow(
      "no longer available",
    );
    expect(intake.discard(db, id, first.token)).toBe(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(() => intake.add(db, { id, token: second.token })).toThrow(
      "no longer available",
    );
    const third = (await intake.preview(db, id, async () => file))!;
    expect(intake.discard(db, id, third.token)).toBe(true);
    expect(() => intake.add(db, { id, token: third.token })).toThrow(
      "no longer available",
    );
    expect(turnsFor(db, id)).toEqual([]);
  });
  it("rolls back the source when its receipt fails and permits a deliberate retry", async () => {
    const preview = (await intake.preview(db, id, async () => file))!;
    db.exec(
      "CREATE TRIGGER refuse_source BEFORE INSERT ON case_turn WHEN NEW.kind = 'receipt' BEGIN SELECT RAISE(ABORT, 'receipt refused'); END",
    );
    expect(() => intake.add(db, { id, token: preview.token })).toThrow(
      "receipt refused",
    );
    expect(turnsFor(db, id)).toEqual([]);
    db.exec("DROP TRIGGER refuse_source");
    intake.add(db, { id, token: preview.token });
    expect(turnsFor(db, id)).toHaveLength(2);
  });
});
