/**
 * Agents — what each one is, and exactly what it will be told.
 *
 * The screen is built around one sentence per agent, because a permission list
 * is a thing people tick through and a sentence is a thing they either
 * recognise as what they wanted or do not. *"Filing clerk works in Downloads,
 * may use list_folder and read_text, never sends anything, thinks with the quickest model, and
 * stops after 40 steps or 10 minutes."* If that is wrong, it is obviously wrong.
 *
 * Under it sits the thing almost nothing else does: **the actual prompt.** Not
 * a summary of the instructions, not a description of the behaviour — the text
 * the model receives, generated from the same brief the sentence came from, so
 * the two cannot disagree. A product that shows you the plan before it touches
 * your files should also show you what it told the thing doing the touching.
 */

import { useRef, useState } from "react";
import type {
  AgentCard,
  AgentRunResult,
  Contact,
  RunProgress,
  StageResult
} from "@cadrane/contracts";
import { Button, Chip } from "./ui";
import { Markdown } from "../markdown";
import { AgentSourceInput, useAgentSource } from "./AgentSourceInput.js";

interface Props {
  agents: readonly AgentCard[] | null;
  /** Who the owner has approved. Empty means the send row explains why, not how. */
  contacts: readonly Contact[];
  onStage(input: {
    agentId: string;
    channel: Contact["channel"];
    address: string;
    text: string;
  }): Promise<StageResult>;
  /** The finished run for each agent, keyed by agent id. */
  runs: Readonly<Record<string, AgentRunResult>>;
  /** Which agent is working right now, if any. */
  running: string | null;
  /** What the running agent is doing right now, or null between runs. */
  progress: RunProgress | null;
  onStop(agentId: string): void;
  onRun(id: string, question: string, sourceToken?: string): Promise<void>;
  onEdit(card: AgentCard): void;
  onExport(agentId: string): void;
  onRemove(id: string): void;
  onWorkroom(id: string): void;
}

/**
 * What to type, in the shape of an actual request.
 *
 * The placeholder used to repeat `agent.purpose`, which the row already prints
 * two lines above — so every agent said the same sentence twice and the box
 * taught nothing about what could go in it. An example is worth more than a
 * restatement, and an empty box with a real example in it is the difference
 * between a person typing and a person leaving.
 */
/**
 * How long it took, in words rather than in decimals.
 *
 * `4.3s` is console output, and D-028 removed those from surfaces a customer
 * sees — they were most of why this product read as cheap. The number that
 * carries meaning on this row is the token count; the duration only needs to
 * answer "was that quick or did I wait".
 */
export function howLong(elapsedMs: number): string {
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds < 1) {
    return "instant";
  }
  if (seconds < 60) {
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export function askHint(agent: Pick<AgentCard, "id">): string {
  switch (agent.id) {
    case "filing-clerk":
      return "Suggest how to group these files by client";
    case "what-changed":
      return "What can you verify about this folder?";
    case "drafts":
      return "Paste something, or say who to write to and why";
    default:
      // For an agent somebody wrote themselves, we do not know the work — so
      // say what the box is for rather than inventing an example that misleads.
      return "What should it do?";
  }
}

export function AgentsView({ agents, contacts, runs, running, progress, onStop, onRun, onStage, onEdit, onExport, onRemove, onWorkroom }: Props) {
  if (agents === null) {
    return <p className="ag__loading">Reading the briefs.</p>;
  }

  if (agents.length === 0) {
    return (
      <p className="ag__empty">
        No agents yet. An agent is a short brief — what it is for, which folder it may work in,
        what it may do, and when it stops.
      </p>
    );
  }

  return (
    <div className="ag">
      <p className="ag__lede">
        Runs use the model on this Mac and the sources in each brief. No subscription is contacted.
        Review every answer; these agents can read and propose, but cannot change files.
        Each run is kept in Workrooms. A required file is saved as a source snapshot; other reads are recorded by name.
      </p>
      <ul className="ag__rows">
        {agents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            run={runs[agent.id]}
            busy={running === agent.id}
            anyRunning={running !== null}
            progress={progress?.agentId === agent.id ? progress : null}
            onStop={onStop}
            contacts={contacts}
            onRun={onRun}
            onStage={onStage}
            onEdit={onEdit}
            onExport={onExport}
            onRemove={onRemove}
            onWorkroom={onWorkroom}
          />
        ))}
      </ul>
    </div>
  );
}

