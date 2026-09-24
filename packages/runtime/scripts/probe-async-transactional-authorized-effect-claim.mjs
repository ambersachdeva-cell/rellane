import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const prefix = "/private/tmp/switchboard-t24b3-probe-";
const root = await mkdtemp(prefix);
await chmod(root, 0o700);

const original = await lstat(root, { bigint: true });
const originalPath = await realpath(root);
const worker = fileURLToPath(new URL("./probe-async-transactional-authorized-effect-claim-worker.mjs", import.meta.url));
const pids = new Set();
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

try {
  const results = [];
  for (const phase of ["one", "two", "three"]) results.push(await run(phase));
  const events = [[id(30), 1, "run-recorded"], [id(31), 2, "effect-created"], [id(32), 3, "effect-claimed"]];
  const common = {
    records: 8,
    runReadVerified: true,
    authorizationUseAtClosed: true,
    resultRedacted: true,
    effectExecution: "not-performed",
  };
  assertChild(results[0], {
    phase: "one", generation: 6, refs: 8, events: events.slice(0, 2), effect: ["pending", 1], claims: 0,
    bindingEvidence: { run: true, runRecorded: true, create: true, issued: true, consumed: true, claimTarget: "absent" },
    claimUuidV4: false, eventClaimHashMatches: false, ...common,
  });
  for (const phase of ["two", "three"]) {
    assertChild(results[phase === "two" ? 1 : 2], {
      phase, generation: 7, refs: 0, events, effect: ["claimed", 2], claims: 1,
      bindingEvidence: { run: true, runRecorded: true, create: true, issued: true, consumed: true, claimTarget: "exact" },
      claimUuidV4: true, eventClaimHashMatches: true, ...common,
    });
  }
  if (results[1].redactedResultSha256 !== results[2].redactedResultSha256) throw Error("redacted replay");
  if (!results.slice(1).every((value) => value.resultRedacted && typeof value.redactedResultSha256 === "string")) throw Error("redaction");
  const bindingsRecovered = results.every((value) => Object.values(value.bindingEvidence).every((binding) => binding === true || binding === "absent" || binding === "exact"));
  const receipt = {
    receiptVersion: 2,
    status: "three-process-private-async-transactional-authorized-effect-claim-probe-passed",
    childProcesses: results.length,
    phaseEndGenerations: results.map((value) => value.generation),
    phaseEndRecordCounts: results.map((value) => value.records),
    ciphertextRefAllocations: results.map((value) => value.refs),
    eventSequences: results[2].events.map((event) => event[1]),
    effectRevisions: [results[0].effect[1], results[2].effect[1]],
    issuedClaims: results[2].claims,
    issuedClaimUuidV4: results.slice(1).every((value) => value.claimUuidV4),
    eventClaimHashMatches: results.slice(1).every((value) => value.eventClaimHashMatches),
    runReadVerified: results.every((value) => value.runReadVerified),
    bindingsRecovered,
    targetBindingAbsentBeforeClaim: results[0].bindingEvidence.claimTarget === "absent",
    authorizationUseAtClosed: results.every((value) => value.authorizationUseAtClosed),
    resultRedacted: results.slice(1).every((value) => value.resultRedacted),
    redactedResultReplayMatches: results[1].redactedResultSha256 === results[2].redactedResultSha256,
    effectExecution: results.every((value) => value.effectExecution === "not-performed") ? "not-performed" : "invalid",
    fixtures: "synthetic-encrypted-consumed-authorization-claim",
  };
  if (!receipt.bindingsRecovered || !receipt.targetBindingAbsentBeforeClaim || !receipt.authorizationUseAtClosed || !receipt.resultRedacted || !receipt.redactedResultReplayMatches || receipt.effectExecution !== "not-performed") throw Error("receipt");
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  const now = await lstat(root, { bigint: true });
  const current = await realpath(root);
  if (now.dev !== original.dev || now.ino !== original.ino || now.uid !== original.uid || (now.mode & 0o777n) !== 0o700n || !now.isDirectory() || current !== originalPath || dirname(current) !== "/private/tmp" || !current.startsWith(prefix)) throw Error("cleanup");
  await rm(root, { recursive: true, force: false });
}

function assertChild(value, expected) {
  const fields = ["phase", "generation", "records", "refs", "events", "effect", "claims", "runReadVerified", "bindingEvidence", "authorizationUseAtClosed", "redactedResultSha256", "claimUuidV4", "eventClaimHashMatches", "resultRedacted", "effectExecution"];
  if (!plain(value) || JSON.stringify(Object.keys(value)) !== JSON.stringify(fields)) throw Error("child schema");
  const { redactedResultSha256, ...fixed } = value;
  for (const field of fields.filter((field) => field !== "redactedResultSha256")) if (!equal(fixed[field], expected[field])) throw Error(`child evidence: ${field}`);
  if (expected.phase === "one") {
    if (redactedResultSha256 !== null) throw Error("phase one redacted result");
  } else if (typeof redactedResultSha256 !== "string" || !/^[a-f0-9]{64}$/.test(redactedResultSha256)) {
    throw Error("redacted digest");
  }
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function plain(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function run(phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], { shell: false, env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
    if (child.pid === undefined || child.pid === process.pid || pids.has(child.pid)) {
      child.kill("SIGKILL");
      return reject(Error("pid"));
    }
    pids.add(child.pid);
    child.stdin.end(`${JSON.stringify({ rootPath: root, phase })}\n`);
    let out = "";
    let err = "";
    let done = false;
    const fail = (error) => { if (!done) { done = true; reject(error); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(Error("timeout")); }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; if (Buffer.byteLength(out) > 4_096) { child.kill("SIGKILL"); fail(Error("stdout")); } });
    child.stderr.on("data", (chunk) => { err += chunk; if (Buffer.byteLength(err) > 4_096) { child.kill("SIGKILL"); fail(Error("stderr")); } });
    child.once("error", (error) => { clearTimeout(timer); fail(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (done) return;
      try {
        if (code !== 0 || err) throw Error(`child: ${err}`);
        const lines = out.trim().split("\n");
        const value = JSON.parse(lines[0]);
        if (lines.length !== 1 || !value || value.phase !== phase) throw Error("child schema");
        done = true;
        resolve(value);
      } catch (error) { fail(error); }
    });
  });
}
