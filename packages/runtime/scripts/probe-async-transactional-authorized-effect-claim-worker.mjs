import { createHash } from "node:crypto";
import { AsyncTransactionalEncryptedWorkStore } from "../dist/durable/async-transactional-encrypted-work-store.js";
import { AsyncTransactionalInertEventEffectJournal, inertEventEffectOperationBindingSha256ForTestOnly } from "../dist/durable/async-transactional-event-effect-journal.js";
import { AsyncTransactionalCapabilityJournal } from "../dist/durable/async-transactional-capability-journal.js";
import { AsyncTransactionalAuthorizedEffectClaimForTestOnly, authorizedEffectClaimTargetBindingSha256ForTestOnly } from "../dist/durable/async-transactional-authorized-effect-claim.js";
import { AsyncTransactionalPersistenceFilesystemPortForTestOnly } from "../dist/durable/async-transactional-persistence-filesystem-port.js";
import { closeTrustedAppOwnedGenerationRootForTestOnly, openTrustedAppOwnedGenerationRootForTestOnly } from "../dist/durable/transactional-persistence-filesystem.js";
import { prepareIssuedCapabilityJournal, prepareTerminalCapabilityJournal } from "../dist/capability-journal-codec.js";
import { prepareCapabilityGrantIndexes } from "../dist/capability-grant-index.js";
import { canonicalCapabilityIntentSha256 } from "../dist/capability-intent-binding.js";
import { disposeOpaqueJournalSnapshotForTestOnly, operationBindingSha256ForDurableRecordSetForTestOnly } from "../dist/durable/transactional-persistence.js";

const control = await stdin();
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const HASH = /^[a-f0-9]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const provider = {
  async withUnlockedKey(_reference, callback) {
    const key = new Uint8Array(32).fill(7);
    try { await callback(key); } finally { key.fill(0); }
  },
};
const pending = {
  schemaVersion: 1,
  id: id(40),
  spaceId: id(1),
  runId: id(4),
  runRevision: 1,
  stepKey: id(41),
  requestSha256: hash("request"),
  state: "pending",
  effectRevision: 1,
  claimId: null,
};

let root;
let port;
let state;
let refs = 0;

