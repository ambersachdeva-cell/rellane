import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const prefix = "/private/tmp/switchboard-t2p-a4-probe-";
const worker = fileURLToPath(new URL("./probe-async-encrypted-capability-journal-worker.mjs", import.meta.url));
const root = await mkdtemp(prefix); await chmod(root, 0o700);
const original = await lstat(root, { bigint: true }); const originalRealpath = await realpath(root);
const phases = ["issue", "terminal", "replay"];
const lines = [];
const childPids = new Set();
try {
  for (const phase of phases) lines.push(await run(phase));
  const expected = [{ phase: "issue", generation: 1, records: 4, refs: 4, issueBinding: true, terminalBinding: false, events: 0, effects: 0, claims: 0 }, { phase: "terminal", generation: 2, records: 6, refs: 2, issueBinding: true, terminalBinding: true, events: 0, effects: 0, claims: 0 }, { phase: "replay", generation: 2, records: 6, refs: 0, issueBinding: true, terminalBinding: true, events: 0, effects: 0, claims: 0 }];
  if (JSON.stringify(lines) !== JSON.stringify(expected)) throw new Error("probe schema mismatch");
  process.stdout.write(`${JSON.stringify({ receiptVersion: 1, status: "three-process-private-async-capability-journal-probe-passed", childProcesses: 3, generations: [0, 1, 1, 2, 2], recordCounts: [0, 4, 4, 6, 6], ciphertextRefAllocations: [4, 2, 0], issueReplayGeneration: 1, issueBindingRecovered: true, terminalBindingRecovered: true, effectExecution: "not-performed", productActivated: false, fixtures: "synthetic-encrypted-capability-journal" })}\n`);
} finally {
  const now = await lstat(root, { bigint: true }); const resolved = await realpath(root);
  if (now.dev !== original.dev || now.ino !== original.ino || now.uid !== original.uid || (now.mode & 0o777n) !== 0o700n || !now.isDirectory() || resolved !== originalRealpath || dirname(resolved) !== "/private/tmp" || !resolved.startsWith(prefix)) throw new Error("unsafe cleanup target");
  await rm(root, { recursive: true, force: false });
}

function run(phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], { shell: false, env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
    if (child.pid === undefined) { reject(new Error("child pid unavailable")); return; }
    if (child.pid === process.pid || childPids.has(child.pid)) { child.kill("SIGKILL"); reject(new Error("invalid child pid")); return; }
    childPids.add(child.pid);
    child.stdin.end(`${JSON.stringify({ rootPath: root, phase })}\n`);
    let output = ""; let errors = ""; const limit = 4096; const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("child timeout")); }, 20_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk) => { output += chunk; if (output.length > limit) child.kill("SIGKILL"); }); child.stderr.on("data", (chunk) => { errors += chunk; if (errors.length > limit) child.kill("SIGKILL"); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); }); child.once("close", (code) => { clearTimeout(timeout); if (code !== 0 || errors.length > 0) { reject(new Error("child failed")); return; } const split = output.trim().split("\n"); if (split.length !== 1 || split[0] === "") { reject(new Error("invalid child output")); return; } try { const value = JSON.parse(split[0]); if (value === null || typeof value !== "object" || Array.isArray(value) || value.phase !== phase || Object.keys(value).length !== 9) throw new Error("invalid child schema"); resolve(value); } catch { reject(new Error("invalid child output")); } });
  });
}
