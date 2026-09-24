import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { canonicalCapabilityIntentSha256 } from "../capability-intent-binding.js";
import { prepareIssuedCapabilityJournal, prepareTerminalCapabilityJournal } from "../capability-journal-codec.js";
import { prepareCapabilityGrantIndexes } from "../capability-grant-index.js";
import { AsyncTransactionalCapabilityJournal } from "./async-transactional-capability-journal.js";
import { AsyncTransactionalAuthorizedEffectClaimForTestOnly, AsyncTransactionalAuthorizedEffectClaimError, authorizedEffectClaimTargetBindingSha256ForTestOnly } from "./async-transactional-authorized-effect-claim.js";
import { AsyncTransactionalEncryptedWorkStore } from "./async-transactional-encrypted-work-store.js";
import { AsyncTransactionalInertEventEffectJournal } from "./async-transactional-event-effect-journal.js";
import { AsyncTransactionalPersistenceFilesystemPortForTestOnly } from "./async-transactional-persistence-filesystem-port.js";
import { TransactionalPersistenceFilesystemForTestOnly, closeTrustedAppOwnedGenerationRootForTestOnly, openTrustedAppOwnedGenerationRootForTestOnly, type TrustedAppOwnedGenerationRootForTestOnly } from "./transactional-persistence-filesystem.js";
import { TransactionalPersistenceError } from "./transactional-persistence.js";
import { disposeOpaqueJournalSnapshotForTestOnly, restoreInMemoryWorkStoreFromSnapshotForTestOnly, snapshotFromInMemoryWorkStoreForTestOnly, type RecoveredTransactionalState } from "./transactional-persistence.js";
import { InMemoryWorkStore } from "./in-memory-work-store.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: Array<{ path: string; root: TrustedAppOwnedGenerationRootForTestOnly }> = [];
const provider = { async withUnlockedKey(_reference: unknown, callback: (key: Uint8Array) => void | Promise<void>) { const key = new Uint8Array(32).fill(7); try { await callback(key); } finally { key.fill(0); } } };

afterEach(async () => { for (const entry of roots.splice(0)) { await closeTrustedAppOwnedGenerationRootForTestOnly(entry.root); await rm(entry.path, { recursive: true, force: true }); } });
async function root() { const path = await mkdtemp("/private/tmp/switchboard-t24b3-"); await chmod(path, 0o700); const entry = { path, root: await openTrustedAppOwnedGenerationRootForTestOnly(path) }; roots.push(entry); return entry.root; }
function fixed(value: unknown) { expect(value).toBeInstanceOf(AsyncTransactionalAuthorizedEffectClaimError); expect(value).toMatchObject({ code: "ASYNC_TRANSACTIONAL_AUTHORIZED_EFFECT_CLAIM_FAILED", message: "Async transactional authorized effect claim failed." }); expect((value as { cause?: unknown }).cause).toBeUndefined(); }
async function inspect<T>(port: AsyncTransactionalPersistenceFilesystemPortForTestOnly, select: (state: RecoveredTransactionalState) => T): Promise<T> { const state = await port.recover(); try { return select(state); } finally { disposeOpaqueJournalSnapshotForTestOnly(state.snapshot); } }

