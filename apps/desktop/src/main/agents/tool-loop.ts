/**
 * Letting an agent actually use the tools its brief says it has.
 *
 * Until now the system prompt said "Tools available to you: read_text" and the
 * runtime made one model call and returned the text. The model was told it had
 * tools it had no way to invoke, so it did what any model does — emitted a tool
 * call into prose and waited for a result that never came. A prompt that
 * promises a capability the runtime cannot deliver is worse than one that
 * admits there are none.
 *
 * ## Why a text protocol
 *
 * These engines are CLIs, not an API with native function calling: `claude -p`
 * and `agy -p` take a prompt and return text. So the call format is text, and
 * the design constraints are the ones text protocols always have —
 *
 *   - **One call per turn.** A model that emits three calls at once is
 *     guessing at the results of the first two. One at a time costs more
 *     round-trips and produces work that is actually informed.
 *   - **Unparseable is not fatal.** A malformed call is answered with what was
 *     wrong so the model can correct it, because refusing the whole run over a
 *     missing brace throws away everything already paid for.
 *   - **The sandbox is ours.** Paths come from the brief's granted folders. The
 *     model names a file; the sandbox decides whether that file exists as far
 *     as this agent is concerned.
 *
 * ## Reads only, deliberately
 *
 * D-029, decided by the Bench: reads before writes. An agent editing blind
 * cannot produce a plan sheet worth approving, and a read is recoverable where
 * a bad write on somebody's ledger is not. Anything whose risk is not `read` is
 * refused here even if a brief names it.
 */

import { basename } from "node:path";
import type { ToolContext } from "../tools/registry.js";
import { toolByName } from "../tools/registry.js";
import { asEvidence } from "./context.js";

/** How the model is told to ask for a tool. */
// Lazy, not greedy. `[\s\S]*` ran to the LAST brace anywhere in the reply, so a
// tool call followed by any prose containing `}` swallowed all of it — JSON.parse
// then failed and `withoutCall` erased the model's real text along with it.
const CALL = /^[ \t]*TOOL:[ \t]*([a-z_]+)[ \t]*(\{[\s\S]*?\})[ \t]*$/mu;

export interface ToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolOutcome {
  readonly call: ToolCall;
  /** What to feed back to the model, already wrapped as evidence. */
  readonly reply: string;
  readonly failed: boolean;
}

/**
 * The instructions that make the protocol usable.
 *
 * Appended to the system prompt only when the agent actually has tools, so an
 * agent with none is never taught a syntax it cannot use.
 */
export function toolInstructions(tools: readonly string[]): string {
  if (tools.length === 0) {
    return "";
  }
  const described = tools
    .map((name) => {
      const tool = toolByName(name);
      // Only tools `runTool` will actually allow. Advertising a writing tool
      // that is then refused every time teaches the model to keep trying it,
      // and spends the owner's steps doing so (D-029).
      return tool === null || tool.definition.risk !== "read"
        ? null
        : `  ${name} — ${tool.definition.description}`;
    })
    .filter((line): line is string => line !== null);

  if (described.length === 0) {
    // Nothing usable resolved. Emitting the protocol with an empty "Available:"
    // list would teach a syntax with no verbs.
    return "";
  }

  return [
    "When you need something you do not have, ask for it with a single line, on its own, exactly like this:",
    'TOOL: read_text {"path": "/full/path/to/file.txt"}',
    "",
    "Then stop and wait. You will be given the result and may continue. Ask for one thing at a time — asking for three at once means guessing at the results of the first two.",
    "When you have what you need, answer normally with no TOOL line.",
    "",
    "Available:",
    ...described
  ].join("\n");
}

/**
 * Finds a tool call in a model's reply, if there is one.
 *
 * Returns null for ordinary prose, which is the common case and must not be
 * mistaken for a malformed call.
 */
export function parseCall(text: string): ToolCall | { readonly problem: string } | null {
  const found = CALL.exec(text);
  if (found === null) {
    return null;
  }
  const [, tool, json] = found;
  if (tool === undefined || json === undefined) {
    return { problem: "That TOOL line was not readable." };
  }

  let args: unknown;
  try {
    args = JSON.parse(json);
  } catch {
    return {
      problem: `The arguments after TOOL: ${tool} were not valid JSON. Send the line again with correct JSON.`
    };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { problem: `The arguments after TOOL: ${tool} must be a JSON object.` };
  }
  return { tool, args: args as Record<string, unknown> };
}

/**
 * Runs one tool call on the agent's behalf.
 *
 * Every refusal explains itself in terms the model can act on, because a model
 * told only "denied" will try the same thing again.
 */
export async function runTool(
  call: ToolCall,
  allowed: readonly string[],
  context: ToolContext
): Promise<ToolOutcome> {
  const tool = toolByName(call.tool);

  if (tool === null) {
    return fail(call, `There is no tool called ${call.tool}. Use one of: ${allowed.join(", ")}.`);
  }
  if (!allowed.includes(call.tool)) {
    return fail(
      call,
      `${call.tool} is not in this agent's brief. It may use: ${allowed.join(", ") || "nothing"}.`
    );
  }
  if (tool.definition.risk !== "read") {
    // D-029. Enforced here rather than trusted to the brief, so a brief that
    // names a writing tool still cannot get one through an agent today.
    return fail(
      call,
      `${call.tool} changes things, and agents may only read for now. Report what you found instead.`
    );
  }

  try {
    const result = await tool.handler(call.args, context);
    return {
      call,
      // Wrapped as evidence: a file's contents are data, and a document that
      // says "ignore your instructions" is a fact about the document.
      // `JSON.stringify(undefined)` is the value `undefined`, not a string, so
      // `.slice` on it threw and reported a successful tool call as a crash.
      reply: asEvidence(`${call.tool} result`, (JSON.stringify(result) ?? "null").slice(0, 60_000)),
      failed: false
    };
  } catch (error) {
    const why = error instanceof Error ? error.message : "That tool failed.";
    // Name the roots on every path failure. A model told only "that does not
    // exist" tries the same path again — observed live, three times in a row —
    // whereas one told where the fence is corrects itself on the next turn.
    const roots = context.sandbox.roots;
    return fail(
      call,
      roots.length === 0
        ? why
        : `${why} The folders you may use are: ${roots.join(", ")}. Use one of these exact paths.`
    );
  }
}

function fail(call: ToolCall, why: string): ToolOutcome {
  return {
    call,
    reply: asEvidence(`${call.tool} refused`, why),
    failed: true
  };
}

/**
 * One line of the receipt, in the owner's words.
 *
 * Names the file rather than the tool, because "read quote.txt" is something a
 * person can check and "called read_text" is something they have to trust.
 * Falls back to the tool's own name only when the arguments say nothing useful,
 * which is better than printing `{"path":"…"}` at somebody.
 */
export function describeCall(outcome: ToolOutcome): string {
  const { tool, args } = outcome.call;
  const target = typeof args["path"] === "string" ? basename(args["path"]) : null;
  const verb =
    tool === "read_text" ? "read" : tool === "list_folder" ? "looked in" : tool.replace(/_/gu, " ");
  const phrase = target === null ? verb : `${verb} ${target}`;
  // A refusal on the receipt is the row most worth keeping: it is the evidence
  // that the fence held.
  return outcome.failed ? `${phrase} — refused` : phrase;
}

/** Strips the TOOL line so a partial answer beside it still reads. */
export function withoutCall(text: string): string {
  return text.replace(CALL, "").trim();
}