try {
  root = await openTrustedAppOwnedGenerationRootForTestOnly(control.rootPath);
  port = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root);
  const store = new AsyncTransactionalEncryptedWorkStore(port, provider, () => id(100 + refs++));
  await store.put({
    operationId: id(10), spaceId: id(1), keyId: id(2), id: id(3), entityKind: "task", recordRevision: 1,
    idempotency: { kind: "task", idempotencyKeySha256: hash("task") }, kind: "payload", plaintext: bytes("task"),
  });
  const run = await store.put({
    operationId: id(11), spaceId: id(1), keyId: id(2), id: id(4), entityKind: "run", recordRevision: 1,
    idempotency: { kind: "run", taskId: id(3), attempt: 1 }, kind: "payload", plaintext: bytes("run"),
  });
  const runBytes = await store.read({ spaceId: id(1), keyId: id(2), id: id(4), recordRevision: 1 });
  const runReadVerified = Buffer.from(runBytes).toString() === "run";
  runBytes.fill(0);

  const intent = {
    schemaVersion: 1,
    permissionRequestId: id(50),
    permissionDecisionId: id(51),
    spaceId: id(1),
    runId: id(4),
    effectId: id(40),
    effectRevision: 1,
    effectKind: "export-artifact",
    authoritySessionId: id(52),
    subjectBindingSha256: hash("s"),
    targetBindingSha256: hash("t"),
    parameterSha256: hash("p"),
    requestSha256: pending.requestSha256,
    expiresAt: "2026-08-03T00:05:00.000Z",
    maxUses: 1,
  };
  const issued = prepareIssuedCapabilityJournal({
    grantRecordId: id(53),
    grantId: id(54),
    intent,
    approvalEvidence: {
      schemaVersion: 1, kind: "capability-approval-evidence", verifierId: id(55), verdict: "approved",
      permissionRequestId: id(50), permissionDecisionId: id(51), authoritySessionId: id(52),
      requestSha256: pending.requestSha256, intentSha256: canonicalCapabilityIntentSha256(intent), expiresAt: intent.expiresAt,
    },
    issuedAt: "2026-08-03T00:00:00.000Z", issueLifecycleId: id(56), issueOperationId: id(57), issueReceiptId: id(58),
  });
  const consumed = prepareTerminalCapabilityJournal({
    predecessor: { state: issued.state, receipt: issued.receipt }, lifecycle: "consumed", lifecycleId: id(59),
    operationId: id(60), receiptId: id(61), recordedAt: "2026-08-03T00:04:59.999Z",
  });
  const indexes = prepareCapabilityGrantIndexes(issued);
  const input = {
    operationId: id(32),
    runOperationId: id(11),
    runRecordedOperationId: id(30),
    createOperationId: id(31),
    pendingEffect: pending,
    consumedAuthorization: {
      grantRecordId: id(53), issueOperationId: id(57), issueReceiptRecordId: id(58),
      requestIndexRecordId: indexes[0].indexRecordId, decisionIndexRecordId: indexes[1].indexRecordId,
      consumedOperationId: id(60), consumedReceiptRecordId: id(61),
    },
  };

  let recorded;
  let created;
  let result;
  if (control.phase === "one") {
    const b1 = new AsyncTransactionalInertEventEffectJournal(port);
    recorded = await b1.recordRun({
      operationId: id(30), runOperationId: id(11), spaceId: id(1), runId: id(4), runRevision: 1,
      runCiphertextSha256: run.envelope.ciphertextSha256,
    });
    created = await b1.createPendingEffect({ operationId: id(31), runOperationId: id(11), effect: pending });
    const capability = new AsyncTransactionalCapabilityJournal(port, provider, () => id(100 + refs++));
    await capability.issue({ spaceId: id(1), keyId: id(2), bundle: issued });
    await capability.terminalize({ spaceId: id(1), keyId: id(2), bundle: consumed });
  } else {
    const prior = await port.recover();
    try {
      recorded = { event: findEvent(prior, id(30)) };
      created = { event: findEvent(prior, id(31)), effect: pending };
    } finally {
      disposeOpaqueJournalSnapshotForTestOnly(prior.snapshot);
    }
    result = await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(port, provider).claim(input);
  }

  state = await port.recover();
  const bindings = await verifyBindings({ port, state, run, recorded, created, input, issued, consumed, indexes, claimed: control.phase !== "one" });
  const events = state.snapshot.journal.events.map((event) => [event.id, event.sequence, event.kind]);
  const effect = findEffect(state, pending.id);
  const claims = state.snapshot.issuedClaims.flatMap((entry) => entry.claimIds);
  const claimed = control.phase !== "one";
  const expectedEvents = claimed ? [[id(30), 1, "run-recorded"], [id(31), 2, "effect-created"], [id(32), 3, "effect-claimed"]] : [[id(30), 1, "run-recorded"], [id(31), 2, "effect-created"]];
  const authorizationUseAtClosed = consumed.state.lifecycle === "consumed" && consumed.state.stateRevision === 2 && consumed.state.terminal?.operationId === input.consumedAuthorization.consumedOperationId && consumed.receipt.recordedAt === consumed.state.lastTransitionAt && consumed.state.lastTransitionAt < consumed.state.intent.expiresAt;
  assert(runReadVerified && authorizationUseAtClosed, "authorization use");
  assert(state.generation === (claimed ? 7 : 6), "generation");
  assert(refs === (claimed ? 0 : 8), "refs");
  assert(state.snapshot.journal.records.length === 8, "records");
  assert(equal(events, expectedEvents), "events");
  assert(effect.state === (claimed ? "claimed" : "pending") && effect.effectRevision === (claimed ? 2 : 1), "effect");
  assert(claims.length === (claimed ? 1 : 0), "claims");

  const resultEvidence = claimed
    ? validateExactRedactedResult({ result, state, run, pending, consumed, claimId: claims[0] })
    : Object.freeze({ resultRedacted: result === undefined, redactedResultSha256: null, claimUuidV4: false, eventClaimHashMatches: false });
  assert(resultEvidence.resultRedacted, "redaction");
  const effectExecution = claimed ? result.effectExecution : consumed.receipt.effectExecution;
  assert(effectExecution === "not-performed", "effect execution");

  process.stdout.write(`${JSON.stringify({
    phase: control.phase,
    generation: state.generation,
    records: state.snapshot.journal.records.length,
    refs,
    events,
    effect: [effect.state, effect.effectRevision],
    claims: claims.length,
    runReadVerified,
    bindingEvidence: bindings,
    authorizationUseAtClosed,
    redactedResultSha256: resultEvidence.redactedResultSha256,
    claimUuidV4: resultEvidence.claimUuidV4,
    eventClaimHashMatches: resultEvidence.eventClaimHashMatches,
    resultRedacted: resultEvidence.resultRedacted,
    effectExecution,
  })}\n`);
} finally {
  disposeOpaqueJournalSnapshotForTestOnly(state?.snapshot);
  await port?.close();
  if (root) await closeTrustedAppOwnedGenerationRootForTestOnly(root);
}

