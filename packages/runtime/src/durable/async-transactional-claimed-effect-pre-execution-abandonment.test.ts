import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { canonicalCapabilityIntentSha256 } from "../capability-intent-binding.js";
import { prepareIssuedCapabilityJournal, prepareTerminalCapabilityJournal } from "../capability-journal-codec.js";
import { prepareCapabilityGrantIndexes } from "../capability-grant-index.js";
import { AsyncTransactionalCapabilityJournal } from "./async-transactional-capability-journal.js";
import { AsyncTransactionalAuthorizedEffectClaimForTestOnly } from "./async-transactional-authorized-effect-claim.js";
import { AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly, AsyncTransactionalClaimedEffectPreExecutionAbandonmentError, claimedEffectPreExecutionAbandonmentTargetBindingSha256ForTestOnly } from "./async-transactional-claimed-effect-pre-execution-abandonment.js";
import { AsyncTransactionalEncryptedWorkStore } from "./async-transactional-encrypted-work-store.js";
import { AsyncTransactionalInertEventEffectJournal } from "./async-transactional-event-effect-journal.js";
import { AsyncTransactionalPersistenceFilesystemPortForTestOnly } from "./async-transactional-persistence-filesystem-port.js";
import { TransactionalPersistenceFilesystemForTestOnly, closeTrustedAppOwnedGenerationRootForTestOnly, openTrustedAppOwnedGenerationRootForTestOnly, type TrustedAppOwnedGenerationRootForTestOnly } from "./transactional-persistence-filesystem.js";
import { TransactionalPersistenceError, disposeOpaqueJournalSnapshotForTestOnly, type RecoveredTransactionalState } from "./transactional-persistence.js";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: Array<{ path: string; root: TrustedAppOwnedGenerationRootForTestOnly }> = [];
const provider = { async withUnlockedKey(_reference: unknown, callback: (key: Uint8Array) => void | Promise<void>) { const key = new Uint8Array(32).fill(7); try { await callback(key); } finally { key.fill(0); } } };

afterEach(async () => { for (const entry of roots.splice(0)) { await closeTrustedAppOwnedGenerationRootForTestOnly(entry.root); await rm(entry.path, { recursive: true, force: true }); } });

async function root() { const path = await mkdtemp("/private/tmp/switchboard-t24b4-"); await chmod(path, 0o700); const entry = { path, root: await openTrustedAppOwnedGenerationRootForTestOnly(path) }; roots.push(entry); return entry.root; }
function fixed(value: unknown) { expect(value).toBeInstanceOf(AsyncTransactionalClaimedEffectPreExecutionAbandonmentError); expect(value).toMatchObject({ code: "ASYNC_TRANSACTIONAL_CLAIMED_EFFECT_PRE_EXECUTION_ABANDONMENT_FAILED", message: "Async transactional claimed effect pre-execution abandonment failed." }); expect((value as { cause?: unknown }).cause).toBeUndefined(); }
async function inspect<T>(port: AsyncTransactionalPersistenceFilesystemPortForTestOnly, select: (state: RecoveredTransactionalState) => T): Promise<T> { const state = await port.recover(); try { return select(state); } finally { disposeOpaqueJournalSnapshotForTestOnly(state.snapshot); } }

