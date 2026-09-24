/**
 * The record of which engine was right.
 *
 * This is the only place anywhere that knows how two frontier models compare on
 * *this* shop's work rather than on somebody's benchmark. These tests are mostly
 * about the discipline that makes such a record worth reading: it says nothing
 * until it can, and it never keeps more than it needs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBook } from "../book/database.js";
import { argumentsHeld, ENOUGH, remember, routing } from "./corpus.js";

let dir: string;
let db: DatabaseSync;
let at = Date.parse("2026-09-03T10:00:00.000Z");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-corpus-"));
  db = (await openBook(join(dir, "book.sqlite"))).db;
  at = Date.parse("2026-09-03T10:00:00.000Z");
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const held = (conceded: "proposer" | "adversary" | null, question = "Is this quote fair?") => {
  at += 60_000;
  remember(db, {
    id: `${at}`,
    at,
    question,
    proposerEngine: "Claude",
    adversaryEngine: "Gemini",
    outcome: conceded === null ? "unresolved" : "corrected",
    conceded,
    approxTokens: 4_000
  });
};

describe("what it keeps", () => {
  it("records who gave way, which is the whole point", () => {
    held("proposer");

    const [entry] = argumentsHeld(db);

    expect(entry?.conceded).toBe("proposer");
    expect(entry?.proposerEngine).toBe("Claude");
  });

  it("keeps no turns at all", () => {
    // The turns are the owner's business discussed at length. A table quietly
    // accumulating the full text of every argument would be the most sensitive
    // thing on this Mac, and counting is enough to route with.
    held("adversary");
    const columns = db
      .prepare(`SELECT name FROM pragma_table_info('bench_argument')`)
      .all() as readonly Record<string, unknown>[];

    const names = columns.map((column) => String(column["name"]));
    expect(names).not.toContain("turns");
    expect(names).not.toContain("text");
    expect(names).not.toContain("answer");
  });

  it("trims the question rather than storing the whole prompt", () => {
    held(null, "x".repeat(2_000));

    expect(argumentsHeld(db)[0]?.question.length).toBe(300);
  });
});

describe("what it will say", () => {
  it("refuses to read anything into a handful", () => {
    // Three arguments can make one engine look twice as good as another. A
    // product that reported that as a finding teaches its owner to trust noise,
    // after which the real finding is worth nothing.
    held("proposer");
    held("proposer");
    held("proposer");

    const result = routing(db);

    expect(result.enoughToSay).toBe(false);
    expect(result.said).toContain("noise wearing a percentage");
  });

  it("names the engine still standing, once there is enough", () => {
    for (let n = 0; n < ENOUGH; n += 1) {
      held("proposer");
    }

    const result = routing(db);

    expect(result.enoughToSay).toBe(true);
    // The proposer conceded every time, so the adversary is the one standing.
    expect(result.engines[0]?.engine).toBe("Gemini");
    expect(result.engines[0]?.wonOver).toBe(ENOUGH);
    expect(result.said).toContain("Gemini");
    expect(result.said).toContain("does not change which engine answers");
  });

  it("calls an even record an even record, not a failure", () => {
    // "Neither is better on your work" is a real finding, and the most likely
    // one. Dressing it up as inconclusive would waste it.
    for (let n = 0; n < ENOUGH; n += 1) {
      held(null);
    }

    const result = routing(db);

    expect(result.enoughToSay).toBe(true);
    expect(result.said).toContain("evenly matched");
    expect(result.said).toContain("not a failure to find one");
  });

  it("calls a tie a tie rather than picking the alphabetical winner", () => {
    // Sorting breaks a tie somehow, and presenting that as "the one still
    // standing" dresses a coin-flip as a finding.
    for (let n = 0; n < ENOUGH; n += 1) {
      held(n % 2 === 0 ? "proposer" : "adversary");
    }

    const result = routing(db);

    expect(result.said).toContain("evenly matched");
    expect(result.said).not.toContain("still standing");
  });

  it("will not name an engine that has not argued enough itself", () => {
    // Four engines with two arguments each clears a total of eight while
    // telling you nothing about any of them.
    for (let n = 0; n < ENOUGH; n += 1) {
      at += 60_000;
      remember(db, {
        id: `${at}`,
        at,
        question: "q",
        proposerEngine: `Engine ${n}`,
        adversaryEngine: `Other ${n}`,
        outcome: "corrected",
        conceded: "adversary",
        approxTokens: 100
      });
    }

    expect(routing(db).said).toContain(`no single engine has been in ${ENOUGH}`);
  });

  it("does not let an engine argue with itself and win", () => {
    // Two models from one subscription, or a room with one ready engine.
    for (let n = 0; n < ENOUGH; n += 1) {
      at += 60_000;
      remember(db, {
        id: `${at}`,
        at,
        question: "q",
        proposerEngine: "Claude",
        adversaryEngine: "Claude",
        outcome: "corrected",
        conceded: "proposer",
        approxTokens: 100
      });
    }

    const claude = routing(db).engines.find((engine) => engine.engine === "Claude");

    expect(claude?.arguments).toBe(ENOUGH);
    expect(claude?.wonOver).toBe(0);
    expect(claude?.gaveWay).toBe(0);
  });

  it("counts both sides of every argument", () => {
    held("proposer");
    held("adversary");

    const engines = routing(db).engines;

    expect(engines.every((engine) => engine.arguments === 2)).toBe(true);
    expect(engines.find((engine) => engine.engine === "Claude")?.gaveWay).toBe(1);
    expect(engines.find((engine) => engine.engine === "Gemini")?.gaveWay).toBe(1);
  });
});
