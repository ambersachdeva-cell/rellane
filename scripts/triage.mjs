#!/usr/bin/env node
//
// Six hundred reviews produce more findings than anyone will read, and roughly
// two in three are wrong. Triage is the part that makes the volume usable.
//
// D-041 is the standing rule: verify every finding before acting, because
// applying them unread adds guards for impossible states. That rule does not
// scale by reading harder. So the second model gets a second job — not "find
// defects" but "here is a claim about this code; is it true?" — which is a
// different and much easier question, with the burden of proof on the claim.
//
// Two things make the check worth more than the finding it checks:
//
//   1. **A different account answers.** Same model, different process, no memory
//      of having written the claim. It is not being asked to defend itself.
//   2. **The prompt hands it the reasons to say no.** A verifier told only to
//      check agrees, because agreeing is the shape of a helpful answer. Told that
//      most claims are wrong, and given the four ways they are usually wrong, it
//      starts finding them.
//
// This never decides anything. It sorts a thousand findings into ~a hundred that
// a person reads and the rest with a reason attached. The person is still the
// one who edits.
//
//   node scripts/triage.mjs collect            parse every result into findings
//   node scripts/triage.mjs verify             second opinion, different account
//   node scripts/triage.mjs report [--all]     what survived, grouped by file

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runQueue } from "./swarm.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SWARM = path.join(ROOT, ".swarm");
const OUT = path.join(SWARM, "triage");

// A result whose file no longer exists, or whose finding names no file, cannot
// be verified or acted on. It is dropped here rather than surviving to the
// report as an item nobody can check.
const fileOf = (id) => {
  const m = id.match(/^(?:review|drift|a11y|dpdp|threat|testbug|giant)_(.+?)(?:_\d{5})?$/);
  if (!m) return null;
  // Ids are the path with / and . flattened to _. Rebuilding it exactly is not
  // possible, so match against the real tree instead of guessing.
  const flat = m[1];
  for (const ext of ["ts", "tsx"]) {
    const guess = flat.replace(/_(ts|tsx)$/, `.${ext}`).replace(/_/g, "/");
    if (existsSync(path.join(ROOT, guess))) return guess;
  }
  const rebuilt = flat.replace(/_test_ts$/, ".test.ts").replace(/_/g, "/");
  return existsSync(path.join(ROOT, rebuilt)) ? rebuilt : null;
};

