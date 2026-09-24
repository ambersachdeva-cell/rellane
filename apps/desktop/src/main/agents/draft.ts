/**
 * Turning a sentence into a brief — task 3.5.
 *
 * *"Watch Clients and tell me what is late"* should produce something the owner
 * can read, correct and save. Writing a brief by hand means understanding tiers,
 * step budgets and outbound policy before you have done anything useful once,
 * and a form that demands that gets abandoned.
 *
 * ## The model proposes; nothing here is granted
 *
 * This asks an engine for a **shape**, and the shape is then put through exactly
 * the same clamping every other brief gets (`rehydrate` in `roster.ts`). A model
 * naming a folder does not grant that folder; a model asking for sixty steps does
 * not get them past the ceiling; and a model setting `outbound: "ask"` gets it
 * only because that value is checked against a list of two.
 *
 * The draft lands in the editor, not in the roster. **Nothing is saved until a
 * person presses save** — which is the whole reason the sentence under the form
 * exists, and the reason drafting is safe to offer at all.
 *
 * ## Why a strict shape and not free text
 *
 * The reply is parsed as JSON with one key per field. Asking a model for prose
 * and then interpreting it produces a brief that reads plausibly and grants
 * something nobody chose; asking for named fields makes every value checkable
 * before it is shown.
 */

import type { EngineRoomStatus } from "@cadrane/contracts";
import { rehydrate, type StoredBrief } from "./roster.js";
import { diagnostics } from "../foundations/diagnostics.js";
import { prepareLocalAgent } from "./local.js";
import { newBrief } from "./brief.js";
import type { RunDeps } from "./run.js";
import type { LocalWorkroomDeps } from "../workroom/local.js";

/** A model gets this long. Drafting is a convenience; it must not feel like a job. */
export const DRAFT_TIMEOUT_MS = 90_000;

export interface DraftResult {
  readonly ok: boolean;
  /** The brief, ready for the editor. Null when it could not be drafted. */
  readonly draft: StoredBrief | null;
  /** What happened, in the owner's words. Always set. */
  readonly said: string;
}

/**
 * The instruction, written so the reply is checkable rather than plausible.
 *
 * The granted folders are listed because a brief naming a folder this Mac does
 * not have produces a withheld-permission warning on a fresh draft — which
 * teaches the owner that warnings are decoration.
 */
export function draftPrompt(sentence: string, folders: readonly string[]): string {
  return [
    "Turn the request below into an agent brief for a local-first Mac app.",
    "",
    "Reply with JSON only — no prose, no code fence. These keys exactly:",
    '  name          a short title, at most 4 words',
    '  purpose       one sentence, what it is for',
    '  instructions  standing guidance, or ""',
    '  folders       an array chosen ONLY from the list below, or []',
    '  capabilities  any of ["list_folder","read_text"]',
    '  tier          "on-device"',
    '  maxSteps      1-60      maxMinutes 1-60',
    '  outbound      "never" unless the request clearly asks to prepare a message, then "ask"',
    "",
    folders.length === 0
      ? "No folders are available on this Mac, so folders must be []."
      : `Folders available:\n${folders.map((folder) => `  ${folder}`).join("\n")}`,
    "",
    "This agent can only read files and propose answers on this Mac. It cannot watch continuously, change files or send messages. Describe unsupported ambitions as limits to review, not capabilities it has. Prefer a small step/time budget.",
    "",
    `The request: ${sentence}`
  ].join("\n");
}