async function fixture(lifecycle: "consumed" | "revoked" | "expired" = "consumed", authoritySessionId = id(203)) {
  const trusted = await root(); const port = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(trusted); let refs = 500;
  const encrypted = new AsyncTransactionalEncryptedWorkStore(port, provider, () => id(refs++));
  await encrypted.put({ operationId: id(100), spaceId: id(1), keyId: id(2), id: id(3), entityKind: "task", recordRevision: 1, idempotency: { kind: "task", idempotencyKeySha256: hash("task") }, kind: "payload", plaintext: new TextEncoder().encode("task") });
  const run = await encrypted.put({ operationId: id(101), spaceId: id(1), keyId: id(2), id: id(4), entityKind: "run", recordRevision: 1, idempotency: { kind: "run", taskId: id(3), attempt: 1 }, kind: "payload", plaintext: new TextEncoder().encode("run") });
  const b1 = new AsyncTransactionalInertEventEffectJournal(port);
  const recorded = await b1.recordRun({ operationId: id(102), runOperationId: id(101), spaceId: id(1), runId: id(4), runRevision: 1, runCiphertextSha256: run.envelope.ciphertextSha256 });
  const created = await b1.createPendingEffect({ operationId: id(103), runOperationId: id(101), effect: { schemaVersion: 1, id: id(5), spaceId: id(1), runId: id(4), runRevision: 1, stepKey: id(6), requestSha256: hash("request"), state: "pending", effectRevision: 1, claimId: null } });
  const intent = { schemaVersion: 1 as const, permissionRequestId: id(201), permissionDecisionId: id(202), spaceId: id(1), runId: id(4), effectId: id(5), effectRevision: 1, effectKind: "export-artifact" as const, authoritySessionId, subjectBindingSha256: hash("subject"), targetBindingSha256: hash("target"), parameterSha256: hash("parameters"), requestSha256: created.effect.requestSha256, expiresAt: "2026-08-03T00:05:00.000Z", maxUses: 1 as const };
  const issued = prepareIssuedCapabilityJournal({ grantRecordId: id(204), grantId: id(205), intent, approvalEvidence: { schemaVersion: 1 as const, kind: "capability-approval-evidence" as const, verifierId: id(206), verdict: "approved" as const, permissionRequestId: intent.permissionRequestId, permissionDecisionId: intent.permissionDecisionId, authoritySessionId: intent.authoritySessionId, requestSha256: intent.requestSha256, intentSha256: canonicalCapabilityIntentSha256(intent), expiresAt: intent.expiresAt }, issuedAt: "2026-08-03T00:00:00.000Z", issueLifecycleId: id(207), issueOperationId: id(208), issueReceiptId: id(209) });
  const terminal = prepareTerminalCapabilityJournal({ predecessor: { state: issued.state, receipt: issued.receipt }, lifecycle, lifecycleId: id(210), operationId: id(211), receiptId: id(212), recordedAt: lifecycle === "expired" ? "2026-08-03T00:05:00.000Z" : "2026-08-03T00:04:59.999Z" });
  const indexes = prepareCapabilityGrantIndexes(issued); const capability = new AsyncTransactionalCapabilityJournal(port, provider, () => id(refs++));
  await capability.issue({ spaceId: id(1), keyId: id(2), bundle: issued }); await capability.terminalize({ spaceId: id(1), keyId: id(2), bundle: terminal });
  return { trusted, port, input: { operationId: id(300), runOperationId: id(101), runRecordedOperationId: id(102), createOperationId: id(103), pendingEffect: created.effect, consumedAuthorization: { grantRecordId: issued.state.grantRecordId, issueOperationId: issued.state.issueOperationId, issueReceiptRecordId: issued.state.issueReceiptId, requestIndexRecordId: indexes[0].indexRecordId, decisionIndexRecordId: indexes[1].indexRecordId, consumedOperationId: terminal.state.terminal!.operationId, consumedReceiptRecordId: terminal.state.terminal!.receiptId } } };
}

it("claims exactly once after the durable consumed authorization-use, redacts the token, and exact-replays after restart", async () => {
  const setup = await fixture();
  const journal = new AsyncTransactionalAuthorizedEffectClaimForTestOnly(setup.port, provider);
  const first = await journal.claim(setup.input); const replay = await journal.claim(setup.input);
  expect([first, replay, Object.isFrozen(first), Object.isFrozen(first.event), Object.isFrozen(first.effect)]).toEqual([first, first, true, true, true]);
  expect(first).toMatchObject({ event: { id: id(300), sequence: 3, kind: "effect-claimed" }, effect: { id: id(5), state: "claimed", effectRevision: 2 }, authorization: { lifecycle: "consumed", terminalOperationId: id(211), effectKind: "export-artifact" }, effectExecution: "not-performed" });
  expect(Object.hasOwn(first.effect, "claimId")).toBe(false); expect(first.event.claimSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await inspect(setup.port, (state) => state.snapshot.issuedClaims)).toMatchObject([{ effectId: id(5), claimIds: [expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)] }]);
  await setup.port.close(); const reopened = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(setup.trusted);
  const afterRestart = await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(reopened, provider).claim(setup.input);
  expect(afterRestart).toEqual(first); await reopened.close();
});

