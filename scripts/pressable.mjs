/**
 * Which verbs a person can actually reach, and which only a test can.
 *
 * D-114: the import graph proves the app can reach a module; it says nothing
 * about whether anybody can get to a feature. That blind spot hid the worst
 * defect in the product — there was no way to put a line on a quotation without
 * a local model, and every module on the path was perfectly reachable.
 *
 * This is the other half of `reachable.mjs`. It walks the IPC surface rather
 * than the import graph: every channel the main process handles, and whether
 * anything in the renderer ever calls it. A handler nothing calls is a verb the
 * owner cannot press, whatever the tests say about it.
 *
 * ## What it cannot tell you
 *
 * That a call site is itself reachable. `ProposedLines` called `deals.addLine`
 * all along; the screen it lives on could not be got to without a model, and no
 * static check of any kind would have said so. Read this as a floor, not a
 * proof: everything it names is definitely unreachable, and a clean run means
 * only that the first question has been answered.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (path) => readFileSync(path, "utf8");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name)) out.push(full);
  }
  return out;
}

// The channel names, as the shared list declares them.
const channels = [...read("apps/desktop/src/shared/ipc-channels.ts").matchAll(/^\s{2}(\w+):/gmu)].map(
  (m) => m[1]
);

/**
 * Every main-process file, not two of them.
 *
 * This read `main/ipc.ts` and `main/index.ts` alone, which left the whole
 * workstation surface — the screen this product actually is — outside the
 * check. Channels handled in `main/workstation/*` counted as not handled at
 * all, so a verb nobody could press there was reported as fine.
 */
const main = walk("apps/desktop/src/main").map(read).join("\n");
const preload = read("apps/desktop/src/preload/index.ts");
const renderer = walk("apps/desktop/src/renderer").map(read).join("\n");

// `bridge()` names, so a preload verb can be matched to a renderer call.
const verbs = new Map();
for (const m of preload.matchAll(/(\w+):\s*\(([^)]*)\)\s*=>\s*\n?\s*ipcRenderer\.invoke\(IPC_CHANNELS\.(\w+)/gu)) {
  verbs.set(m[3], m[1]);
}

const rows = [];
for (const channel of channels) {
  const handled = new RegExp(`IPC_CHANNELS\\.${channel}\\b`, "u").test(main);
  if (!handled) continue;
  const verb = verbs.get(channel);
  if (verb === undefined) {
    rows.push([channel, "no preload verb"]);
    continue;
  }
  // `api.deals.list()` and the like. The verb name alone is enough: a renderer
  // that never writes the word cannot be calling it.
  if (!new RegExp(`\\.${verb}\\s*\\(`, "u").test(renderer)) {
    rows.push([channel, `preload verb \`${verb}\` is never called`]);
  }
}

for (const [channel, why] of rows) {
  console.log(`${channel.padEnd(28)} ${why}`);
}
console.log(`\n${rows.length} handled channel${rows.length === 1 ? "" : "s"} no screen can reach.`);