async function verifyBindings({ port, state, run, recorded, created, input, issued, consumed, indexes, claimed }) {
  const persistedRun = findRecord(state, input.pendingEffect.runId, 1, "run");
  assert(persistedRun.envelope.ciphertextSha256 === run.envelope.ciphertextSha256, "run ciphertext");
  const runBinding = operationBindingSha256ForDurableRecordSetForTestOnly([persistedRun]);
  const runRecordedBinding = inertEventEffectOperationBindingSha256ForTestOnly(
    "record-run", input.runRecordedOperationId, recorded.event, null,
    { runOperationId: input.runOperationId, runOperationBindingSha256: runBinding, anchorOperationId: null, anchorOperationBindingSha256: null },
  );
  const createBinding = inertEventEffectOperationBindingSha256ForTestOnly(
    "create-pending-effect", input.createOperationId, created.event, input.pendingEffect,
    { runOperationId: input.runOperationId, runOperationBindingSha256: runBinding, anchorOperationId: input.runRecordedOperationId, anchorOperationBindingSha256: runRecordedBinding },
  );
  const issuedRecords = [
    findRecord(state, input.consumedAuthorization.grantRecordId, 1, "capability-grant"),
    findRecord(state, input.consumedAuthorization.issueReceiptRecordId, 1, "capability-grant-receipt"),
    findRecord(state, indexes[0].indexRecordId, 1, "capability-grant-index"),
    findRecord(state, indexes[1].indexRecordId, 1, "capability-grant-index"),
  ];
  const consumedRecords = [
    findRecord(state, input.consumedAuthorization.grantRecordId, 2, "capability-grant"),
    findRecord(state, input.consumedAuthorization.consumedReceiptRecordId, 1, "capability-grant-receipt"),
  ];
  const issuedBinding = operationBindingSha256ForDurableRecordSetForTestOnly(issuedRecords);
  const consumedBinding = operationBindingSha256ForDurableRecordSetForTestOnly(consumedRecords);
  const evidence = {
    run: await exactBinding(port, input.runOperationId, runBinding),
    runRecorded: await exactBinding(port, input.runRecordedOperationId, runRecordedBinding),
    create: await exactBinding(port, input.createOperationId, createBinding),
    issued: await exactBinding(port, input.consumedAuthorization.issueOperationId, issuedBinding),
    consumed: await exactBinding(port, input.consumedAuthorization.consumedOperationId, consumedBinding),
    claimTarget: "absent",
  };
  if (!claimed) {
    await absentBinding(port, input.operationId);
    return Object.freeze(evidence);
  }

  const claimedEffect = findEffect(state, input.pendingEffect.id);
  const claimEvent = findEvent(state, input.operationId);
  const claimIds = state.snapshot.issuedClaims.flatMap((entry) => entry.claimIds);
  assert(claimIds.length === 1, "claim delta");
  const prerequisites = {
    runOperationId: input.runOperationId,
    runOperationBindingSha256: runBinding,
    runRecordedOperationId: input.runRecordedOperationId,
    runRecordedOperationBindingSha256: runRecordedBinding,
    createOperationId: input.createOperationId,
    createOperationBindingSha256: createBinding,
    issueOperationId: input.consumedAuthorization.issueOperationId,
    issueOperationBindingSha256: issuedBinding,
    terminalOperationId: input.consumedAuthorization.consumedOperationId,
    terminalOperationBindingSha256: consumedBinding,
    authorizationUseAt: consumed.state.lastTransitionAt,
  };
  const claimHash = hash(claimIds[0]);
  const targetBinding = authorizedEffectClaimTargetBindingSha256ForTestOnly({
    operationId: input.operationId,
    prerequisites,
    consumedCapabilityBundleSha256: hash(`authorized-effect-claim-consumed-capability:v1:${JSON.stringify(consumed)}`),
    pendingEffect: input.pendingEffect,
    claimedEffect: redactedClaimedEffect(claimedEffect, claimHash),
    issuedClaimDelta: { effectId: input.pendingEffect.id, claimSha256: claimHash },
    event: claimEvent,
    effectExecution: "not-performed",
  });
  evidence.claimTarget = (await exactBinding(port, input.operationId, targetBinding)) ? "exact" : "invalid";
  assert(evidence.claimTarget === "exact", "target binding");
  return Object.freeze(evidence);
}

