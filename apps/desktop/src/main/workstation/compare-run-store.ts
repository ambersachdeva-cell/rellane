/** Compare's parent and child receipts live in the existing Case book. */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { appendTurn } from "../book/cases.js";
import type { DispatchBoard, DispatchLane, LaneState } from "./dispatch-run-ipc.js";

export {
  askInCase,
  systemFor,
  promptFor as askInCasePromptFor,
  MAX_SEATS,
  type CaseSeat,
  type AskInCaseDeps,
  type SeatOutcome,
  type AskInCaseResult
} from "../crew/ask-in-case.js";

export {
  Board,
  LEASE_MS,
  MAX_ATTEMPTS,
  type JobState,
  type Job
} from "../crew/claims.js";

export {
  round,
  work,
  promptFor as fanoutPromptFor,
  ESTIMATE,
  type CrewSeat,
  type FanOutDeps,
  type RoundResult
} from "../crew/fanout.js";

export {
  renderRoom,
  boundary,
  safeLabel,
  decide,
  withinReach,
  narrowReach,
  type Turn,
  type Caller,
  type ToolRequest,
  type Decision
} from "../crew/untrusted.js";

const PREFIX = "RellaneCompareV1:";
const Parent = z.strictObject({ event: z.literal("parent"), runId: z.uuid(), caseId: z.string().min(1),
  brief: z.string().min(1), at: z.number().int(),
  children: z.array(z.strictObject({ providerId: z.string().min(1), label: z.string().min(1),
    modelId: z.string().min(1), contextSnapshotId: z.string().min(1), sourceHash: z.string().min(1) })).min(1).max(5) });
const Child = z.strictObject({ event: z.literal("child"), runId: z.uuid(), index: z.number().int().min(0).max(4),
  state: z.enum(["starting", "answered", "stopped", "failed", "interrupted"]),
  at: z.number().int(), line: z.string().max(800), answerTurnId: z.string().nullable(),
  draftTurnId: z.string().nullable(), chars: z.number().int().min(0) });
type ParentRecord = z.infer<typeof Parent>;
type ChildRecord = z.infer<typeof Child>;

function appendReceipt(db: DatabaseSync, caseId: string, runId: string, record: ParentRecord | ChildRecord): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    appendTurn(db, caseId, { seat: "workstation", kind: "receipt",
      body: `${PREFIX}${runId}:${JSON.stringify(record)}` });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveCompareParent(db: DatabaseSync, record: unknown): void {
  const valid = Parent.parse(record);
  appendReceipt(db, valid.caseId, valid.runId, valid);
}

export function saveCompareChild(db: DatabaseSync, caseId: string, record: ChildRecord): void {
  Child.parse(record);
  appendReceipt(db, caseId, record.runId, record);
}

/** A restart never guesses an answer or replays a native effect. */
export function recoveredCompareBoard(db: DatabaseSync, runId: string): DispatchBoard | null {
  if (!z.uuid().safeParse(runId).success) return null;
  const rows = db.prepare(`SELECT case_id AS caseId, body FROM case_turn
    WHERE seat = 'workstation' AND kind = 'receipt' AND body LIKE ? ORDER BY at, seq`)
    .all(`${PREFIX}${runId}:%`) as unknown as readonly { readonly caseId: string; readonly body: string }[];
  let parent: ParentRecord | null = null;
  const children = new Map<number, ChildRecord>();
  for (const row of rows) {
    try {
      const data: unknown = JSON.parse(row.body.slice(`${PREFIX}${runId}:`.length));
      const parsedParent = Parent.safeParse(data);
      if (parsedParent.success && parsedParent.data.runId === runId && row.caseId === parsedParent.data.caseId) {
        parent = parsedParent.data;
        continue;
      }
      const parsedChild = Child.safeParse(data);
      if (parsedChild.success && parsedChild.data.runId === runId && parent !== null && row.caseId === parent.caseId)
        children.set(parsedChild.data.index, parsedChild.data);
    } catch {
      // An unreadable receipt grants neither an answer nor a retry.
    }
  }
  if (parent === null) return null;
  let answered = 0;
  const lanes: DispatchLane[] = parent.children.map((selected, index) => {
    const child = children.get(index);
    const state: LaneState = child?.state === "answered" ? "answered"
      : child?.state === "stopped" ? "stopped"
      : child?.state === "failed" ? "failed" : "interrupted";
    if (state === "answered") answered += 1;
    const line = child?.state === "starting"
      ? "The provider was attempted before the app stopped. Check its session receipt before retrying."
      : child === undefined
        ? "This lane was not started before the app stopped. Review it again to retry."
        : child.line;
    return { providerId: selected.providerId, label: selected.label,
      state, line, elapsed: "—", answerTurnId: child?.answerTurnId ?? null,
      draftTurnId: child?.draftTurnId ?? null, outcome: null, chars: child?.chars ?? 0,
      canStop: false };
  });
  return { runId, caseId: parent.caseId, brief: parent.brief, lanes,
    headline: `${answered} answered; ${lanes.length - answered} stopped, failed, or interrupted.`,
    working: 0, answered, done: true };
}
