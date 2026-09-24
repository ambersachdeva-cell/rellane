/**
 * Running an agent, and being able to say afterwards exactly what happened.
 *
 * The shape is deliberately narrow for a first version: an agent gathers what
 * its brief allows, asks one engine, may ask that engine for more — one tool
 * call per turn, reads only (D-029) — and produces an answer that lands in the
 * record. It does not change files. The agents that will do that go through the
 * plan sheet the Librarian already uses, and bolting a second, unreviewed write
 * path onto this one would undo the only guarantee the product actually makes.
 *
 * What this file is careful about is the *reporting*, because a run that fails
 * silently is worse than one that never started:
 *
 *   - Every outcome is one of four named states, and "failed" carries what
 *     stopped it and what to do.
 *   - A step is a model call, so a brief that says "stops after 40 steps" is
 *     counting the thing that costs money rather than something invisible.
 *   - Every tool it called is on the run, so "it answered" and "it answered
 *     after reading four files" are not the same row in the record.
 *   - The engine it actually ran on is recorded, including when that was not
 *     the tier the brief asked for. The brief is what the owner read; a run on
 *     something else has to say so.
 *   - The budget is enforced rather than declared. A brief that says "stops
 *     after 3 minutes" and then runs for nine has taught its owner that the
 *     numbers on that screen are decoration.
 *   - Evidence from the owner's folders is wrapped as data before it reaches a
 *     model, and a model's reply is never treated as a command.
 */

import { randomUUID } from "node:crypto";
import type { AgentBrief, EngineRoomStatus } from "@cadrane/contracts";
import { resolveBrief, type Ceiling } from "./brief.js";
import { asEvidence, roughTokens, toSystemPrompt } from "./context.js";
import { selectEngine, type Selection } from "./select.js";
import { describeCall, parseCall, runTool, toolInstructions, withoutCall } from "./tool-loop.js";
import type { ToolContext } from "../tools/registry.js";
import { diagnostics } from "../foundations/diagnostics.js";

export type RunOutcome = "answered" | "refused" | "stopped" | "failed";

export interface AgentRun {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: RunOutcome;
  /** What it produced. Empty unless the outcome is "answered". */
  readonly answer: string;
  /** Which engine and model actually ran it. Null when nothing ran. */
  readonly ranOn: Selection | null;
  /** Present on refused, stopped and failed. Always says what to do next. */
  readonly problem: string | null;
  /**
   * Every tool the agent actually called, in order, each already phrased for a
   * person: "read quote.txt", "looked in Downloads — refused".
   */
  readonly used: readonly { readonly tool: string; readonly said: string; readonly failed: boolean }[];
  readonly elapsedMs: number;
  /** Rough, for the budget meter. Never used to bill anything. */
  readonly approxTokens: number;
}

/**
 * What an agent is doing, while it is doing it.
 *
 * A run can take a minute on a frontier model, and a spinner for a minute is
 * indistinguishable from a hang. Worse, it hides the thing worth watching: an
 * agent is reading files, and *which* file it is reading is exactly what somebody
 * would want to interrupt over.
 *
 * Every field is already known to the run — nothing is gathered for the sake of
 * this. It is the run saying out loud what it was going to do anyway.
 */
export interface RunProgress {
  readonly runId: string;
  readonly agentId: string;
  readonly agentName: string;
  /** Which step of the brief's budget this is, from 1. */
  readonly step: number;
  readonly ofSteps: number;
  readonly stage: "thinking" | "reading" | "answering";
  /** What it is doing, in the owner's words. Never a raw tool call. */
  readonly said: string;
}

/** One piece of context an agent was allowed to gather. */
export interface Evidence {
  readonly label: string;
  readonly content: string;
}

export interface RunDeps {
  readonly room: EngineRoomStatus;
  readonly ceiling: Ceiling;
  /**
   * Asks the chosen engine. Injected rather than imported so a run can be
   * tested without launching a process — the interesting behaviour here is the
   * budget, the reporting and the refusals, none of which should need a CLI to
   * exercise.
   */
  ask(input: {
    readonly engineId: string;
    readonly modelId: string;
    readonly system: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
  }): Promise<string>;
  /** What the agent is allowed to look at, already filtered by its brief. */
  gather(brief: AgentBrief): Promise<readonly Evidence[]>;
  /** Recheck host grants at each read/model boundary; newly granted access is not adopted. */
  checkAccess?(): Promise<void>;
  /**
   * The sandbox its tools run in, when it has any.
   *
   * Absent means no tool loop — the agent reasons over what `gather` gave it
   * and answers. Present means it may ask for more, one call at a time.
   */
  readonly tools?: ToolContext | undefined;
  /** Recorded so the run appears on the Timeline like everything else. */
  record?(run: AgentRun): Promise<void>;
  /**
   * Called as the run moves, so somebody can watch it.
   *
   * Never awaited: a slow or throwing listener must not be able to hold up or
   * fail the run it is only observing.
   */
  progress?(update: RunProgress): void;
  /**
   * Stops the run from outside.
   *
   * Owned by the caller rather than made here, so whoever started a run can
   * also stop it. Without this the only thing that could interrupt an agent was
   * its own budget, which makes "you can stop it" untrue.
   */
  readonly signal?: AbortSignal | undefined;
  now?(): number;
}

