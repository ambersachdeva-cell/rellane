import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The dependency rule, enforced — task 0.9.
 *
 * The plan asks for this "enforced by lint". There is no ESLint in this repo,
 * and adding a linter and its plugin tree to enforce dependency discipline would
 * be a joke at its own expense. This repo already enforces configuration rules
 * with tests — `macos-plist-hardening.test.ts` reads `tsup.config.ts` as text
 * and asserts what it must contain — so this follows that, and costs nothing.
 *
 * ## Why the rule exists
 *
 * Every runtime dependency is code that ships to the owner's Mac, that we do not
 * read, that can be taken over upstream, and that has to keep working for as
 * long as the product does. `node:sqlite` was chosen over `better-sqlite3`
 * precisely to avoid a native module (D-006); the bundle is small because
 * nothing was added without a reason.
 *
 * This is not a ban. It is a **speed bump**: adding a dependency means editing
 * this list, which means saying in the commit why it earned its place.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));

/**
 * Everything allowed to ship at runtime, and why each is here.
 *
 * Devtime packages are unconstrained — they never reach a customer.
 */
const ALLOWED_RUNTIME: Readonly<Record<string, string>> = {
  react: "The renderer. Pinned exactly so a build is reproducible.",
  "react-dom": "The renderer's host bindings; inseparable from react and pinned with it.",
  zod: "Validates everything crossing the IPC boundary — the one place a schema library earns its size.",
  docx: "Editable Word export from a reviewed workroom version, fully bundled with pinned dependencies and licence notices; no hosted converter.",
  jszip: "Already shipped by docx; stream only a bounded Word body for source previews, without extracting files or following links.",
  "xml-js": "Already shipped by docx; preserve Word paragraph order in a bounded, non-compact parse, rejecting entity declarations.",
  "@fontsource/ibm-plex-sans": "Bundled so the interface never depends on a font CDN being reachable.",
  "@fontsource/ibm-plex-serif": "The display face, bundled for the same reason as the sans.",
  "@fontsource/ibm-plex-mono": "Paths, ids and amounts need tabular figures that line up in columns.",
  "@fontsource/ibm-plex-sans-devanagari": "Hindi and Hinglish are ordinary in this data, not an edge case.",
  "markdown-it": "Replaces a 4.5 KB hand-rolled parser that could not render a table, so a real model answer reached the owner as pipe soup. Used through its token API only — `md.parse`, never `md.render` — so model output still never becomes an HTML string.",
  shiki: "VS Code's own TextMate grammars, 302 languages, light and dark in one pass. Reviewing generated code is the thing this app is most used for. Imported dynamically, so none of its 12 MB reaches the initial bundle.",
  katex: "Models write LaTeX constantly and it was shown as backslashes. Rendered through katex's DOM API with `trust: false`, so no \\href or \\includegraphics in model output can become active content. Imported dynamically.",
  "fuse.js": "440 KB. The palette the owner reaches for most was a `.includes()` filter that failed on a single typo or a different word order. Typo tolerance and match positions are the whole feature.",
  mermaid: "Models answer process questions with diagrams and the owner was shown the source. Imported dynamically and only after a cheap structural check, initialised with `securityLevel: \"strict\"`, and it sanitises its own SVG with DOMPurify.",
  lexical: "Structured, editable document drafts in Studio, with explicit save and preserved local draft state; pinned to one reviewed editor version.",
  "@lexical/react": "React bindings for the Studio document editor and its controlled update, history, and rich-text plugins.",
  "@lexical/rich-text": "Heading and quotation nodes for editable Studio documents instead of flattening them to plain text.",
  "@lexical/list": "Editable ordered and unordered list nodes in Studio documents.",
  "@lexical/link": "Editable link nodes in Studio documents, handled within the editor boundary.",
  "@lexical/code": "Editable code blocks in Studio documents without a second editor runtime.",
  "@lexical/markdown": "Imports and exports the Studio editor's Markdown representation without a hand-written converter.",
  "cron-parser": "Pinned recurrence parser for bounded schedule preview and occurrence calculation, replacing ad hoc cron interpretation.",
  "@cadrane/contracts": "Workspace package in this repository, not third-party code.",
  "@cadrane/daemon": "Workspace package in this repository, not third-party code.",
  "@cadrane/runtime": "Workspace package in this repository, not third-party code."
};