async function fixture(authoritySessionId = id(52)) {
  const trusted = await root(); const port = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(trusted); let refs = 500;
  const encrypted = new AsyncTransactionalEncryptedWorkStore(port, provider, () => id(refs++));
  await encrypted.put({ operationId: id(10), spaceId: id(1), keyId: id(2), id: id(3), entityKind: "task", recordRevision: 1, idempotency: { kind: "task", idempotencyKeySha256: hash("task") }, kind: "payload", plaintext: new TextEncoder().encode("task") });
  const run = await encrypted.put({ operationId: id(11), spaceId: id(1), keyId: id(2), id: id(4), entityKind: "run", recordRevision: 1, idempotency: { kind: "run", taskId: id(3), attempt: 1 }, kind: "payload", plaintext: new TextEncoder().encode("run") });
  const pending = { schemaVersion: 1 as const, id: id(40), spaceId: id(1), runId: id(4), runRevision: 1, stepKey: id(41), requestSha256: hash("request"), state: "pending" as const, effectRevision: 1 as const, claimId: null };
  const b1 = new AsyncTransactionalInertEventEffectJournal(port);
  await b1.recordRun({ operationId: id(30), runOperationId: id(11), spaceId: id(1), runId: id(4), runRevision: 1, runCiphertextSha256: run.envelope.ciphertextSha256 });
  const created = await b1.createPendingEffect({ operationId: id(31), runOperationId: id(11), effect: pending });
  const intent = { schemaVersion: 1 as const, permissionRequestId: id(50), permissionDecisionId: id(51), spaceId: id(1), runId: id(4), effectId: id(40), effectRevision: 1 as const, effectKind: "export-artifact" as const, authoritySessionId, subjectBindingSha256: hash("subject"), targetBindingSha256: hash("target"), parameterSha256: hash("parameters"), requestSha256: created.effect.requestSha256, expiresAt: "2026-08-03T00:05:00.000Z", maxUses: 1 as const };
  const issued = prepareIssuedCapabilityJournal({ grantRecordId: id(53), grantId: id(54), intent, approvalEvidence: { schemaVersion: 1 as const, kind: "capability-approval-evidence" as const, verifierId: id(55), verdict: "approved" as const, permissionRequestId: id(50), permissionDecisionId: id(51), authoritySessionId, requestSha256: pending.requestSha256, intentSha256: canonicalCapabilityIntentSha256(intent), expiresAt: intent.expiresAt }, issuedAt: "2026-08-03T00:00:00.000Z", issueLifecycleId: id(56), issueOperationId: id(57), issueReceiptId: id(58) });
  const consumed = prepareTerminalCapabilityJournal({ predecessor: { state: issued.state, receipt: issued.receipt }, lifecycle: "consumed", lifecycleId: id(59), operationId: id(60), receiptId: id(61), recordedAt: "2026-08-03T00:04:59.999Z" });
  const indexes = prepareCapabilityGrantIndexes(issued); const capability = new AsyncTransactionalCapabilityJournal(port, provider, () => id(refs++));
  await capability.issue({ spaceId: id(1), keyId: id(2), bundle: issued }); await capability.terminalize({ spaceId: id(1), keyId: id(2), bundle: consumed });
  const claimInput = { operationId: id(300), runOperationId: id(11), runRecordedOperationId: id(30), createOperationId: id(31), pendingEffect: created.effect, consumedAuthorization: { grantRecordId: issued.state.grantRecordId, issueOperationId: issued.state.issueOperationId, issueReceiptRecordId: issued.state.issueReceiptId, requestIndexRecordId: indexes[0].indexRecordId, decisionIndexRecordId: indexes[1].indexRecordId, consumedOperationId: consumed.state.terminal!.operationId, consumedReceiptRecordId: consumed.state.terminal!.receiptId } };
  await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(port, provider).claim(claimInput);
  return { trusted, port, input: { operationId: id(301), claimOperationId: claimInput.operationId, runOperationId: claimInput.runOperationId, runRecordedOperationId: claimInput.runRecordedOperationId, createOperationId: claimInput.createOperationId, pendingEffect: claimInput.pendingEffect, consumedAuthorization: claimInput.consumedAuthorization } };
}

it("abandons an exact B3 claim without exposing its token and exact-replays after restart", async () => {
  const setup = await fixture(); const journal = new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(setup.port, provider);
  const first = await journal.abandonClaimBeforeExecution(setup.input); const replay = await journal.abandonClaimBeforeExecution(setup.input);
  expect([first, replay, Object.isFrozen(first), Object.isFrozen(first.event), Object.isFrozen(first.effect)]).toEqual([first, first, true, true, true]);
  expect(first).toMatchObject({ event: { id: id(301), sequence: 4, kind: "effect-failed", effectState: "failed" }, effect: { id: id(40), state: "failed", effectRevision: 3 }, authorization: { lifecycle: "consumed", terminalOperationId: id(60) }, abandonment: "before-execution", effectExecution: "not-performed" });
  const raw = await inspect(setup.port, (state) => state.snapshot.issuedClaims.flatMap((item) => item.claimIds)[0]);
  expect([Object.hasOwn(first.effect, "claimId"), JSON.stringify(first).includes(raw!)]).toEqual([false, false]);
  expect(await inspect(setup.port, (state) => [state.generation, state.snapshot.journal.records.length, state.snapshot.issuedClaims.flatMap((item) => item.claimIds).length])).toEqual([8, 8, 1]);
  await setup.port.close(); const reopened = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(setup.trusted);
  expect(await new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(reopened, provider).abandonClaimBeforeExecution(setup.input)).toEqual(first); await reopened.close();
});