it("rejects non-consumed capability terminals, wrong intent/bindings/operation identities, and token collisions before publication", async () => {
  for (const lifecycle of ["revoked", "expired"] as const) { const setup = await fixture(lifecycle); const journal = new AsyncTransactionalAuthorizedEffectClaimForTestOnly(setup.port, provider); fixed(await journal.claim(setup.input).catch((error: unknown) => error)); expect(await inspect(setup.port, (state) => state.generation)).toBe(6); await setup.port.close(); }
  const setup = await fixture(); const journal = new AsyncTransactionalAuthorizedEffectClaimForTestOnly(setup.port, provider);
  for (const input of [{ ...setup.input, operationId: id(211) }, { ...setup.input, runOperationId: id(999) }, { ...setup.input, pendingEffect: { ...setup.input.pendingEffect, requestSha256: hash("wrong") } }, { ...setup.input, consumedAuthorization: { ...setup.input.consumedAuthorization, decisionIndexRecordId: id(999) } }]) fixed(await journal.claim(input).catch((error: unknown) => error));
  expect(await inspect(setup.port, (state) => state.generation)).toBe(6); await setup.port.close();
});

it("rejects provider-independently invalid B1 and target preflight before key access", async () => {
  const setup = await fixture(); let providerCalls = 0;
  const counted = { async withUnlockedKey(reference: unknown, callback: (key: Uint8Array) => void | Promise<void>) { providerCalls += 1; return provider.withUnlockedKey(reference, callback); } };
  const journal = new AsyncTransactionalAuthorizedEffectClaimForTestOnly(setup.port, counted);
  fixed(await journal.claim({ ...setup.input, runOperationId: id(999) }).catch((error: unknown) => error));
  fixed(await journal.claim({ ...setup.input, operationId: id(211) }).catch((error: unknown) => error));
  expect(providerCalls).toBe(0); await setup.port.close();
});

it("rejects every locator substitution and prerequisite-binding fault before provider entry", async () => {
  const setup = await fixture(); let calls = 0;
  const counted = { async withUnlockedKey(reference: unknown, callback: (key: Uint8Array) => void | Promise<void>) { calls += 1; return provider.withUnlockedKey(reference, callback); } };
  const journal = new AsyncTransactionalAuthorizedEffectClaimForTestOnly(setup.port, counted);
  for (const field of ["grantRecordId", "issueOperationId", "issueReceiptRecordId", "requestIndexRecordId", "decisionIndexRecordId", "consumedOperationId", "consumedReceiptRecordId"] as const) fixed(await journal.claim({ ...setup.input, consumedAuthorization: { ...setup.input.consumedAuthorization, [field]: id(999) } }).catch((error: unknown) => error));
  const wrong = { concurrencyIdentity: setup.port.concurrencyIdentity, recover: setup.port.recover.bind(setup.port), commit: setup.port.commit.bind(setup.port), close: setup.port.close.bind(setup.port), recoverOperationBinding: async (operationId: unknown) => operationId === id(101) || operationId === id(102) || operationId === id(103) || operationId === id(208) || operationId === id(211) ? undefined : setup.port.recoverOperationBinding(operationId) };
  fixed(await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(wrong, counted).claim(setup.input).catch((error: unknown) => error));
  expect(calls).toBe(0); await setup.port.close();
});