function validateExactRedactedResult({ result, state, run, pending, consumed, claimId }) {
  assert(typeof claimId === "string" && UUID_V4.test(claimId), "claim uuid");
  const claimSha256 = hash(claimId);
  const claimed = findEffect(state, pending.id);
  const event = findEvent(state, id(32));
  const expectedEvent = {
    schemaVersion: 1, id: id(32), spaceId: pending.spaceId, runId: pending.runId, runRevision: pending.runRevision,
    sequence: 3, kind: "effect-claimed", runCiphertextSha256: run.envelope.ciphertextSha256,
    effectId: pending.id, effectRevision: 2, effectState: "claimed", claimSha256,
  };
  const expectedEffect = redactedResultEffect(claimed, claimSha256);
  const expected = {
    event: expectedEvent,
    effect: expectedEffect,
    authorization: {
      grantId: consumed.state.grantId,
      intentSha256: consumed.state.intentSha256,
      effectKind: consumed.state.intent.effectKind,
      terminalOperationId: consumed.state.terminal.operationId,
      lifecycle: "consumed",
    },
    effectExecution: "not-performed",
  };
  const serialized = JSON.stringify(expected);
  assert(equal(event, expectedEvent) && claimed.claimId === claimId, "claimed state");
  assert(plain(result) && JSON.stringify(result) === serialized, "redacted result");
  assert(!serialized.includes(claimId) && !Object.hasOwn(result.effect, "claimId"), "raw claim token");
  return Object.freeze({
    resultRedacted: true,
    redactedResultSha256: hash(`t24b3-canonical-redacted-result:v1:${serialized}`),
    claimUuidV4: true,
    eventClaimHashMatches: result.event.claimSha256 === claimSha256,
  });
}

async function exactBinding(port, commitId, expectedBinding) {
  const recovered = await port.recoverOperationBinding(commitId);
  assert(plain(recovered), "binding shape");
  assert(Object.keys(recovered).length === 2 && recovered.commitId === commitId && recovered.operationBindingSha256 === expectedBinding && HASH.test(recovered.operationBindingSha256), "binding exact");
  return true;
}

async function absentBinding(port, commitId) {
  assert((await port.recoverOperationBinding(commitId)) === undefined, "unexpected target binding");
}

function findRecord(state, recordId, recordRevision, entityKind) {
  const matches = state.snapshot.journal.records.filter((record) => record.id === recordId && record.recordRevision === recordRevision);
  assert(matches.length === 1 && matches[0].envelope.entityKind === entityKind, "record");
  return matches[0];
}

function findEvent(state, eventId) {
  const matches = state.snapshot.journal.events.filter((event) => event.id === eventId);
  assert(matches.length === 1, "event");
  return matches[0];
}

function findEffect(state, effectId) {
  const matches = state.snapshot.journal.effects.filter((effect) => effect.id === effectId);
  assert(matches.length === 1, "effect");
  return matches[0];
}

function redactedClaimedEffect(claimed, claimSha256) {
  assert(claimed.state === "claimed" && claimed.effectRevision === 2 && typeof claimed.claimId === "string" && hash(claimed.claimId) === claimSha256, "claimed effect");
  return {
    schemaVersion: claimed.schemaVersion,
    id: claimed.id,
    spaceId: claimed.spaceId,
    runId: claimed.runId,
    runRevision: claimed.runRevision,
    stepKey: claimed.stepKey,
    requestSha256: claimed.requestSha256,
    state: claimed.state,
    effectRevision: claimed.effectRevision,
    claimSha256,
  };
}

function redactedResultEffect(claimed, claimSha256) {
  assert(claimed.state === "claimed" && claimed.effectRevision === 2 && typeof claimed.claimId === "string" && hash(claimed.claimId) === claimSha256, "claimed result effect");
  return {
    schemaVersion: claimed.schemaVersion,
    id: claimed.id,
    spaceId: claimed.spaceId,
    runId: claimed.runId,
    runRevision: claimed.runRevision,
    stepKey: claimed.stepKey,
    requestSha256: claimed.requestSha256,
    state: claimed.state,
    effectRevision: claimed.effectRevision,
  };
}

function bytes(value) {
  return new Uint8Array(Buffer.from(value));
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function plain(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function assert(value, label) {
  if (!value) throw Error(label);
}

function stdin() {
  return new Promise((resolve, reject) => {
    let source = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      source += chunk;
      if (Buffer.byteLength(source) > 1_024) reject(Error("control"));
    });
    process.stdin.once("end", () => {
      try {
        const value = JSON.parse(source);
        if (!plain(value) || Object.keys(value).length !== 2 || typeof value.rootPath !== "string" || !["one", "two", "three"].includes(value.phase)) throw Error("control");
        resolve(value);
      } catch (error) { reject(error); }
    });
  });
}
