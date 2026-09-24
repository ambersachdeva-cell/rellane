import { useState, type ChangeEvent, type ReactElement } from "react";
import { Icon, Modal } from "./ui.js";

/** One part of a split request, and who is taking it. */
export interface CrewPart {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly seatId: string;
  readonly seatLabel: string;
  readonly dependsOn: readonly string[];
}

export type CrewPartState =
  | "waiting"
  | "claimed"
  | "working"
  | "answered"
  | "refining"
  | "done"
  | "failed"
  | "stopped";

export interface CrewPartView {
  readonly id: string;
  readonly title: string;
  readonly seatLabel: string;
  readonly state: CrewPartState;
  readonly line: string;
  readonly elapsed: string;
  readonly answerTurnId: string | null;
  readonly refinedFrom: readonly string[];
  readonly canStop: boolean;
}

export interface CrewRunView {
  readonly runId: string;
  readonly caseId: string;
  readonly request: string;
  readonly parts: readonly CrewPartView[];
  readonly round: "splitting" | "working" | "reading-each-other" | "done" | "stopped" | "failed";
  readonly headline: string;
  readonly canStop: boolean;
}

/** What one seat learned, written back so the next round starts with it. */
export interface CrewNote {
  readonly partId: string;
  readonly seatLabel: string;
  readonly finding: string;
  readonly confidence: "stated" | "inferred" | "uncertain";
  readonly at: number;
}

export interface PlanPart {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly seatLabel: string;
  readonly dependsOnTitles: readonly string[];
}

export interface CrewPlanReviewProps {
  readonly request: string;
  readonly parts: readonly PlanPart[];
  readonly idleSeats: readonly string[];
  readonly sourceLabels: readonly string[];
  readonly wholeJob: boolean;
  readonly refusedBecause: string | null;
  readonly estimatedCalls: number;
  readonly onSend: () => void;
  readonly onEditPart: (id: string, prompt: string) => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

export function CrewPlanReview({
  request,
  parts,
  idleSeats,
  sourceLabels,
  wholeJob,
  refusedBecause,
  estimatedCalls,
  onSend,
  onEditPart,
  onClose,
  busy,
}: CrewPlanReviewProps): ReactElement {
  // Local drafts isolate in-progress text edits from parent re-renders until committed.
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});

  // When a request cannot be split or serviced, refusal takes precedence over plan execution.
  if (refusedBecause !== null) {
    return (
      <Modal title="Before they start" eyebrow="Who does what" wide onClose={onClose}>
        <div className="ws-plan-container ws-plan-refused">
          <div className="ws-plan-refused-body">
            <p className="ws-plan-refused-message">{refusedBecause}</p>
          </div>
          <footer className="ws-plan-actions">
            <button
              type="button"
              className="ws-plan-button ws-plan-button-cancel"
              onClick={onClose}
            >
              Close
            </button>
          </footer>
        </div>
      </Modal>
    );
  }

  // Count distinct participating seats so the button accurately describes bot allocation.
  const distinctSeats = new Set(
    parts
      .map((part) => part.seatLabel.trim())
      .filter((label) => label.length > 0),
  );
  const botCount = distinctSeats.size > 0 ? distinctSeats.size : parts.length;
  const sendButtonText = botCount === 1 ? "Send to 1 bot" : `Send to ${botCount} bots`;

  const handlePromptChange = (id: string, newPrompt: string): void => {
    setDrafts((prev) => ({
      ...prev,
      [id]: newPrompt,
    }));
    onEditPart(id, newPrompt);
  };

  return (
    <Modal title="Before they start" eyebrow="Who does what" wide onClose={onClose}>
      <div className="ws-plan-container">
        {request.trim().length > 0 ? (
          <section className="ws-plan-section ws-plan-request">
            <span className="ws-plan-section-label">Your request</span>
            <p className="ws-plan-request-content">{request}</p>
          </section>
        ) : null}

        {wholeJob ? (
          <section className="ws-plan-section ws-plan-whole-job">
            <p className="ws-plan-whole-job-text">
              This request could not usefully be split, so one bot will take all of it.
            </p>
          </section>
        ) : null}

        <section className="ws-plan-section ws-plan-cost">
          <p className="ws-plan-cost-text">
            {estimatedCalls === 1
              ? "This will ask your subscriptions 1 time."
              : `This will ask your subscriptions ${estimatedCalls} times.`}
          </p>
        </section>

        {sourceLabels.length > 0 ? (
          <section className="ws-plan-section ws-plan-sources">
            <span className="ws-plan-section-label">Files included</span>
            <ul className="ws-plan-sources-list">
              {sourceLabels.map((source) => (
                <li key={source} className="ws-plan-source-item">
                  <Icon name="file" size={14} />
                  <span className="ws-plan-source-name">{source}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="ws-plan-section ws-plan-parts">
          <span className="ws-plan-section-label">Division of work</span>
          {parts.length === 0 ? (
            <p className="ws-plan-empty">No parts to divide.</p>
          ) : (
            <div className="ws-plan-parts-list">
              {parts.map((part) => {
                const draft = drafts[part.id];
                const currentPrompt = draft !== undefined ? draft : part.prompt;

                return (
                  <div key={part.id} className="ws-plan-part-card">
                    <header className="ws-plan-part-header">
                      <h3 className="ws-plan-part-title">{part.title}</h3>
                      <span className="ws-plan-part-bot">{part.seatLabel}</span>
                    </header>

                    {part.dependsOnTitles.length > 0 ? (
                      <div className="ws-plan-part-waits">
                        <span className="ws-plan-part-waits-label">Waits for:</span>{" "}
                        <span className="ws-plan-part-waits-list">
                          {part.dependsOnTitles.join(", ")}
                        </span>
                      </div>
                    ) : (
                      <p className="ws-plan-part-waits">Starts immediately</p>
                    )}

                    <div className="ws-plan-part-prompt-wrapper">
                      <label
                        htmlFor={`ws-plan-prompt-${part.id}`}
                        className="ws-plan-part-prompt-label"
                      >
                        Prompt for {part.seatLabel}
                      </label>
                      <textarea
                        id={`ws-plan-prompt-${part.id}`}
                        className="ws-plan-part-prompt-input"
                        value={currentPrompt}
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                          handlePromptChange(part.id, event.target.value)
                        }
                        rows={4}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {idleSeats.length > 0 ? (
          <section className="ws-plan-section ws-plan-idle">
            {idleSeats.map((seat) => (
              <p key={seat} className="ws-plan-idle-item">
                {seat} will not be used for this one.
              </p>
            ))}
          </section>
        ) : null}

        <footer className="ws-plan-actions">
          <button
            type="button"
            className="ws-plan-button ws-plan-button-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ws-plan-button ws-plan-button-send"
            onClick={onSend}
            disabled={busy || parts.length === 0}
          >
            {sendButtonText}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
