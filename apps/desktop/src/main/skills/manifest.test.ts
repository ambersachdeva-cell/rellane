import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describePermissions, describeWatch, loadSkills, parseManifest } from "./manifest.js";

const GOOD = {
  id: "librarian",
  name: "Desktop Librarian",
  description: "Tidy a folder",
  version: "1.0.0",
  author: "Rellane",
  tools: ["list_folder", "move_file"],
  autonomy: { read: "auto", write: "confirm" },
  triggers: ["organise", "tidy"]
};

describe("parsing a manifest from someone else", () => {
  it("accepts a sound one", () => {
    const result = parseManifest(GOOD);
    expect(result.ok).toBe(true);
    expect(result.ok && result.manifest.id).toBe("librarian");
  });

  it("collects every problem at once", () => {
    // Someone installing a stranger's skill deserves the whole list, not a
    // sequence of one-at-a-time refusals.
    const result = parseManifest({ id: "Bad ID!", version: "one", tools: [] });
    expect(result.ok).toBe(false);
    const fields = result.ok === false ? result.problems.map((p) => p.field) : [];
    expect(fields).toEqual(expect.arrayContaining(["id", "name", "version", "tools"]));
  });

  it("refuses a skill that calls no tools", () => {
    const result = parseManifest({ ...GOOD, tools: [] });
    expect(result.ok).toBe(false);
  });

  it("refuses an invented risk class rather than ignoring it", () => {
    const result = parseManifest({ ...GOOD, autonomy: { everything: "auto" } });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems[0]?.problem).toMatch(/no risk class/u);
  });

  it("refuses an invented autonomy level", () => {
    const result = parseManifest({ ...GOOD, autonomy: { read: "always" } });
    expect(result.ok).toBe(false);
  });

  it("refuses anything that is not a manifest at all", () => {
    for (const junk of [null, 42, "text", []]) {
      expect(parseManifest(junk).ok).toBe(false);
    }
  });
});

describe("watch triggers", () => {
  it("accepts a folder watch and clamps the settle delay", () => {
    const result = parseManifest({
      ...GOOD,
      watch: { kind: "folder", path: "/Users/amber/Downloads", settleMs: 999_999 }
    });
    expect(result.ok && result.manifest.watch).toMatchObject({ kind: "folder", settleMs: 300_000 });
  });

  it("requires an absolute path", () => {
    expect(parseManifest({ ...GOOD, watch: { kind: "folder", path: "Downloads" } }).ok).toBe(false);
  });

  it("validates a schedule", () => {
    expect(parseManifest({ ...GOOD, watch: { kind: "schedule", hour: 9, minute: 30 } }).ok).toBe(true);
    expect(parseManifest({ ...GOOD, watch: { kind: "schedule", hour: 25, minute: 0 } }).ok).toBe(false);
  });

  it("refuses an unknown trigger kind", () => {
    expect(parseManifest({ ...GOOD, watch: { kind: "whenever" } }).ok).toBe(false);
  });

  it("describes a trigger in plain words", () => {
    expect(describeWatch({ kind: "schedule", hour: 9, minute: 5 })).toMatch(/every day at 09:05/u);
  });
});

describe("what installing it would permit", () => {
  it("says it in the owner's words, not in risk classes", () => {
    const manifest = parseManifest(GOOD);
    const lines = describePermissions(manifest.ok ? manifest.manifest : ({} as never));
    expect(lines.join(" ")).toMatch(/read files in the folders you grant without asking/u);
    expect(lines.join(" ")).toMatch(/move and change files.*after asking you each time/u);
    expect(lines.join(" ")).not.toMatch(/risk|autonomy/iu);
  });

  it("shows what a skill will actually get, not what it asked for", () => {
    // Asking for outbound "auto" is capped at confirm by the platform ceiling,
    // and the install dialogue must not promise the higher one.
    const manifest = parseManifest({ ...GOOD, autonomy: { outbound: "auto" } });
    const lines = describePermissions(manifest.ok ? manifest.manifest : ({} as never));
    expect(lines.join(" ")).toMatch(/send messages.*after asking you each time/u);
    expect(lines.join(" ")).not.toMatch(/send messages.*without asking/u);
  });

  it("says plainly when a skill does nothing on its own", () => {
    const manifest = parseManifest({ ...GOOD, autonomy: {} });
    expect(describePermissions(manifest.ok ? manifest.manifest : ({} as never))).toEqual([
      "It does nothing on its own."
    ]);
  });
});

describe("loading a folder of skills", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cadrane-skills-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads the good ones and reports the broken ones", async () => {
    await mkdir(join(dir, "good"));
    await writeFile(join(dir, "good", "skill.json"), JSON.stringify(GOOD));
    await mkdir(join(dir, "broken"));
    await writeFile(join(dir, "broken", "skill.json"), "{ not json");
    await mkdir(join(dir, "invalid"));
    await writeFile(join(dir, "invalid", "skill.json"), JSON.stringify({ id: "x" }));

    const result = await loadSkills(dir);

    expect(result.loaded.map((s) => s.id)).toEqual(["librarian"]);
    expect(result.rejected).toHaveLength(2);
    // A broken skill is named, not silently dropped.
    expect(result.rejected.map((r) => r.folder).join(" ")).toMatch(/broken/u);
  });

  it("ignores folders without a manifest and dotfolders", async () => {
    await mkdir(join(dir, "notaskill"));
    await mkdir(join(dir, ".hidden"));
    const result = await loadSkills(dir);
    expect(result.loaded).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it("returns empty rather than throwing when the directory is absent", async () => {
    const result = await loadSkills(join(dir, "nope"));
    expect(result.loaded).toHaveLength(0);
  });
});

describe("a skill that asks for more than it can have", () => {
  it("says so, rather than quietly showing what it got", () => {
    // Showing only the effective permission is accurate and incomplete: the
    // skill gets `confirm` either way, and the owner never learns it tried.
    // That reach is the difference between a skill that fits the rules and one
    // that would ignore them given the chance.
    const said = describePermissions({
      id: "greedy",
      name: "Greedy",
      description: "d",
      version: "1.0.0",
      author: "a",
      tools: ["move_file"],
      autonomy: { outbound: "auto" },
      triggers: [],
      watch: null
    });

    expect(said.join(" ")).toContain("asked for more than that");
    expect(said.join(" ")).toContain("does not allow it");
    // Never the phrase it was refused: a person skimming reads the first half.
    expect(said.join(" ")).not.toMatch(/send messages.*without asking/u);
  });

  it("stays quiet when a skill asked for exactly what it can have", () => {
    // A warning on every row is a warning nobody reads.
    const said = describePermissions({
      id: "polite",
      name: "Polite",
      description: "d",
      version: "1.0.0",
      author: "a",
      tools: ["read_text"],
      autonomy: { read: "auto" },
      triggers: [],
      watch: null
    });

    expect(said.join(" ")).not.toContain("does not allow");
  });
});
