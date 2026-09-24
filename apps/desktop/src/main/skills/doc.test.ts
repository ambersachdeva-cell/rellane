import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";
import { HARD_CEILING, LOCKED_RISKS } from "../tools/types.js";

/**
 * The documented example must actually install — task 5.2.
 *
 * "Somebody outside this repo writes a working skill from the docs" is only
 * true if the example in those docs is real. A worked example that has drifted
 * from the parser is worse than none: it costs somebody an afternoon before
 * they conclude the format is undocumented.
 *
 * So the example is lifted out of the markdown and run through the same parser
 * a real install uses.
 */
const DOC = new URL("../../../../../docs/WRITING-A-SKILL.md", import.meta.url);

async function exampleFromDocs(): Promise<unknown> {
  const text = await readFile(fileURLToPath(DOC), "utf8");
  const start = text.indexOf("```json");
  const end = text.indexOf("```", start + 7);
  return JSON.parse(text.slice(start + 7, end)) as unknown;
}

describe("the example in the documentation", () => {
  it("parses as a real manifest", async () => {
    const result = parseManifest(await exampleFromDocs());

    expect(result.ok, JSON.stringify("problems" in result ? result.problems : [])).toBe(true);
  });

  it("names only tools that exist", async () => {
    const result = parseManifest(await exampleFromDocs());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.tools.length).toBeGreaterThan(0);
    }
  });
});

describe("the documentation matches the rules it describes", () => {
  it("does not promise a ceiling the code would refuse", async () => {
    // The table in the docs says outbound and shell are locked. If somebody
    // raises one in code, this fails rather than leaving a document quietly
    // telling people something untrue about their own safety.
    const text = await readFile(fileURLToPath(DOC), "utf8");

    for (const risk of LOCKED_RISKS) {
      expect(text).toContain(`\`${risk}\``);
      expect(HARD_CEILING[risk]).not.toBe("auto");
    }
  });

  it("still says that unrecognised fields are refused rather than ignored", async () => {
    // The property a skill author most needs to know, and the one most likely
    // to be softened later for convenience.
    const text = await readFile(fileURLToPath(DOC), "utf8");

    expect(text).toContain("refused, not ignored");
  });
});
