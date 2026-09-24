#!/usr/bin/env node
/**
 * A generated test must be seen failing before it is allowed to pass.
 *
 * ## Why this exists
 *
 * The crew's Tester writes tests against a task's stated done-when, never having
 * read the implementation. That is the right shape — a test written from the
 * spec cannot be bent by the code's mistakes — and it has one failure mode that
 * matters more than wrongness: **vacuity**. A test that passes against the new
 * code *and would also have passed before it was written* asserts nothing, and
 * nothing about it looks wrong. It is green. It is in the suite. It is counted.
 *
 * So every generated test is run twice, and must be **red** the first time.
 *
 * ## Against a stub tree, not a missing file
 *
 * The naive version of this is defeated in one line, and a reviewer defeated it
 * before it was built:
 *
 * ```ts
 * import { Case } from "./case.js";
 * expect(Case).toBeDefined();
 * ```
 *
 * Against a tree where `case.ts` does not exist that fails — with a module
 * resolution error, which vitest reports as a failing test. Against the
 * Builder's diff it passes. The gate sees red then green and certifies a test
 * that checks nothing.
 *
 * The red run therefore happens against a **stub tree**: the same files, the
 * same exported names, every function present and throwing `not implemented`.
 * An existence assertion is now green on both sides and is rejected. A test that
 * asserts what the thing *does* is still red against the stub, and that is the
 * only red worth counting.
 *
 * ## What it does not do
 *
 * It does not judge whether a test is *good*. It answers one question — does
 * this test distinguish the implementation from nothing at all — and a human
 * still reads what survives. A gate that claimed more than that would be the
 * same mistake it exists to catch.
 *
 * Usage:
 *   scripts/red-green.mjs --test <path/to/file.test.ts> --impl <path/to/impl.ts>
 *   scripts/red-green.mjs --test a.test.ts --impl a.ts --impl b.ts
 */

import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function parseArgs(argv) {
  const out = { impl: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--test") out.test = argv[++i];
    else if (argv[i] === "--impl") out.impl.push(argv[++i]);
    else if (argv[i] === "--quiet") out.quiet = true;
  }
  return out;
}

/**
 * Replaces every function body with a throw, keeping every signature.
 *
 * **Parsed, not pattern-matched.** The first version of this used regular
 * expressions and was wrong within a minute of being run: a function returning
 * an object type — `): { readonly open: number } {` — has braces inside its
 * return type, the pattern could not tell those from the body's, and it emitted
 * syntax errors. Every test then failed to compile, every run looked red, and
 * **the gate cheerfully certified a test that asserts nothing** — which is
 * precisely the failure it exists to prevent, reproduced inside the tool.
 *
 * That is worth keeping as a comment, because a broken gate is more dangerous
 * than no gate: it reports safety it is not providing.
 *
 * TypeScript is already a dependency, so its own parser finds the bodies and
 * this only rewrites the exact character ranges they occupy. Types, interfaces
 * and constants are untouched — a test importing a type is not asserting
 * behaviour with it, and types are erased before the test ever runs.
 */
/**
 * Walks source, skipping anything a brace could hide inside.
 *
 * Strings, template literals, regexes and comments all contain braces that mean
 * nothing, and every one of them has broken a naive scanner at some point. This
 * returns the index of the next `char` that is genuinely code.
 */
function scanFor(source, from, predicate) {
  let i = from;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") { i = source.indexOf("\n", i); if (i === -1) return -1; continue; }
    if (c === "/" && next === "*") { const e = source.indexOf("*/", i + 2); if (e === -1) return -1; i = e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    const verdict = predicate(c, i);
    if (verdict === true) return i;
    i += 1;
  }
  return -1;
}

/** The index just past the `}` matching the `{` at `open`. */
function matchBrace(source, open) {
  let depth = 0;
  let closed = -1;
  scanFor(source, open, (c, i) => {
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) { closed = i; return true; } }
    return false;
  });
  return closed === -1 ? -1 : closed + 1;
}

/**
 * Replaces every function body with a throw, keeping every signature.
 *
 * **The first version used regular expressions and was wrong within a minute.**
 * A function returning an object type — `): { readonly open: number } {` — has
 * braces inside its return type, the pattern could not tell those from the
 * body's, and it emitted syntax errors. Every test then failed to compile, every
 * run looked red, and **the gate cheerfully certified a test that asserts
 * nothing** — precisely the failure it exists to prevent, reproduced inside the
 * tool. That is worth keeping written down, because a broken gate is worse than
 * no gate: it reports a safety it is not providing.
 *
 * TypeScript's own parser was the obvious fix and is not available — the version
 * pinned here is the Go rewrite, whose package does not expose the old compiler
 * API. So: a scanner that knows what a brace can hide inside, plus one rule for
 * the case that broke it.
 *
 * **The rule.** After a signature, the body is the *last* brace group in the
 * chain. `): { open: number } {` is a type group followed by a body group; a
 * plain `): string {` is one group and that group is the body. Matching each
 * candidate and asking whether another `{` follows it settles which is which
 * without needing to understand types at all.
 */