/**
 * Runs one agent to completion, a refusal, or its own budget.
 *
 * Never throws for an ordinary failure. Every path returns an `AgentRun` a
 * person can read, because a thrown error somewhere up the stack becomes a red
 * toast with no history, and the whole point of this product is that there is
 * always a record.
 */
export async function runAgent(
  brief: AgentBrief,
  question: string,
  deps: RunDeps
): Promise<AgentRun> {
  const now = deps.now ?? (() => Date.now());
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const id = randomUUID();

  const finish = (
    outcome: RunOutcome,
    over: Partial<AgentRun> = {}
  ): AgentRun => {
    const finishedMs = now();
    const run: AgentRun = {
      id,
      agentId: brief.id,
      agentName: brief.name,
      startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      outcome,
      answer: "",
      ranOn: null,
      problem: null,
      used: [],
      elapsedMs: finishedMs - startedMs,
      approxTokens: 0,
      ...over
    };
    // Recording must never fail the run: the work already happened, and
    // throwing here would report a success as an error.
    void deps.record?.(run).catch((error: unknown) => {
      diagnostics.warn("agents", "could not record a run", {
        error: error instanceof Error ? error.message : "unknown"
      });
    });
    return run;
  };

  const resolved = resolveBrief(brief, deps.ceiling);
  if (resolved.inert) {
    // Refused before anything is spent. An agent with no folder or no tool
    // would produce a confident answer about nothing, which is the most
    // expensive kind of useless.
    return finish("refused", {
      problem:
        resolved.withheld.length > 0
          ? `${brief.name} cannot run: ${resolved.withheld[0]?.why ?? "it has nothing to work with."}`
          : `${brief.name} has no folder to work in, or nothing it can do. Give it a folder and a skill in its brief.`
    });
  }

  const chosen = selectEngine(deps.room, brief);
  if (!chosen.ok) {
    return finish("refused", { problem: chosen.reason });
  }
  const selection = chosen.selection;

  const controller = new AbortController();
  let unlinkStop: (() => void) | undefined;
  // The caller's stop and the brief's clock abort the same run. Linked rather
  // than checked in two places, so every `await` below already honours both.
  //
  // The listener is removed when the run's own controller settles, because a
  // caller's signal can outlive many runs — a long-lived one would accumulate a
  // listener, and the closure behind it, for every agent ever started.
  if (deps.signal !== undefined) {
    if (deps.signal.aborted) {
      controller.abort();
    } else {
      const onStop = () => controller.abort();
      const onAbort = () => deps.signal?.removeEventListener("abort", onStop);
      deps.signal.addEventListener("abort", onStop, { once: true });
      controller.signal.addEventListener("abort", onAbort, { once: true });
      unlinkStop = () => {
        deps.signal?.removeEventListener("abort", onStop);
        controller.signal.removeEventListener("abort", onAbort);
      };
    }
  }
  const budgetMs = brief.limits.maxMinutes * 60_000;
  // A clock the brief promised, enforced rather than described. Unref'd so a
  // pending timer cannot hold the process open after a fast run.
  const timer = setTimeout(() => controller.abort(), budgetMs);
  timer.unref?.();

  // Declared outside the try so a timeout or an engine failure still reports
  // what was actually done. Scoped inside, `catch` recorded `used: []` and
  // `approxTokens: 0` — erasing every tool call the owner had already paid for
  // from the one record this product promises always exists.
  let approxTokens = 0;
  let dispatched = false;
  const used: { tool: string; said: string; failed: boolean }[] = [];

  try {
    controller.signal.throwIfAborted();
    await deps.checkAccess?.();
    controller.signal.throwIfAborted();
    const evidence = await deps.gather(brief);
    used.push(...evidence.map(item => ({ tool: "source", said: `used ${item.label}`, failed: false })));
    controller.signal.throwIfAborted();
    const canUseTools = deps.tools !== undefined && resolved.capabilities.length > 0;
    const system = [
      toSystemPrompt(resolved, { now: new Date(startedMs) }),
      canUseTools ? toolInstructions(resolved.capabilities) : ""
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    let conversation = [
      question.trim(),
      ...evidence.map((item) => asEvidence(item.label, item.content))
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    approxTokens = roughTokens(system);
    let answer = "";
    let answered = false;

    /**
     * One turn per step of the brief's budget, so "stops after 40 steps" counts
     * the thing that costs money. A loop that spent an unbounded number of
     * calls inside one "step" would make that number decorative.
     */
    /** Said out loud, never awaited, never allowed to break the run. */
    const say = (stage: RunProgress["stage"], step: number, said: string): void => {
      try {
        deps.progress?.({
          runId: id,
          agentId: brief.id,
          agentName: brief.name,
          step,
          ofSteps: brief.limits.maxSteps,
          stage,
          said
        });
      } catch {
        // An observer that throws is an observer's problem.
      }
    };

    for (let step = 0; step < brief.limits.maxSteps; step += 1) {
      controller.signal.throwIfAborted();
      await deps.checkAccess?.();
      controller.signal.throwIfAborted();
      say("thinking", step + 1, `${brief.name} is thinking on ${selection.modelLabel}.`);
      approxTokens += roughTokens(conversation);
      dispatched = true;
      const reply = await deps.ask({
        engineId: selection.engineId,
        modelId: selection.modelId,
        system,
        prompt: conversation,
        signal: controller.signal
      });
      controller.signal.throwIfAborted();
      await deps.checkAccess?.();
      controller.signal.throwIfAborted();
      approxTokens += roughTokens(reply);

      const call = canUseTools ? parseCall(reply) : null;
      if (call === null) {
        say("answering", step + 1, `${brief.name} is writing its answer.`);
        answer = reply;
        answered = true;
        break;
      }
      if ("problem" in call) {
        // Answered rather than aborted: a missing brace should not throw away
        // everything already paid for.
        conversation = `${conversation}\n\n${reply}\n\n${call.problem}`;
        continue;
      }

      const outcome = await runTool(call, resolved.capabilities, deps.tools as ToolContext);
      used.push({ tool: outcome.call.tool, said: describeCall(outcome), failed: outcome.failed });
      controller.signal.throwIfAborted();
      // The file it just touched, named. This is the line somebody watching
      // would actually act on.
      say("reading", step + 1, describeCall(outcome));
      conversation = [conversation, withoutCall(reply), outcome.reply].filter(Boolean).join("\n\n");
      answer = withoutCall(reply);
    }

    if (!answered || answer.trim().length === 0) {
      // It spent its whole budget asking for things and never answered. Named
      // as stopped rather than answered, because an empty answer on the record
      // looks like the agent considered the question and had nothing to say.
      return finish("stopped", {
        ranOn: dispatched ? selection : null,
        used,
        approxTokens,
        problem: `${brief.name} used all ${brief.limits.maxSteps} of its steps gathering and never reached an answer. Raise its step limit, or ask it something narrower.`
      });
    }

    diagnostics.info("agents", `${brief.name} answered`, {
      engine: selection.engineId,
      model: selection.modelId,
      substituted: selection.substituted !== null,
      toolCalls: used.filter(step => step.tool !== "source").length,
      approxTokens
    });

    return finish("answered", { answer, ranOn: selection, used, approxTokens });
  } catch (error) {
    if (controller.signal.aborted) {
      // Stopped, not failed. The agent did what its brief said it would do, and
      // calling that a failure would teach the owner to distrust the limits
      // they set themselves.
      //
      // Which of the two stops it was matters, and getting it wrong was worse
      // than saying nothing: pressing Stop reported "stopped at its 10-minute
      // limit" after four seconds, which blames the clock for something the
      // person just did and sends them to raise a limit that was never reached.
      const byOwner = deps.signal?.aborted === true;
      return finish("stopped", {
        ranOn: dispatched ? selection : null,
        used,
        approxTokens,
        problem: byOwner
          ? `You stopped ${brief.name}. Completed reads are listed below.`
          : `${brief.name} stopped at its ${brief.limits.maxMinutes}-minute limit. Raise the limit in its brief, or narrow what you asked for.`
      });
    }
    return finish("failed", {
      ranOn: dispatched ? selection : null,
      used,
      approxTokens,
      problem: `${brief.name} could not finish on ${selection.engineLabel}. ${
        error instanceof Error ? error.message : "The engine gave no reason."
      }`
    });
  } finally {
    clearTimeout(timer);
    unlinkStop?.();
  }
}

/**
 * One line for the record, in the owner's words.
 *
 * Names the engine only when it was not what the brief asked for. Printing
 * "ran on Claude Sonnet" on every row would make the one row where that changed
 * invisible, which is the whole reason the substitution is tracked.
 */
export function describeRun(run: AgentRun): string {
  switch (run.outcome) {
    case "answered":
      return run.ranOn?.substituted === null || run.ranOn === null
        ? `${run.agentName} answered.`
        : `${run.agentName} answered. ${run.ranOn.substituted}`;
    case "refused":
      return run.problem ?? `${run.agentName} did not run.`;
    case "stopped":
      return run.problem ?? `${run.agentName} stopped at its limit.`;
    case "failed":
      return run.problem ?? `${run.agentName} failed.`;
  }
}
