#!/usr/bin/env node
//
// Somebody who has never seen the app, driving the real app, twenty times over.
//
// Plan task 4.4 says onboarding is "measured on someone who has never seen it".
// That has sat unticked because the only instrument was a person, and a person
// can be new to a product exactly once. A model in a fresh context is new to it
// every single time, and there are three subscriptions' worth of them.
//
// This is NOT a screenshot test and not a scripted click-through. Nothing here
// knows the name of a single button. The loop is:
//
//   real app (CDP) → semantic snapshot → Flash, in character → one action → repeat
//
// The model is given a person to be and something to get done, and nothing else.
// It cannot see the code, the plan, or the names of the screens. When it cannot
// find the way forward it is told to say so — and **that sentence is the whole
// output**. A pass tells you nothing. "I looked for something that said Bill and
// the only word here is Invoice" is the finding.
//
// Why a text snapshot rather than pixels. A screenshot needs a vision model and
// answers a question we are not asking. What is being tested is whether the
// screen SAYS what to do next, and a blind reader who can still complete the task
// is the strongest possible evidence that it does. It is also the accessibility
// test, run for free: an element this snapshot cannot name is an element a screen
// reader cannot name either.
//
// Usage:
//   node scripts/usertest.mjs                     all personas, default goals
//   node scripts/usertest.mjs --persona shopkeeper --steps 12
//
// Each session gets a throwaway `$HOME`, not a throwaway `--user-data-dir`: the
// main process overrides `userData` from `appData` as its first act, so
// Chromium's own profile switch is ignored and a run launched that way quietly
// opens the owner's real book. `$HOME` is the only handle that actually isolates
// a session — see `freshHome` below.

