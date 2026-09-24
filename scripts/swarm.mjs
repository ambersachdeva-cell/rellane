#!/usr/bin/env node
//
// The swarm exists because one subscription answering one question at a time is
// the slowest possible way to spend three of them.
//
// `scripts/review.sh` fans a batch out with `&` and `wait`. That works for ten
// files on one account and breaks on everything else: it cannot fail a task over
// to another account when one runs out of quota, it cannot tell "the model said
// NONE" from "the CLI died in four seconds", and it re-runs the whole batch when
// one file times out. The swarm is the same idea with the three things that
// actually matter at volume — failover, honest results, and a concurrency level
// discovered rather than guessed.
//
// An account here is a directory and a label, exactly as in D-091: `HOME` is the
// only thing overridden, the vendor's own binary reads its own token out of that
// directory, and nothing about a credential is read, moved, or logged.
//
// Concurrency is adaptive because the right number is not knowable from here.
// Antigravity publishes no per-account parallelism limit, so the swarm starts
// low, raises the ceiling on sustained success, and collapses it the moment an
// account says quota. Guessing high wastes the quota on retries; guessing low
// wastes the afternoon.
//
// Usage:
//   node scripts/swarm.mjs run <queue-dir> [--out <dir>] [--model M] [--start N]
//   node scripts/swarm.mjs probe                       measure per-account concurrency
//
// A task is one JSON file in the queue directory:
//   { "id": "...", "stream": "review", "prompt": "...", "cwd": "/abs/path",
//     "timeoutMs": 300000, "skipPermissions": true }

import { spawn } from "node:child_process";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const SETUP = path.join(os.homedir(), "agy-setup");

// Three accounts, and the real home is deliberately not among them. A profile
// directory equal to the owner's own home would be the same subscription wearing
// three names — three green lights for one quota (D-091).
export const ACCOUNTS = [
  { id: 1, home: path.join(SETUP, "config1"), label: "Profile 1" },
  { id: 2, home: path.join(SETUP, "config2"), label: "Profile 2" },
  { id: 3, home: path.join(SETUP, "config3"), label: "Profile 3" },
];

// Amber's ruling, 2026-09-03: Flash-high for everything on Antigravity. It is
// not a quality ranking — it is the level that traces a defect to its
// consequence (D-092), at the price that lets us run thousands of calls.
export const MODEL = "gemini-3.8-flash-high";

const QUOTA = /resource[_ ]exhausted|quota|rate.?limit|429|too many requests|exceeded your current/i;

// Signed out is not spent, and the two want opposite handling. A spent account
// comes back on its own, so it is worth cooling and retrying. A signed-out one
// never does — only a person at a browser fixes it — so retrying it burns the
// whole queue's wall time against a lane that cannot answer. Tokens expire
// overnight, which makes this the normal state of the morning's first run.
const SIGNED_OUT = /authentication required|please visit the url|accounts\.google\.com\/o\/oauth2/i;

// A CLI that returns in under three seconds did not think about anything. It
// failed to start, and reporting its stderr as a review finding is how a broken
// account turns into sixty imaginary defects.
const FLOOR_MS = 3_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "Resets in 2h39m27s" → milliseconds, plus a minute so we do not race it. */
export function resetIn(text) {
  const m = /resets? in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(text ?? "");
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  const ms =
    (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000 + 60_000;
  return ms > 60_000 ? ms : null;
}

/** Run one prompt on one account. Never throws — a dead worker is a result. */
export function invoke(account, prompt, opts = {}) {
  const { model = MODEL, cwd = process.cwd(), timeoutMs = 300_000, skipPermissions = true } = opts;
  const args = ["-p", prompt, "--model", model, "--effort", "high"];
  if (skipPermissions) args.push("--dangerously-skip-permissions");

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("agy", args, {
      cwd,
      // HOME and nothing else. The token stays in that directory, unread.
      env: { ...process.env, HOME: account.home },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    let timer = null;
    let settled = false;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - started;
      const text = out.trim();
      // Three ways an account says no, and the first version of this only looked
      // for one of them. `agy` reports "Individual quota reached" on stderr and
      // exits 1 — but on a long prompt it sometimes exits 1 having printed
      // nothing at all, and 29 tasks were recorded as mysterious empty answers
      // while two accounts were in fact already spent. **A non-zero exit with no
      // output is a refusal**, whatever it did or did not say, and treating it as
      // anything else keeps a dead account in the rotation.
      const signedOut = SIGNED_OUT.test(out) || SIGNED_OUT.test(err);
      const said = !signedOut && (QUOTA.test(out) || QUOTA.test(err));
      const silent = !signedOut && extra?.code !== undefined && extra.code !== 0 && text.length === 0;
      const quota = said || silent;
      resolve({
        account: account.id,
        durationMs,
        output: text,
        stderr: err.trim().slice(0, 4000),
        quota,
        signedOut,
        quotaSignal: said ? "said so" : silent ? `exit ${extra.code}, no output` : null,
        // "ok" means the model answered. Empty output, a sub-floor return, and a
        // refusal are all failures, and each is a different failure.
        ok: !quota && !signedOut && !extra?.timedOut && text.length > 0 && durationMs >= FLOOR_MS,
        ...extra,
      });
    };

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ timedOut: true });
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => finish({ spawnError: String(e) }));
    child.on("close", (code) => finish({ code }));
  });
}

