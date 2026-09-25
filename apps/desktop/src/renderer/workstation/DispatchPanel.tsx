import { useId, useState, type ReactNode } from "react";
import { Icon } from "./ui.js";

export type LaneState =
  | "queued"
  | "awaiting-approval"
  | "working"
  | "answered"
  | "stopped"
  | "failed"
  | "interrupted"
  | "unavailable";

export interface DispatchLane {
  readonly providerId: string;
  readonly label: string;
  readonly state: LaneState;
  readonly line: string;
  readonly elapsed: string;
  readonly answerTurnId: string | null;
  readonly chars: number;
  readonly canStop: boolean;
}

export interface DispatchBoard {
  readonly runId: string;
  readonly caseId: string;
  readonly brief: string;
  readonly lanes: readonly DispatchLane[];
  readonly headline: string;
  readonly working: number;
  readonly answered: number;
  readonly done: boolean;
}

export interface DispatchPanelProps {
  readonly providers: readonly {
    readonly id: string;
    readonly label: string;
    readonly usable: boolean;
    readonly detail: string;
    readonly models: readonly { readonly id: string; readonly label: string }[];
  }[];
  readonly board: DispatchBoard | null;
  readonly answers: readonly {
    readonly providerId: string;
    readonly text: string;
  }[];
  readonly sourceCount: number;
  readonly onSend: (brief: string, selections: readonly { readonly providerId: string; readonly modelId: string }[]) => void;
  readonly onStopLane: (providerId: string) => void;
  readonly onStopAll: () => void;
  readonly onCompare: () => void;
  readonly onKeep: (providerId: string) => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

/**
 * Text status labels ensure state is perceptible without relying on colour alone.
 */
function formatLaneState(state: LaneState): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "awaiting-approval":
      return "Awaiting approval";
    case "working":
      return "Working";
    case "answered":
      return "Answered";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "unavailable":
      return "Unavailable";
  }
}