function AgentRow({
  agent,
  run,
  busy,
  anyRunning,
  progress,
  onStop,
  contacts,
  onRun,
  onStage,
  onEdit,
  onExport,
  onRemove,
  onWorkroom
}: {
  agent: AgentCard;
  run: AgentRunResult | undefined;
  busy: boolean;
  anyRunning: boolean;
  contacts: readonly Contact[];
  progress: RunProgress | null;
  onStop(agentId: string): void;
  onRun(id: string, question: string, sourceToken?: string): Promise<void>;
  onEdit(card: AgentCard): void;
  onExport(agentId: string): void;
  onRemove(id: string): void;
  onWorkroom(id: string): void;
  onStage(input: {
    agentId: string;
    channel: Contact["channel"];
    address: string;
    text: string;
  }): Promise<StageResult>;
}) {
  const [question, setQuestion] = useState("");
  const [stageSaid, setStageSaid] = useState<string | null>(null);
  const source = useAgentSource(agent);
  const submitting = useRef(false);
  async function submit() {
    if (submitting.current || agent.inert || anyRunning || source.waiting) return;
    submitting.current = true;
    const token = source.preview?.token;
    try { await onRun(agent.id, question.trim() || agent.purpose, token); }
    finally { submitting.current = false; source.retire(token); }
  }

  return (
    <li className={agent.inert ? "agrow agrow--inert" : "agrow"}>
      <div className="agrow__head">
        <span className="agrow__name">{agent.name}</span>
        <span className="agrow__tier">{agent.tierLabel}</span>
        {agent.outbound === "never" ? (
          <Chip tone="muted">no message handoff</Chip>
        ) : (
          <Chip tone="warn">review before handoff</Chip>
        )}
        <span className="agrow__spacer" />
        {/* Only agents the owner wrote can be changed. The three that ship are
            the worked examples, and an editable example stops being one. */}
        {/* Duplicate is offered on the shipped agents too — copying a worked
            example is the easiest way to write your first brief, and the copy
            is editable where the original is not. */}
        <Button onClick={() => onEdit({ ...agent, id: "", name: `${agent.name} copy` })}>
          Duplicate
        </Button>
        {agent.custom ? (
          <>
            <Button onClick={() => onEdit(agent)}>Edit</Button>
            <Button onClick={() => onExport(agent.id)}>Export</Button>
            <Button onClick={() => onRemove(agent.id)}>Delete</Button>
          </>
        ) : null}
        {busy ? (
          // Stop sits where Run was, so the thing you reach for to interrupt is
          // under the finger that started it. A separate control elsewhere is
          // one somebody has to look for while watching something they want to
          // stop.
          <Button tone="danger" onClick={() => onStop(agent.id)}>
            Stop
          </Button>
        ) : (
          <Button
            onClick={() => void submit()}
            disabled={agent.inert || anyRunning || source.waiting}
          >
            {agent.inert ? "Cannot run" : "Run"}
          </Button>
        )}
      </div>

      {/**
        * What it is doing, right now.
        *
        * A spinner for a minute is indistinguishable from a hang, and it hides
        * the one line worth watching: which file it just read. That is what
        * somebody would actually interrupt over.
        */}
      {busy ? (
        <p className={`agrow__live agrow__live--${progress?.stage ?? "thinking"}`}>
          <span className="agrow__pulse" aria-hidden="true" />
          <span>{progress?.said ?? `${agent.name} is starting.`}</span>
          {progress === null ? null : (
            <span className="agrow__step">
              step {progress.step} of {progress.ofSteps}
            </span>
          )}
        </p>
      ) : null}

      <p className="agrow__purpose">{agent.purpose}</p>

      {/**
       * The brief in one line. This is the thing to read if you read nothing
       * else on the row.
       */}
      <p className="agrow__sentence">{agent.sentence}</p>

      {agent.withheld.length === 0 ? null : (
        <ul className="agrow__withheld">
          {agent.withheld.map((item) => (
            <li key={item.what} className="agrow__wheld">
              <span className="agrow__wname">{item.what}</span>
              <span className="agrow__wwhy">{item.why}</span>
            </li>
          ))}
        </ul>
      )}

      {agent.inert ? null : (
        <input
          className="agrow__ask"
          value={question}
          maxLength={8_000}
          placeholder={askHint(agent)}
          aria-label={`What should ${agent.name} do?`}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !anyRunning) {
              void submit();
            }
          }}
        />
      )}

      <AgentSourceInput agent={agent} source={source} disabled={anyRunning} />

      {run === undefined ? null : (
        <div className={`agrun agrun--${run.outcome}`}>
          <p className="agrun__head">
            <span className="agrun__outcome">{run.outcome}</span>
            {run.ranOnLabel === null ? null : <span className="agrun__on">{run.ranOnLabel}</span>}
            <span className="agrun__cost">
              {howLong(run.elapsedMs)} · ~{run.approxTokens.toLocaleString()} tokens
            </span>
          </p>
          {run.substituted === null ? null : (
            <p className="agrun__note">{run.substituted}</p>
          )}
          {run.problem === null ? null : <p className="agrun__problem">{run.problem}</p>}
          {run.recordProblem ? <p className="agrun__problem" role="alert">{run.recordProblem}</p> : null}
          {run.answer.length === 0 ? null : (
            <div className="agrun__answer">
              <Markdown text={run.answer} />
            </div>
          )}
          {/**
           * The receipt. Under the answer rather than above it, because what it
           * concluded is the thing you came for — but always present, because an
           * agent that read four of your files and showed only a conclusion is
           * exactly what this product exists not to be.
           */}
          {run.read.length === 0 ? null : (
            <ul className="agrun__read">
              {run.read.map((step, index) => (
                <li key={`${step}-${index}`}>{step}</li>
              ))}
            </ul>
          )}
          {run.workroomId ? <Button onClick={() => onWorkroom(run.workroomId!)}>
            {run.recordProblem ? "Open the saved start →" : "Review saved work →"}
          </Button> : null}

          {/**
            * Handing the draft over — only for an agent whose brief allows it,
            * and only when there is an answer to hand over.
            *
            * The row's "asks to send" chip used to be the whole feature: a label
            * with no path behind it. This is the path, and it still cannot send
            * — every channel here opens the owner's own app with the message in
            * it, and a person presses send.
            */}
          {agent.outbound === "never" || run.answer.length === 0 ? null : (
            <div className="agsend">
              {contacts.length === 0 ? (
                <p className="agsend__none">
                  Nobody on your list yet. Add someone in Settings and this draft can be
                  opened in WhatsApp or Mail, ready to send.
                </p>
              ) : (
                <div className="agsend__row">
                  <span className="agsend__label">Open this for</span>
                  {contacts.map((contact) => (
                    <Button
                      key={`${contact.channel}:${contact.address}`}
                      onClick={() => {
                        void onStage({
                          agentId: agent.id,
                          channel: contact.channel,
                          address: contact.address,
                          text: run.answer
                        }).then((result) => setStageSaid(result.said));
                      }}
                    >
                      {contact.label || contact.address}
                    </Button>
                  ))}
                </div>
              )}
              {stageSaid === null ? null : <p className="agsend__said">{stageSaid}</p>}
            </div>
          )}
        </div>
      )}

      {/**
       * Collapsed, because "what is it told" is a question you have after
       * "what does it do" — but never more than one click away, because the
       * whole trust model is that nothing about this is hidden.
       */}
      <details className="agrow__prompt">
        <summary className="agrow__disclosure">See its base instructions</summary>
        <p className="agrow__purpose">A run also includes your request, its selected sources and instructions for the tools it may use.</p>
        <pre className="agrow__prompttext">{agent.systemPrompt}</pre>
      </details>
    </li>
  );
}