import { spawn, execSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invoke, ACCOUNTS } from "./swarm.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = "/Applications/Cadrane.app/Contents/MacOS/Cadrane";
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Node buffers stdout when it is a pipe, so a run watched from another terminal
// shows nothing until it ends — which is exactly when you no longer need it.
// Everything goes to a file as it happens, and the file is the thing to tail.
const LOG = path.join(ROOT, ".swarm", "usertest", "run.log");
function log(line) {
  console.log(line);
  try {
    appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)}  ${line}\n`);
  } catch {
    /* the directory is made before the first session; a lost line is not fatal */
  }
}

// ── The people ───────────────────────────────────────────────────────────────
// Each one is somebody who would plausibly be sat in front of this, with a
// reason to be there. The goal is written in THEIR words, never the product's —
// "find out who owes me money", not "open the Book view" — because a goal
// phrased in the product's vocabulary tests nothing except whether the model can
// read a label back to itself.

// `virgin: true` runs against an empty home — a real first launch, which is what
// plan task 4.4 measures. Everything else runs against a COPY of the owner's
// actual records: real names, real figures, real mess. A goal like "who owes me
// money" against an empty book measures nothing, and running against the
// original would let a persona delete a customer.

export const PERSONAS = {
  // The loop, walked by the person it is for. These are the six steps of D-111
  // written as things somebody wants done, never as screens or buttons — the
  // model is not told this app has an Enquiries list any more than a customer
  // walking into the shop is.
  //
  // `virgin` on the first three on purpose: the whole point is what a person can
  // do with nothing installed, no model, no folder granted and an empty book.
  // That state hid the worst defect this product has had (D-114).
  printshop: {
    who: "You run a printing shop in Gurugram. You are 52. You use WhatsApp all day and Tally for your books. You quote about eight jobs a day — visiting cards, brochures, wedding cards, flex banners. You are not stupid about computers but you have no patience for software that makes you guess. English is your second language.",
    goals: [
      {
        goal: "A customer just sent you this on WhatsApp: \"bhai 500 visiting cards banwane hain, 300 gsm matte, dono side printing. rate kya lagega? thursday tak chahiye\". Get it into this app so you do not forget it.",
        virgin: true
      },
      {
        goal: "You have decided to charge ₹4.50 each for those 500 visiting cards. Get that price onto a quotation for the customer.",
        virgin: true
      },
      {
        goal: "You want the customer to see that price. Get the quotation to them, or tell me exactly why you cannot.",
        virgin: true
      },
      { goal: "A customer rang and said they are going with somebody else. Write that down against their job so you know later which jobs you lose." },
      { goal: "You are looking at a new enquiry for visiting cards. Find out what you charged the last customer for the same thing." },
      { goal: "One of the messages in here is spam from an SEO company. Get it out of your way without losing it." },
      { goal: "You quoted somebody last week and heard nothing. Chase them, without leaving this app." },
    ],
  },
  shopkeeper: {
    who: "You run a printing shop in Gurugram. You are 52. You use WhatsApp all day and Tally for your books. You are not stupid about computers but you have no patience for software that makes you guess. English is your second language.",
    goals: [
      { goal: "Find out which of your customers owes you money and has owed it the longest." },
      { goal: "You have a paper bill in your hand from a supplier. Get it into this app without typing it all out." },
      { goal: "Make sure that if this laptop is stolen tomorrow, your records are not gone." },
      { goal: "Somebody owes you money and has not paid. Chase them, without leaving this app.", },
    ],
  },
  operator: {
    who: "You run two small businesses from one Mac. You are 24, comfortable with software, and impatient. You have paid for a Claude subscription already and you resent paying twice for anything.",
    goals: [
      { goal: "Make this app use the AI subscription you already pay for, and confirm it is actually working." },
      { goal: "Set something up that watches a folder and tells you when something needs your attention, without it being able to message anyone." },
      { goal: "Find out exactly what this app has read on your machine, and stop it reading one of those folders." },
      { goal: "Get a second opinion out of it — you want two different models to disagree with each other about something so you can judge for yourself." },
    ],
  },
  sceptic: {
    who: "You are an accountant. You have been burned by software that silently changed a number. You trust nothing you cannot verify, and you will go looking for the receipt before you use any figure.",
    goals: [
      { goal: "Satisfy yourself that this app has not altered any of your files without telling you." },
      { goal: "Find a number this app is showing you and work out where it came from." },
      { goal: "Find out what this app is allowed to send out of this machine, and to whom." },
    ],
  },
  hurried: {
    who: "You opened this app for the first time because someone said it would help. You have four minutes before a call. If it is not obvious, you will close it and never open it again.",
    goals: [
      { goal: "Work out what this thing is for and whether it is worth your time. Then either do one useful thing with it, or give up and say why.", virgin: true },
    ],
  },
  firstday: {
    who: "You bought a Mac app on somebody's recommendation and this is the very first time it has ever been opened. Nothing is set up. You are willing to spend ten minutes, but only if it keeps telling you what to do next.",
    goals: [
      { goal: "Get this app to the point where it is actually doing something useful for you. Set up whatever it needs.", virgin: true },
      { goal: "Get your business's records into it, starting from nothing.", virgin: true },
    ],
  },
};

// ── CDP ──────────────────────────────────────────────────────────────────────

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    });
  }

  static async open(port, match = "index.html") {
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const t = list.find((t) => t.type === "page" && t.url.includes(match));
        if (t) {
          const ws = new WebSocket(t.webSocketDebuggerUrl);
          await new Promise((res, rej) => {
            ws.addEventListener("open", res, { once: true });
            ws.addEventListener("error", rej, { once: true });
          });
          return new Page(ws);
        }
      } catch {
        /* the window takes about five seconds to appear; do not conclude early */
      }
      await sleep(1000);
    }
    throw new Error(`no ${match} target on :${port} after 60s`);
  }

  // Every call is bounded. A `Runtime.evaluate` whose reply never arrives — the
  // renderer wedged, the window gone, a socket half-open — otherwise parks the
  // whole run on a promise nothing will ever settle. That is not theoretical: it
  // is what the first version of this file did, silently, for sixteen minutes.
  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer in ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? "evaluate threw");
    }
    return r.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

// ── The snapshot ─────────────────────────────────────────────────────────────
// Runs inside the page. Produces what a person can SEE and what they can DO, and
// nothing else — no class names, no ids, no component names. If a control is
// only identifiable by its CSS class, this snapshot cannot name it, and neither
// can the person we are pretending to be.

const SNAPSHOT = `(() => {
  const seen = new Set();
  const out = [];
  let n = 0;

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };

  // The accessible name, found the way a screen reader finds it. An element that
  // reaches the last fallback is an element nobody can refer to out loud.
  const name = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const t = document.getElementById(labelled)?.textContent?.trim();
      if (t) return t;
    }
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, 120);
    const ph = el.getAttribute('placeholder') || el.getAttribute('title') || el.value;
    if (ph) return String(ph).trim().slice(0, 120);
    return '';
  };

  const interactive = 'button, a[href], input, textarea, select, [role=button], [role=link], [role=tab], [role=switch], [role=checkbox], [tabindex]:not([tabindex="-1"]), [onclick]';

  for (const el of document.querySelectorAll(interactive)) {
    if (!visible(el)) continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-usertest-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'input') : tag);
    const nm = name(el);
    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
    // An unnamed control is reported AS unnamed rather than skipped. It is the
    // most useful line in the whole snapshot: something is clickable and nothing
    // says what it does.
    out.push('[' + ref + '] ' + role + ' "' + (nm || '(NO ACCESSIBLE NAME)') + '"' + (disabled ? ' (disabled)' : ''));
    seen.add(el);
  }

  // Prose, in reading order, minus anything already listed as a control.
  const prose = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent.replace(/\\s+/g, ' ').trim();
    if (t.length < 2) continue;
    const el = node.parentElement;
    if (!el || !visible(el)) continue;
    if (el.closest('[data-usertest-ref]')) continue;
    prose.push(t);
  }

  const dedup = [...new Set(prose)].slice(0, 120);
  return 'WHAT IS ON THE SCREEN:\\n' + dedup.join('\\n') +
         '\\n\\nWHAT YOU CAN DO:\\n' + (out.join('\\n') || '(nothing on this screen can be clicked)') +
         '\\n\\nWINDOW: ' + innerWidth + 'x' + innerHeight;
})()`;

const clickRef = (ref) => `(() => {
  const el = document.querySelector('[data-usertest-ref="${ref}"]');
  if (!el) return 'NO SUCH ELEMENT';
  el.scrollIntoView({block:'center'});
  el.focus?.();
  el.click();
  return 'clicked ' + (el.innerText || el.getAttribute('aria-label') || el.tagName).slice(0,60);
})()`;

const typeRef = (ref, text) => `(() => {
  const el = document.querySelector('[data-usertest-ref="${ref}"]');
  if (!el) return 'NO SUCH ELEMENT';
  el.focus();
  // React listens to the input event and ignores a plain value assignment, so
  // set through the native setter and then announce it the way the browser does.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter ? setter.call(el, ${JSON.stringify(text)}) : (el.value = ${JSON.stringify(text)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'typed into ' + (el.getAttribute('placeholder') || el.tagName);
})()`;

// ── A home to throw away ─────────────────────────────────────────────────────
// A virgin home is empty. A populated one is a *copy* of the owner's real
// records — `cp -c` clones on APFS, so 100 MB of book costs no disk and no wait,
// and a persona that deletes a customer deletes it out of a clone.

const REAL_SUPPORT = path.join(process.env.HOME ?? "", "Library", "Application Support");

async function freshHome(virgin) {
  const home = await mkdtemp(path.join(tmpdir(), "cadrane-usertest-"));
  const support = path.join(home, "Library", "Application Support");
  await mkdir(support, { recursive: true });
  if (virgin) return home;
  for (const dir of ["Cadrane", "@cadrane", "@switchboard"]) {
    const from = path.join(REAL_SUPPORT, dir);
    if (!existsSync(from)) continue;
    try {
      execSync(`cp -Rc ${JSON.stringify(from)} ${JSON.stringify(support)}`, { stdio: "ignore" });
    } catch {
      // No clone support on this volume; a plain copy is slower and still correct.
      execSync(`cp -R ${JSON.stringify(from)} ${JSON.stringify(support)}`, { stdio: "ignore" });
    }
  }
  const agents = path.join(process.env.HOME ?? "", ".cadrane");
  if (existsSync(agents)) {
    try {
      execSync(`cp -Rc ${JSON.stringify(agents)} ${JSON.stringify(home)}`, { stdio: "ignore" });
    } catch {
      /* agents are optional */
    }
  }
  return home;
}

// ── The loop ─────────────────────────────────────────────────────────────────

const ASK = (persona, goal, snapshot, history) => `
You are a real person using a Mac app for the first time. Stay in character.