it("rejects hostile captured input and helper projections without recovery side effects", async () => {
  const setup = await fixture(); let calls = 0;
  const counted = { async withUnlockedKey(reference: unknown, callback: (key: Uint8Array) => void | Promise<void>) { calls += 1; return provider.withUnlockedKey(reference, callback); } };
  const journal = new AsyncTransactionalAuthorizedEffectClaimForTestOnly(setup.port, counted); const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [new Proxy(setup.input, {}), Object.defineProperty({ ...setup.input }, "operationId", { enumerable: true, get() { throw new Error("getter"); } }), { ...setup.input, pendingEffect: cycle }]) fixed(await journal.claim(value).catch((error: unknown) => error));
  expect(() => authorizedEffectClaimTargetBindingSha256ForTestOnly({ operationId: id(300), prerequisites: new Proxy({}, {}), consumedCapabilityBundleSha256: hash("bundle"), pendingEffect: setup.input.pendingEffect, claimedEffect: {}, issuedClaimDelta: {}, event: {}, effectExecution: "not-performed" })).toThrow(AsyncTransactionalAuthorizedEffectClaimError);
  expect([calls, await inspect(setup.port, (state) => state.generation)]).toEqual([0, 6]); await setup.port.close();
});

it("rejects decoded hidden capability-role collisions and bad key-provider access", async () => {
  const collision = await fixture("consumed", id(101)); fixed(await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(collision.port, provider).claim(collision.input).catch((error: unknown) => error)); await collision.port.close();
  const setup = await fixture(); let calls = 0; const wrongKey = { async withUnlockedKey(_reference: unknown, callback: (key: Uint8Array) => void | Promise<void>) { calls += 1; const key = new Uint8Array(32).fill(9); try { await callback(key); } finally { key.fill(0); } } };
  fixed(await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(setup.port, wrongKey).claim(setup.input).catch((error: unknown) => error)); expect([calls, await inspect(setup.port, (state) => state.generation)]).toEqual([1, 6]); await setup.port.close();
  const reentrySetup = await fixture(); const reentry = { async withUnlockedKey(_reference: unknown, callback: (key: Uint8Array) => void | Promise<void>) { const key = new Uint8Array(32).fill(7); try { await callback(key); await callback(key); } finally { key.fill(0); } } };
  fixed(await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(reentrySetup.port, reentry).claim(reentrySetup.input).catch((error: unknown) => error)); expect(await inspect(reentrySetup.port, (state) => state.generation)).toBe(6); await reentrySetup.port.close();
});

it("stops active and queued reservations when the borrowed port closes", async () => {
  const setup = await fixture(); let release!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  const wrapped = { concurrencyIdentity: setup.port.concurrencyIdentity, recover: async () => { const state = await setup.port.recover(); calls += 1; entered(); await gate; return state; }, commit: setup.port.commit.bind(setup.port), close: setup.port.close.bind(setup.port), recoverOperationBinding: setup.port.recoverOperationBinding.bind(setup.port) };
  const journal = new AsyncTransactionalAuthorizedEffectClaimForTestOnly(wrapped, provider); const active = journal.claim(setup.input), queued = journal.claim({ ...setup.input, operationId: id(301) });
  await started; const closing = setup.port.close(); release(); fixed(await active.catch((error: unknown) => error)); fixed(await queued.catch((error: unknown) => error)); await closing;
  expect(calls).toBe(1);
});

