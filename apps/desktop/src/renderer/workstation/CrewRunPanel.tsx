import { useState, type ReactElement } from "react";
import { IconButton } from "./ui.js";

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
  readonly seatId?: string;
  readonly dependsOn?: readonly string[];
}

export interface CrewRunView {
  readonly runId: string;
  readonly caseId: string;
  readonly request: string;
  readonly parts: readonly CrewPartView[];
  readonly round:
    | "splitting"
    | "working"
    | "reading-each-other"
    | "done"
    | "stopped"
    | "failed";
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

export interface CrewRunAnswer {
  readonly partId: string;
  readonly text: string;
}

export interface CrewRunPanelProps {
  readonly view: CrewRunView;
  readonly answers: readonly CrewRunAnswer[];
  readonly onStopPart: (partId: string) => void;
  readonly onStopAll: () => void;
  readonly onKeep: (partId: string) => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

function formatRound(round: CrewRunView["round"]): string {
  switch (round) {
    case "splitting":
      return "Splitting";
    case "working":
      return "Working";
    case "reading-each-other":
      return "Reading each other";
    case "done":
      return "Finished";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
  }
}

function formatState(state: CrewPartState): string {
  switch (state) {
    case "waiting":
      return "Waiting";
    case "claimed":
      return "Claimed";
    case "working":
      return "Working";
    case "answered":
      return "Answered";
    case "refining":
      return "Refining";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

// Replaces internal task identifiers with the human title of the target part
function getWaitingText(
  part: CrewPartView,
  allParts: readonly CrewPartView[]
): string {
  if (part.dependsOn && part.dependsOn.length > 0) {
    const titles = part.dependsOn.map(id => {
      const match = allParts.find(p => p.id === id);
      return match ? match.title : id;
    });

    let resolvedLine = part.line;
    for (const other of allParts) {
      if (other.id && resolvedLine.includes(other.id)) {
        resolvedLine = resolvedLine.split(other.id).join(other.title);
      }
    }

    const hasTitle = titles.some(title =>
      resolvedLine.toLowerCase().includes(title.toLowerCase())
    );
    if (hasTitle && resolvedLine.trim().length > 0) {
      return resolvedLine;
    }

    if (titles.length === 1) {
      const singleTitle = titles[0]!;
      return `Waiting for ${singleTitle} to finish.`;
    }
    return `Waiting for ${titles.join(" and ")} to finish.`;
  }

  let resolvedLine = part.line;
  for (const other of allParts) {
    if (other.id && resolvedLine.includes(other.id)) {
      resolvedLine = resolvedLine.split(other.id).join(other.title);
    }
  }
  return resolvedLine;
}

// Formats notes cross-referenced from peer parts during the revision stage
function getRefinedText(
  refinedFrom: readonly string[],
  allParts: readonly CrewPartView[]
): string | null {
  if (refinedFrom.length === 0) {
    return null;
  }
  const titles = refinedFrom.map(id => {
    const match = allParts.find(p => p.id === id);
    return match ? match.title : id;
  });
  if (titles.length === 1) {
    const singleTitle = titles[0]!;
    return `Read ${singleTitle} before revising.`;
  }
  return `Read ${titles.join(" and ")} before revising.`;
}

function getAnswerPreview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 220) {
    return trimmed;
  }
  return `${trimmed.slice(0, 220)}...`;
}

export function CrewRunPanel({
  view,
  answers,
  onStopPart,
  onStopAll,
  onKeep,
  onClose,
  busy,
}: CrewRunPanelProps): ReactElement {
  const [expandedParts, setExpandedParts] = useState<readonly string[]>([]);

  const toggleExpanded = (partId: string) => {
    setExpandedParts(current =>
      current.includes(partId)
        ? current.filter(id => id !== partId)
        : [...current, partId]
    );
  };

  return (
    <div className="ws-crew-panel">
      <header className="ws-crew-header">
        <div className="ws-crew-header-top">
          <div className="ws-crew-header-copy">
            <div className="ws-crew-round-row">
              <span
                className={`ws-crew-round-badge ws-crew-round-badge--${view.round}`}
              >
                {formatRound(view.round)}
              </span>
            </div>
            {view.request ? (
              <h2 className="ws-crew-request">{view.request}</h2>
            ) : null}
            {view.headline ? (
              <p className="ws-crew-headline">{view.headline}</p>
            ) : null}
          </div>
          <div className="ws-crew-header-actions">
            <button
              type="button"
              className="ws-crew-stop-all"
              onClick={onStopAll}
              disabled={!view.canStop || busy}
            >
              Stop everything
            </button>
            <IconButton
              icon="close"
              label="Close panel"
              onClick={onClose}
              disabled={busy}
              className="ws-crew-close"
            />
          </div>
        </div>
      </header>

      {view.parts.length === 0 ? (
        <div className="ws-crew-empty">
          <p className="ws-crew-empty-message">
            No work has been divided yet.
          </p>
        </div>
      ) : (
        <div className="ws-crew-parts">
          {view.parts.map(part => {
            const answerEntry = answers.find(a => a.partId === part.id);
            const answerText =
              answerEntry && answerEntry.text.trim().length > 0
                ? answerEntry.text
                : null;
            const isExpanded = expandedParts.includes(part.id);
            const refinedText = getRefinedText(part.refinedFrom, view.parts);

            return (
              <section
                key={part.id}
                className={`ws-crew-part ws-crew-part--${part.state}`}
                aria-labelledby={`ws-crew-part-title-${part.id}`}
              >
                <header className="ws-crew-part-header">
                  <div className="ws-crew-part-meta">
                    <h3
                      id={`ws-crew-part-title-${part.id}`}
                      className="ws-crew-part-title"
                    >
                      {part.title}
                    </h3>
                    <span className="ws-crew-part-bot">{part.seatLabel}</span>
                  </div>
                  <div className="ws-crew-part-status">
                    <span
                      className={`ws-crew-part-state ws-crew-part-state--${part.state}`}
                    >
                      {formatState(part.state)}
                    </span>
                    {part.elapsed ? (
                      <span className="ws-crew-part-elapsed">
                        {part.elapsed}
                      </span>
                    ) : null}
                  </div>
                </header>

                <div className="ws-crew-part-body">
                  <p
                    className={`ws-crew-part-line ${
                      part.state === "failed"
                        ? "ws-crew-part-line--failed"
                        : ""
                    }`}
                  >
                    {part.state === "waiting"
                      ? getWaitingText(part, view.parts)
                      : part.line}
                  </p>

                  {refinedText ? (
                    <p className="ws-crew-part-refined">{refinedText}</p>
                  ) : null}

                  {answerText ? (
                    <div className="ws-crew-part-answer">
                      <div className="ws-crew-part-answer-body">
                        <p className="ws-crew-part-answer-text">
                          {isExpanded
                            ? answerText
                            : getAnswerPreview(answerText)}
                        </p>
                        <button
                          type="button"
                          className="ws-crew-part-answer-toggle"
                          onClick={() => toggleExpanded(part.id)}
                        >
                          {isExpanded ? "Show less" : "Read full answer"}
                        </button>
                      </div>
                      <div className="ws-crew-part-answer-actions">
                        <button
                          type="button"
                          className="ws-crew-part-keep"
                          onClick={() => onKeep(part.id)}
                          disabled={busy}
                        >
                          Keep answer
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <footer className="ws-crew-part-footer">
                  <button
                    type="button"
                    className="ws-crew-part-stop"
                    onClick={() => onStopPart(part.id)}
                    disabled={!part.canStop || busy}
                  >
                    Stop
                  </button>
                </footer>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
