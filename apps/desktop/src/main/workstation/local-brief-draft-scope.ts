/** A projectless Agent brief draft has durable local admission without pretending to be a Case. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { LocalChatRequestSchema, type LocalChatRequest } from "@cadrane/contracts";
import { z } from "zod";
import { DRAFT_TIMEOUT_MS, draftLocalBrief, draftPrompt, type DraftResult } from "../agents/draft.js";
import type { LocalWorkroomDeps } from "../workroom/local.js";
import type { RunningSession } from "./session-pool.js";

export const MAX_LOCAL_BRIEF_ATTEMPTS = 2_000;
export interface LocalBriefHistory {
  readonly count: number;
  readonly unfinished: number;
  readonly oldestAt: number | null;
  readonly newestAt: number | null;
  readonly reviewSha256: string;
}
const SYSTEM = "You write agent briefs. You reply with JSON and nothing else.";
const Input = z.strictObject({
  sentence: z.string().trim().min(1).max(2_000),
  folders: z.array(z.string().min(1).max(1_024)).max(20)
}).superRefine((value, context) => {
  if (new Set(value.folders).size !== value.folders.length)
    context.addIssue({ code: "custom", path: ["folders"], message: "Duplicate brief folder." });
});
const Receipt = z.strictObject({
  sequence: z.number().int().min(1).max(3),
  event: z.enum(["admitted", "dispatch_attempt", "completed", "failed", "interrupted"]),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  at: z.number().int().positive().safe()
});
type LocalBriefReceipt = z.infer<typeof Receipt>;

export interface LocalBriefDraftInput {
  readonly db: DatabaseSync;
  readonly handle: string;
  readonly sentence: string;
  readonly folders: readonly string[];
  readonly owner: object;
  readonly workspacePath: string;
  readonly assertOwner: () => void;
  readonly grantedFolders: () => readonly string[];
  readonly runtime: LocalWorkroomDeps;
  readonly signal?: AbortSignal;
}

interface ActiveBrief {
  readonly owner: object;
  readonly workspacePath: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  stopping: boolean;
  terminal: boolean;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertPacket(request: LocalChatRequest, sentence: string, folders: readonly string[]): void {
  if (request.runtimeId !== "cadrane-local-loopback" || request.responseProfile !== "local-draft-v1" ||
      request.messages.length !== 2 || request.messages[0]?.role !== "system" ||
      request.messages[0].content !== SYSTEM || request.messages[1]?.role !== "user" ||
      request.messages[1].content !== draftPrompt(sentence, folders) ||
      request.temperature !== 0.2 || request.maxTokens !== 1_024) {
    throw new Error("The local brief packet differs from its admitted context.");
  }
}

function assertGranted(folders: readonly string[], current: readonly string[]): void {
  if (folders.some((folder) => !current.includes(folder)))
    throw new Error("A folder grant changed. Review the brief before drafting again.");
}

function appendReceipt(db: DatabaseSync, handle: string, event: LocalBriefReceipt["event"],
  resultSha256: string | null = null, at = Date.now()): void {
  const existingTerminal = db.prepare(
    "SELECT 1 FROM workstation_local_brief_receipt WHERE attempt_id = ? AND event IN ('completed', 'failed', 'interrupted') LIMIT 1"
  ).get(handle);
  if (existingTerminal && ["completed", "failed", "interrupted"].includes(event)) {
    throw new Error("Local brief attempt is already terminal.");
  }
  const next = db.prepare(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM workstation_local_brief_receipt WHERE attempt_id = ?"
  ).get(handle) as { sequence: number };
  const receipt = Receipt.parse({ sequence: next.sequence, event, resultSha256, at });
  db.prepare(`INSERT INTO workstation_local_brief_receipt
    (attempt_id, sequence, event, result_sha256, at) VALUES (?, ?, ?, ?, ?)`)
    .run(handle, receipt.sequence, receipt.event, receipt.resultSha256, receipt.at);
}

function inspect(db: DatabaseSync, handle: string): { readonly input: z.infer<typeof Input>;
  readonly request: LocalChatRequest | null; readonly receipts: readonly LocalBriefReceipt[] } {
  const row = db.prepare(
    "SELECT input_json AS inputJson, input_sha256 AS inputSha256 FROM workstation_local_brief_attempt WHERE id = ?"
  ).get(handle) as { inputJson: string; inputSha256: string } | undefined;
  if (!row || sha256(row.inputJson) !== row.inputSha256) throw new Error("Local brief admission is missing or corrupt.");
  const input = Input.parse(JSON.parse(row.inputJson));
  const snapshot = db.prepare(`SELECT request_json AS requestJson, request_sha256 AS requestSha256,
    model_id AS modelId FROM workstation_local_brief_request WHERE attempt_id = ?`)
    .get(handle) as { requestJson: string; requestSha256: string; modelId: string } | undefined;
  let request: LocalChatRequest | null = null;
  if (snapshot) {
    if (sha256(snapshot.requestJson) !== snapshot.requestSha256)
      throw new Error("Local brief request snapshot changed.");
    request = LocalChatRequestSchema.parse(JSON.parse(snapshot.requestJson));
    if (request.modelId !== snapshot.modelId) throw new Error("Local brief model identity changed.");
    assertPacket(request, input.sentence, input.folders);
  }
  const rawReceipts = db.prepare(`SELECT sequence, event, result_sha256 AS resultSha256, at
    FROM workstation_local_brief_receipt WHERE attempt_id = ? ORDER BY sequence`)
    .all(handle) as unknown as readonly Record<string, unknown>[];
  const receipts = rawReceipts.map((one) => Receipt.parse(one));
  const terminal = receipts.filter((one) => ["completed", "failed", "interrupted"].includes(one.event));
  if (receipts.length < 1 || receipts.length > 3 || receipts[0]?.event !== "admitted" ||
      receipts.some((one, index) => one.sequence !== index + 1) ||
      terminal.length > 1 ||
      (request === null) !== !receipts.some((one) => one.event === "dispatch_attempt") ||
      (receipts[1]?.event === "dispatch_attempt") !== (request !== null) ||
      (terminal.length === 1 && terminal[0] !== receipts[receipts.length - 1]) ||
      receipts.some((one) => (one.event === "completed") !== (one.resultSha256 !== null)))
    throw new Error("Local brief receipts disagree with the exact request. Recovery is paused.");
  return { input, request, receipts };
}

/** The Host can own this scope when its legacy Agent shortcut is moved behind admission. */
export class LocalBriefDraftScope {
  private readonly active = new Map<string, ActiveBrief>();
  private readonly running = new Set<Promise<unknown>>();
  private recovered = false;

