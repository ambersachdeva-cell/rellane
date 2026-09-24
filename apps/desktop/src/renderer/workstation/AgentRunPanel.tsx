import type { ReactNode } from "react";

export type AgentRunState =
  | "planning"
  | "awaiting-approval"
  | "running"
  | "stopping"
  | "done"
  | "stopped"
  | "failed";

export interface AgentStepView {
  readonly index: number;
  readonly kind: "thought" | "tool" | "answer" | "refusal";
  readonly title: string;
  readonly detail: string;
  readonly toolLabel: string | null;
  readonly at: number;
  readonly durationMs: number | null;
  readonly ok: boolean | null;
}

export interface AgentRunView {
  readonly runId: string;
  readonly caseId: string;
  readonly goal: string;
  readonly state: AgentRunState;
  readonly steps: readonly AgentStepView[];
  readonly headline: string;
  readonly stepsUsed: number;
  readonly stepsAllowed: number;
  readonly canStop: boolean;
}

/** The plan the owner is approving. Shaped by `agent-plan`, shown here. */
export interface AgentPlanShape {
  readonly summary: string;
  readonly steps: readonly { readonly title: string; readonly detail: string }[];
  readonly reads: readonly string[];
  readonly mayUse: readonly string[];
  readonly leavesThisMac: string;
  readonly warnings: readonly string[];
  readonly refusedBecause: string | null;
}

export interface AgentRunPanelProps {
  readonly plan?: AgentPlanShape;
  readonly view: AgentRunView;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onCancel: () => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

/** Converts internal state identifiers to calm, plain British English labels. */
function formatState(state: AgentRunState): string {
  switch (state) {
    case "planning":
      return "Planning";
    case "awaiting-approval":
      return "Awaiting approval";
    case "running":
      return "Working";
    case "stopping":
      return "Stopping";
    case "done":
      return "Finished";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
  }
}

/** Provides human-readable titles for each step classification. */
function formatStepKind(kind: AgentStepView["kind"]): string {
  switch (kind) {
    case "thought":
      return "Thought";
    case "tool":
      return "Tool";
    case "answer":
      return "Answer";
    case "refusal":
      return "Refusal";
  }
}

/** Fallback descriptions ensure the status region always communicates something useful. */
function defaultHeadline(state: AgentRunState): string {
  switch (state) {
    case "planning":
      return "Planning the work.";
    case "awaiting-approval":
      return "Review the plan and start when you are ready.";
    case "running":
      return "Working through the steps.";
    case "stopping":
      return "Stopping the run.";
    case "done":
      return "All steps finished.";
    case "stopped":
      return "The run was stopped.";
    case "failed":
      return "The run failed.";
  }
}

/** Renders execution duration in seconds or milliseconds. */
function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const seconds = (durationMs / 1000).toFixed(1);
  return `${seconds}s`;
}

/**
 * Finds the currently active step index.
 * While running, an unfinished step or the latest step carries live focus.
 */
function findLiveStepIndex(view: AgentRunView): number {
  if (view.state !== "running") {
    return -1;
  }
  const unfinishedIndex = view.steps.findIndex(
    (step) => step.durationMs === null,
  );
  if (unfinishedIndex !== -1) {
    return unfinishedIndex;
  }
  return view.steps.length > 0 ? view.steps.length - 1 : -1;
}

/**
 * Renders a single execution step within the disclosure hierarchy.
 */
function renderStep(step: AgentStepView, isLive: boolean): ReactNode {
  return (
    <li
      key={step.index}
      className={`ws-agent-step ${
        isLive ? "ws-agent-step--live" : "ws-agent-step--finished"
      } ws-agent-step--${step.kind}`}
      {...(isLive ? { "aria-current": "step" as const } : {})}
    >
      <details className="ws-agent-step-disclosure">
        <summary className="ws-agent-step-summary">
          <span className="ws-agent-step-main">
            <span className="ws-agent-step-kind">
              {formatStepKind(step.kind)}
            </span>
            <span className="ws-agent-step-title">{step.title}</span>
          </span>
          <span className="ws-agent-step-meta">
            {step.kind === "tool" && step.toolLabel !== null ? (
              <span className="ws-agent-step-tool">{step.toolLabel}</span>
            ) : null}
            {step.kind === "tool" && step.ok !== null ? (
              <span
                className={`ws-agent-step-outcome ${
                  step.ok
                    ? "ws-agent-step-outcome--ok"
                    : "ws-agent-step-outcome--fail"
                }`}
              >
                {step.ok ? "Worked" : "Did not work"}
              </span>
            ) : null}
            {step.durationMs !== null ? (
              <span className="ws-agent-step-duration">
                {formatDuration(step.durationMs)}
              </span>
            ) : null}
          </span>
        </summary>
        <div className="ws-agent-step-detail">
          <p className="ws-agent-step-detail-text">
            {step.detail.length > 0 ? step.detail : "No details recorded."}
          </p>
        </div>
      </details>
    </li>
  );
}