/** Pulls the JSON object out of a reply that may still carry a fence or prose. */
export function readDraft(text: string): Record<string, unknown> | null {
  // Models add fences and preambles however firmly they are told not to, and
  // failing the whole draft over a stray "Here you go:" would be a worse
  // product than tolerating it.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Picks the cheapest ready engine. Drafting is not work worth a frontier model. */
function cheapest(room: EngineRoomStatus): { engineId: string; modelId: string } | null {
  for (const tier of ["on-device", "fast", "balanced", "frontier"] as const) {
    for (const engine of room.engines) {
      if (engine.state !== "ready") {
        continue;
      }
      const model = engine.models.find((candidate) => candidate.tier === tier);
      if (model !== undefined) {
        return { engineId: engine.id, modelId: model.id };
      }
    }
  }
  return null;
}

/**
 * Drafts a brief from one sentence.
 *
 * Never throws: a failure here is a line under the input box, because the owner
 * can always write the brief themselves and the draft is a shortcut, not a
 * dependency.
 */
export async function draftBrief(
  sentence: string,
  folders: readonly string[],
  room: EngineRoomStatus,
  ask: RunDeps["ask"],
  signal = AbortSignal.timeout(DRAFT_TIMEOUT_MS)
): Promise<DraftResult> {
  const request = sentence.trim();
  if (request.length === 0) {
    return { ok: false, draft: null, said: "Say what you want it to do first." };
  }

  const engine = cheapest(room);
  if (engine === null) {
    return {
      ok: false,
      draft: null,
      said: "No engine is connected, so there is nothing to draft with. Write the brief yourself, or open Engines."
    };
  }

  let reply: string;
  try {
    reply = await ask({
      engineId: engine.engineId,
      modelId: engine.modelId,
      system: "You write agent briefs. You reply with JSON and nothing else.",
      prompt: draftPrompt(request, folders),
      signal
    });
  } catch (error) {
    return {
      ok: false,
      draft: null,
      said: error instanceof Error ? error.message : "That could not be drafted."
    };
  }

  const raw = readDraft(reply);
  if (raw === null) {
    return {
      ok: false,
      draft: null,
      said: "The reply was not a brief. Try saying it differently, or write it yourself."
    };
  }

  /**
   * Through the same door every other brief goes through.
   *
   * `rehydrate` clamps the budgets, refuses an unknown tier, and treats any
   * unrecognised outbound value as "never". A model cannot widen anything by
   * asking — and the folders it named are still checked against real grants when
   * the brief resolves, so naming one it was not offered produces a withheld
   * line rather than access.
   */
  const stored: StoredBrief = {
    id: slug(String(raw["name"] ?? "")) || `agent-${Date.now()}`,
    name: String(raw["name"] ?? ""),
    purpose: String(raw["purpose"] ?? ""),
    instructions: typeof raw["instructions"] === "string" ? raw["instructions"] : "",
    folders: asStrings(raw["folders"]).filter((folder) => folders.includes(folder)),
    capabilities: asStrings(raw["capabilities"]),
    tier: typeof raw["tier"] === "string" ? raw["tier"] : "fast",
    maxSteps: typeof raw["maxSteps"] === "number" ? raw["maxSteps"] : 12,
    maxMinutes: typeof raw["maxMinutes"] === "number" ? raw["maxMinutes"] : 3,
    outbound: raw["outbound"] === "ask" ? "ask" : "never"
  };

  if (rehydrate(stored) === null) {
    return { ok: false, draft: null, said: "That did not come back as a usable brief." };
  }

  diagnostics.info("agents", "drafted a brief from a sentence", { engine: engine.engineId });
  return {
    ok: true,
    draft: stored,
    said: "Here is a draft. Read it, change anything, and save it when it says what you meant."
  };
}

/** The live entry point has no subscription dispatcher or credential path. */
export async function draftLocalBrief(
  sentence: string, folders: readonly string[], runtime: LocalWorkroomDeps,
  signal = AbortSignal.timeout(DRAFT_TIMEOUT_MS)
): Promise<DraftResult> {
  if (!sentence.trim()) return { ok: false, draft: null, said: "Say what you want it to do first." };
  if (sentence.length > 2_000 || folders.length > 20)
    return { ok: false, draft: null, said: "Use a shorter request or fewer workspace folders for this local draft." };
  try {
    const local = await prepareLocalAgent(newBrief({ id: "brief-drafting", name: "Brief drafting",
      purpose: "Prepare an editable brief", tier: "on-device", outbound: "never" }), runtime, signal);
    const result = await draftBrief(sentence, folders, local.room, local.ask, signal);
    if (!result.ok || !result.draft) return result;
    signal.throwIfAborted();
    const normalized = rehydrate({ ...result.draft, tier: "on-device",
      capabilities: result.draft.capabilities?.filter(tool => tool === "list_folder" || tool === "read_text") ?? [] });
    if (!normalized) return { ok: false, draft: null, said: "The local model did not return a usable brief. Write it yourself or try a clearer request." };
    return { ok: true, said: "Drafted on this Mac. Check its purpose, folders and limits before saving. The agent has not run, and this draft grants no access.",
      draft: { id: normalized.id, name: normalized.name, purpose: normalized.purpose,
        instructions: normalized.instructions, folders: normalized.workspace.folders,
        capabilities: normalized.capabilities, tier: "on-device", maxSteps: normalized.limits.maxSteps,
        maxMinutes: normalized.limits.maxMinutes, outbound: normalized.outbound } };
  } catch (error) {
    return { ok: false, draft: null,
      said: error instanceof Error ? error.message : "The local draft could not finish. Write it yourself or try again." };
  }
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
}