WHO YOU ARE: ${persona}

WHAT YOU CAME HERE TO DO: ${goal}

You have never seen this app. Nobody has explained it. You cannot read its manual
or its source code. All you have is what is on the screen, below.

${history.length ? `WHAT YOU HAVE DONE SO FAR:\n${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}\n` : ""}
${snapshot}

Decide the ONE next thing you would actually do. Answer in exactly this shape and
nothing else:

THINKING: <one sentence, in your own voice, on what you think this screen is for>
ACTION: <one of: CLICK e4 | TYPE e7 "the text" | DONE | LOST>
BECAUSE: <one sentence on why that, or if LOST, exactly what you looked for and could not find>

Use DONE only when what you came to do is actually done — not when you think you
have found where it probably lives.
Use LOST when you genuinely cannot see how to get further. Being honest about
being lost is the most useful thing you can do here; do not click something at
random to look competent.
`.trim();

const parse = (text) => {
  const grab = (k) => text.match(new RegExp(`^${k}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? "";
  const action = grab("ACTION");
  const click = action.match(/^CLICK\s+(e\d+)/i);
  const type = action.match(/^TYPE\s+(e\d+)\s+"([\s\S]*)"$/i);
  return {
    thinking: grab("THINKING"),
    because: grab("BECAUSE"),
    raw: action,
    kind: click ? "click" : type ? "type" : /^DONE/i.test(action) ? "done" : "lost",
    ref: click?.[1] ?? type?.[1],
    text: type?.[2],
  };
};

