/**
 * Durable reviewed parent receipts and truthful, non-replaying read views.
 *
 * Implements a bounded adapter over the existing Case Book receipt table.
 * Persists normalized parent/child facts for agent, crew, and research runs,
 * and recovers immutable read views without replaying effects or fabricating
 * answer bodies from summary lines.
 */

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ProjectMemoryRoleIdSchema } from "@cadrane/contracts";
import { appendTurn } from "../book/cases.js";

export const REVIEWED_PARENT_PREFIX = "RellaneReviewedParentV1:";

export const ReviewedParentKindSchema = z.enum(["agent", "crew", "research"]);
export type ReviewedParentKind = z.infer<typeof ReviewedParentKindSchema>;

export const ReviewedChildStateSchema = z.enum([
  "starting",
  "answered",
  "stopped",
  "failed",
  "interrupted"
]);
export type ReviewedChildState = z.infer<typeof ReviewedChildStateSchema>;

export const ReviewedParentChildSchema = z.strictObject({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(500),
  title: z.string().min(1).max(500).optional(),
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  contextSnapshotId: z.string().min(1).max(200),
  sourceHash: z.string().min(1).max(200),
  dependsOn: z.array(z.string().min(1).max(200)).max(64).optional(),
  role: z.string().min(1).max(500).optional(),
  contextRoleId: ProjectMemoryRoleIdSchema.optional(),
  work: z.string().min(1).max(2000).optional(),
  expectedOutput: z.string().min(1).max(2000).optional()
});
export type ReviewedParentChild = z.infer<typeof ReviewedParentChildSchema>;

export const ReviewedParentRecordSchema = z.strictObject({
  event: z.literal("parent"),
  kind: ReviewedParentKindSchema,
  runId: z.string().uuid(),
  caseId: z.string().min(1).max(200),
  request: z.string().min(1).max(50000),
  brief: z.string().min(1).max(5000).optional(),
  integrationOwner: z.string().min(1).max(200).optional(),
  agentContract: z.strictObject({
    agentId: z.string().min(1).max(64),
    origin: z.enum(["bundled", "user"]),
    revision: z.string().regex(/^[0-9a-f]{64}$/u),
    contractHash: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedOutput: z.string().min(1).max(2000),
    requestedToolScopes: z.array(z.enum(["none", "review-each-call"])).min(1).max(1)
  }).optional(),
  at: z.number().int(),
  children: z.array(ReviewedParentChildSchema).min(1).max(64)
});
export type ReviewedParentRecord = z.infer<typeof ReviewedParentRecordSchema>;

export type WorkstationProviderId = string;

export const ReviewedChildAttemptSchema = z.strictObject({
  attemptId: z.string().uuid(),
  contextSnapshotId: z.string().min(1).max(200),
  sourceHash: z.string().min(1).max(200),
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  contextRoleId: ProjectMemoryRoleIdSchema.optional()
});
export type ReviewedChildAttempt = z.infer<typeof ReviewedChildAttemptSchema>;

export const ReviewedChildRecordSchema = z.strictObject({
  event: z.literal("child"),
  kind: ReviewedParentKindSchema,
  runId: z.string().uuid(),
  childId: z.string().min(1).max(200),
  state: ReviewedChildStateSchema,
  at: z.number().int(),
  line: z.string().max(2000),
  answerTurnId: z.string().min(1).max(200).nullable(),
  draftTurnId: z.string().min(1).max(200).nullable(),
  chars: z.number().int().min(0),
  attempt: ReviewedChildAttemptSchema.optional()
});
export type ReviewedChildRecord = z.infer<typeof ReviewedChildRecordSchema>;

export interface RecoveredChildAttemptHistoryItem {
  readonly attemptId?: string;
  readonly contextSnapshotId: string;
  readonly sourceHash: string;
  readonly providerId: WorkstationProviderId;
  readonly modelId: string;
  readonly contextRoleId?: string;
  readonly state: "answered" | "stopped" | "failed" | "interrupted";
  readonly line: string;
  readonly answerTurnId: string | null;
  readonly draftTurnId: string | null;
  readonly chars: number;
  readonly at: number;
  readonly bindingVerified: boolean;
}

