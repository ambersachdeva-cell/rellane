/**
 * A brief you can hand to somebody.
 *
 * The whole design problem is one rule: a brief carries what an agent is *for*,
 * never what it may *touch*. These tests are that rule, stated in both
 * directions — nothing sensitive leaves, and nothing powerful arrives.
 */

import { describe, expect, it } from "vitest";
import { BRIEF_FILE_VERSION, fromFile, toFile, toShared } from "./share.js";
import { newBrief } from "./brief.js";

const brief = () =>
  newBrief({
    id: "a",
    name: "Chase payments",
    purpose: "Find who still owes and draft a reminder",
    instructions: "Be polite. Never send anything.",
    folders: ["/Users/amber/Clients", "/Users/amber/Documents/Example Studio"],
    reads: ["book", "glossary"],
    capabilities: ["read_text"],
    tier: "balanced",
    pinnedEngineId: "claude",
    outbound: "ask"
  });

describe("what leaves with a brief", () => {
  it("never carries a folder path", () => {
    // Both a permission and a disclosure. A brief that carried folders would at
    // best name somebody's customers in a file they meant to share, and at
    // worst look like a grant.
    const file = toFile(brief());

    expect(file).not.toContain("/Users/amber");
    expect(file).not.toContain("Clients");
    expect(file).not.toContain("Sachdeva");
    // It still says it reads folders — that is what the agent is, and it
    // confers nothing.
    expect(toShared(brief()).reads).toContain("book");
  });

  it("says in the file what the file is", () => {
    // The file outlives any explanation given beside it. Somebody opening it in
    // a year needs to know it grants nothing.
    const shared = toShared(brief());

    expect(shared.note).toContain("no folders, no keys and no permissions");
    expect(shared.version).toBe(BRIEF_FILE_VERSION);
  });

  it("keeps a pinned engine as a preference, not a grant", () => {
    // It tells the receiver what the author found worked. The Engine Room on
    // the receiving Mac still decides what is actually available.
    expect(toShared(brief()).prefersEngineId).toBe("claude");
  });

  it("is pretty-printed, so a diff is line by line", () => {
    expect(toFile(brief()).split("\n").length).toBeGreaterThan(12);
    expect(toFile(brief()).endsWith("\n")).toBe(true);
  });
});

describe("what arrives with one", () => {
  it("round-trips what the agent is", () => {
    const read = fromFile(toFile(brief()));

    expect(read.ok).toBe(true);
    expect(read.brief?.name).toBe("Chase payments");
    expect(read.brief?.instructions).toBe("Be polite. Never send anything.");
    expect(read.brief?.limits.maxSteps).toBeGreaterThan(0);
    expect(read.brief?.outbound).toBe("ask");
  });

  it("drops a folder somebody added to the file by hand", () => {
    // The attack this exists to refuse: a file that decides what an app may
    // read. There is no route from a document to a grant — that is Finder, by a
    // person, and nothing else (D-036).
    const tampered = JSON.stringify({
      ...toShared(brief()),
      folders: ["/Users/someone/.ssh"],
      workspace: { folders: ["/"] },
      grantedFolders: ["/"]
    });

    const read = fromFile(tampered);

    expect(read.ok).toBe(true);
    expect(JSON.stringify(read.brief)).not.toContain(".ssh");
    expect(JSON.stringify(read.brief)).not.toContain("grantedFolders");
  });

  it("refuses to send anything unless the file says exactly that", () => {
    // An unreadable value must not become permission to prepare a message.
    const odd = JSON.stringify({ ...toShared(brief()), outbound: "always" });

    expect(fromFile(odd).brief?.outbound).toBe("never");
  });

  it("clamps limits rather than believing them", () => {
    const greedy = JSON.stringify({
      ...toShared(brief()),
      limits: { maxSteps: 10_000, maxMinutes: 9_999 }
    });

    const read = fromFile(greedy);

    expect(read.brief?.limits.maxSteps).toBe(200);
    expect(read.brief?.limits.maxMinutes).toBe(120);
  });

  it("refuses a version it does not know rather than half-reading it", () => {
    // A brief that half-loaded would run with limits nobody chose.
    const future = JSON.stringify({ ...toShared(brief()), version: BRIEF_FILE_VERSION + 1 });

    expect(fromFile(future).ok).toBe(false);
    expect(fromFile(future).said).toContain("different version");
  });

  it("answers rather than throwing on anything that is not a brief", () => {
    for (const text of ["", "not json", "{}", '{"kind":"something-else"}', "[]"]) {
      const read = fromFile(text);
      expect(read.ok).toBe(false);
      expect(read.said.length).toBeGreaterThan(0);
    }
  });
});
