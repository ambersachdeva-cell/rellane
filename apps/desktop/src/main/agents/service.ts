/**
 * The agent service — one place that turns "run this" into a result.
 *
 * Assembled here rather than in the IPC handler so the wiring is testable and
 * so the handler stays what it should be: a sender check, a schema, and a call.
 */

import type { AgentRunResult } from "@cadrane/contracts";
import type { DatabaseSync } from "node:sqlite";
import { prepareLocalAgent } from "./local.js";
import type { LocalWorkroomDeps } from "../workroom/local.js";
import { findAgent } from "./roster.js";
import { describeRun, runAgent, type AgentRun, type Evidence, type RunProgress } from "./run.js";
import type { AgentBrief } from "@cadrane/contracts";
import { reachableFolders, resolveBrief, type Ceiling } from "./brief.js";
import { captureManifest } from "../timeline/manifest.js";
import { createSandbox, type Sandbox } from "../tools/sandbox.js";
import { glossary, glossaryPrompt } from "../glossary/terms.js";
import { outstanding, totalOwedPaise } from "../book/records.js";
import { rupees } from "../book/money.js";
import { startAgentWorkroom, finishAgentWorkroom, type AgentWorkroom } from "../workroom/agent-runs.js";
import type { AgentSourceSnapshot } from "./sources.js";

/**
 * What an agent is allowed to look at.
 *
 * A listing, not contents. The first thing every one of these agents needs is
 * "what is in this folder", and handing a model the bytes of nine hundred files
 * to answer that would be slow, expensive and worse. Reading a specific file is
 * a capability, and it goes through the tool layer where it can be recorded.
 */
async function gatherFolderListing(folders: readonly string[]): Promise<readonly Evidence[]> {
  const evidence: Evidence[] = [];
  for (const folder of folders) {
    const { manifest } = await captureManifest(folder);
    const rows = manifest.rows
      .slice(0, 40)
      .map((row) => `${row.path}\t${row.size}\t${new Date(row.mtimeMs).toISOString()}`)
      .join("\n");
    evidence.push({
      label: `listing of ${folder.split("/").filter(Boolean).pop() ?? folder}`,
      content:
        `path\tbytes\tmodified\n${rows}` +
        (manifest.rows.length > 40
          ? `\n… ${manifest.rows.length - 40} more files not listed. This is a partial listing, not a complete folder review.`
          : "")
    });
  }
  return evidence;
}

/** How many customers reach a prompt. A model does not need the long tail. */
const BOOK_ROWS = 40;

/**
 * The book, as a model is told it.
 *
 * Figures come from here and only from here: the vault source below carries the
 * owner's prose and never a number, so there is exactly one place an amount in a
 * prompt can have come from.
 */
function gatherBook(db: DatabaseSync): Evidence {
  const parties = outstanding(db);
  const owing = parties.filter((party) => party.owedPaise > 0).slice(0, BOOK_ROWS);
  return {
    label: "the book",
    content: [
      `${rupees(totalOwedPaise(db))} outstanding across ${parties.filter((party) => party.owedPaise > 0).length} customers.`,
      ...owing.map(
        (party) =>
          `${party.name}\t${rupees(party.owedPaise)}\t${party.openBills} open ${party.openBills === 1 ? "bill" : "bills"}`
      )
    ].join("\n")
  };
}

/** What the owner has written about people, in their own words. */
function gatherNotes(db: DatabaseSync): Evidence | null {
  const noted = outstanding(db).filter(
    (party) => party.note !== null && party.note.trim().length > 0
  );
  if (noted.length === 0) {
    return null;
  }
  return {
    label: "the owner's notes",
    content: noted.map((party) => `${party.name}: ${party.note ?? ""}`).join("\n")
  };
}

/**
 * Everything one agent's brief says it may draw on.
 *
 * Dispatches on `reads` rather than always handing over a folder listing. The
 * screen tells the owner *"may draw on its folders, your records and the names
 * it has learned"*, and until this dispatched, that sentence was decorative in
 * both directions: an agent that declared only the glossary still received a
 * folder listing, and one that declared the glossary received no glossary. A
 * permission list that does not decide anything is the most expensive kind of
 * lie, because it reads exactly like a working one.
 */