  sessions(): readonly RunningSession[] {
    return [...this.active].map(([operationId, run]) => ({ operationId,
      caseId: "agent-brief", providerId: "bundled-local", workspacePath: run.workspacePath,
      owner: run.owner, startedAt: run.startedAt }));
  }

  history(db: DatabaseSync): LocalBriefHistory {
    this.recover(db);
    const rows = db.prepare("SELECT id, created_at AS createdAt FROM workstation_local_brief_attempt ORDER BY created_at, id LIMIT ?")
      .all(MAX_LOCAL_BRIEF_ATTEMPTS + 1) as unknown as readonly { id: string; createdAt: number }[];
    if (rows.length > MAX_LOCAL_BRIEF_ATTEMPTS) throw new Error("Local brief history exceeds review bound.");
    const digest = createHash("sha256");
    let unfinished = 0;
    for (const row of rows) {
      const state = inspect(db, row.id);
      digest.update(JSON.stringify({ ...row, ...state }) + "\n", "utf8");
      if (!["completed", "failed", "interrupted"].includes(state.receipts.at(-1)!.event)) unfinished += 1;
    }
    return { count: rows.length, unfinished,
      oldestAt: rows[0]?.createdAt ?? null, newestAt: rows.at(-1)?.createdAt ?? null,
      reviewSha256: digest.digest("hex") };
  }

  forget(db: DatabaseSync, expectedSha256: string): { removed: number } {
    z.string().regex(/^[a-f0-9]{64}$/u).parse(expectedSha256);
    if (this.active.size > 0) throw new Error("Stop the active brief before forgetting draft history.");
    this.recover(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      const review = this.history(db);
      if (review.reviewSha256 !== expectedSha256) throw new Error("Draft history changed. Review it again before forgetting.");
      if (review.unfinished !== 0) throw new Error("Draft history still has an unfinished attempt.");
      db.exec("DELETE FROM workstation_local_brief_attempt");
      db.exec("COMMIT");
      return { removed: review.count };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  /** Once per launch, unresolved attempts become interrupted; no model call is replayed. */
  recover(db: DatabaseSync, at = Date.now()): number {
    if (this.recovered) return 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = db.prepare(
        "SELECT id FROM workstation_local_brief_attempt ORDER BY created_at, id LIMIT ?"
      ).all(MAX_LOCAL_BRIEF_ATTEMPTS + 1) as unknown as readonly { id: string }[];
      if (rows.length > MAX_LOCAL_BRIEF_ATTEMPTS) throw new Error("Local brief history exceeds recovery bound.");
      let interrupted = 0;
      for (const row of rows) {
        const state = inspect(db, row.id);
        if (!["completed", "failed", "interrupted"].includes(state.receipts.at(-1)!.event)) {
          appendReceipt(db, row.id, "interrupted", null, at);
          interrupted += 1;
        }
      }
      db.exec("COMMIT");
      this.recovered = true;
      return interrupted;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  stop(handle: string, owner: object): { stopped: boolean } {
    const run = this.active.get(handle);
    if (!run) return { stopped: false };
    if (run.owner !== owner) throw new Error("This local brief belongs to another window.");
    if (run.stopping || run.terminal) return { stopped: false };
    run.stopping = true;
    run.controller.abort(new Error("Stopped. No Agent brief was saved."));
    return { stopped: true };
  }

  invalidate(owner: object): void {
    for (const [handle, run] of this.active)
      if (run.owner === owner) this.stop(handle, owner);
  }

  async shutdown(): Promise<void> {
    for (const [handle, run] of this.active) this.stop(handle, run.owner);
    await Promise.race([
      Promise.allSettled([...this.running]).then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 4_000);
        if (typeof timer.unref === "function") timer.unref();
      })
    ]);
  }