it("rejects malformed, aliased, hidden-role, and pre-key-invalid inputs before provider entry", async () => {
  const setup = await fixture(id(301)); let calls = 0;
  const counted = { async withUnlockedKey(reference: unknown, callback: (key: Uint8Array) => void | Promise<void>) { calls += 1; return provider.withUnlockedKey(reference, callback); } };
  const journal = new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(setup.port, counted);
  for (const input of [new Proxy(setup.input, {}), { ...setup.input, operationId: setup.input.claimOperationId }, { ...setup.input, claimOperationId: id(999) }, { ...setup.input, runOperationId: id(999) }, { ...setup.input, pendingEffect: { ...setup.input.pendingEffect, requestSha256: hash("wrong") } }]) fixed(await journal.abandonClaimBeforeExecution(input).catch((error: unknown) => error));
  expect(calls).toBe(0); fixed(await journal.abandonClaimBeforeExecution(setup.input).catch((error: unknown) => error)); expect(calls).toBe(6); await setup.port.close();
});

it("rejects missing B3 receipt, malformed helper data, and caller-owned raw-token fields", async () => {
  const setup = await fixture(); let calls = 0;
  const counted = { async withUnlockedKey(reference: unknown, callback: (key: Uint8Array) => void | Promise<void>) { calls += 1; return provider.withUnlockedKey(reference, callback); } };
  const missing = { concurrencyIdentity: setup.port.concurrencyIdentity, recover: setup.port.recover.bind(setup.port), commit: setup.port.commit.bind(setup.port), close: setup.port.close.bind(setup.port), recoverOperationBinding: async (operationId: unknown) => operationId === id(300) ? undefined : setup.port.recoverOperationBinding(operationId) };
  fixed(await new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(missing, counted).abandonClaimBeforeExecution(setup.input).catch((error: unknown) => error));
  fixed(await new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(setup.port, counted).abandonClaimBeforeExecution({ ...setup.input, rawClaimToken: id(700) }).catch((error: unknown) => error));
  expect(() => claimedEffectPreExecutionAbandonmentTargetBindingSha256ForTestOnly({ operationId: id(301), claimOperationId: id(300), claimOperationBindingSha256: hash("binding"), prerequisites: new Proxy({}, {}), consumedCapabilityBundleSha256: hash("capability"), pendingEffect: setup.input.pendingEffect, claimedEffect: {}, failedEffect: {}, issuedClaimDelta: {}, claimEvent: {}, event: {}, abandonment: "before-execution", effectExecution: "not-performed" })).toThrow(AsyncTransactionalClaimedEffectPreExecutionAbandonmentError);
  expect(calls).toBe(0); await setup.port.close();
});

it("retries one identical interruption, adopts a lost acknowledgement, and never rebases", async () => {
  const setup = await fixture(); let interrupted = true;
  const wrapped = { concurrencyIdentity: setup.port.concurrencyIdentity, recover: setup.port.recover.bind(setup.port), recoverOperationBinding: setup.port.recoverOperationBinding.bind(setup.port), close: setup.port.close.bind(setup.port), commit: async (value: unknown) => { if (interrupted) { interrupted = false; throw new TransactionalPersistenceError("INTERRUPTED"); } return setup.port.commit(value); } };
  expect((await new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(wrapped, provider).abandonClaimBeforeExecution(setup.input)).event.sequence).toBe(4);
  await setup.port.close(); const reopened = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(setup.trusted); expect((await new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(reopened, provider).abandonClaimBeforeExecution(setup.input)).event.id).toBe(id(301)); await reopened.close();
  const lostSetup = await fixture(); const filesystem = new TransactionalPersistenceFilesystemForTestOnly(lostSetup.trusted); await lostSetup.port.close(); let lost = false;
  const lostPort = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(lostSetup.trusted, () => ({ loadLatest: () => filesystem.loadLatest(), publish: async (image) => { const published = await filesystem.publish(image); if (!lost) { lost = true; throw new Error("lost acknowledgement"); } return published; } }));
  expect((await new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(lostPort, provider).abandonClaimBeforeExecution(lostSetup.input)).event.sequence).toBe(4); await lostPort.close();
});

