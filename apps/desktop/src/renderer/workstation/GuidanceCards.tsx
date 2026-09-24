import { useId, type ReactNode } from "react";
import { Icon, IconButton } from "./ui.js";
import type { OnboardingView, Step } from "./onboarding-path.js";
import type { ProposalView } from "./routine-proposal.js";

export type OnboardingStepLike = Step | {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly done: boolean;
  readonly current: boolean;
};

export type OnboardingViewLike = OnboardingView | {
  readonly steps: readonly OnboardingStepLike[];
  readonly completed: number;
  readonly headline: string;
  readonly nextAction: string | null;
  readonly finished: boolean;
};

export type ProposalViewLike = ProposalView | {
  readonly heading: string;
  readonly reason: string;
  readonly benefit: string;
  readonly previewPrompt: string;
  readonly evidenceCount: number;
};

export interface OnboardingCardProps {
  readonly view: OnboardingViewLike;
  readonly onAct: (stepId: string) => void;
  readonly onDismiss: () => void;
}

export interface RoutineProposalCardProps {
  readonly proposal: ProposalViewLike;
  readonly onAccept: () => void;
  readonly onEdit: () => void;
  readonly onIgnore: () => void;
}

/**
 * Inline guidance card presenting the owner's honest onboarding progress.
 * Vanishes as soon as all milestones are reached to avoid cluttering active work.
 */
export function OnboardingCard({
  view,
  onAct,
  onDismiss,
}: OnboardingCardProps): ReactNode {
  const titleId = useId();

  // Completed onboarding guides are dismissed to keep attention on active work.
  if (!view || view.finished || !Array.isArray(view.steps) || view.steps.length === 0) {
    return null;
  }

  const steps = view.steps;
  const headline = view.headline || `${view.completed} of ${steps.length} done`;

  return (
    <section
      className="ws-card ws-guidance-card ws-guidance-card--onboarding"
      aria-labelledby={titleId}
    >
      <header className="ws-guidance-card__header">
        <div>
          <h3 id={titleId} className="ws-guidance-card__title">
            Getting started
          </h3>
          <p className="ws-guidance-card__headline">{headline}</p>
        </div>
        <IconButton
          icon="close"
          label="Dismiss guide"
          onClick={onDismiss}
        />
      </header>

      <ol className="ws-guidance-card__steps" aria-label="Onboarding steps">
        {steps.map((step, index) => {
          const isCurrent = step.current;
          const isDone = step.done;

          return (
            <li
              key={step.id}
              className={`ws-step ${isCurrent ? "ws-step--current" : ""} ${isDone ? "ws-step--done" : ""}`}
              {...(isCurrent ? { "aria-current": "step" as const } : {})}
            >
              <div className="ws-step__marker" aria-hidden="true">
                {isDone ? (
                  <Icon name="check" size={14} />
                ) : (
                  <span className="ws-step__number">{index + 1}</span>
                )}
              </div>
              <div className="ws-step__content">
                <div className="ws-step__header">
                  <span className="ws-step__title">{step.title}</span>
                  {isDone ? (
                    <span className="ws-step__status">Done</span>
                  ) : isCurrent ? (
                    <span className="ws-step__status ws-step__status--current">
                      Current
                    </span>
                  ) : null}
                </div>
                <p className="ws-step__detail">{step.detail}</p>
                {isCurrent ? (
                  <div className="ws-step__action">
                    <button
                      type="button"
                      className="ws-button ws-button--primary"
                      onClick={() => onAct(step.id)}
                    >
                      {step.title}
                    </button>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * Inline proposal card suggesting an automated routine derived from previous work.
 * Offers equal-weight actions without pre-focusing to avoid pushing unwanted routines.
 */
export function RoutineProposalCard({
  proposal,
  onAccept,
  onEdit,
  onIgnore,
}: RoutineProposalCardProps): ReactNode {
  const headingId = useId();

  // Return nothing when the proposal is unavailable or unshaped.
  if (!proposal) {
    return null;
  }

  const heading = proposal.heading?.trim() || "Suggested routine";
  const evidenceCount =
    typeof proposal.evidenceCount === "number" &&
    Number.isFinite(proposal.evidenceCount) &&
    proposal.evidenceCount > 0
      ? proposal.evidenceCount
      : 0;

  return (
    <section
      className="ws-card ws-guidance-card ws-guidance-card--proposal"
      aria-labelledby={headingId}
    >
      <header className="ws-guidance-card__header">
        <div>
          <p className="ws-eyebrow">Suggested routine</p>
          <h3 id={headingId} className="ws-guidance-card__title">
            {heading}
          </h3>
        </div>
      </header>

      {proposal.reason ? (
        <p className="ws-guidance-card__reason">{proposal.reason}</p>
      ) : null}

      {proposal.previewPrompt ? (
        <div className="ws-guidance-card__preview">
          <p className="ws-guidance-card__prompt">{proposal.previewPrompt}</p>
        </div>
      ) : null}

      {proposal.benefit ? (
        <p className="ws-guidance-card__benefit">{proposal.benefit}</p>
      ) : null}

      {evidenceCount > 0 ? (
        <p className="ws-guidance-card__evidence">
          {`Based on ${evidenceCount} ${evidenceCount === 1 ? "turn" : "turns"} of work.`}
        </p>
      ) : null}

      <div className="ws-guidance-card__actions">
        <button type="button" className="ws-button" onClick={onAccept}>
          Accept
        </button>
        <button type="button" className="ws-button" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="ws-button" onClick={onIgnore}>
          Ignore
        </button>
      </div>
    </section>
  );
}
