import type { ReactNode } from "react";
import type { Board, Seat, SeatState } from "./crew-board.js";
import { Modal, ProviderGlyph } from "./ui.js";

export interface CrewPanelProps {
  readonly board: Board;
  readonly onStart: (providerId: string) => void;
  readonly onOpen: (caseId: string) => void;
  readonly onClose: () => void;
}

// Distinguishes the primary model families supported by workstation glyphs.
function getProviderFamily(providerId: string, label: string): string {
  const text = `${providerId} ${label}`.toLowerCase();
  if (text.includes("gemini")) {
    return "gemini";
  }
  if (text.includes("claude")) {
    return "claude";
  }
  if (text.includes("local") || text.includes("qwen") || text.includes("ollama")) {
    return "local";
  }
  return "codex";
}

// Provides plain British English descriptions for every seat state without relying on colour alone.
function formatStateWord(state: SeatState): string {
  switch (state) {
    case "idle":
      return "Free";
    case "working":
      return "Working";
    case "waiting":
      return "Needs approval";
    case "stopped":
      return "Stopped";
    case "unavailable":
      return "Unavailable";
    default:
      return state;
  }
}

export function CrewPanel({
  board,
  onStart,
  onOpen,
  onClose
}: CrewPanelProps): ReactNode {
  // Retained for interface compatibility with workstation callers; Seat carries no caseId.
  void onOpen;

  const seats = board.seats;

  return (
    <Modal title="Crew" eyebrow={board.headline} onClose={onClose} wide>
      <div className="ws-crew-panel">
        {seats.length === 0 ? (
          <div className="ws-crew-empty">
            <p className="ws-crew-empty-message">No subscriptions configured yet.</p>
          </div>
        ) : (
          <ul className="ws-crew-list" role="list" aria-label="Subscriptions">
            {seats.map((seat: Seat) => (
              <li
                key={seat.providerId}
                className={`ws-crew-row ws-crew-row--${seat.state}${seat.state === "unavailable" ? " ws-crew-row--muted" : ""}`}
              >
                <div className="ws-crew-identity">
                  <ProviderGlyph family={getProviderFamily(seat.providerId, seat.label)} />
                  <div className="ws-crew-seat-info">
                    <div className="ws-crew-seat-header">
                      <span className="ws-crew-label">{seat.label}</span>
                      <span className={`ws-crew-state ws-crew-state--${seat.state}`}>
                        {formatStateWord(seat.state)}
                      </span>
                      {seat.badge ? (
                        <span className="ws-crew-badge">{seat.badge}</span>
                      ) : null}
                    </div>
                    <div className="ws-crew-seat-detail">
                      <span className="ws-crew-line">{seat.line}</span>
                      {seat.elapsed ? (
                        <span className="ws-crew-elapsed">{seat.elapsed}</span>
                      ) : null}
                    </div>
                  </div>
                </div>
                {seat.canStart ? (
                  <div className="ws-crew-actions">
                    <button
                      type="button"
                      className="ws-button ws-button--primary ws-crew-start-btn"
                      onClick={() => onStart(seat.providerId)}
                      aria-label={`Start work with ${seat.label}`}
                    >
                      Start work
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
