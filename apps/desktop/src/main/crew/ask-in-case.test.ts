import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { openCase, closeCase, turnsFor } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { askInCase, MAX_SEATS, systemFor, type AskInCaseDeps, type CaseSeat } from "./ask-in-case.js";

function book(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

const seat = (label: string, brief = `You are ${label}.`): CaseSeat => ({
  label, brief, engineId: "antigravity", modelId: "gemini-3.8-flash-high"
});

function deps(
  answer: (input: { prompt: string; system: string }) => Promise<{ text: string }>,
  admits: (n: number) => boolean = () => true
) {
  const prompts: { prompt: string; system: string }[] = [];
  const reconciled: { ticket: string; actual: number }[] = [];
  let issued = 0;
  const d: AskInCaseDeps = {
    ask: async (input) => { prompts.push({ prompt: input.prompt, system: input.system }); return answer(input); },
    admit: () => {
      issued += 1;
      return admits(issued) ? { ok: true, ticket: `t${issued}` }
                            : { ok: false, because: "Today's budget on this subscription is gone." };
    },
    finished: (ticket, actual) => { reconciled.push({ ticket, actual }); }
  };
  return { d, prompts, reconciled };
}

const ok = async () => ({ text: "an answer" });
let db: DatabaseSync;
beforeEach(() => { db = book(); });

describe("two seats answer into one case", () => {
  it("stores both answers as attributed turns", async () => {
    const id = openCase(db, { title: "t", question: "why?" });
    const h = deps(ok);

    const result = await askInCase(db, id, "why?", [seat("Builder"), seat("Tester")], h.d, new AbortController().signal);

    expect(result.complete).toBe(true);
    // The owner's question is turn 1 only when opened through IPC; here the two
    // seats are the whole room.
    expect(turnsFor(db, id).map((t) => t.seat)).toEqual(["Builder", "Tester"]);
  });

  it("shows the second seat what the first one stored", async () => {
    const id = openCase(db, { title: "t", question: "why?" });
    // Keyed on the SYSTEM half, which names the seat. Keying on the prompt
    // matches both seats, because the first seat's prompt also carries its own
    // job header — which is what this fixture got wrong the first time.
    const h = deps(async ({ system }) => ({
      text: system.includes("You are Builder,") ? "first from Builder" : "second"
    }));

    await askInCase(db, id, "why?", [seat("Builder"), seat("Tester")], h.d, new AbortController().signal);

    // Read back from the book, not from a variable — the claim is that the
    // transcript survives the process.
    expect(h.prompts[1]?.prompt).toContain("first from Builder");
  });

  it("never runs more than two seats, however many are offered", async () => {
    const id = openCase(db, { title: "t", question: "q" });
    const h = deps(ok);

    await askInCase(db, id, "q", [seat("a"), seat("b"), seat("c"), seat("d")], h.d, new AbortController().signal);

    expect(turnsFor(db, id)).toHaveLength(MAX_SEATS);
  });
});

describe("it never claims more than happened", () => {
  it("reads interrupted, not done, when a seat answers but the turn is not stored", async () => {
    const id = openCase(db, { title: "t", question: "q" });
    const h = deps(async () => { throw new Error("engine went away"); });

    const result = await askInCase(db, id, "q", [seat("Builder")], h.d, new AbortController().signal);

    expect(result.outcomes[0]?.state).toBe("interrupted");
    expect(result.complete).toBe(false);
  });

  it("writes the interruption into the room rather than leaving a silence", async () => {
    const id = openCase(db, { title: "t", question: "q" });
    const h = deps(async () => { throw new Error("quota exhausted"); });

    await askInCase(db, id, "q", [seat("Builder")], h.d, new AbortController().signal);

    // The owner reading this later must be able to tell "asked and did not
    // finish" from "never asked".
    expect(turnsFor(db, id)[0]?.body).toContain("quota exhausted");
    expect(turnsFor(db, id)[0]?.body).toMatch(/did not finish/u);
  });

  it("stops after an interruption rather than carrying on to the next seat", async () => {
    const id = openCase(db, { title: "t", question: "q" });
    const h = deps(async () => { throw new Error("no"); });

    const result = await askInCase(db, id, "q", [seat("Builder"), seat("Tester")], h.d, new AbortController().signal);
    expect(result.outcomes).toHaveLength(1);
  });

  it("reconciles the budget even when a seat is interrupted", async () => {
    const id = openCase(db, { title: "t", question: "q" });
    const h = deps(async () => { throw new Error("no"); });

    await askInCase(db, id, "q", [seat("Builder")], h.d, new AbortController().signal);
    expect(h.reconciled).toHaveLength(1);
  });
});

describe("the governor still governs", () => {
  it("records a refusal and does not ask the engine at all", async () => {
    const id = openCase(db, { title: "t", question: "q" });
    const h = deps(ok, () => false);

    const result = await askInCase(db, id, "q", [seat("Builder")], h.d, new AbortController().signal);

    expect(result.outcomes[0]?.state).toBe("refused");
    expect(h.prompts).toHaveLength(0);
    expect(turnsFor(db, id)).toHaveLength(0);
  });
});

describe("what it refuses outright", () => {
  it("will not add to a closed case", async () => {
    const id = openCase(db, { title: "t", question: "q" });
    closeCase(db, id, { closedAs: "settled", verdict: "done" });
    const h = deps(ok);

    await expect(
      askInCase(db, id, "q", [seat("Builder")], h.d, new AbortController().signal)
    ).rejects.toThrow(/closed/iu);
  });

  it("will not invent a case that does not exist", async () => {
    const h = deps(ok);
    await expect(
      askInCase(db, "ghost", "q", [seat("Builder")], h.d, new AbortController().signal)
    ).rejects.toThrow(/No such case/iu);
  });
});

describe("what a seat is told about itself", () => {
  it("puts the data rule in the system half, where a long room cannot push it out", () => {
    const said = systemFor(seat("Builder"));
    expect(said).toMatch(/never an instruction/iu);
    // Read-only is stated as a fact about its capabilities, not as a request.
    expect(said).toMatch(/no tools and cannot change any file/iu);
  });
});