/**
 * Full-height side panel enabling live inspection and stop authority over an agent run.
 */
export function AgentRunPanel({
  view,
  plan,
  onStart,
  onStop,
  onCancel,
  onClose,
  busy,
}: AgentRunPanelProps): ReactNode {
  const liveIndex = findLiveStepIndex(view);

  return (
    <aside className="ws-agent-panel" aria-label="Agent run">
      <header className="ws-agent-header">
        <h2 className="ws-agent-goal">{view.goal}</h2>
        <div className="ws-agent-status" role="status" aria-live="polite">
          <span className={`ws-agent-badge ws-agent-badge--${view.state}`}>
            {formatState(view.state)}
          </span>
          {view.stepsAllowed > 0 ? (
            <span className="ws-agent-progress">
              Step {view.stepsUsed} of {view.stepsAllowed}
            </span>
          ) : null}
          <p className="ws-agent-status-headline">
            {view.headline.length > 0
              ? view.headline
              : defaultHeadline(view.state)}
          </p>
        </div>
      </header>

      {view.state === "awaiting-approval" ? (
        <section className="ws-agent-plan" aria-label="Proposed plan">
          <h3 className="ws-agent-plan-heading">Before it starts</h3>
          {plan === undefined ? (
            <p className="ws-agent-plan-note">Working out what it would do.</p>
          ) : plan.refusedBecause !== null ? (
            <p className="ws-agent-plan-note" role="alert">{plan.refusedBecause}</p>
          ) : (
            <>
              <p className="ws-agent-plan-note">{plan.summary}</p>
              <ol className="ws-agent-plan-steps">
                {plan.steps.map((step, index) => (
                  <li key={`${index}-${step.title}`} className="ws-agent-plan-step">
                    <strong>{step.title}</strong>
                    <span>{step.detail}</span>
                  </li>
                ))}
              </ol>
              <dl className="ws-agent-plan-facts">
                <dt>It may read</dt>
                <dd>{plan.reads.length === 0 ? "Nothing — only what you typed." : plan.reads.join(", ")}</dd>
                <dt>It may use</dt>
                <dd>{plan.mayUse.length === 0 ? "Nothing else." : plan.mayUse.join(", ")}</dd>
                <dt>Leaving this Mac</dt>
                <dd>{plan.leavesThisMac}</dd>
              </dl>
              {plan.warnings.length > 0 ? (
                <ul className="ws-agent-plan-warnings">
                  {plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <div className="ws-agent-content">
        {view.steps.length === 0 ? (
          <div className="ws-agent-empty">
            <p className="ws-agent-empty-text">
              {view.state === "planning"
                ? "Planning the first step."
                : view.state === "awaiting-approval"
                  ? "No steps proposed yet."
                  : view.state === "stopped"
                    ? "No steps were recorded before the run stopped."
                    : view.state === "failed"
                      ? "No steps were recorded before the run failed."
                      : "No steps recorded yet."}
            </p>
          </div>
        ) : (
          <ol className="ws-agent-steps" aria-label="Steps">
            {view.steps.map((step, index) =>
              renderStep(step, index === liveIndex),
            )}
          </ol>
        )}
      </div>

      <footer className="ws-agent-actions">
        {view.state === "awaiting-approval" ? (
          <>
            <button
              type="button"
              className="ws-agent-button ws-agent-button--primary"
              onClick={onStart}
              disabled={busy}
            >
              Start
            </button>
            <button
              type="button"
              className="ws-agent-button"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
          </>
        ) : view.state === "done" ||
          view.state === "stopped" ||
          view.state === "failed" ? (
          <button
            type="button"
            className="ws-agent-button ws-agent-button--primary"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        ) : (
          <button
            type="button"
            className="ws-agent-button ws-agent-button--danger"
            onClick={onStop}
            disabled={!view.canStop || busy || view.state === "stopping"}
          >
            Stop
          </button>
        )}
      </footer>
    </aside>
  );
}