async function packageJson(relative: string): Promise<{
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}> {
  return JSON.parse(await readFile(new URL(relative, `file://${HERE}`), "utf8")) as never;
}

describe("what ships to the owner's Mac", () => {
  it("adds no runtime dependency without a deliberate edit here", async () => {
    // The speed bump. A new name in either list fails this test, and the fix is
    // to write down why it earned its place.
    for (const relative of [
      "../../package.json",
      "../../../daemon/package.json",
      "../../../../packages/contracts/package.json",
      "../../../../packages/runtime/package.json"
    ]) {
      const { dependencies = {} } = await packageJson(relative);
      for (const name of Object.keys(dependencies)) {
        expect(ALLOWED_RUNTIME, `${relative} pulls in ${name}`).toHaveProperty(name);
      }
    }
  });

  it("keeps every runtime dependency pinned, never caret-ranged", async () => {
    // A caret range means the build is not reproducible and an upstream
    // compromise arrives on the next install. Workspace links are exempt: they
    // are this repository.
    const { dependencies = {} } = await packageJson("../../package.json");
    for (const [name, range] of Object.entries(dependencies)) {
      if (range.startsWith("workspace:")) {
        continue;
      }
      if (name.startsWith("@fontsource/")) {
        // Fonts are content, not code, and are the one place a range is
        // tolerable. Called out rather than silently skipped.
        continue;
      }
      expect(range, `${name} is ranged, not pinned`).toMatch(/^\d+\.\d+\.\d+$/u);
    }
  });

  it("states a reason for each thing it allows", async () => {
    // A list nobody has to justify becomes a list anybody can append to.
    for (const [name, why] of Object.entries(ALLOWED_RUNTIME)) {
      expect(why.length, `${name} has no stated reason`).toBeGreaterThan(8);
    }
  });
});

describe("the size that discipline buys", () => {
  it("keeps the main bundle under its budget", async () => {
    // Measured, not asserted from memory. The number is generous enough not to
    // fail on an ordinary feature and tight enough that pulling in something
    // large is noticed on the commit that does it, rather than a year later.
    const bundle = await stat(new URL("../../dist/main/index.cjs", `file://${HERE}`));

    expect(bundle.size).toBeLessThan(3 * 1024 * 1024);
  });
});

describe("what the shipping tree is licensed under", () => {
  /**
   * The attribution obligation, held by a test rather than by remembering.
   *
   * `docs/OPEN-SOURCE-ADOPTION.md` records the licence *decisions* and why each
   * dependency is here. It is a design document, and it goes stale the moment
   * somebody runs `npm install`. `NOTICES.md` is the compliance artefact,
   * generated by `scripts/notices.mjs` from the installed production tree, and
   * this asserts the two things about it that actually matter.
   */
  const notices = async (): Promise<string> =>
    readFile(new URL("../../../../NOTICES.md", `file://${HERE}`), "utf8");

  it("ships attribution at all", async () => {
    // Attribution is the one obligation MIT and Apache-2.0 genuinely impose:
    // the notice has to travel with the software. A list in a design doc that
    // nobody regenerates is not that.
    const text = await notices();

    expect(text).toContain("Third-party notices");
    expect(text).toContain("llama.cpp");
    expect(text).toContain("Qwen3");
  });

  it("contains no copyleft licence", async () => {
    // Rellane is a private product that is meant to be sold. GPL or AGPL in the
    // shipping tree is not a licensing footnote — it is a demand to publish the
    // source of the thing being sold, and by the time it is noticed it is
    // load-bearing. Measured 2026-09-04: 337 packages, all permissive.
    //
    // MPL-2.0 is deliberately allowed. It is file-level copyleft, so shipping an
    // unmodified copy carries no obligation over the rest of the app.
    const text = await notices();
    const forbidden = ["AGPL", "GPL-2.0", "GPL-3.0", "LGPL", "SSPL", "CC-BY-NC"];

    for (const licence of forbidden) {
      expect(text.includes(`### ${licence}`), `${licence} is in the shipping tree`).toBe(false);
    }
  });
});