/**
 * Truncation retains layout symmetry across competing lanes before full reading.
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength).trimEnd()}…`;
}

export function DispatchPanel({
  providers,
  board,
  answers,
  sourceCount,
  onSend,
  onStopLane,
  onStopAll,
  onCompare,
  onKeep,
  onClose,
  busy,
}: DispatchPanelProps): ReactNode {
  const [brief, setBrief] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [models, setModels] = useState<Readonly<Record<string, string>>>({});
  const [expandedLaneIds, setExpandedLaneIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const briefInputId = useId();

  const toggleProvider = (id: string): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleLaneExpanded = (providerId: string): void => {
    setExpandedLaneIds((previous) => {
      const next = new Set(previous);
      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }
      return next;
    });
  };

  const usableSelectedProviders = providers.filter(
    (provider) => selectedIds.has(provider.id) && provider.usable,
  );
  const usableCount = usableSelectedProviders.length;
  const trimmedBrief = brief.trim();
  const canSend = trimmedBrief.length > 0 && usableCount > 0 &&
    usableSelectedProviders.every((provider) => Boolean(models[provider.id]?.trim())) && !busy;
  const sendLabel =
    usableCount === 1 ? "Send to 1 bot" : `Send to ${usableCount} bots`;

  const handleSend = (): void => {
    if (!canSend) {
      return;
    }
    const selections = usableSelectedProviders.map((provider) => ({
      providerId: provider.id, modelId: models[provider.id]!.trim()
    }));
    onSend(trimmedBrief, selections);
  };

  if (board === null) {
    return (
      <section className="ws-dispatch-panel" aria-label="Dispatch">
        <header className="ws-dispatch-header">
          <div className="ws-dispatch-header-title">
            <h2 className="ws-dispatch-title">Dispatch</h2>
          </div>
          <button
            type="button"
            className="ws-dispatch-close"
            onClick={onClose}
            aria-label="Close dispatch panel"
            disabled={busy}
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="ws-dispatch-chooser">
          <div className="ws-dispatch-section">
            <h3 className="ws-dispatch-section-title">Choose bots</h3>
            <div
              className="ws-dispatch-cards"
              role="group"
              aria-label="Available bots"
            >
              {providers.map((provider) => {
                const isSelected = selectedIds.has(provider.id);
                return (
                  <button
                    type="button"
                    key={provider.id}
                    className={`ws-dispatch-card ${
                      isSelected ? "ws-dispatch-card--selected" : ""
                    } ${!provider.usable ? "ws-dispatch-card--unusable" : ""}`}
                    aria-pressed={isSelected}
                    onClick={() => toggleProvider(provider.id)}
                    disabled={busy}
                  >
                    <div className="ws-dispatch-card-header">
                      <span className="ws-dispatch-card-name">
                        {provider.label}
                      </span>
                      <span
                        className={`ws-dispatch-card-status ${
                          provider.usable
                            ? "ws-dispatch-card-status--usable"
                            : "ws-dispatch-card-status--unusable"
                        }`}
                      >
                        {provider.usable ? "Available" : "Unavailable"}
                      </span>
                    </div>
                    {provider.detail.length > 0 ? (
                      <p className="ws-dispatch-card-detail">
                        {provider.detail}
                      </p>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div role="group" aria-label="Models for selected connections">
              {usableSelectedProviders.map((provider) => (
                <label key={provider.id}>{provider.label} model
                  {provider.models.length === 0
                    ? <input value={models[provider.id] ?? ""} onChange={(event) => setModels((previous) => ({ ...previous, [provider.id]: event.target.value }))} placeholder="Enter model ID" disabled={busy} />
                    : <select value={models[provider.id] ?? ""} onChange={(event) => setModels((previous) => ({ ...previous, [provider.id]: event.target.value }))} disabled={busy}>
                        <option value="">Choose a model</option>
                        {provider.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                      </select>}
                </label>
              ))}
            </div>
          </div>

          <div className="ws-dispatch-section">
            <label htmlFor={briefInputId} className="ws-dispatch-brief-label">
              Brief
            </label>
            <textarea
              id={briefInputId}
              className="ws-dispatch-brief-input"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="Write what you want the bots to investigate…"
              rows={4}
              disabled={busy}
            />
          </div>

          <div className="ws-dispatch-footer">
            <div className="ws-dispatch-sources" aria-label="Attached files">
              <Icon name="file" size={16} />
              <span className="ws-dispatch-sources-count">
                {sourceCount === 1
                  ? "1 file attached"
                  : `${sourceCount} files attached`}
              </span>
            </div>
            <button
              type="button"
              className="ws-dispatch-send"
              onClick={handleSend}
              disabled={!canSend}
            >
              {sendLabel}
            </button>
          </div>
        </div>
      </section>
    );
  }

  const answeredLanesCount = board.lanes.filter(
    (lane) => lane.state === "answered",
  ).length;
  const answeredCount = Math.max(board.answered, answeredLanesCount);
  const canCompare = answeredCount >= 2;

  return (
    <section className="ws-dispatch-panel" aria-label="Dispatch board">
      <header className="ws-dispatch-header">
        <div className="ws-dispatch-header-title">
          <h2 className="ws-dispatch-title">Dispatch board</h2>
        </div>
        <button
          type="button"
          className="ws-dispatch-close"
          onClick={onClose}
          aria-label="Close dispatch panel"
          disabled={busy}
        >
          <Icon name="close" size={18} />
        </button>
      </header>

      <div className="ws-dispatch-board">
        <div className="ws-dispatch-board-summary">
          <p className="ws-dispatch-headline">{board.headline}</p>
          {board.working > 0 ? (
            <button
              type="button"
              className="ws-dispatch-stop-all"
              onClick={onStopAll}
              disabled={busy}
            >
              <Icon name="stop" size={14} />
              <span>Stop all</span>
            </button>
          ) : null}
        </div>

        <div
          className="ws-dispatch-lanes"
          role="status"
          aria-label="Dispatch lanes"
        >
          {board.lanes.map((lane) => {
            const answer = answers.find(
              (item) => item.providerId === lane.providerId,
            );
            const isExpanded = expandedLaneIds.has(lane.providerId);
            const hasAnswer =
              lane.state === "answered" &&
              answer !== undefined &&
              answer.text.trim().length > 0;
            const canStop =
              (lane.canStop || lane.state === "working") &&
              lane.state !== "stopped" &&
              lane.state !== "answered" &&
              lane.state !== "failed";

            return (
              <article
                key={lane.providerId}
                className={`ws-dispatch-lane ws-dispatch-lane--${lane.state}`}
                aria-label={lane.label}
              >
                <header className="ws-dispatch-lane-header">
                  <h3 className="ws-dispatch-lane-name">{lane.label}</h3>
                  <div className="ws-dispatch-lane-meta">
                    <span
                      className={`ws-dispatch-lane-state ws-dispatch-lane-state--${lane.state}`}
                    >
                      {formatLaneState(lane.state)}
                    </span>
                    {lane.elapsed.length > 0 ? (
                      <span className="ws-dispatch-lane-elapsed">
                        <Icon name="clock" size={14} />
                        <span>{lane.elapsed}</span>
                      </span>
                    ) : null}
                  </div>
                </header>

                {lane.line.length > 0 ? (
                  <p className="ws-dispatch-lane-line">{lane.line}</p>
                ) : null}

                {canStop ? (
                  <button
                    type="button"
                    className="ws-dispatch-lane-stop"
                    onClick={() => onStopLane(lane.providerId)}
                    aria-label={`Stop ${lane.label}`}
                    disabled={busy}
                  >
                    <Icon name="stop" size={14} />
                    <span>Stop</span>
                  </button>
                ) : null}

                {hasAnswer ? (
                  <div className="ws-dispatch-lane-answer">
                    <p className="ws-dispatch-lane-answer-text">
                      {isExpanded
                        ? answer.text
                        : truncateText(answer.text, 240)}
                    </p>
                    <div className="ws-dispatch-lane-answer-actions">
                      <button
                        type="button"
                        className="ws-dispatch-lane-read-all"
                        onClick={() => toggleLaneExpanded(lane.providerId)}
                      >
                        {isExpanded ? "Show less" : "Read it all"}
                      </button>
                      <button
                        type="button"
                        className="ws-dispatch-lane-keep"
                        onClick={() => onKeep(lane.providerId)}
                        disabled={busy}
                        aria-label={`Keep answer from ${lane.label}`}
                      >
                        <Icon name="check" size={14} />
                        <span>Keep answer</span>
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>

        {canCompare ? (
          <footer className="ws-dispatch-board-footer">
            <button
              type="button"
              className="ws-dispatch-compare"
              onClick={onCompare}
              disabled={busy}
            >
              <Icon name="compare" size={16} />
              <span>Compare answers</span>
            </button>
          </footer>
        ) : null}
      </div>
    </section>
  );
}
