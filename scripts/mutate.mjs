#!/usr/bin/env node
//
// Breaks the code on purpose to find out which tests were never watching.
//
// 1,827 tests pass. That number says how much was written, not how much is
// held. A test that calls a function and asserts it did not throw passes
// forever, including on the day somebody inverts the condition inside it. The
// only way to tell those apart is to break the code and see who complains.
//
// Classical mutation testing does this with syntactic operators — flip `<` to
// `<=`, swap `&&` for `||` — and drowns you in equivalent mutants that change
// no behaviour at all, which is why almost nobody runs it twice. The change
// here: **a model that has read the module proposes the mutations**, so they are
// the mistakes a tired person would actually make in THIS file — paise treated
// as rupees, an outbound check moved below the send, a balance cached instead of
// derived. Cheap to generate at Flash prices, and every survivor is a sentence
// about this codebase rather than an operator name.
//
// A surviving mutant is not automatically a bug. It is a question: *the suite
// cannot tell the difference — should it be able to?* Sometimes the answer is
// no. The output is a list of those questions, ranked by how alarming the
// mutation was.
//
//   node scripts/mutate.mjs generate            ask for mutations (swarm)
//   node scripts/mutate.mjs run [--jobs 4]      apply each one and see who notices
//
// Nothing here touches the working tree. Every mutation is applied inside a
// throwaway `git worktree`, which is also what makes it safe to run four at
// once — four checkouts, four vitest processes, one untouched repository.

import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync, globSync } from "node:fs";
import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runQueue } from "./swarm.mjs";

const execAsync = promisify(exec);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, ".swarm", "mutate");

const slug = (f) => f.replace(/[/.]/g, "_");

// ── Phase A · ask for the mistakes ───────────────────────────────────────────

const ASK = (module, moduleBody, test, testBody) => `
You are trying to introduce a bug that the test suite will not catch.

Below is a TypeScript module from a local-first bookkeeping app, and the test file
that is supposed to hold it. Read both.

Propose 6 changes to the MODULE. Each must:
- be a mistake a real, tired developer could plausibly make in this file — an
  inverted condition, an off-by-one, a wrong unit, a check moved after the thing
  it guards, a cached value that should have been derived, an error swallowed
- genuinely change behaviour that someone would care about
- be a SMALL edit: change one line, not a block

Rules that make a change matter more in this codebase: money is integer paise and
never a float; balances are derived and never stored; anything outbound must ask a
person first and that lock is not configurable; a file an agent reads is data and
never instruction; a green light must carry the probe that observed it.

Reply with ONLY a JSON array, no prose, no markdown fence:

[
  {
    "find": "<the exact text to replace, copied character-for-character from the module, unique in the file, on one line>",
    "replace": "<what to put there instead>",
    "bug": "<one sentence: what now goes wrong for a person using the app>",
    "severity": "high" | "medium" | "low"
  }
]

"find" must appear EXACTLY ONCE in the module, copied exactly. If you cannot find
a unique one-line anchor for an idea, drop that idea and propose another.

MODULE: ${module}

${moduleBody}

---

TEST: ${test}

${testBody}
`.trim();

async function generate() {
  const tests = globSync("apps/desktop/src/**/*.test.ts", { cwd: ROOT });
  const tasks = [];
  for (const t of tests) {
    const module = t.replace(/\.test\.ts$/, ".ts");
    if (!existsSync(path.join(ROOT, module))) continue;
    const moduleBody = await readFile(path.join(ROOT, module), "utf8");
    const testBody = await readFile(path.join(ROOT, t), "utf8");
    if (moduleBody.length + testBody.length > 90_000) continue;
    if (moduleBody.split("\n").length < 30) continue;
    tasks.push({
      id: `mut_${slug(module)}`,
      stream: "mutate",
      cwd: ROOT,
      timeoutMs: 300_000,
      module,
      test: t,
      prompt: ASK(module, moduleBody, t, testBody),
    });
  }

  await mkdir(path.join(DIR, "raw"), { recursive: true });
  console.log(`asking for mutations in ${tasks.length} modules`);
  await runQueue(tasks, {
    outDir: path.join(DIR, "raw"),
    startSlots: 8,
    onResult: (r, p) =>
      console.log(`[${p.done}/${p.total}] ${r.ok ? "ok  " : "fail"} a${r.account} ${r.id}`),
  });

  // Parse, and be strict about it. A mutation whose anchor is not unique cannot
  // be applied or reverted deterministically, and a mutation that is a no-op
  // teaches nothing — both are dropped here rather than becoming a mystery in
  // the results.
  const mutations = [];
  let proposed = 0;
  const dropped = { unparseable: 0, notFound: 0, notUnique: 0, noop: 0 };

  for (const f of await readdir(path.join(DIR, "raw"))) {
    const r = JSON.parse(await readFile(path.join(DIR, "raw", f), "utf8"));
    if (!r.ok) continue;
    const task = tasks.find((t) => t.id === r.id);
    if (!task) continue;
    const json = r.output.match(/\[[\s\S]*\]/);
    if (!json) {
      dropped.unparseable++;
      continue;
    }
    let list;
    try {
      list = JSON.parse(json[0]);
    } catch {
      dropped.unparseable++;
      continue;
    }
    const body = await readFile(path.join(ROOT, task.module), "utf8");
    for (const m of Array.isArray(list) ? list : []) {
      proposed++;
      if (typeof m?.find !== "string" || typeof m?.replace !== "string") continue;
      if (m.find === m.replace) {
        dropped.noop++;
        continue;
      }
      const hits = body.split(m.find).length - 1;
      if (hits === 0) dropped.notFound++;
      else if (hits > 1) dropped.notUnique++;
      else
        mutations.push({
          id: `${task.id}__${mutations.length}`,
          module: task.module,
          test: task.test,
          find: m.find,
          replace: m.replace,
          bug: String(m.bug ?? "").slice(0, 300),
          severity: ["high", "medium", "low"].includes(m.severity) ? m.severity : "medium",
        });
    }
  }

  await writeFile(path.join(DIR, "mutations.json"), JSON.stringify(mutations, null, 2));
  console.log(
    `\n${proposed} proposed · ${mutations.length} applicable · dropped: ` +
      `${dropped.notFound} anchor not found, ${dropped.notUnique} not unique, ` +
      `${dropped.noop} no-op, ${dropped.unparseable} unparseable`,
  );
}