it("allows one same-root B4 winner, rejects a divergent B4 ID, and closes active plus queued work", async () => {
  const setup = await fixture(); const right = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(setup.trusted);
  const races = await Promise.allSettled([new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(setup.port, provider).abandonClaimBeforeExecution(setup.input), new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(right, provider).abandonClaimBeforeExecution({ ...setup.input, operationId: id(302) })]);
  expect([races.filter((result) => result.status === "fulfilled").length, races.filter((result) => result.status === "rejected").length]).toEqual([1, 1]); await setup.port.close(); await right.close();
  const closing = await fixture(); let release!: () => void, entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const wrapped = { concurrencyIdentity: closing.port.concurrencyIdentity, recoverOperationBinding: closing.port.recoverOperationBinding.bind(closing.port), commit: closing.port.commit.bind(closing.port), close: closing.port.close.bind(closing.port), recover: async () => { const state = await closing.port.recover(); entered(); await gate; return state; } };
  const journal = new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(wrapped, provider); const active = journal.abandonClaimBeforeExecution(closing.input), queued = journal.abandonClaimBeforeExecution({ ...closing.input, operationId: id(302) }); await started; const shutdown = closing.port.close(); release(); fixed(await active.catch((error: unknown) => error)); fixed(await queued.catch((error: unknown) => error)); await shutdown;
});

it("fails closed on postcommit B4-binding corruption and leaves an unpublished interrupted request retryable", async () => {
  const corrupt = await fixture(); let reads = 0;
  const corruptPort = { concurrencyIdentity: corrupt.port.concurrencyIdentity, recover: corrupt.port.recover.bind(corrupt.port), commit: corrupt.port.commit.bind(corrupt.port), close: corrupt.port.close.bind(corrupt.port), recoverOperationBinding: async (operationId: unknown) => { if (operationId !== id(301)) return corrupt.port.recoverOperationBinding(operationId); reads += 1; return reads <= 2 ? undefined : { commitId: id(301), operationBindingSha256: hash("postcommit-corrupt") }; } };
  fixed(await new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(corruptPort, provider).abandonClaimBeforeExecution(corrupt.input).catch((error: unknown) => error));
  expect(await inspect(corrupt.port, (state) => state.generation)).toBe(8); expect((await new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(corrupt.port, provider).abandonClaimBeforeExecution(corrupt.input)).event.id).toBe(id(301)); await corrupt.port.close();
  const interrupted = await fixture(); let attempts = 0;
  const unavailable = { concurrencyIdentity: interrupted.port.concurrencyIdentity, recover: interrupted.port.recover.bind(interrupted.port), recoverOperationBinding: interrupted.port.recoverOperationBinding.bind(interrupted.port), close: interrupted.port.close.bind(interrupted.port), commit: async () => { attempts += 1; throw new TransactionalPersistenceError("INTERRUPTED"); } };
  fixed(await new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(unavailable, provider).abandonClaimBeforeExecution(interrupted.input).catch((error: unknown) => error));
  expect([attempts, await inspect(interrupted.port, (state) => state.generation), await interrupted.port.recoverOperationBinding(id(301))]).toEqual([2, 7, undefined]); expect((await new AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly(interrupted.port, provider).abandonClaimBeforeExecution(interrupted.input)).event.sequence).toBe(4); await interrupted.port.close();
});

it("keeps the private seam inert and documents failed as local lease abandonment only", async () => {
  const source = readFileSync(new URL("./async-transactional-claimed-effect-pre-execution-abandonment.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/node:(?:fs|path|http|https|child_process)|electron|\bipc\b|process\.env|\bfetch\b|Date\.now|\bclock\b|\.completeEffect\s*\(|\.cancelEffect\s*\(|\.execute(?:Effect)?\s*\(/i);
  expect(source.match(/\.failEffect\(/g) ?? []).toHaveLength(1); expect(source).toMatch(/abandonment: "before-execution"/); expect(source).toMatch(/effectExecution: "not-performed"/);
  for (const surface of [readFileSync(new URL("../index.ts", import.meta.url), "utf8"), readFileSync(new URL("../../package.json", import.meta.url), "utf8"), readFileSync(new URL("../../../contracts/src/index.ts", import.meta.url), "utf8"), readFileSync(new URL("../../../../apps/daemon/src/index.ts", import.meta.url), "utf8"), readFileSync(new URL("../../../../apps/desktop/src/preload/index.ts", import.meta.url), "utf8"), readFileSync(new URL("../../../../apps/desktop/src/main/ipc.ts", import.meta.url), "utf8"), readFileSync(new URL("../../../../apps/desktop/src/renderer/App.tsx", import.meta.url), "utf8")]) expect(surface).not.toMatch(/async-transactional-claimed-effect-pre-execution-abandonment/);
  expect(readFileSync(new URL("../../../../apps/desktop/src/main/durable-spaces-gate.ts", import.meta.url), "utf8")).toMatch(/DURABLE_SPACES_ENABLED\s*=\s*false/);
  // `effect-failed` here is retryable local lease abandonment, never execution or external failure evidence. A future retry needs new authorization and is out of scope.
});