export interface RecoveredChildView {
  readonly id: string;
  readonly label: string;
  readonly title?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly contextSnapshotId: string;
  readonly sourceHash: string;
  readonly contextRoleId?: string;
  readonly dependsOn?: readonly string[];
  readonly role?: string;
  readonly work?: string;
  readonly expectedOutput?: string;
  readonly state: "answered" | "stopped" | "failed" | "interrupted";
  readonly attempted: boolean;
  readonly line: string;
  readonly answerTurnId: string | null;
  readonly draftTurnId: string | null;
  readonly chars: number;
  readonly at: number;
  readonly attempt?: ReviewedChildAttempt;
  readonly binding?: ReviewedChildAttempt;
  readonly bindingVerified: boolean;
  readonly attemptCount: number;
  readonly attemptHistory: readonly RecoveredChildAttemptHistoryItem[];
  readonly attempts?: readonly RecoveredChildAttemptHistoryItem[];
}

export interface RecoveredReviewedParent {
  readonly runId: string;
  readonly kind: ReviewedParentKind;
  readonly caseId: string;
  readonly request: string;
  readonly brief?: string;
  readonly integrationOwner?: string;
  readonly agentContract?: ReviewedParentRecord["agentContract"];
  readonly at: number;
  readonly status: "done" | "stopped" | "failed" | "interrupted";
  readonly terminal: "done" | "stopped" | "failed" | "interrupted";
  readonly done: boolean;
  readonly answeredCount: number;
  readonly totalChildren: number;
  readonly headline: string;
  readonly children: readonly RecoveredChildView[];
  readonly outcomes: readonly RecoveredChildView[];
}