it("rejects receipt-only, forged claimed, partial recovery, and postcommit target-binding corruption", async () => {
  const receiptOnly = await fixture(); let calls = 0; const counted = { async withUnlockedKey(reference: unknown, callback: (key: Uint8Array) => void | Promise<void>) { calls += 1; return provider.withUnlockedKey(reference, callback); } };
  const receiptPort = { concurrencyIdentity: receiptOnly.port.concurrencyIdentity, recover: receiptOnly.port.recover.bind(receiptOnly.port), commit: receiptOnly.port.commit.bind(receiptOnly.port), close: receiptOnly.port.close.bind(receiptOnly.port), recoverOperationBinding: async (operationId: unknown) => operationId === id(300) ? { commitId: id(300), operationBindingSha256: hash("receipt-only") } : receiptOnly.port.recoverOperationBinding(operationId) };
  fixed(await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(receiptPort, counted).claim(receiptOnly.input).catch((error: unknown) => error)); expect(calls).toBe(0); await receiptOnly.port.close();
  const partial = await fixture(); const partialPort = { concurrencyIdentity: partial.port.concurrencyIdentity, recover: async () => ({ generation: 6, snapshotSha256: hash("partial"), snapshot: {} } as unknown as RecoveredTransactionalState), commit: partial.port.commit.bind(partial.port), close: partial.port.close.bind(partial.port), recoverOperationBinding: partial.port.recoverOperationBinding.bind(partial.port) };
  fixed(await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(partialPort, counted).claim(partial.input).catch((error: unknown) => error)); expect(calls).toBe(0); await partial.port.close();
  const forged = await fixture(); const parent = await forged.port.recover(); let source: InMemoryWorkStore | undefined, candidate: InMemoryWorkStore | undefined, staged: unknown; try { source = restoreInMemoryWorkStoreFromSnapshotForTestOnly(parent.snapshot); const image = source.exportImageForTestOnly(); try { candidate = new InMemoryWorkStore(() => id(301), () => id(300)); candidate.restoreImageForTestOnly(image); candidate.claimEffect(id(1), id(5), 1); staged = snapshotFromInMemoryWorkStoreForTestOnly(candidate); await forged.port.commit({ commitId: id(400), expectedGeneration: parent.generation, expectedSnapshotSha256: parent.snapshotSha256, operationBindingSha256: hash("forged"), snapshot: staged }); } finally { image.envelopes.forEach((entry) => entry.ciphertext.fill(0)); } } finally { disposeOpaqueJournalSnapshotForTestOnly(parent.snapshot); source?.disposeForTestOnly(); candidate?.disposeForTestOnly(); if (staged !== undefined) disposeOpaqueJournalSnapshotForTestOnly(staged); }
  calls = 0; fixed(await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(forged.port, counted).claim(forged.input).catch((error: unknown) => error)); expect(calls).toBe(0); await forged.port.close();
  const corrupt = await fixture(); let reads = 0; const corruptPort = { concurrencyIdentity: corrupt.port.concurrencyIdentity, recover: corrupt.port.recover.bind(corrupt.port), commit: corrupt.port.commit.bind(corrupt.port), close: corrupt.port.close.bind(corrupt.port), recoverOperationBinding: async (operationId: unknown) => { if (operationId !== id(300)) return corrupt.port.recoverOperationBinding(operationId); reads += 1; return reads === 1 ? undefined : { commitId: id(300), operationBindingSha256: hash("postcommit-corrupt") }; } };
  fixed(await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(corruptPort, provider).claim(corrupt.input).catch((error: unknown) => error)); expect(await inspect(corrupt.port, (state) => state.generation)).toBe(7); expect(await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(corrupt.port, provider).claim(corrupt.input)).toMatchObject({ event: { id: id(300) } }); await corrupt.port.close();
});

it("retries one exact interrupted publication and serializes shared-root replays without rebasing", async () => {
  const setup = await fixture(); let interrupted = true;
  const wrapped = { concurrencyIdentity: setup.port.concurrencyIdentity, recover: setup.port.recover.bind(setup.port), recoverOperationBinding: setup.port.recoverOperationBinding.bind(setup.port), close: setup.port.close.bind(setup.port), commit: async (value: unknown) => { if (interrupted) { interrupted = false; throw new TransactionalPersistenceError("INTERRUPTED"); } return setup.port.commit(value); } };
  const first = await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(wrapped, provider).claim(setup.input);
  expect(first.event.sequence).toBe(3); await setup.port.close();
  const left = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(setup.trusted), right = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(setup.trusted);
  const replay = await Promise.all([new AsyncTransactionalAuthorizedEffectClaimForTestOnly(left, provider).claim(setup.input), new AsyncTransactionalAuthorizedEffectClaimForTestOnly(right, provider).claim(setup.input)]);
  expect(replay).toEqual([first, first]); await left.close(); await right.close();
});