function parseFindings(text) {
  if (!text || /^\s*NONE\s*$/i.test(text)) return [];
  const out = [];
  // The asked-for shape is one line per finding, but a model that has been told
  // to be concise will still sometimes wrap. Split on the keyword, not the line.
  const chunks = text.split(/(?=FINDING:)/i).slice(1);
  for (const c of chunks) {
    const finding = c.match(/FINDING:\s*([\s\S]*?)(?=·|WHY IT MATTERS:|LINE:|$)/i)?.[1];
    const why = c.match(/WHY IT MATTERS:\s*([\s\S]*?)(?=·|LINE:|FINDING:|$)/i)?.[1];
    const line = c.match(/LINE:\s*(\d+)/i)?.[1];
    if (!finding || finding.trim().length < 15) continue;
    out.push({
      finding: finding.replace(/\s+/g, " ").trim().slice(0, 400),
      why: (why ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
      line: line ? Number(line) : null,
    });
  }
  return out;
}

async function collect() {
  await mkdir(OUT, { recursive: true });
  const findings = [];
  const streams = (await readdir(SWARM, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && existsSync(path.join(SWARM, d.name, "results")))
    .map((d) => d.name);

  const stats = {};
  for (const stream of streams) {
    const dir = path.join(SWARM, stream, "results");
    let answered = 0;
    let none = 0;
    let raised = 0;
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const r = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      if (!r.ok) continue;
      answered++;
      const parsed = parseFindings(r.output);
      if (parsed.length === 0) none++;
      const file = fileOf(r.id);
      for (const p of parsed) {
        raised++;
        findings.push({
          id: `${r.id}__${findings.length}`,
          stream,
          file,
          foundBy: r.account,
          ...p,
        });
      }
    }
    stats[stream] = { answered, none, raised };
  }

  await writeFile(path.join(OUT, "findings.json"), JSON.stringify(findings, null, 2));
  console.log("stream    answered  said NONE  findings");
  for (const [s, v] of Object.entries(stats)) {
    console.log(
      `${s.padEnd(9)} ${String(v.answered).padStart(8)} ${String(v.none).padStart(10)} ${String(v.raised).padStart(9)}`,
    );
  }
  const unlocatable = findings.filter((f) => !f.file).length;
  console.log(`\n${findings.length} findings · ${unlocatable} could not be tied to a file`);
}

// ── The second opinion ───────────────────────────────────────────────────────

const CHECK = (file, body, f) => `
Somebody reviewed this file and claims it has a defect. Your job is to decide
whether the claim is TRUE, by reading the code.

Most such claims are wrong. These are the four ways they are usually wrong, and
you should look for each of them before you agree:

1. **The guard exists somewhere else.** The claimed unchecked value is validated
   by the caller, by a type, or a few lines above. Read the whole file.
2. **The state is impossible.** The claim describes an input the code can never
   receive — a null that a type forbids, a branch nothing reaches.
3. **Optional chaining or a default already handles it.** \`a?.b()\` does not throw
   when \`a\` is absent; \`??\` and destructuring defaults cover the missing case.
4. **It is a style opinion wearing a defect's clothes.** No user-visible behaviour
   changes. "Could be clearer", "should be extracted", "missing a comment".

If it survives all four, it is real.

Answer in exactly this shape, nothing else:

VERDICT: REAL | WRONG | UNSURE
BECAUSE: <one sentence, citing the specific line or construct that decides it>

Use UNSURE only when deciding genuinely needs a file you were not given.

THE CLAIM: ${f.finding}
WHY IT SUPPOSEDLY MATTERS: ${f.why}
${f.line ? `AT ABOUT LINE: ${f.line}` : ""}

FILE: ${file}

${body}
`.trim();

async function verify() {
  const findings = JSON.parse(await readFile(path.join(OUT, "findings.json"), "utf8"));
  const checkable = findings.filter((f) => f.file);
  const tasks = [];
  for (const f of checkable) {
    const body = await readFile(path.join(ROOT, f.file), "utf8").catch(() => null);
    if (!body) continue;
    const numbered = body
      .split("\n")
      .map((l, i) => `${i + 1}\t${l}`)
      .join("\n");
    tasks.push({
      id: f.id,
      stream: "verify",
      cwd: ROOT,
      timeoutMs: 240_000,
      // The account that raised it is excluded, so nothing is asked to grade its
      // own homework. `runQueue` picks the least-loaded of the rest.
      avoidAccount: f.foundBy,
      prompt: CHECK(f.file, numbered, f),
    });
  }

  console.log(`verifying ${tasks.length} findings on a second account`);
  await runQueue(tasks, {
    outDir: path.join(OUT, "verdicts"),
    startSlots: 8,
    onResult: (r, p) => {
      if (p.done % 25 === 0) console.log(`  [${p.done}/${p.total}]`);
    },
  });

  const verdicts = new Map();
  for (const f of await readdir(path.join(OUT, "verdicts"))) {
    if (!f.endsWith(".json")) continue;
    const r = JSON.parse(await readFile(path.join(OUT, "verdicts", f), "utf8"));
    if (!r.ok) continue;
    const v = r.output.match(/VERDICT:\s*(REAL|WRONG|UNSURE)/i)?.[1]?.toUpperCase();
    const because = r.output.match(/BECAUSE:\s*([\s\S]*?)$/i)?.[1]?.replace(/\s+/g, " ").trim();
    if (v) verdicts.set(r.id, { verdict: v, because: (because ?? "").slice(0, 400), by: r.account });
  }

  const merged = findings.map((f) => ({ ...f, ...(verdicts.get(f.id) ?? { verdict: "UNCHECKED" }) }));
  await writeFile(path.join(OUT, "verified.json"), JSON.stringify(merged, null, 2));

  const count = (v) => merged.filter((m) => m.verdict === v).length;
  console.log(
    `\nREAL ${count("REAL")} · WRONG ${count("WRONG")} · UNSURE ${count("UNSURE")} · ` +
      `unchecked ${count("UNCHECKED")}  (of ${merged.length})`,
  );
}

async function report() {
  const all = process.argv.includes("--all");
  const merged = JSON.parse(await readFile(path.join(OUT, "verified.json"), "utf8"));
  const keep = merged.filter((m) => (all ? true : m.verdict === "REAL" || m.verdict === "UNSURE"));

  // Security-shaped streams first: a wrong finding there costs a minute, and a
  // missed one costs the thing the whole architecture exists to protect.
  const order = { threat: 0, dpdp: 1, testbug: 2, giants: 3, review: 4, drift: 5, a11y: 6 };
  const byFile = new Map();
  for (const m of keep) (byFile.get(m.file) ?? byFile.set(m.file, []).get(m.file)).push(m);

  const files = [...byFile.entries()].sort(
    (a, b) =>
      Math.min(...a[1].map((x) => order[x.stream] ?? 9)) -
        Math.min(...b[1].map((x) => order[x.stream] ?? 9)) || b[1].length - a[1].length,
  );

  for (const [file, items] of files) {
    console.log(`\n━━━ ${file ?? "(no file)"}`);
    for (const i of items.sort((a, b) => (order[a.stream] ?? 9) - (order[b.stream] ?? 9))) {
      console.log(`  [${i.stream}/${i.verdict}] ${i.finding}`);
      if (i.why) console.log(`      → ${i.why}`);
      if (i.because) console.log(`      ✓ second reader: ${i.because}`);
    }
  }
  console.log(`\n${keep.length} findings across ${files.length} files.`);
}

const cmd = process.argv[2];
if (cmd === "collect") await collect();
else if (cmd === "verify") await verify();
else if (cmd === "report") await report();
else {
  console.error("usage: triage.mjs collect | verify | report [--all]");
  process.exit(2);
}
