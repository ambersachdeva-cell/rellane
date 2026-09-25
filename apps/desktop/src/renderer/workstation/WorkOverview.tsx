/** The empty work surface points to real sessions and saved cases already held by the workstation. */
import type { JSX } from "react";
import type { CaseSummary } from "@cadrane/contracts";
import type { SessionRow } from "./running-sessions.js";
import "./work-overview.css";

type SessionState = SessionRow["state"];

export interface WorkOverviewProps {
  readonly cases: readonly CaseSummary[];
  readonly sessions: readonly SessionRow[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  onOpenWork(caseId: string): void;
  onOpenSession(caseId: string): void;
  onStop(operationId: string): void;
  onNewWork(): void;
  onRetry(): void;
  onAllWork?(): void;
  onAllSessions?(): void;
}

const STATE_ORDER: Record<SessionState, number> = {
  "needs-approval": 1,
  running: 2,
  starting: 3,
  stopping: 4,
  done: 5,
};

export function WorkOverview({
  cases,
  sessions,
  loading,
  error,
  busy,
  onOpenWork,
  onOpenSession,
  onStop,
  onNewWork,
  onRetry,
  onAllWork,
  onAllSessions,
}: WorkOverviewProps): JSX.Element {
  if (loading) {
    return (
      <section className="wo-root wo-state-card" aria-busy="true" aria-label="Loading workspace">
        <p className="wo-state-msg">Loading workspace…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="wo-root wo-state-card" role="alert" aria-label="Workspace error">
        <p className="wo-state-msg wo-error-msg">{error}</p>
        <button type="button" className="wo-btn wo-btn-primary" onClick={onRetry}>
          Retry
        </button>
      </section>
    );
  }

  const active = sessions
    .filter((s) => s.state !== "done")
    .slice()
    .sort((a, b) => {
      if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
      return STATE_ORDER[a.state] - STATE_ORDER[b.state];
    });

  const shownSessions = active.slice(0, 3);
  const activeCaseIds = new Set(shownSessions.map((s) => s.caseId));
  const recentCases = cases
    .filter((c) => c.closedAt === null && !activeCaseIds.has(c.id))
    .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, 5);

  if (shownSessions.length === 0 && recentCases.length === 0) {
    return (
      <section className="wo-root wo-state-card wo-empty" aria-label="No active work">
        <h2 className="wo-heading">No active work</h2>
        <p className="wo-sub">Start a new case to investigate, verify, or review.</p>
        <button type="button" className="wo-btn wo-btn-primary" onClick={onNewWork}>
          Start work
        </button>
      </section>
    );
  }

  return (
    <section className="wo-root" aria-label="Work overview">
      <header className="wo-header">
        <div>
          <h2 className="wo-heading">Workspace</h2>
          <span className="wo-sub">{active.length} active session{active.length === 1 ? "" : "s"}</span>
        </div>
        <button type="button" className="wo-btn wo-btn-primary" onClick={onNewWork}>
          New work
        </button>
      </header>

      {shownSessions.length > 0 && (
        <div className="wo-sec">
          <div className="wo-sec-bar">
            <span className="wo-sec-label">Active sessions</span>
            {onAllSessions && (
              <button type="button" className="wo-link-btn" onClick={onAllSessions}>
                All sessions ({active.length})
              </button>
            )}
          </div>
          <ul className="wo-list">
            {shownSessions.map((s) => (
              <li key={s.operationId} className={`wo-row ${s.needsYou ? "wo-row-urgent" : ""}`}>
                <div className="wo-row-main">
                  <span className="wo-title">{s.title}</span>
                  <span className="wo-desc">{s.line} · {s.elapsed}</span>
                </div>
                <div className="wo-row-actions">
                  {s.needsYou ? (
                    <button
                      type="button"
                      className="wo-btn wo-btn-primary"
                      onClick={() => onOpenWork(s.caseId)}
                      aria-label={`Review ${s.title}`}
                    >
                      Review
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="wo-btn"
                      onClick={() => onOpenSession(s.caseId)}
                      aria-label={`Open session ${s.title}`}
                    >
                      Open
                    </button>
                  )}
                  {s.canStop && (
                    <button
                      type="button"
                      className="wo-btn wo-btn-danger"
                      disabled={busy}
                      onClick={() => onStop(s.operationId)}
                      aria-label={`Stop ${s.title}`}
                    >
                      Stop
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {recentCases.length > 0 && (
        <div className="wo-sec">
          <div className="wo-sec-bar">
            <span className="wo-sec-label">Saved work</span>
            {onAllWork ? <button type="button" className="wo-link-btn" onClick={onAllWork}>All work</button> : null}
          </div>
          <ul className="wo-list">
            {recentCases.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="wo-case-btn"
                  onClick={() => onOpenWork(c.id)}
                  aria-label={`Open ${c.title || "Untitled"}`}
                >
                  <span className="wo-title">{c.title || "Untitled"}</span>
                  {c.question && <span className="wo-desc">{c.question}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