function checkAcyclicDependencies(
  children: readonly ReviewedParentChild[],
  childIds: ReadonlySet<string>
): void {
  const depMap = new Map<string, readonly string[]>();
  for (const child of children) {
    if (child.dependsOn !== undefined) {
      const seen = new Set<string>();
      for (const dep of child.dependsOn) {
        if (dep === child.id) {
          throw new Error(`Child ${child.id} cannot depend on itself`);
        }
        if (!childIds.has(dep)) {
          throw new Error(`Child ${child.id} depends on unknown child ID ${dep}`);
        }
        if (seen.has(dep)) {
          throw new Error(`Child ${child.id} has duplicate dependency ${dep}`);
        }
        seen.add(dep);
      }
      depMap.set(child.id, child.dependsOn);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string): void {
    visiting.add(id);
    const deps = depMap.get(id) ?? [];
    for (const dep of deps) {
      if (visiting.has(dep)) {
        throw new Error(`Circular dependency detected involving child ${id}`);
      }
      if (!visited.has(dep)) {
        visit(dep);
      }
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const child of children) {
    if (!visited.has(child.id)) {
      visit(child.id);
    }
  }
}

export function saveReviewedParent(db: DatabaseSync, record: unknown): string {
  const valid = ReviewedParentRecordSchema.parse(record);

  const childIds = new Set<string>();
  for (const child of valid.children) {
    if (childIds.has(child.id)) {
      throw new Error(`Duplicate child id: ${child.id}`);
    }
    childIds.add(child.id);
  }

  if (valid.integrationOwner !== undefined && !childIds.has(valid.integrationOwner)) {
    throw new Error(`Invalid integration owner: ${valid.integrationOwner}`);
  }

  checkAcyclicDependencies(valid.children, childIds);

  db.exec("BEGIN IMMEDIATE");
  try {
    const caseRow = db
      .prepare("SELECT id, closed_at AS closedAt FROM work_case WHERE id = ?")
      .get(valid.caseId) as { readonly id: string; readonly closedAt: number | null } | undefined;
    if (caseRow === undefined) {
      throw new Error(`Case ${valid.caseId} does not exist.`);
    }
    if (caseRow.closedAt !== null) {
      throw new Error(`Case ${valid.caseId} is closed. A closed case does not grow.`);
    }

    const existingRows = db
      .prepare(
        `SELECT body FROM case_turn WHERE seat = 'workstation' AND kind = 'receipt' AND body LIKE ?`
      )
      .all(`${REVIEWED_PARENT_PREFIX}${valid.runId}:%`) as unknown as readonly { readonly body: string }[];

    for (const row of existingRows) {
      try {
        const jsonStr = row.body.slice(`${REVIEWED_PARENT_PREFIX}${valid.runId}:`.length);
        const data: unknown = JSON.parse(jsonStr);
        const parsed = ReviewedParentRecordSchema.safeParse(data);
        if (parsed.success && parsed.data.runId === valid.runId) {
          throw new Error(`Duplicate parent receipt for runId ${valid.runId}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("Duplicate parent receipt")) {
          throw error;
        }
      }
    }

    const turnId = appendTurn(
      db,
      valid.caseId,
      {
        seat: "workstation",
        kind: "receipt",
        body: `${REVIEWED_PARENT_PREFIX}${valid.runId}:${JSON.stringify(valid)}`
      },
      valid.at
    );
    db.exec("COMMIT");
    return turnId;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve primary error if rollback cannot execute
    }
    throw error;
  }
}

export function saveReviewedChild(db: DatabaseSync, caseId: string, record: unknown): string {
  const validCaseId = z.string().min(1).max(200).parse(caseId);
  const valid = ReviewedChildRecordSchema.parse(record);

  db.exec("BEGIN IMMEDIATE");
  try {
    const caseRow = db
      .prepare("SELECT id, closed_at AS closedAt FROM work_case WHERE id = ?")
      .get(validCaseId) as { readonly id: string; readonly closedAt: number | null } | undefined;
    if (caseRow === undefined) {
      throw new Error(`Case ${validCaseId} does not exist.`);
    }
    if (caseRow.closedAt !== null) {
      throw new Error(`Case ${validCaseId} is closed. A closed case does not grow.`);
    }

    const rows = db
      .prepare(
        `SELECT case_id AS caseId, body FROM case_turn
         WHERE seat = 'workstation' AND kind = 'receipt' AND body LIKE ?
         ORDER BY at ASC, seq ASC`
      )
      .all(`${REVIEWED_PARENT_PREFIX}${valid.runId}:%`) as unknown as readonly {
        readonly caseId: string;
        readonly body: string;
      }[];

    let parent: ReviewedParentRecord | null = null;
    for (const row of rows) {
      try {
        const jsonStr = row.body.slice(`${REVIEWED_PARENT_PREFIX}${valid.runId}:`.length);
        const data: unknown = JSON.parse(jsonStr);
        const parsed = ReviewedParentRecordSchema.safeParse(data);
        if (
          parsed.success &&
          parsed.data.runId === valid.runId &&
          row.caseId === parsed.data.caseId
        ) {
          parent = parsed.data;
          break;
        }
      } catch {
        // Skip malformed rows
      }
    }

    if (parent === null) {
      throw new Error(`Cannot save child: parent receipt for runId ${valid.runId} not found.`);
    }
    if (parent.caseId !== validCaseId) {
      throw new Error(
        `Cannot save child: caseId ${validCaseId} does not match parent caseId ${parent.caseId}.`
      );
    }
    if (parent.kind !== valid.kind) {
      throw new Error(
        `Cannot save child: kind ${valid.kind} does not match parent kind ${parent.kind}.`
      );
    }
    if (!parent.children.some((child) => child.id === valid.childId)) {
      throw new Error(`Cannot save child: childId ${valid.childId} not found in parent children.`);
    }
    const parentChild = parent.children.find((child) => child.id === valid.childId)!;
    if (valid.attempt !== undefined && valid.attempt.contextRoleId !== parentChild.contextRoleId)
      throw new Error("Cannot save child: attempted context role does not match reviewed parent.");

    const existingChildRecordsForChild: ReviewedChildRecord[] = [];
    for (const row of rows) {
      try {
        const jsonStr = row.body.slice(`${REVIEWED_PARENT_PREFIX}${valid.runId}:`.length);
        const data: unknown = JSON.parse(jsonStr);
        const parsedChild = ReviewedChildRecordSchema.safeParse(data);
        if (
          parsedChild.success &&
          parsedChild.data.runId === valid.runId &&
          parsedChild.data.kind === parent.kind &&
          row.caseId === parent.caseId
        ) {
          if (
            valid.attempt !== undefined &&
            parsedChild.data.attempt !== undefined &&
            parsedChild.data.attempt.attemptId === valid.attempt.attemptId
          ) {
            const prev = parsedChild.data.attempt;
            if (
              prev.contextSnapshotId !== valid.attempt.contextSnapshotId ||
              prev.sourceHash !== valid.attempt.sourceHash ||
              prev.providerId !== valid.attempt.providerId ||
              prev.modelId !== valid.attempt.modelId ||
              prev.contextRoleId !== valid.attempt.contextRoleId
            ) {
              throw new Error(
                `Cannot save child: attemptId ${valid.attempt.attemptId} reused with differing fields.`
              );
            }
          }

          if (parsedChild.data.childId === valid.childId) {
            existingChildRecordsForChild.push(parsedChild.data);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("differing fields")) {
          throw err;
        }
      }
    }

    for (const rec of existingChildRecordsForChild) {
      if (rec.state === "answered" && rec.answerTurnId !== null && rec.answerTurnId.trim().length > 0) {
        const turnRow = db
          .prepare("SELECT id, case_id AS caseId, kind FROM case_turn WHERE id = ?")
          .get(rec.answerTurnId) as { readonly id: string; readonly caseId: string; readonly kind: string } | undefined;
        if (
          turnRow !== undefined &&
          turnRow.caseId === validCaseId &&
          (turnRow.kind === "verbatim" || turnRow.kind === "finding")
        ) {
          throw new Error(
            `Cannot save child: child ${valid.childId} is already completed.`
          );
        }
      }
    }

    const startingRecords = existingChildRecordsForChild.filter((r) => r.state === "starting");
    const latestStart = startingRecords.length > 0 ? startingRecords[startingRecords.length - 1] : undefined;

    if (valid.state === "starting") {
      if (valid.attempt !== undefined) {
        if (
          existingChildRecordsForChild.some(
            (r) => r.state === "starting" && r.attempt?.attemptId === valid.attempt?.attemptId
          )
        ) {
          throw new Error(
            `Cannot save child: attemptId ${valid.attempt.attemptId} has already started.`
          );
        }
      } else if (latestStart !== undefined && latestStart.attempt !== undefined) {
        throw new Error(
          "Cannot save child: cannot use unbound start following a bound start."
        );
      }

      const hasUnterminatedStart = startingRecords.some((startRec) => {
        const startIdx = existingChildRecordsForChild.indexOf(startRec);
        if (startRec.attempt !== undefined) {
          return !existingChildRecordsForChild.some(
            (r, idx) =>
              idx > startIdx &&
              r.state !== "starting" &&
              r.attempt?.attemptId === startRec.attempt?.attemptId
          );
        }
        return !existingChildRecordsForChild.some(
          (r, idx) => idx > startIdx && r.state !== "starting" && r.attempt === undefined
        );
      });

      if (hasUnterminatedStart) {
        throw new Error(
          `Cannot save child: prior start for child ${valid.childId} has no matching terminal.`
        );
      }
    } else {
      if (valid.attempt !== undefined) {
        if (latestStart === undefined || latestStart.attempt === undefined) {
          throw new Error(
            `Cannot save child: terminal receipt before bound start for child ${valid.childId}.`
          );
        }
        if (valid.attempt.attemptId !== latestStart.attempt.attemptId) {
          throw new Error(
            `Cannot save child: terminal attemptId ${valid.attempt.attemptId} does not match latest start attemptId ${latestStart.attempt.attemptId}.`
          );
        }
        if (valid.attempt.contextSnapshotId !== latestStart.attempt.contextSnapshotId) {
          throw new Error(
            `Cannot save child: terminal contextSnapshotId ${valid.attempt.contextSnapshotId} does not match latest start contextSnapshotId ${latestStart.attempt.contextSnapshotId}.`
          );
        }
        if (valid.attempt.sourceHash !== latestStart.attempt.sourceHash) {
          throw new Error(
            `Cannot save child: terminal sourceHash ${valid.attempt.sourceHash} does not match latest start sourceHash ${latestStart.attempt.sourceHash}.`
          );
        }
        if (valid.attempt.providerId !== latestStart.attempt.providerId) {
          throw new Error(
            `Cannot save child: terminal providerId ${valid.attempt.providerId} does not match latest start providerId ${latestStart.attempt.providerId}.`
          );
        }
        if (valid.attempt.modelId !== latestStart.attempt.modelId) {
          throw new Error(
            `Cannot save child: terminal modelId ${valid.attempt.modelId} does not match latest start modelId ${latestStart.attempt.modelId}.`
          );
        }
        if (valid.attempt.contextRoleId !== latestStart.attempt.contextRoleId)
          throw new Error("Cannot save child: terminal context role does not match latest start.");
        const hasTerminated = existingChildRecordsForChild.some(
          (r) => r.state !== "starting" && r.attempt?.attemptId === valid.attempt?.attemptId
        );
        if (hasTerminated) {
          throw new Error(
            `Cannot save child: attemptId ${valid.attempt.attemptId} has already terminated.`
          );
        }
      } else if (latestStart !== undefined && latestStart.attempt !== undefined) {
        throw new Error(
          "Cannot save child: missing attempt binding following a bound start."
        );
      }
    }

    if (valid.state === "answered") {
      if (valid.answerTurnId === null || valid.answerTurnId.trim().length === 0) {
        throw new Error("Cannot save child: answered child must have nonempty answerTurnId.");
      }
      const turnRow = db
        .prepare("SELECT id, case_id AS caseId, kind FROM case_turn WHERE id = ?")
        .get(valid.answerTurnId) as { readonly id: string; readonly caseId: string; readonly kind: string } | undefined;
      if (turnRow === undefined) {
        throw new Error(`Cannot save child: answerTurnId ${valid.answerTurnId} does not exist.`);
      }
      if (turnRow.caseId !== validCaseId) {
        throw new Error(
          `Cannot save child: answerTurnId ${valid.answerTurnId} belongs to case ${turnRow.caseId}, not ${validCaseId}.`
        );
      }
      if (turnRow.kind !== "verbatim" && turnRow.kind !== "finding") {
        throw new Error(
          `Cannot save child: answerTurnId ${valid.answerTurnId} has invalid kind '${turnRow.kind}'.`
        );
      }
    }

    const turnId = appendTurn(
      db,
      validCaseId,
      {
        seat: "workstation",
        kind: "receipt",
        body: `${REVIEWED_PARENT_PREFIX}${valid.runId}:${JSON.stringify(valid)}`
      },
      valid.at
    );
    db.exec("COMMIT");
    return turnId;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve primary error if rollback cannot execute
    }
    throw error;
  }
}

export function recoverReviewedParent(
  db: DatabaseSync,
  kind: ReviewedParentKind,
  runId: string
): RecoveredReviewedParent | null {
  if (!z.string().uuid().safeParse(runId).success) {
    return null;
  }
  if (!ReviewedParentKindSchema.safeParse(kind).success) {
    return null;
  }

  const rows = db
    .prepare(
      `SELECT case_id AS caseId, body, at, seq FROM case_turn
       WHERE seat = 'workstation' AND kind = 'receipt' AND body LIKE ?
       ORDER BY at ASC, seq ASC`
    )
    .all(`${REVIEWED_PARENT_PREFIX}${runId}:%`) as unknown as readonly {
      readonly caseId: string;
      readonly body: string;
      readonly at: number;
      readonly seq: number;
    }[];

  if (rows.length === 0) {
    return null;
  }

  let parent: ReviewedParentRecord | null = null;
  for (const row of rows) {
    try {
      const jsonStr = row.body.slice(`${REVIEWED_PARENT_PREFIX}${runId}:`.length);
      const data: unknown = JSON.parse(jsonStr);
      const parsedParent = ReviewedParentRecordSchema.safeParse(data);
      if (parsedParent.success) {
        if (
          parsedParent.data.runId === runId &&
          parsedParent.data.kind === kind &&
          row.caseId === parsedParent.data.caseId
        ) {
          const caseRow = db
            .prepare("SELECT id FROM work_case WHERE id = ?")
            .get(parsedParent.data.caseId);
          if (caseRow !== undefined) {
            parent = parsedParent.data;
            break;
          }
        }
      }
    } catch {
      // Skip malformed receipts
    }
  }

  if (parent === null) {
    return null;
  }

  let answeredCount = 0;
  let hasAttemptedUnknown = false;
  let hasInterrupted = false;
  let hasFailed = false;
  let hasStopped = false;

  const recoveredChildren: readonly RecoveredChildView[] = parent.children.map((childDef) => {
    const childRecords: ReviewedChildRecord[] = [];
    for (const row of rows) {
      try {
        const jsonStr = row.body.slice(`${REVIEWED_PARENT_PREFIX}${runId}:`.length);
        const data: unknown = JSON.parse(jsonStr);
        const parsedChild = ReviewedChildRecordSchema.safeParse(data);
        if (
          parsedChild.success &&
          parsedChild.data.runId === runId &&
          parsedChild.data.kind === kind &&
          row.caseId === parent.caseId &&
          parsedChild.data.childId === childDef.id
        ) {
          childRecords.push(parsedChild.data);
        }
      } catch {
        // Skip unreadable rows
      }
    }

    interface AttemptInProgress {
      start: ReviewedChildRecord;
      terminal?: ReviewedChildRecord;
    }

    const attemptsList: AttemptInProgress[] = [];
    let currentAttempt: AttemptInProgress | null = null;
    let queuedStoppedRecord: ReviewedChildRecord | null = null;

    for (const rec of childRecords) {
      if (rec.state === "starting") {
        if (currentAttempt !== null) {
          attemptsList.push(currentAttempt);
        }
        currentAttempt = { start: rec };
      } else if (currentAttempt !== null && currentAttempt.terminal === undefined) {
        if (currentAttempt.start.attempt !== undefined) {
          if (
            rec.attempt !== undefined &&
            rec.attempt.attemptId === currentAttempt.start.attempt.attemptId &&
            rec.attempt.contextSnapshotId === currentAttempt.start.attempt.contextSnapshotId &&
            rec.attempt.sourceHash === currentAttempt.start.attempt.sourceHash &&
            rec.attempt.providerId === currentAttempt.start.attempt.providerId &&
            rec.attempt.modelId === currentAttempt.start.attempt.modelId &&
            rec.attempt.contextRoleId === currentAttempt.start.attempt.contextRoleId
          ) {
            currentAttempt.terminal = rec;
            attemptsList.push(currentAttempt);
            currentAttempt = null;
          }
        } else if (rec.attempt === undefined) {
          currentAttempt.terminal = rec;
          attemptsList.push(currentAttempt);
          currentAttempt = null;
        }
      } else if (rec.state === "stopped" && attemptsList.length === 0 && currentAttempt === null) {
        queuedStoppedRecord = rec;
      } else if (currentAttempt === null && (rec.state === "answered" || rec.state === "failed")) {
        attemptsList.push({ start: rec, terminal: rec });
      }
    }

    if (currentAttempt !== null) {
      attemptsList.push(currentAttempt);
    }

    const history: RecoveredChildAttemptHistoryItem[] = [];
    let latestVerifiedBinding: ReviewedChildAttempt | undefined = undefined;

    for (const att of attemptsList) {
      const isBound = att.start.attempt !== undefined &&
        att.start.attempt.contextRoleId === childDef.contextRoleId;
      const attemptId = att.start.attempt?.attemptId;
      const contextSnapshotId = att.start.attempt?.contextSnapshotId ?? childDef.contextSnapshotId;
      const sourceHash = att.start.attempt?.sourceHash ?? childDef.sourceHash;
      const providerId = att.start.attempt?.providerId ?? childDef.providerId;
      const modelId = att.start.attempt?.modelId ?? childDef.modelId;
      const contextRoleId = att.start.attempt?.contextRoleId ?? childDef.contextRoleId;

      let attemptState: "answered" | "stopped" | "failed" | "interrupted";
      let attemptLine: string;
      let attemptAnswerTurnId: string | null = null;
      let attemptDraftTurnId: string | null = null;
      let attemptChars = 0;
      let attemptAt = att.start.at;
      let bindingVerified = false;

      if (att.terminal !== undefined) {
        const term = att.terminal;
        attemptDraftTurnId = term.draftTurnId;
        attemptChars = term.chars;
        attemptAt = term.at;

        if (term.state === "answered") {
          let isAnswerValid = false;
          if (term.answerTurnId !== null && term.answerTurnId.trim().length > 0) {
            const turnRow = db
              .prepare("SELECT id, case_id AS caseId, kind FROM case_turn WHERE id = ?")
              .get(term.answerTurnId) as { readonly id: string; readonly caseId: string; readonly kind: string } | undefined;
            if (
              turnRow !== undefined &&
              turnRow.caseId === parent.caseId &&
              (turnRow.kind === "verbatim" || turnRow.kind === "finding")
            ) {
              isAnswerValid = true;
            }
          }

          if (isAnswerValid) {
            attemptState = "answered";
            attemptLine = term.line;
            attemptAnswerTurnId = term.answerTurnId;
            bindingVerified = isBound;
          } else {
            attemptState = "interrupted";
            attemptLine = term.line.length > 0
              ? `${term.line}: Answer turn missing or invalid (needs inspection).`
              : "Answer turn missing or invalid (needs inspection).";
            attemptAnswerTurnId = term.answerTurnId;
            bindingVerified = false;
          }
        } else if (term.state === "stopped") {
          attemptState = "stopped";
          attemptLine = term.line;
          bindingVerified = isBound;
        } else if (term.state === "failed") {
          attemptState = "failed";
          attemptLine = term.line;
          bindingVerified = isBound;
        } else {
          attemptState = "interrupted";
          attemptLine = term.line;
          attemptAnswerTurnId = term.answerTurnId;
          bindingVerified = false;
        }
      } else {
        attemptState = "interrupted";
        attemptLine = att.start.line.length > 0
          ? `${att.start.line}: The child was attempted before the app stopped. Check its session receipt before retrying.`
          : "The child was attempted before the app stopped. Check its session receipt before retrying.";
        attemptDraftTurnId = att.start.draftTurnId;
        attemptChars = att.start.chars;
        attemptAt = att.start.at;
        bindingVerified = isBound;
      }

      if (bindingVerified && att.start.attempt !== undefined) {
        latestVerifiedBinding = att.start.attempt;
      }

      const item: RecoveredChildAttemptHistoryItem = {
        ...(attemptId !== undefined ? { attemptId } : {}),
        contextSnapshotId,
        sourceHash,
        providerId,
        modelId,
        ...(contextRoleId !== undefined ? { contextRoleId } : {}),
        state: attemptState,
        line: attemptLine,
        answerTurnId: attemptAnswerTurnId,
        draftTurnId: attemptDraftTurnId,
        chars: attemptChars,
        at: attemptAt,
        bindingVerified
      };
      history.push(Object.freeze(item));
    }

    let state: "answered" | "stopped" | "failed" | "interrupted";
    let attempted: boolean;
    let line: string;
    let answerTurnId: string | null = null;
    let draftTurnId: string | null = null;
    let chars = 0;
    let at = parent.at;
    let bindingVerified = false;

    if (history.length === 0) {
      if (queuedStoppedRecord !== null) {
        state = "stopped";
        attempted = false;
        line = queuedStoppedRecord.line;
        answerTurnId = null;
        draftTurnId = queuedStoppedRecord.draftTurnId;
        chars = queuedStoppedRecord.chars;
        at = queuedStoppedRecord.at;
        bindingVerified = false;
        hasStopped = true;
      } else {
        state = "interrupted";
        attempted = false;
        line = "This child was not started before the app stopped. Review it again to retry.";
        answerTurnId = null;
        draftTurnId = null;
        chars = 0;
        at = parent.at;
        bindingVerified = false;
        hasInterrupted = true;
      }
    } else {
      const last = history[history.length - 1]!;
      state = last.state;
      attempted = true;
      line = last.line;
      answerTurnId = last.answerTurnId;
      draftTurnId = last.draftTurnId;
      chars = last.chars;
      at = last.at;
      bindingVerified = last.bindingVerified;

      if (state === "answered") {
        answeredCount += 1;
      } else if (state === "stopped") {
        hasStopped = true;
      } else if (state === "failed") {
        hasFailed = true;
      } else {
        hasInterrupted = true;
        if (attemptsList[attemptsList.length - 1]!.terminal === undefined) {
          hasAttemptedUnknown = true;
        }
      }
    }

    const view: RecoveredChildView = {
      id: childDef.id,
      label: childDef.label,
      providerId: latestVerifiedBinding?.providerId ?? childDef.providerId,
      modelId: latestVerifiedBinding?.modelId ?? childDef.modelId,
      contextSnapshotId: latestVerifiedBinding?.contextSnapshotId ?? childDef.contextSnapshotId,
      sourceHash: latestVerifiedBinding?.sourceHash ?? childDef.sourceHash,
      ...(childDef.contextRoleId !== undefined ? { contextRoleId: childDef.contextRoleId } : {}),
      ...(childDef.title !== undefined ? { title: childDef.title } : {}),
      ...(childDef.dependsOn !== undefined ? { dependsOn: childDef.dependsOn } : {}),
      ...(childDef.role !== undefined ? { role: childDef.role } : {}),
      ...(childDef.work !== undefined ? { work: childDef.work } : {}),
      ...(childDef.expectedOutput !== undefined ? { expectedOutput: childDef.expectedOutput } : {}),
      state,
      attempted,
      line,
      answerTurnId,
      draftTurnId,
      chars,
      at,
      ...(latestVerifiedBinding !== undefined
        ? { attempt: latestVerifiedBinding, binding: latestVerifiedBinding }
        : {}),
      bindingVerified,
      attemptCount: history.length,
      attemptHistory: Object.freeze(history),
      attempts: Object.freeze(history)
    };
    return Object.freeze(view);
  });

  const total = recoveredChildren.length;
  const allAnswered = answeredCount === total;

  let status: "done" | "stopped" | "failed" | "interrupted";
  if (allAnswered) {
    status = "done";
  } else if (hasAttemptedUnknown || hasInterrupted) {
    status = "interrupted";
  } else if (hasFailed) {
    status = "failed";
  } else if (hasStopped) {
    status = "stopped";
  } else {
    status = "interrupted";
  }

  const headline = `${answeredCount} answered; ${total - answeredCount} stopped, failed, or interrupted.`;

  return Object.freeze({
    runId: parent.runId,
    kind: parent.kind,
    caseId: parent.caseId,
    request: parent.request,
    ...(parent.brief !== undefined ? { brief: parent.brief } : {}),
    ...(parent.integrationOwner !== undefined ? { integrationOwner: parent.integrationOwner } : {}),
    ...(parent.agentContract !== undefined ? { agentContract: parent.agentContract } : {}),
    at: parent.at,
    status,
    terminal: status,
    done: status === "done",
    answeredCount,
    totalChildren: total,
    headline,
    children: Object.freeze(recoveredChildren),
    outcomes: Object.freeze(recoveredChildren)
  });
}
