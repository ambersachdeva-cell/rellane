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

export type CrewPartState = "waiting" | "claimed" | "working" | "answered" | "refining" | "done" | "failed" | "stopped";

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

export interface SeenFolder {
  readonly path: string;
  readonly name: string;
  readonly watching: boolean;
  readonly files: number | null;
  readonly lastSeenAt: string | null;
}

export interface SeenNote {
  readonly partyName: string;
  readonly note: string;
}

export interface SeenCases {
  readonly open: number;
  readonly closed: number;
  readonly openTitles: readonly string[];
}

export interface SeenTerm {
  readonly key: string;
  readonly word: string;
  readonly meaning: string;
  readonly hidden: boolean;
}

export interface Seen {
  readonly terms: readonly SeenTerm[];
  readonly folders: readonly SeenFolder[];
  readonly notes: readonly SeenNote[];
  readonly cases: SeenCases;
  readonly empty: boolean;
}

export interface KnowledgePanelProps {
  readonly seen: Seen | null;
  readonly now: number;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onHideTerm: (key: string, hidden: boolean) => void;
  readonly onPauseFolder: (path: string, paused: boolean) => void;
  readonly onGrantFolder: () => void;
  readonly onClose: () => void;
}

// Relative time is derived against a caller-provided timestamp to avoid render drift.
function formatLastSeen(lastSeenAt: string | null, now: number): string {
  if (lastSeenAt === null || lastSeenAt.trim() === "") {
    return "never";
  }
  const timestamp = Date.parse(lastSeenAt);
  if (Number.isNaN(timestamp)) {
    return "never";
  }
  const diffMs = Math.max(0, now - timestamp);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) {
    if (diffSec <= 1) {
      return "looked just now";
    }
    return `looked ${diffSec} seconds ago`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return diffMin === 1 ? "looked 1 minute ago" : `looked ${diffMin} minutes ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return diffHours === 1 ? "looked 1 hour ago" : `looked ${diffHours} hours ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return diffDays === 1 ? "looked 1 day ago" : `looked ${diffDays} days ago`;
}

function formatFilesCount(files: number | null): string {
  if (files === null) {
    return "files not yet counted";
  }
  return `${files} ${files === 1 ? "file" : "files"}`;
}