async function runOne({ page, personaKey, goal, account, steps, virgin }) {
  const persona = PERSONAS[personaKey].who;
  const history = [];
  const trace = [];

  for (let step = 1; step <= steps; step++) {
    let snapshot;
    try {
      snapshot = await page.eval(SNAPSHOT);
    } catch (e) {
      trace.push({ step, error: `snapshot failed: ${e.message}` });
      break;
    }

    const r = await invoke(account, ASK(persona, goal, snapshot, history), { timeoutMs: 180_000 });
    if (!r.ok) {
      trace.push({ step, error: `model did not answer: ${r.quota ? "quota" : r.stderr.slice(0, 200)}` });
      break;
    }
    const move = parse(r.output);
    trace.push({ step, ...move, screen: snapshot.slice(0, 900) });
    log(`    ${personaKey} step ${step}: ${move.raw || "(unparseable)"} — ${move.thinking}`);

    if (move.kind === "done" || move.kind === "lost") break;

    let outcome = "nothing happened";
    try {
      if (move.kind === "click") outcome = await page.eval(clickRef(move.ref));
      else if (move.kind === "type") outcome = await page.eval(typeRef(move.ref, move.text));
    } catch (e) {
      outcome = `that did nothing: ${e.message}`;
    }
    history.push(`${move.raw} — ${outcome}`);
    // Long enough for a view change and a first paint, short enough that twenty
    // of these still finish inside an afternoon.
    await sleep(1200);
  }

  const last = trace.at(-1) ?? {};
  return {
    persona: personaKey,
    goal,
    virgin: virgin === true,
    steps: trace.length,
    verdict: last.kind === "done" ? "done" : last.kind === "lost" ? "lost" : "ran out of steps",
    lostBecause: last.kind === "lost" ? last.because : "",
    trace,
  };
}

async function main() {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const only = arg("persona");
  const steps = Number(arg("steps", "14"));
  const outDir = path.join(ROOT, ".swarm", "usertest");
  await mkdir(outDir, { recursive: true });

  const runs = [];
  for (const [key, p] of Object.entries(PERSONAS)) {
    if (only && key !== only) continue;
    for (const g of p.goals) runs.push({ personaKey: key, goal: g.goal, virgin: g.virgin === true });
  }

  log(`user testing: ${runs.length} sessions · ${ACCOUNTS.length} accounts · a throwaway home each\n`);
  const results = [];

  for (const [i, run] of runs.entries()) {
    const account = ACCOUNTS[i % ACCOUNTS.length];
    const home = await freshHome(run.virgin);
    try {
      execSync("pkill -f '/Applications/Cadrane.app' || true", { stdio: "ignore" });
    } catch {
      /* nothing was running */
    }
    await sleep(1500);

    // HOME, not --user-data-dir. `index.ts` overrides `userData` from `appData`
    // the moment it starts, so Chromium's own profile switch is ignored — a
    // "throwaway profile" launched that way still opens the owner's real book,
    // which is how this was nearly measured against a machine that was already
    // set up. `appData` derives from `$HOME`, so `$HOME` is the only handle.
    const child = spawn(APP, [`--remote-debugging-port=${PORT}`], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME: home },
    });
    child.unref();

    let page;
    try {
      page = await Page.open(PORT);
      const out = await runOne({ page, ...run, account, steps });
      results.push(out);
      const flag = out.verdict === "done" ? "✓" : out.verdict === "lost" ? "✗ LOST" : "… ran out";
      log(`[${i + 1}/${runs.length}] ${flag}  ${run.personaKey} · ${out.steps} steps`);
      log(`        "${run.goal}"`);
      if (out.lostBecause) log(`        → ${out.lostBecause}`);
      await writeFile(
        path.join(outDir, `${run.personaKey}_${i}.json`),
        JSON.stringify(out, null, 2),
      );
    } catch (e) {
      log(`[${i + 1}/${runs.length}] harness error: ${e.message}`);
      results.push({ ...run, verdict: "harness error", error: e.message, trace: [] });
    } finally {
      page?.close();
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }

  const done = results.filter((r) => r.verdict === "done").length;
  const lost = results.filter((r) => r.verdict === "lost");
  console.log(`\n${done}/${results.length} sessions reached the goal.`);
  if (lost.length) {
    console.log(`\nWhere people got stuck — this is the actual output:\n`);
    for (const l of lost) console.log(`  ${l.persona}: ${l.goal}\n    → ${l.lostBecause}\n`);
  }
  await writeFile(path.join(outDir, "summary.json"), JSON.stringify(results, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