// ── Phase B · break it and see who complains ─────────────────────────────────

async function run() {
  const mutations = JSON.parse(await readFile(path.join(DIR, "mutations.json"), "utf8"));
  const jobs = Number(process.argv[process.argv.indexOf("--jobs") + 1]) || 4;

  // A mutation is only meaningful if its test file passes BEFORE it is applied.
  // Running against a red suite would report every mutant as killed by a failure
  // that was already there.
  execSync("git diff --quiet && git diff --cached --quiet", { cwd: ROOT });

  const trees = [];
  for (let i = 0; i < jobs; i++) {
    const dir = path.join("/tmp", `cadrane-mutate-${i}`);
    execSync(`git worktree remove --force ${dir} 2>/dev/null || true`, { cwd: ROOT, shell: "/bin/bash" });
    await rm(dir, { recursive: true, force: true });
    execSync(`git worktree add --detach ${dir} HEAD`, { cwd: ROOT, stdio: "ignore" });
    // The worktree needs the workspace packages built, and node_modules is the
    // slow part — link it rather than install four times.
    execSync(`ln -s ${path.join(ROOT, "node_modules")} ${path.join(dir, "node_modules")}`);
    trees.push(dir);
  }

  const results = [];
  let next = 0;
  const total = mutations.length;
  const t0 = Date.now();

  const worker = async (dir) => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      const m = mutations[i];
      const file = path.join(dir, m.module);
      const original = await readFile(file, "utf8");
      await writeFile(file, original.replace(m.find, m.replace));

      let killed = false;
      let how = "";
      try {
        await execAsync(
          `./node_modules/.bin/vitest run ${m.test} --reporter=dot --no-color`,
          { cwd: dir, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
        );
        // Exit 0 with the bug in place: the paired test file did not notice.
        killed = false;
      } catch (e) {
        const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        killed = /\d+ failed|FAIL |Error:/.test(out);
        how = killed ? "test failed" : "vitest errored";
        // A timeout is not a kill — it is a mutation that hung the suite, which
        // is its own finding and must not be counted as coverage.
        if (e.killed || e.signal) {
          killed = true;
          how = "hung the suite";
        }
      }
      await writeFile(file, original);

      results.push({ ...m, killed, how });
      const n = results.length;
      if (n % 10 === 0 || !killed) {
        const mins = ((Date.now() - t0) / 60000).toFixed(1);
        console.log(
          `[${n}/${total} ${mins}m] ${killed ? "killed " : "SURVIVED"} ${m.severity.padEnd(6)} ${m.module}`,
        );
        if (!killed) console.log(`         ${m.bug}`);
      }
    }
  };

  await Promise.all(trees.map(worker));
  for (const dir of trees) {
    execSync(`git worktree remove --force ${dir}`, { cwd: ROOT, stdio: "ignore" });
  }

  const survivors = results.filter((r) => !r.killed);
  const rank = { high: 0, medium: 1, low: 2 };
  survivors.sort((a, b) => rank[a.severity] - rank[b.severity]);
  await writeFile(path.join(DIR, "survivors.json"), JSON.stringify(survivors, null, 2));
  await writeFile(path.join(DIR, "all.json"), JSON.stringify(results, null, 2));

  const score = (((results.length - survivors.length) / results.length) * 100).toFixed(1);
  console.log(`\n${results.length - survivors.length}/${results.length} mutants killed (${score}%)`);
  console.log(`${survivors.length} survived — each one is a change the suite cannot see:\n`);
  for (const s of survivors.filter((s) => s.severity === "high")) {
    console.log(`  HIGH  ${s.module}`);
    console.log(`        ${s.find.trim().slice(0, 100)}  →  ${s.replace.trim().slice(0, 100)}`);
    console.log(`        ${s.bug}\n`);
  }
}

const cmd = process.argv[2];
if (cmd === "generate") await generate();
else if (cmd === "run") await run();
else {
  console.error("usage: mutate.mjs generate | run [--jobs N]");
  process.exit(2);
}