export function KnowledgePanel({
  seen,
  now,
  busy,
  problem,
  onHideTerm,
  onPauseFolder,
  onGrantFolder,
  onClose,
}: KnowledgePanelProps) {
  const problemBlock = problem ? (
    <div className="ws-seen-problem" role="alert">
      {problem}
    </div>
  ) : null;

  // When seen is null, the desktop process is still reading from the local database.
  if (seen === null) {
    return (
      <Modal title="What this app has seen" eyebrow="Yours, and only here" wide onClose={onClose}>
        {problemBlock}
        <div className="ws-seen-reading">
          <p className="ws-seen-reading-text">Still reading what this app has seen.</p>
        </div>
      </Modal>
    );
  }

  // When seen.empty is true, nothing has been stored yet; offering a folder lets the owner begin.
  if (seen.empty) {
    return (
      <Modal title="What this app has seen" eyebrow="Yours, and only here" wide onClose={onClose}>
        {problemBlock}
        <div className="ws-seen-empty">
          <p className="ws-seen-empty-text">
            This app has seen nothing yet. Add a folder to let it read your work.
          </p>
          <button
            type="button"
            className="ws-seen-grant-button"
            onClick={onGrantFolder}
            disabled={busy}
          >
            <Icon name="plus" size={14} />
            <span>Add a folder</span>
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="What this app has seen" eyebrow="Yours, and only here" wide onClose={onClose}>
      {problemBlock}
      <div className="ws-seen-sections">
        {/* Section 1: Folders it watches */}
        <section className="ws-seen-section">
          <div className="ws-seen-section-header">
            <h3 className="ws-seen-section-heading">Folders it watches</h3>
            <button
              type="button"
              className="ws-seen-add-folder-button"
              onClick={onGrantFolder}
              disabled={busy}
            >
              <Icon name="plus" size={14} />
              <span>Add a folder</span>
            </button>
          </div>
          {seen.folders.length === 0 ? (
            <p className="ws-seen-empty-note">No folders are being watched yet.</p>
          ) : (
            <ul className="ws-seen-folders-list">
              {seen.folders.map((folder) => {
                const toggleLabel = folder.watching
                  ? `Stop reading ${folder.name}`
                  : `Resume reading ${folder.name}`;
                return (
                  <li
                    key={folder.path}
                    className={`ws-seen-folder-item ${
                      folder.watching ? "" : "ws-seen-folder-item--paused"
                    }`}
                  >
                    <div className="ws-seen-folder-main">
                      <div className="ws-seen-folder-heading">
                        <span className="ws-seen-folder-name">{folder.name}</span>
                        <div className="ws-seen-folder-stats">
                          <span>{formatFilesCount(folder.files)}</span>
                          <span className="ws-seen-bullet"> · </span>
                          <span>{formatLastSeen(folder.lastSeenAt, now)}</span>
                        </div>
                      </div>
                      <div className="ws-seen-folder-path">{folder.path}</div>
                      {!folder.watching ? (
                        <p className="ws-seen-folder-paused-note">
                          Nothing is read from this folder.
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="ws-seen-folder-toggle"
                      aria-label={toggleLabel}
                      title={toggleLabel}
                      onClick={() => onPauseFolder(folder.path, folder.watching)}
                      disabled={busy}
                    >
                      {toggleLabel}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Section 2: Words it has learned */}
        <section className="ws-seen-section">
          <h3 className="ws-seen-section-heading">Words it has learned</h3>
          {seen.terms.length === 0 ? (
            <p className="ws-seen-empty-note">No words learned yet.</p>
          ) : (
            <ul className="ws-seen-terms-list">
              {seen.terms.map((term) => {
                const toggleLabel = term.hidden ? `Show ${term.word}` : `Hide ${term.word}`;
                return (
                  <li
                    key={term.key}
                    className={`ws-seen-term-item ${
                      term.hidden ? "ws-seen-term-item--hidden" : ""
                    }`}
                  >
                    <div className="ws-seen-term-main">
                      <div className="ws-seen-term-heading">
                        <span className="ws-seen-term-word">{term.word}</span>
                        {term.hidden ? (
                          <span className="ws-seen-term-badge">Hidden</span>
                        ) : null}
                      </div>
                      <p className="ws-seen-term-meaning">{term.meaning}</p>
                    </div>
                    <button
                      type="button"
                      className="ws-seen-term-toggle"
                      aria-label={toggleLabel}
                      title={toggleLabel}
                      onClick={() => onHideTerm(term.key, !term.hidden)}
                      disabled={busy}
                    >
                      {toggleLabel}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Section 3: What it knows about people */}
        <section className="ws-seen-section">
          <h3 className="ws-seen-section-heading">What it knows about people</h3>
          {seen.notes.length === 0 ? (
            <p className="ws-seen-empty-note">No notes recorded about people yet.</p>
          ) : (
            <ul className="ws-seen-notes-list">
              {seen.notes.map((note, idx) => (
                <li key={`${note.partyName}-${idx}`} className="ws-seen-note-item">
                  <div className="ws-seen-note-party">{note.partyName}</div>
                  <p className="ws-seen-note-text">{note.note}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Section 4: Your work */}
        <section className="ws-seen-section">
          <h3 className="ws-seen-section-heading">Your work</h3>
          <div className="ws-seen-cases-counts">
            <span className="ws-seen-cases-count">{seen.cases.open} open</span>
            <span className="ws-seen-bullet"> · </span>
            <span className="ws-seen-cases-count">{seen.cases.closed} closed</span>
          </div>
          {/* Stating this constraint gives visibility to the deliberate privacy boundary. */}
          <p className="ws-seen-cases-restraint">
            Case titles are listed here, but what was said inside them is not.
          </p>
          {seen.cases.openTitles.length === 0 ? (
            <p className="ws-seen-empty-note">No open cases at the moment.</p>
          ) : (
            <ul className="ws-seen-cases-list">
              {seen.cases.openTitles.map((title) => (
                <li key={title} className="ws-seen-case-item">
                  {title}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