export async function gatherFor(
  brief: AgentBrief,
  granted: readonly string[],
  book: DatabaseSync | null,
  requiredSource?: AgentSourceSnapshot
): Promise<readonly Evidence[]> {
  const reads = new Set(brief.workspace.reads);
  const evidence: Evidence[] = requiredSource ? [{
    label: `required source snapshot ${requiredSource.fileName} · SHA-256 ${requiredSource.fileSha256}`,
    content: requiredSource.text
  }] : [];

  if (reads.has("folders") && !requiredSource) {
    evidence.push(
      ...(await gatherFolderListing(
        brief.workspace.folders.filter((folder) => granted.includes(folder))
      ))
    );
  }

  if (reads.has("timeline")) {
    evidence.push({ label: "change-history availability",
      content: "No before-and-after capture comparison is connected to this agent yet. Current file metadata does not prove arrivals, moves, deletions or who changed a file. Say that change history is unavailable; do not invent a comparison." });
  }

  // Every remaining source is in the book, so one closed book means the agent
  // is told nothing rather than told something stale.
  if (book === null) {
    return evidence;
  }

  if (reads.has("glossary")) {
    const prompt = glossaryPrompt(glossary(book));
    if (prompt.length > 0) {
      evidence.push({ label: "words this business uses", content: prompt });
    }
  }
  if (reads.has("book")) {
    evidence.push(gatherBook(book));
  }
  if (reads.has("vault")) {
    const notes = gatherNotes(book);
    if (notes !== null) {
      evidence.push(notes);
    }
  }

  return evidence;
}

/**
 * Runs in flight, so one that is watched can also be stopped.
 *
 * Keyed by the agent rather than by a run id: only one agent runs at a time by
 * design (two frontier CLIs on a laptop is a fan and a bill), so this map holds
 * at most one entry and "stop what is running" needs no id to be plumbed
 * through the renderer before the run has told it one.
 */
const inFlight = new Map<string, { controller: AbortController; workroomId: string | null }>();

/** Closing or erasing live work would make its completion impossible to keep. */
export function assertAgentWorkroomIdle(caseId: string): void {
  if ([...inFlight.values()].some(active => active.workroomId === caseId))
    throw new Error("This workroom's agent is still running. Stop it on the Agents page before closing, erasing or starting another request here.");
}

/** Stops a running agent. True when there was one to stop. */
export function stopAgent(agentId: string): boolean {
  const controller = inFlight.get(agentId);
  if (controller === undefined) {
    return false;
  }
  controller.controller.abort();
  return true;
}

