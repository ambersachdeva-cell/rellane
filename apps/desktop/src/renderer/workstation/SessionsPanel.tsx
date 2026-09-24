import type { ReactNode } from "react";
import { Icon, Modal, ProviderGlyph } from "./ui.js";
import type { SessionRow } from "./running-sessions.js";
import type { FleetSummary } from "./fleet-summary.js";

export interface SessionsPanelProps {
  readonly rows: readonly SessionRow[];
  readonly summary: FleetSummary;
  readonly onStop: (operationId: string) => void;
  readonly onOpen: (caseId: string) => void;
  readonly onClose: () => void;
}

/**
 * Maps arbitrary provider labels to known icon glyph families.
 * Unrecognised providers fall back to Codex styling in ProviderGlyph.
 */
function toProviderFamily(provider: string): string {
  const normalized = provider.toLowerCase();
  if (normalized.includes("gemini")) {
    return "gemini";
  }
  if (normalized.includes("claude")) {
    return "claude";
  }
  if (normalized.includes("local") || normalized.includes("qwen")) {
    return "local";
  }
  return "codex";
}

/**
 * Converts internal session states into plain British English labels.
 * Text labels ensure status changes are accessible without relying on colour alone.
 */
function formatState(state: SessionRow["state"]): string {
  switch (state) {
    case "needs-approval":
      return "Needs your approval";
    case "running":
      return "Working";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "done":
      return "Finished";
    default:
      return "Working";
  }
}

export function SessionsPanel({
  rows,
  summary,
  onStop,
  onOpen,
  onClose,
}: SessionsPanelProps): ReactNode {
  return (
    <Modal title="Sessions" onClose={onClose} wide>
      <div className="ws-sessions-panel">
        {rows.length === 0 ? (
          <div className="ws-sessions-empty" role="status">
            <p className="ws-sessions-empty-message">
              {summary.headline.length > 0 ? summary.headline : "Nothing is running."}
            </p>
          </div>
        ) : (
          <>
            <div className="ws-sessions-summary" role="status">
              <p className="ws-sessions-summary-line">{summary.headline}</p>
            </div>
            <ul className="ws-sessions-list" aria-label="Active sessions">
              {rows.map((row) => (
                <li
                  key={row.operationId}
                  className={`ws-sessions-item ${
                    row.needsYou ? "ws-sessions-item--needs-you" : ""
                  }`}
                >
                  <div className="ws-sessions-item-main">
                    <div className="ws-sessions-item-header">
                      <button
                        type="button"
                        className="ws-sessions-title-button"
                        onClick={() => onOpen(row.caseId)}
                        title={`Open ${row.title}`}
                      >
                        {row.title}
                      </button>
                      <span
                        className={`ws-sessions-badge ${
                          row.needsYou
                            ? "ws-sessions-badge--needs-you"
                            : `ws-sessions-badge--${row.state}`
                        }`}
                      >
                        {formatState(row.state)}
                      </span>
                    </div>
                    <div className="ws-sessions-item-details">
                      <span className="ws-sessions-provider">
                        <ProviderGlyph
                          family={toProviderFamily(row.provider)}
                          small
                        />
                        <span>{row.provider}</span>
                      </span>
                      <span className="ws-sessions-line">{row.line}</span>
                      <span className="ws-sessions-elapsed">
                        <Icon name="clock" size={14} />
                        <span>{row.elapsed}</span>
                      </span>
                    </div>
                  </div>
                  <div className="ws-sessions-actions">
                    <button
                      type="button"
                      className="ws-button ws-sessions-stop-button"
                      onClick={() => onStop(row.operationId)}
                      disabled={!row.canStop || row.state === "stopping"}
                      aria-label={`Stop session for ${row.title}`}
                    >
                      <Icon name="stop" size={14} />
                      <span>{row.state === "stopping" ? "Stopping…" : "Stop"}</span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