it("bounds one interrupted retry without permanently locking an unpublished claim", async () => {
  const setup = await fixture(); let attempts = 0;
  const interrupted = { concurrencyIdentity: setup.port.concurrencyIdentity, recover: setup.port.recover.bind(setup.port), recoverOperationBinding: setup.port.recoverOperationBinding.bind(setup.port), close: setup.port.close.bind(setup.port), commit: async () => { attempts += 1; throw new TransactionalPersistenceError("INTERRUPTED"); } };
  fixed(await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(interrupted, provider).claim(setup.input).catch((error: unknown) => error));
  expect([attempts, await inspect(setup.port, (state) => state.generation), await setup.port.recoverOperationBinding(id(300))]).toEqual([2, 6, undefined]);
  const later = await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(setup.port, provider).claim(setup.input);
  expect(later.event.sequence).toBe(3); await setup.port.close();
});

it("adopts an exact after-publication lost acknowledgement without a second claim", async () => {
  const setup = await fixture(); const filesystem = new TransactionalPersistenceFilesystemForTestOnly(setup.trusted); await setup.port.close(); let lost = false;
  const port = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(setup.trusted, () => ({ loadLatest: () => filesystem.loadLatest(), publish: async (image) => { const published = await filesystem.publish(image); if (!lost) { lost = true; throw new Error("lost acknowledgement"); } return published; } }));
  const claimed = await new AsyncTransactionalAuthorizedEffectClaimForTestOnly(port, provider).claim(setup.input);
  expect([claimed.event.sequence, await inspect(port, (state) => [state.generation, state.snapshot.issuedClaims.flatMap((entry) => entry.claimIds).length])]).toEqual([3, [7, 1]]); await port.close();
});

it("permits one divergent initial shared-root winner and leaves one target receipt", async () => {
  const setup = await fixture(); const right = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(setup.trusted);
  const outcomes = await Promise.allSettled([new AsyncTransactionalAuthorizedEffectClaimForTestOnly(setup.port, provider).claim(setup.input), new AsyncTransactionalAuthorizedEffectClaimForTestOnly(right, provider).claim({ ...setup.input, operationId: id(301) })]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1); expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  const winner = outcomes[0]!.status === "fulfilled" ? id(300) : id(301), loser = winner === id(300) ? id(301) : id(300);
  expect([await setup.port.recoverOperationBinding(winner), await setup.port.recoverOperationBinding(loser), await inspect(setup.port, (state) => state.generation)]).toEqual([expect.objectContaining({ commitId: winner }), undefined, 7]);
  await setup.port.close(); await right.close();
});

it("keeps the seam private and inert: no time, executor, IPC, product, or external-effect reachability", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./async-transactional-authorized-effect-claim.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/node:(?:fs|path|http|https|child_process)|electron|\bipc\b|process\.env|\bfetch\b|Date\.now|\bclock\b|\.execute(?:Effect)?\s*\(|\.completeEffect\s*\(|\.failEffect\s*\(/i);
  expect(source.match(/\.claimEffect\(/g) ?? []).toHaveLength(1);
  expect(source).toMatch(/effectExecution:\s*"not-performed"/);
  expect(source).toMatch(/randomUUID/); expect(source).not.toMatch(/claimIdGenerator/);
  for (const surface of [readFileSync(new URL("../index.ts", import.meta.url), "utf8"), readFileSync(new URL("../../package.json", import.meta.url), "utf8"), readFileSync(new URL("../../../contracts/src/index.ts", import.meta.url), "utf8"), readFileSync(new URL("../../../../apps/daemon/src/index.ts", import.meta.url), "utf8"), readFileSync(new URL("../../../../apps/desktop/src/preload/index.ts", import.meta.url), "utf8"), readFileSync(new URL("../../../../apps/desktop/src/main/ipc.ts", import.meta.url), "utf8"), readFileSync(new URL("../../../../apps/desktop/src/renderer/App.tsx", import.meta.url), "utf8")]) expect(surface).not.toMatch(/async-transactional-authorized-effect-claim/);
  expect(readFileSync(new URL("../../../../apps/desktop/src/main/durable-spaces-gate.ts", import.meta.url), "utf8")).toMatch(/DURABLE_SPACES_ENABLED\s*=\s*false/);
});
