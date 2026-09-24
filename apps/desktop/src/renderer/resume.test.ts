import { describe, expect, it } from "vitest";
import { browserStorage, NOTHING, readResume, writeResume } from "./resume.js";

/** A storage that behaves, and one that does not. Both are real conditions. */
function fake(initial: string | null = null) {
  let held = initial;
  return {
    getItem: () => held,
    setItem: (_key: string, value: string) => { held = value; },
    read: () => held
  };
}
const throwing = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("quota"); }
};

describe("remembering where you were", () => {
  it("round-trips a place and a case", () => {
    const store = fake();
    writeResume(store, { place: "cases", caseId: "abc-123" });

    expect(readResume(store)).toEqual({ place: "cases", caseId: "abc-123" });
  });

  it("returns nothing on a first run", () => {
    expect(readResume(fake())).toEqual(NOTHING);
  });
});

describe("what it refuses to trust", () => {
  it("drops a place that no longer exists", () => {
    // The rail is about to lose several destinations. Somebody upgrading must
    // not land on a screen that was deleted.
    const store = fake(JSON.stringify({ place: "connectors-old", caseId: null }));
    expect(readResume(store).place).toBeNull();
  });

  it("drops a case id long enough to be an attack rather than an id", () => {
    const store = fake(JSON.stringify({ place: "cases", caseId: "x".repeat(500) }));
    // It came off disk and is about to cross IPC. The main process validates it
    // too; this is the first of the two, not the only one.
    expect(readResume(store).caseId).toBeNull();
    expect(readResume(store).place).toBe("cases");
  });

  it("survives a value written by something that was not this", () => {
    for (const junk of ["", "null", "[]", "{", '"a string"', "42"]) {
      expect(readResume(fake(junk))).toEqual(NOTHING);
    }
  });

  it("ignores fields of the wrong type rather than believing them", () => {
    const store = fake(JSON.stringify({ place: 7, caseId: { id: "x" } }));
    expect(readResume(store)).toEqual(NOTHING);
  });
});

describe("storage that refuses to work", () => {
  it("reads as nothing rather than throwing, because a throw here costs the window", () => {
    expect(() => readResume(throwing)).not.toThrow();
    expect(readResume(throwing)).toEqual(NOTHING);
  });

  it("writes silently rather than throwing when storage is full or blocked", () => {
    expect(() => writeResume(throwing, { place: "cases", caseId: "a" })).not.toThrow();
  });

  it("treats no storage at all as no memory", () => {
    expect(readResume(null)).toEqual(NOTHING);
    expect(() => writeResume(null, { place: "cases", caseId: "a" })).not.toThrow();
  });

  it("reports the absence of localStorage instead of assuming it", () => {
    // Under a thumbnailer or a browser told to block site data this is the
    // normal case, not an exotic one.
    expect(() => browserStorage()).not.toThrow();
  });
});

describe("clearing where you were", () => {
  it("forgets the case but can keep the place", () => {
    const store = fake();
    writeResume(store, { place: "cases", caseId: "abc" });
    writeResume(store, { place: "cases", caseId: null });

    expect(readResume(store)).toEqual({ place: "cases", caseId: null });
  });
});