/** Per-account health: how many at once, and whether it is currently cooling. */
class Lane {
  constructor(account, slots) {
    this.account = account;
    this.slots = slots;
    this.inFlight = 0;
    this.wins = 0;
    this.coolUntil = 0;
    this.done = 0;
    this.failed = 0;
    this.quotaHits = 0;
    /** Signed out. Only a person at a browser fixes it, so it never comes back. */
    this.dead = false;
  }

  get free() {
    return !this.dead && Date.now() >= this.coolUntil && this.inFlight < this.slots;
  }

  // Raise the ceiling slowly on sustained success; collapse it instantly on a
  // quota answer. The asymmetry is the point: the cost of being one slot too low
  // is a slower afternoon, and the cost of being too high is a burnt account.
  record(result) {
    this.inFlight--;
    this.done++;
    if (result.signedOut) {
      // Out for the whole run. Cooling and retrying an account whose token has
      // expired spends the queue's wall time on a lane that cannot answer until
      // somebody signs in — and tokens expire overnight, so this is the ordinary
      // state of the first run of the morning.
      this.dead = true;
      console.log(
        `account ${this.account.id} (${this.account.label}) is signed out — ` +
          `skipping it. Fix with: HOME=${this.account.home} agy`,
      );
      return;
    }
    if (result.quota) {
      this.quotaHits++;
      this.wins = 0;
      this.slots = 1;
      // The refusal says when it lifts — "Resets in 2h39m27s" — so believe it
      // rather than guessing. A flat two-minute cooldown was the original, and
      // against a reset measured in hours it just means retrying a dead account
      // eighty times.
      this.coolUntil = Date.now() + (resetIn(result.stderr) ?? resetIn(result.output) ?? 15 * 60_000);
      return;
    }
    if (result.ok) {
      this.wins++;
      // Ceiling of 12, measured rather than assumed: `swarm.mjs probe` on
      // 2026-09-03 ran nine at once on one account in the same 13s wall time as
      // one, with no refusal. Per-call latency is the bottleneck, not per-account
      // parallelism — so the ceiling is set by this Mac's patience, not Google's.
      if (this.wins >= 3 && this.slots < 12) {
        this.slots++;
        this.wins = 0;
      }
    } else {
      this.failed++;
      this.wins = 0;
    }
  }
}

export async function runQueue(tasks, opts = {}) {
  const { outDir, startSlots = 3, onResult, maxRetries = 1, maxWaitMs = 10 * 60_000 } = opts;
  if (outDir) await mkdir(outDir, { recursive: true });

  const lanes = ACCOUNTS.filter((a) => existsSync(a.home)).map((a) => new Lane(a, startSlots));
  if (lanes.length === 0) throw new Error(`no account profiles found under ${SETUP}`);

  const pending = [...tasks];
  const results = [];
  const attempts = new Map();
  let active = 0;

  // `task.avoidAccount` keeps a task off the account that produced the thing it
  // is about — a second opinion from the process that wrote the first one is not
  // a second opinion. It is a preference, not a rule: if that is the only lane
  // free, a checked finding beats a stalled queue.
  const pickLane = (task) => {
    const free = lanes.filter((l) => l.free);
    if (free.length === 0) return null;
    const others = free.filter((l) => l.account.id !== task?.avoidAccount);
    return (others.length ? others : free).sort(
      (a, b) => a.inFlight - b.inFlight || a.done - b.done,
    )[0];
  };

  return await new Promise((resolve) => {
    const pump = () => {
      while (pending.length > 0) {
        const lane = pickLane(pending[0]);
        if (!lane) break;
        const task = pending.shift();
        lane.inFlight++;
        active++;

        invoke(lane.account, task.prompt, task).then(async (raw) => {
          const result = { ...raw, id: task.id, stream: task.stream ?? "task" };
          lane.record(raw);
          active--;

          const tried = (attempts.get(task.id) ?? 0) + 1;
          attempts.set(task.id, tried);

          // A quota refusal is not the task's fault, so it does not count as a
          // retry — it goes back in the queue and another account takes it.
          const retryable = (raw.quota || raw.timedOut || raw.spawnError) && tried <= maxRetries + 1;
          if (retryable && lanes.some((l) => Date.now() >= l.coolUntil)) {
            pending.push(task);
          } else {
            results.push(result);
            if (outDir) {
              await writeFile(
                path.join(outDir, `${task.id}.json`),
                JSON.stringify(result, null, 2),
              );
            }
            onResult?.(result, { done: results.length, total: tasks.length, lanes });
          }
          pump();
        });
      }

      if (pending.length === 0 && active === 0) {
        resolve(results);
        return;
      }
      if (active === 0 && pending.length > 0) {
        // Everything left is waiting on a cooling account. A short cooldown is
        // worth waiting out; a reset measured in hours is not something to hold
        // a terminal open for, so the run ends and says what it did not do. The
        // queue is on disk and re-running skips what already has a result.
        const alive = lanes.filter((l) => !l.dead);
        if (alive.length === 0) {
          console.log(`\nevery account is signed out. ${pending.length} tasks not attempted.`);
          resolve(results);
          return;
        }
        const soonest = Math.min(...alive.map((l) => l.coolUntil));
        const waitMs = soonest - Date.now();
        if (waitMs > maxWaitMs) {
          console.log(
            `\nevery account is spent. ${pending.length} tasks not attempted; ` +
              `the earliest reset is in ${Math.round(waitMs / 60_000)} min.`,
          );
          resolve(results);
          return;
        }
        sleep(Math.min(Math.max(waitMs, 0) + 1_000, 30_000)).then(pump);
      }
    };
    pump();
  });
}

