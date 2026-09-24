import { canonicalCapabilityIntentSha256 } from "../dist/capability-intent-binding.js";
import { prepareIssuedCapabilityJournal, prepareTerminalCapabilityJournal } from "../dist/capability-journal-codec.js";
import { AsyncTransactionalCapabilityJournal } from "../dist/durable/async-transactional-capability-journal.js";
import { AsyncTransactionalPersistenceFilesystemPortForTestOnly } from "../dist/durable/async-transactional-persistence-filesystem-port.js";
import { closeTrustedAppOwnedGenerationRootForTestOnly, openTrustedAppOwnedGenerationRootForTestOnly } from "../dist/durable/transactional-persistence-filesystem.js";
import { disposeOpaqueJournalSnapshotForTestOnly, operationBindingSha256ForDurableRecordSetForTestOnly } from "../dist/durable/transactional-persistence.js";

const control = await readControl(); const { rootPath, phase } = control;
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const hash = "a".repeat(64);
if (typeof rootPath !== "string" || !["issue", "terminal", "replay"].includes(phase)) throw new Error("invalid probe input");
const intent = { schemaVersion: 1, permissionRequestId: id(1), permissionDecisionId: id(2), spaceId: id(3), runId: id(4), effectId: id(5), effectRevision: 1, effectKind: "export-artifact", authoritySessionId: id(6), subjectBindingSha256: hash, targetBindingSha256: hash, parameterSha256: hash, requestSha256: hash, expiresAt: "2026-08-03T00:05:00.000Z", maxUses: 1 };
const issued = prepareIssuedCapabilityJournal({ grantRecordId: id(15), grantId: id(7), intent, approvalEvidence: { schemaVersion: 1, kind: "capability-approval-evidence", verifierId: id(8), verdict: "approved", permissionRequestId: id(1), permissionDecisionId: id(2), authoritySessionId: id(6), requestSha256: hash, intentSha256: canonicalCapabilityIntentSha256(intent), expiresAt: intent.expiresAt }, issuedAt: "2026-08-03T00:00:00.000Z", issueLifecycleId: id(9), issueOperationId: id(10), issueReceiptId: id(11) });
const terminal = prepareTerminalCapabilityJournal({ predecessor: { state: issued.state, receipt: issued.receipt }, lifecycle: "consumed", lifecycleId: id(12), operationId: id(13), receiptId: id(14), recordedAt: "2026-08-03T00:04:59.999Z" });
const provider = { async withUnlockedKey(_reference, callback) { const key = new Uint8Array(32).fill(7); try { await callback(key); } finally { key.fill(0); } } };
let reference = phase === "issue" ? 100 : phase === "terminal" ? 200 : 300; let refCalls = 0;
const root = await openTrustedAppOwnedGenerationRootForTestOnly(rootPath);
let port;
try {
  port = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root);
  const service = new AsyncTransactionalCapabilityJournal(port, provider, () => { refCalls += 1; return id(reference++); }); let issueRecords; let terminalRecords;
  if (phase === "issue") issueRecords = await service.issue({ spaceId: id(3), keyId: id(20), bundle: issued });
  if (phase === "terminal") { issueRecords = await service.issue({ spaceId: id(3), keyId: id(20), bundle: issued }); terminalRecords = await service.terminalize({ spaceId: id(3), keyId: id(20), bundle: terminal }); }
  if (phase === "replay") { issueRecords = await service.issue({ spaceId: id(3), keyId: id(20), bundle: issued }); terminalRecords = await service.terminalize({ spaceId: id(3), keyId: id(20), bundle: terminal }); }
  const recovered = await port.recover();
  const issueBinding = await port.recoverOperationBinding(id(10)); const terminalBinding = await port.recoverOperationBinding(id(13));
  if (recovered.snapshot.journal.events.length !== 0 || recovered.snapshot.journal.effects.length !== 0 || recovered.snapshot.issuedClaims.length !== 0 || issueBinding?.operationBindingSha256 !== operationBindingSha256ForDurableRecordSetForTestOnly(issueRecords) || (terminalRecords !== undefined && terminalBinding?.operationBindingSha256 !== operationBindingSha256ForDurableRecordSetForTestOnly(terminalRecords))) throw new Error("unexpected authority transcript");
  const expected = phase === "issue" ? [1, 4] : [2, 6];
  if (recovered.generation !== expected[0] || recovered.snapshot.journal.records.length !== expected[1] || issueBinding?.commitId !== id(10) || (phase !== "issue" && terminalBinding?.commitId !== id(13)) || refCalls !== (phase === "issue" ? 4 : phase === "terminal" ? 2 : 0)) throw new Error("unexpected recovered state");
  disposeOpaqueJournalSnapshotForTestOnly(recovered.snapshot); process.stdout.write(`${JSON.stringify({ phase, generation: expected[0], records: expected[1], refs: refCalls, issueBinding: true, terminalBinding: phase !== "issue", events: 0, effects: 0, claims: 0 })}\n`);
} finally {
  await port?.close();
  await closeTrustedAppOwnedGenerationRootForTestOnly(root);
}

function readControl() { return new Promise((resolve, reject) => { let bytes = 0; let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > 1024) reject(new Error("control too large")); else text += chunk; }); process.stdin.once("error", reject); process.stdin.once("end", () => { try { const lines = text.split("\n").filter(Boolean); if (lines.length !== 1) throw new Error("invalid control"); const value = JSON.parse(lines[0]); if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || typeof value.rootPath !== "string" || !["issue", "terminal", "replay"].includes(value.phase)) throw new Error("invalid control"); resolve(value); } catch (error) { reject(error); } }); }); }