  run(input: LocalBriefDraftInput): Promise<DraftResult> {
    if (!this.recovered) throw new Error("Recover local brief attempts before drafting.");
    const handle = z.string().uuid().parse(input.handle);
    const admitted = Input.parse({ sentence: input.sentence, folders: [...input.folders] });
    if (this.active.size > 0) throw new Error("A local brief is already running.");
    input.assertOwner();
    assertGranted(admitted.folders, input.grantedFolders());
    if (input.signal?.aborted) throw new Error("Stopped. No Agent brief was saved.");
    const inputJson = JSON.stringify(admitted);
    if (Buffer.byteLength(inputJson, "utf8") > 32_768) throw new Error("Local brief input exceeds snapshot bound.");
    const controller = new AbortController();
    const active: ActiveBrief = { owner: input.owner, workspacePath: input.workspacePath,
      startedAt: Date.now(), controller, stopping: false, terminal: false };
    const onAbort = () => { this.stop(handle, input.owner); };
    const timeout = setTimeout(() => { this.stop(handle, input.owner); }, DRAFT_TIMEOUT_MS);
    if (typeof timeout.unref === "function") timeout.unref();
    input.db.exec("BEGIN IMMEDIATE");
    try {
      const count = input.db.prepare("SELECT COUNT(*) AS count FROM workstation_local_brief_attempt")
        .get() as { count: number };
      if (count.count >= MAX_LOCAL_BRIEF_ATTEMPTS) throw new Error("Local brief history exceeds admission bound.");
      input.db.prepare(`INSERT INTO workstation_local_brief_attempt
        (id, input_json, input_sha256, created_at) VALUES (?, ?, ?, ?)`)
        .run(handle, inputJson, sha256(inputJson), Date.now());
      appendReceipt(input.db, handle, "admitted");
      input.db.exec("COMMIT");
    } catch (error) { input.db.exec("ROLLBACK"); clearTimeout(timeout); throw error; }
    this.active.set(handle, active);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    let attempted = false;
    let chatReturned = false;
    const runtime: LocalWorkroomDeps = {
      discover: () => input.runtime.discover(),
      cancel: (operationId) => input.runtime.cancel(operationId),
      chat: async (raw) => {
        controller.signal.throwIfAborted();
        input.assertOwner();
        assertGranted(admitted.folders, input.grantedFolders());
        if (input.signal?.aborted) this.stop(handle, input.owner);
        controller.signal.throwIfAborted();
        const request = LocalChatRequestSchema.parse(raw);
        assertPacket(request, admitted.sentence, admitted.folders);
        const packet = JSON.stringify(request);
        if (Buffer.byteLength(packet, "utf8") > 32_768)
          throw new Error("Local brief request exceeds snapshot bound.");
        input.db.exec("BEGIN IMMEDIATE");
        try {
          if (attempted) throw new Error("A local brief may dispatch only once.");
          input.db.prepare(`INSERT INTO workstation_local_brief_request
            (attempt_id, request_json, request_sha256, model_id, attempted_at)
            VALUES (?, ?, ?, ?, ?)`)
            .run(handle, packet, sha256(packet), request.modelId, Date.now());
          appendReceipt(input.db, handle, "dispatch_attempt");
          input.db.exec("COMMIT");
          attempted = true;
        } catch (error) { input.db.exec("ROLLBACK"); throw error; }
        const answer = await input.runtime.chat(request);
        chatReturned = true;
        return answer;
      }
    };
    const task = Promise.resolve().then(() => draftLocalBrief(
      admitted.sentence, admitted.folders, runtime, controller.signal
    )).then((result) => {
      controller.signal.throwIfAborted();
      input.assertOwner();
      assertGranted(admitted.folders, input.grantedFolders());
      if (input.signal?.aborted) this.stop(handle, input.owner);
      controller.signal.throwIfAborted();
      const event = result.ok ? "completed" : attempted && !chatReturned ? "interrupted" : "failed";
      input.db.exec("BEGIN IMMEDIATE");
      try {
        appendReceipt(input.db, handle, event, result.ok ? sha256(JSON.stringify(result)) : null);
        input.db.exec("COMMIT");
        active.terminal = true;
      } catch (error) { input.db.exec("ROLLBACK"); throw error; }
      return result;
    }).catch((error: unknown) => {
      const state = inspect(input.db, handle);
      if (!["completed", "failed", "interrupted"].includes(state.receipts.at(-1)!.event)) {
        input.db.exec("BEGIN IMMEDIATE");
        try {
          appendReceipt(input.db, handle, attempted || active.stopping ? "interrupted" : "failed");
          input.db.exec("COMMIT");
          active.terminal = true;
        } catch (receiptError) { input.db.exec("ROLLBACK"); throw receiptError; }
      } else {
        active.terminal = true;
      }
      throw error;
    }).finally(() => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      this.active.delete(handle);
      this.running.delete(task);
    });
    this.running.add(task);
    return task;
  }
}