export async function runAgentById(
  agentId: string,
  question: string,
  ceiling: Ceiling,
  record?: (run: AgentRun) => Promise<void>,
  /** The open book, when there is one. Null means those sources are skipped. */
  book: DatabaseSync | null = null,
  /** Told what the run is doing, as it does it. */
  progress?: (update: RunProgress) => void,
  /** No dependency means no dispatch, never a subscription fallback. */
  localRuntime?: LocalWorkroomDeps & {
    currentCeiling(): Promise<Ceiling>;
    requiredSource?: { snapshot: AgentSourceSnapshot; sandbox: Sandbox; assertCurrent(): Promise<void> };
  }
): Promise<AgentRunResult> {
  const brief = findAgent(ceiling.grantedFolders, ceiling.storedAgents, agentId);
  if (brief === undefined) {
    return {
      id: "",
      agentId,
      agentName: agentId,
      outcome: "refused",
      summary: `There is no agent called ${agentId}.`,
      answer: "",
      problem: `There is no agent called ${agentId}.`,
      substituted: null,
      ranOnLabel: null,
      read: [],
      elapsedMs: 0,
      approxTokens: 0
    };
  }

  const refused = (problem: string, outcome: "refused" | "stopped" | "failed" = "refused"): AgentRunResult => ({
    id: "", agentId, agentName: brief.name, outcome, summary: problem, answer: "",
    problem, substituted: null, ranOnLabel: null, read: [], elapsedMs: 0, approxTokens: 0
  });
  if (inFlight.size > 0)
    return refused("An agent is already running on this Mac. Stop it or wait for its result before starting another.");
  if (!localRuntime)
    return refused("The local agent connection is not available. Restart the app and try again. No subscription was contacted.");
  const required = localRuntime.requiredSource;
  if (required && !book)
    return refused("The required source needs a saved workroom before this agent can run. No model was asked.");
  const originalAccess = resolveBrief(brief, ceiling);
  if (originalAccess.inert)
    return refused("This agent has no usable folder or reading tool. Review its brief and grants before running it.");
  const checkAccess = async (): Promise<void> => {
    await required?.assertCurrent();
    const current = resolveBrief(brief, await localRuntime.currentCeiling());
    if (originalAccess.folders.some(folder => !current.folders.includes(folder)) ||
        originalAccess.capabilities.some(capability => !current.capabilities.includes(capability)))
      throw new Error("A folder or tool grant changed while this agent was running. Review its brief before starting again.");
  };

  // The sandbox is built from the *resolved* folders, so an agent can only
  // reach what its brief was actually granted — never what it asked for.
  const controller = new AbortController();
  const active = { controller, workroomId: null as string | null };
  let workroom: AgentWorkroom | null = null;
  const finish = (result: AgentRunResult): AgentRunResult => {
    if (!workroom || !book) return result;
    try {
      finishAgentWorkroom(book, workroom, result);
      return { ...result, workroomId: workroom.caseId, recordProblem: null };
    } catch {
      return { ...result, workroomId: workroom.caseId,
        recordProblem: "This result could not be saved. Keep this window open to copy it; the earlier saved start does not confirm completion. Nothing will retry automatically." };
    }
  };
  // Admit before the first await. UI disabling alone cannot prevent two IPC calls.
  inFlight.set(agentId, active);

  try {
    if (required) {
      await checkAccess();
      controller.signal.throwIfAborted();
    }
    if (book) {
      try {
        workroom = startAgentWorkroom(book, brief, question, originalAccess, required?.snapshot);
        active.workroomId = workroom.caseId;
      } catch {
        return refused("The agent's workroom could not be saved. No model was asked or agent tool run. Check local storage before trying again.");
      }
    }
    let local: Awaited<ReturnType<typeof prepareLocalAgent>>;
    try {
      local = await prepareLocalAgent(brief, localRuntime, controller.signal);
    } catch (error) {
      return finish(controller.signal.aborted
        ? refused(`You stopped ${brief.name} before it asked the model.`, "stopped")
        : refused(error instanceof Error ? error.message : "The bundled model could not be checked."));
    }
    // Built from the folders that are actually granted, and the *count of those*
    // decides whether there is a sandbox at all.
    //
    // It used to test what the brief asked for, so an agent naming three folders
    // that had all been revoked or paused got `createSandbox([])` — a sandbox
    // object bounding nothing — and was handed a tool context, contradicting the
    // rule that it can only reach what it was granted.
    const reachable = reachableFolders(ceiling.grantedFolders, brief.workspace.folders);
    const sandbox = required?.sandbox ??
      (reachable.length === 0 ? null : await createSandbox(reachable).catch(() => null));

    const run = await runAgent(brief, question, {
      room: local.room,
      ceiling,
      ...(sandbox === null ? {} : { tools: { sandbox } }),
      ask: local.ask,
      checkAccess,
      gather: async (candidate) => gatherFor(candidate, ceiling.grantedFolders, book, required?.snapshot),
      signal: controller.signal,
      ...(progress === undefined ? {} : { progress }),
      ...(record === undefined ? {} : { record })
    });

    return finish({
      id: run.id,
      agentId: run.agentId,
      agentName: run.agentName,
      outcome: run.outcome,
      summary: describeRun(run),
      answer: run.answer,
      problem: run.problem,
      substituted: run.ranOn?.substituted ?? null,
      ranOnLabel: run.ranOn === null ? null : `${run.ranOn.engineLabel} ${run.ranOn.modelLabel}`,
      read: run.used.map((step) => step.said),
      elapsedMs: run.elapsedMs,
      approxTokens: run.approxTokens
    });
  } catch (error) {
    return finish(refused(error instanceof Error ? error.message : "This agent did not finish. Review its saved start before trying again.", controller.signal.aborted ? "stopped" : "failed"));
  } finally {
    // Retire only this run's admission entry.
    if (inFlight.get(agentId) === active) {
      inFlight.delete(agentId);
    }
  }
}
