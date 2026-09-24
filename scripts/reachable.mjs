/**
 * What actually runs, walked from the entrypoints the app is built from.
 *
 * D-112: eleven modules were written, tested, and never reachable. `grep` proves
 * somebody wrote it; only the import graph from a real entrypoint proves the
 * shipped binary can get there (D-043). This walks that graph and prints what it
 * never arrives at, so the next orphan is caught the day it is written rather
 * than in an audit months later.
 *
 * Tests are not entrypoints. A module with a passing suite and no path from
 * `index.ts` is exactly the failure this exists to find.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? "apps/desktop/src");
const ENTRIES = [
  "apps/desktop/src/main/index.ts",
  "apps/desktop/src/main/storage-capability-probe.ts",
  "apps/desktop/src/main/durable-spaces-gate.ts",
  "apps/desktop/src/preload/index.ts",
  "apps/desktop/src/renderer/main.tsx",
  "apps/desktop/src/renderer/overlay.tsx",
  // Real, and deliberately not shipped: `review.html` is served by the dev
  // server and listed in no build input, so it reaches no bundle. It is still
  // an entrypoint — a page somebody opens — and counting it as an orphan would
  // teach this audit to cry wolf about the one file that exists to be looked at.
  "apps/desktop/src/renderer/review.tsx"
].filter((p) => existsSync(p)).map((p) => resolve(p));

const IMPORT = /(?:^|[\s;])(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/gu;

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith(".")) return null;          // package — not our tree
  const base = resolve(dirname(fromFile), spec);
  const tries = [
    base.replace(/\.js$/u, ".ts"),
    base.replace(/\.js$/u, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    base
  ];
  for (const t of tries) {
    if (existsSync(t) && statSync(t).isFile()) return t;
  }
  return null;
}

const seen = new Set();
const queue = [...ENTRIES];
while (queue.length > 0) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec === undefined) continue;
    const next = resolveSpec(file, spec);
    if (next !== null && !seen.has(next)) queue.push(next);
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name) && !/\.d\.ts$/u.test(name)) out.push(full);
  }
  return out;
}

const all = walk(ROOT);
const orphans = all.filter((f) => !seen.has(f)).sort();
let lines = 0;
for (const f of orphans) {
  const n = readFileSync(f, "utf8").split("\n").length;
  lines += n;
  console.log(`${String(n).padStart(5)}  ${relative(process.cwd(), f)}`);
}
console.log(`\n${orphans.length} unreachable of ${all.length} modules, ${lines} lines.`);
process.exit(0);