/** Measure what one account will actually sustain, instead of assuming. */
async function probe() {
  const prompt = "Reply with exactly the single word: PING";
  for (const account of ACCOUNTS) {
    if (!existsSync(account.home)) continue;
    for (const n of [1, 3, 6, 9]) {
      const started = Date.now();
      const rs = await Promise.all(
        Array.from({ length: n }, () => invoke(account, prompt, { timeoutMs: 90_000 })),
      );
      const ok = rs.filter((r) => r.ok).length;
      const quota = rs.filter((r) => r.quota).length;
      const wall = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `account ${account.id}  n=${String(n).padStart(2)}  ok=${ok}/${n}  quota=${quota}  wall=${wall}s  ` +
          `throughput=${(n / ((Date.now() - started) / 1000)).toFixed(2)}/s`,
      );
      if (quota > 0) {
        console.log(`  → account ${account.id} refuses at ${n}; stopping its ramp`);
        break;
      }
    }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "probe") return probe();

  if (cmd === "run") {
    const queueDir = rest[0];
    if (!queueDir) {
      console.error("usage: swarm.mjs run <queue-dir> [--out <dir>] [--start N]");
      process.exit(2);
    }
    const flag = (name, fallback) => {
      const i = rest.indexOf(`--${name}`);
      return i >= 0 ? rest[i + 1] : fallback;
    };
    const outDir = flag("out", path.join(queueDir, "..", "results"));
    const startSlots = Number(flag("start", "3"));

    const files = (await readdir(queueDir)).filter((f) => f.endsWith(".json")).sort();
    const tasks = [];
    let already = 0;
    for (const f of files) {
      const task = JSON.parse(await readFile(path.join(queueDir, f), "utf8"));
      task.id ??= path.basename(f, ".json");
      // Resume rather than restart. A run interrupted by a quota reset leaves
      // most of the queue answered, and paying for those answers twice is the
      // most expensive possible way to recover from running out of quota. Only
      // an answered result counts — a failure is worth retrying.
      const done = path.join(outDir, `${task.id}.json`);
      if (existsSync(done)) {
        try {
          if (JSON.parse(await readFile(done, "utf8")).ok === true) {
            already++;
            continue;
          }
        } catch {
          /* an unreadable result is not a result */
        }
      }
      tasks.push(task);
    }

    if (tasks.length === 0) {
      console.log(`nothing to do: all ${already} tasks already answered`);
      return;
    }
    console.log(
      `swarm: ${tasks.length} tasks · ${ACCOUNTS.length} accounts · ${MODEL}` +
        (already > 0 ? ` · skipping ${already} already answered` : ""),
    );
    const t0 = Date.now();
    const results = await runQueue(tasks, {
      outDir,
      startSlots,
      onResult: (r, p) => {
        const mark = r.ok ? "ok  " : r.quota ? "QUOTA" : r.timedOut ? "TIME" : "fail";
        const slots = p.lanes.map((l) => l.slots).join("/");
        console.log(
          `[${String(p.done).padStart(3)}/${p.total}] ${mark} a${r.account} ` +
            `${(r.durationMs / 1000).toFixed(0)}s slots=${slots}  ${r.id}`,
        );
      },
    });

    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    const ok = results.filter((r) => r.ok).length;
    console.log(`\ndone: ${ok}/${results.length} answered in ${mins} min → ${outDir}`);
    return;
  }

  console.error("usage: swarm.mjs run <queue-dir> | probe");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
