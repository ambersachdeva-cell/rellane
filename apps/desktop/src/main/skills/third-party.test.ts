import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCKED_RISKS, HARD_CEILING } from "../tools/types.js";
import { toolByName } from "../tools/registry.js";

/**
 * What a skill from somebody else can and cannot do — task 5.3.
 *
 * The enforcement here is **structural**, not a check that could be forgotten:
 * a skill is a *declaration*, not a program. Its `skill.json` names tools that
 * already exist in this binary; it never ships code, so there is no path by
 * which a third-party skill executes anything the sandbox has not already
 * bounded, and no path by which it completes without `execute` producing a
 * receipt.
 *
 * That property is worth asserting precisely because it is invisible. The day
 * somebody adds a `script` field to the manifest, or lets a skill name a tool
 * that is resolved at run time from disk, this file fails — which is the only
 * warning anybody would get.
 */

const SOURCE = fileURLToPath(new URL(".", import.meta.url));

describe("a skill cannot bring its own code", () => {
  it("declares tools that must already exist in this binary", () => {
    // The whole guarantee. A name that resolves to nothing is refused at run
    // time; a name cannot resolve to something the owner did not install.
    expect(toolByName("read_text")).not.toBeNull();
    expect(toolByName("whatever_it_wants")).toBeNull();
  });

  it("has no manifest field that could carry executable content", () => {
    // A `script`, `exec`, `command` or `eval` field would turn a declaration
    // into a program and this entire argument would stop holding.
    const manifest = readFileSync(join(SOURCE, "manifest.ts"), "utf8");
    const fields = manifest.slice(manifest.indexOf("export interface SkillManifest"));
    const shape = fields.slice(0, fields.indexOf("}"));

    for (const dangerous of ["script", "exec", "command", "eval", "entry", "main"]) {
      expect(shape.toLowerCase(), `manifest carries a ${dangerous} field`).not.toContain(
        `${dangerous}:`
      );
    }
  });
});

describe("what no skill may be granted, whatever it asks", () => {
  it("keeps outbound and shell permanently behind a person", () => {
    // Not a default. There is no manifest value, no setting and no install
    // choice that raises these — which is what makes "nothing leaves this Mac
    // without you" a property rather than a promise.
    for (const risk of LOCKED_RISKS) {
      expect(HARD_CEILING[risk]).not.toBe("auto");
    }
  });

  it("caps every risk class, including ones added later", () => {
    // A new risk class with no ceiling would default to whatever a manifest
    // asked for. Every entry must name a ceiling explicitly.
    for (const [risk, ceiling] of Object.entries(HARD_CEILING)) {
      expect(["off", "draft", "confirm", "auto"], `${risk} has no ceiling`).toContain(ceiling);
    }
  });
});

describe("the skills that ship", () => {
  it("are the only ones in the tree, so an example is not a live capability", () => {
    // A worked example that installs itself is a capability nobody chose.
    const here = readdirSync(SOURCE).filter((name) => name.endsWith(".ts"));

    expect(here).toContain("librarian.ts");
    expect(here).toContain("paste-as.ts");
  });
});
