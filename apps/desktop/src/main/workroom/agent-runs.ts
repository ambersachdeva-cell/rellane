/** An agent's work must survive its screen. Starts precede work; answers and
 * terminal receipts commit together. Reopening these records never executes. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentBrief, AgentRunResult, ResolvedBrief } from "@cadrane/contracts";
import { appendTurn, openCase, readCase, turnsFor } from "../book/cases.js";
import type { AgentSourceSnapshot } from "../agents/sources.js";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";

export interface AgentWorkroom {
  readonly caseId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly requiredSourceTurnId: string | null;
}

/** Optional Host hooks run inside the existing Case start/finish transactions. */
export interface AgentWorkroomHooks {
  readonly attemptId: string;
  onStart(room: AgentWorkroom): void;
  onFinish(room: AgentWorkroom, result: AgentRunResult, answerTurnId: string | null): void;
}

/** A short label helps scanning; the full request is still saved verbatim. */
export function agentWorkroomTitle(name: string, question: string): string {
  const shorten = (value: string, limit: number, fallback: string) => {
    const clean = value.trim().replace(/\s+/gu, " ");
    if ([...clean].length <= limit) return clean;
    const leading = [...clean].slice(0, limit + 1).join("");
    const boundary = leading.lastIndexOf(" ");
    return boundary > 0 ? `${leading.slice(0, boundary).replace(/[.,;:!?—-]+$/u, "")}…` : fallback;
  };
  return `${shorten(name, 32, "Agent")} — ${shorten(question, 60, "Saved request")}`;
}

/** A failed start rolls back the entire room and prevents the first read. */
export function startAgentWorkroom(
  db: DatabaseSync, brief: AgentBrief, question: string, access: ResolvedBrief,
  source?: AgentSourceSnapshot, hooks?: AgentWorkroomHooks
): AgentWorkroom {
  const snapshot = JSON.stringify({ brief, allowedFolders: access.folders,
    allowedTools: access.capabilities, withheld: access.withheld }, null, 2);
  if (!question.trim() || question.length > 8_000 || snapshot.length > 50_000)
    throw new Error("This agent request or brief is too large to keep safely. Shorten it before running.");
  const attemptId = hooks?.attemptId ?? randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    const caseId = openCase(db, {
      title: agentWorkroomTitle(brief.name, question),
      question
    });
    appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: question });
    appendTurn(db, caseId, { seat: "agent run", kind: "receipt", body: [
      `Agent run ${attemptId} started on this Mac.`,
      `Agent: ${brief.name}. Saved identity: ${brief.id}.`,
      "This is a start, not a completed answer. Without a matching outcome, the run was interrupted; it will not restart automatically.",
      source
        ? "While it runs, use Stop on the Agents page. The required source snapshot is saved below. Additional tool reads are recorded by label, not archived."
        : "While it runs, use Stop on the Agents page. The receipt will list completed reads; original file contents are not archived here.",
      `Brief and access at the start:\n${snapshot}`
    ].join("\n") });
    let requiredSourceTurnId: string | null = null;
    if (source) {
      const sourceId = appendTurn(db, caseId, { seat: `${CASE_SOURCE_SEAT_PREFIX}${source.fileName}`,
        kind: "verbatim", body: source.text });
      requiredSourceTurnId = sourceId;
      appendTurn(db, caseId, { seat: "workroom", kind: "receipt", body: [
        `Required source snapshot selected by you for agent run ${attemptId}. Source turn: ${sourceId}.`,
        `File: ${source.fileName}. Format: ${source.format}. Bytes: ${source.bytes}.`,
        `File SHA-256: ${source.fileSha256}. Saved text SHA-256: ${source.textSha256}.`,
        `Coverage: ${source.coverage}`,
        "This captured text is the required input, not a live file reread. A saved start does not prove that a model received it or answered correctly."
      ].join("\n") });
    }
    const room = { caseId, attemptId, agentId: brief.id, agentName: brief.name,
      requiredSourceTurnId };
    hooks?.onStart(room);
    db.exec("COMMIT");
    return room;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** No answer is saved on its own, no completion is implied by a start, and no
 * retry can append a second terminal result to the same attempt. */
export function finishAgentWorkroom(
  db: DatabaseSync, room: AgentWorkroom, result: AgentRunResult,
  hooks?: AgentWorkroomHooks
): void {
  const prefix = `Agent run ${room.attemptId}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    const turns = turnsFor(db, room.caseId);
    if (result.agentId !== room.agentId || result.agentName !== room.agentName ||
        readCase(db, room.caseId)?.closedAt !== null ||
        !turns.some(turn => turn.seat === "agent run" && turn.kind === "receipt" && turn.body.startsWith(`${prefix} started `)) ||
        turns.some(turn => turn.seat === "agent run" && turn.kind === "receipt" && turn.body.startsWith(`${prefix} finished `)))
      throw new Error("The saved agent run no longer matches this result. No answer was added.");
    if ((result.outcome === "answered") !== (result.answer.trim().length > 0))
      throw new Error("An unfinished agent result cannot become a saved answer.");
    const answerId = result.outcome === "answered"
      ? appendTurn(db, room.caseId, { seat: `Agent · ${room.agentName}`, kind: "verbatim", body: result.answer })
      : null;
    appendTurn(db, room.caseId, { seat: "agent run", kind: "receipt", body: [
      `${prefix} finished — ${result.outcome}.`,
      result.summary,
      `Agent: ${room.agentName}. Saved identity: ${room.agentId}. Execution: ${result.id || "no model run"}.`,
      `Ran on: ${result.ranOnLabel ?? "No model was asked"}.`,
      `Elapsed: ${result.elapsedMs} ms. Approximate tokens: ${result.approxTokens}.`,
      ...(result.problem ? [`Problem: ${result.problem}`] : []),
      ...(result.substituted ? [result.substituted] : []),
      "Completed read/tool outcomes:",
      ...(result.read.length ? result.read.map(step => `• ${step}`) : ["None recorded."]),
      "Read labels describe actions; they are not archived file contents or proof that the answer is correct.",
      answerId ? `Saved answer: ${answerId}. Review it in Your output before accepting or exporting. Nothing was automatically accepted.`
        : "No answer was accepted. Any retry is a new explicit request."
    ].join("\n") });
    hooks?.onFinish(room, result, answerId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