export function stub(source) {
  const edits = [];
  const declaration = /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gu;

  for (const match of source.matchAll(declaration)) {
    const name = match[1];
    const paramsAt = scanFor(source, match.index + match[0].length, (c) => c === "(");
    if (paramsAt === -1) continue;

    // Skip the parameter list by paren depth — defaults can contain calls.
    let depth = 0;
    let afterParams = -1;
    scanFor(source, paramsAt, (c, i) => {
      if (c === "(") depth += 1;
      else if (c === ")") { depth -= 1; if (depth === 0) { afterParams = i + 1; return true; } }
      return false;
    });
    if (afterParams === -1) continue;

    // Walk brace groups until one is not followed by another. That last one is
    // the body; everything before it was a return type.
    let cursor = afterParams;
    let bodyStart = -1;
    let bodyEnd = -1;
    for (let guard = 0; guard < 8; guard += 1) {
      const brace = scanFor(source, cursor, (c) => c === "{" || c === ";");
      if (brace === -1 || source[brace] === ";") break;      // an overload, no body
      const close = matchBrace(source, brace);
      if (close === -1) break;
      bodyStart = brace;
      bodyEnd = close;
      const following = scanFor(source, close, (c) => !/\s/u.test(c));
      if (following === -1 || source[following] !== "{") break;
      cursor = close;
    }

    if (bodyStart !== -1) {
      edits.push({
        start: bodyStart,
        end: bodyEnd,
        text: `{ throw new Error("not implemented: ${name}"); }`
      });
    }
  }

  // Applied back to front so an earlier edit never shifts a later one's range.
  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

function vitest(target, cwd) {
  return new Promise((resolve) => {
    execFile(
      path.join(REPO, "node_modules", ".bin", "vitest"),
      ["run", target, "--pool", "threads", "--maxWorkers", "1"],
      { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 },
      (error, stdout, stderr) => resolve({ passed: error === null, output: `${stdout}${stderr}` })
    );
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.test === undefined || args.impl.length === 0) {
    console.error("red-green: --test <file> and at least one --impl <file> are required.");
    process.exit(64);
  }

  const say = (line) => { if (args.quiet !== true) console.log(line); };

  // The originals are put back in a finally, including when this is killed —
  // leaving a repository full of stubs would be a far worse failure than any
  // this script is trying to prevent.
  const keep = await mkdtemp(path.join(tmpdir(), "red-green-"));
  const saved = [];
  const restore = async () => {
    for (const { original, backup } of saved) {
      await copyFile(backup, original);
    }
    await rm(keep, { recursive: true, force: true });
  };
  process.on("SIGINT", () => { void restore().then(() => process.exit(130)); });
  process.on("SIGTERM", () => { void restore().then(() => process.exit(143)); });

  let verdict = 0;
  try {
    for (const [index, file] of args.impl.entries()) {
      const original = path.resolve(REPO, file);
      const backup = path.join(keep, `${index}-${path.basename(file)}`);
      await copyFile(original, backup);
      saved.push({ original, backup });
      await writeFile(original, stub(await readFile(original, "utf8")), "utf8");
    }
    say(`stubbed ${args.impl.length} file(s); every exported function now throws.`);

    const red = await vitest(args.test, REPO);
    if (red.passed) {
      console.error(
        `\nREJECTED — vacuous.\n\n` +
          `${args.test} passes against a tree where every implementation throws.\n` +
          `It distinguishes the code from nothing at all, which means it asserts nothing.\n` +
          `The usual cause is asserting that something exists rather than what it does.\n`
      );
      verdict = 1;
    } else {
      say("red against the stub tree — good, it is testing behaviour.");
    }
  } finally {
    await restore();
  }

  if (verdict !== 0) {
    process.exit(verdict);
  }

  const green = await vitest(args.test, REPO);
  if (!green.passed) {
    console.error(`\nFAILED — red against the real implementation too.\n`);
    console.error(green.output.slice(-4000));
    process.exit(2);
  }

  console.log("\nred against the stub, green against the implementation. Not vacuous.");
}

// Only run when invoked directly, so `stub` can be unit-tested.
if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((error) => { console.error("red-green:", error); process.exit(1); });
}
