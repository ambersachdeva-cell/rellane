import { Icon, Modal } from "./ui.js";

export type LearnedKind =
  | "business"
  | "people"
  | "decision"
  | "preference"
  | "constraint";

export interface Learned {
  readonly id: string;
  readonly kind: LearnedKind;
  readonly text: string;
  readonly source: string;
  readonly count: number;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly lastSeen: number;
}

export interface MemoryPanelProps {
  readonly facts: readonly Learned[];
  readonly stale: readonly Learned[];
  readonly projectTitle: string;
  readonly now: number;
  readonly busy: boolean;
  readonly onPin: (id: string, pinned: boolean) => void;
  readonly onHide: (id: string, hidden: boolean) => void;
  readonly onForget: (id: string) => void;
  readonly onClose: () => void;
}

const CANONICAL_KINDS: readonly LearnedKind[] = [
  "business",
  "people",
  "decision",
  "preference",
  "constraint",
] as const;

function getKindHeading(kind: LearnedKind | string): string {
  switch (kind) {
    case "business":
      return "About the business";
    case "people":
      return "About people";
    case "decision":
      return "Decisions you made";
    case "preference":
      return "How you like things";
    case "constraint":
      return "Things that constrain you";
    default:
      return kind;
  }
}

function formatTimeAgo(timestamp: number, now: number): string {
  /**
   * A missing timestamp is not a recent one. This reads as "Last seen ..." under
   * the stale heading, so answering "recently" for a time nobody recorded both
   * claims something never observed and contradicts the heading above it.
   */
  if (timestamp <= 0 || now <= 0) {
    return "at an unknown time";
  }
  if (timestamp > now) {
    return "just now";
  }
  const elapsedMs = now - timestamp;
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes === 1) {
    return "1 minute ago";
  }
  if (minutes < 60) {
    return `${minutes} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 1) {
    return "1 hour ago";
  }
  if (hours < 24) {
    return `${hours} hours ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return "yesterday";
  }
  return `${days} days ago`;
}

export function MemoryPanel({
  facts,
  stale,
  projectTitle,
  now,
  busy,
  onPin,
  onHide,
  onForget,
  onClose,
}: MemoryPanelProps) {
  const eyebrowText =
    projectTitle.trim().length > 0 ? `For ${projectTitle.trim()}` : "For this project";

  const activeKinds: readonly LearnedKind[] = CANONICAL_KINDS.filter((kind) =>
    facts.some((f) => f.kind === kind)
  );

  const hasAnyContent = facts.length > 0 || stale.length > 0;

  return (
    <Modal title="What it has worked out" eyebrow={eyebrowText} wide onClose={onClose}>
      <div className="ws-mem-container">
        <p className="ws-mem-intro">
          These are things worked out from your work, which are put in front of your subscriptions when relevant, and you can strike out any of them.
        </p>

        {!hasAnyContent ? (
          <div className="ws-mem-empty">
            <span className="ws-mem-empty-icon" aria-hidden="true">
              <Icon name="spark" size={24} />
            </span>
            <p className="ws-mem-empty-text">
              Nothing is remembered yet. Working through cases will build up what is known about your business, preferences, and decisions.
            </p>
          </div>
        ) : null}

        {facts.length > 0 ? (
          <div className="ws-mem-sections">
            {activeKinds.map((kind) => {
              const groupFacts = facts.filter((f) => f.kind === kind);
              return (
                <section key={kind} className="ws-mem-section" aria-label={getKindHeading(kind)}>
                  <h3 className="ws-mem-section-title">{getKindHeading(kind)}</h3>
                  <ul className="ws-mem-list">
                    {groupFacts.map((fact) => (
                      <li
                        key={fact.id}
                        className={`ws-mem-item ${fact.hidden ? "ws-mem-item--hidden" : ""} ${
                          fact.pinned ? "ws-mem-item--pinned" : ""
                        }`}
                      >
                        <div className="ws-mem-item-main">
                          <p
                            className={`ws-mem-item-text ${
                              fact.hidden ? "ws-mem-item-text--hidden" : ""
                            }`}
                          >
                            {fact.hidden ? <del>{fact.text}</del> : fact.text}
                          </p>
                          <div className="ws-mem-item-meta">
                            {fact.hidden ? (
                              <span className="ws-mem-badge ws-mem-badge--hidden">
                                Stopped using
                              </span>
                            ) : null}
                            {fact.pinned ? (
                              <span className="ws-mem-badge ws-mem-badge--pinned">
                                <Icon name="check" size={12} /> Kept
                              </span>
                            ) : null}
                            <span className="ws-mem-source">Learned from {fact.source}</span>
                            <span className="ws-mem-count">
                              {fact.count === 1 ? "Came up once" : `Came up ${fact.count} times`}
                            </span>
                          </div>
                        </div>
                        <div className="ws-mem-actions">
                          <button
                            type="button"
                            className={`ws-mem-btn ws-mem-btn--keep ${
                              fact.pinned ? "ws-mem-btn--kept" : ""
                            }`}
                            onClick={() => onPin(fact.id, !fact.pinned)}
                            disabled={busy}
                            aria-label={
                              fact.pinned
                                ? `Stop keeping "${fact.text}"`
                                : `Keep "${fact.text}"`
                            }
                            title={
                              fact.pinned
                                ? "Stop keeping this fact"
                                : "Keep this fact so it never goes stale"
                            }
                          >
                            {fact.pinned ? "Kept" : "Keep"}
                          </button>
                          <button
                            type="button"
                            className={`ws-mem-btn ws-mem-btn--hide ${
                              fact.hidden ? "ws-mem-btn--restore" : ""
                            }`}
                            onClick={() => onHide(fact.id, !fact.hidden)}
                            disabled={busy}
                            aria-label={
                              fact.hidden
                                ? `Resume using "${fact.text}"`
                                : `Stop using "${fact.text}"`
                            }
                            title={
                              fact.hidden
                                ? "Resume sending this fact to subscriptions"
                                : "Stop sending this fact to subscriptions"
                            }
                          >
                            {fact.hidden ? "Use again" : "Stop using"}
                          </button>
                          <button
                            type="button"
                            className="ws-mem-btn ws-mem-btn--forget"
                            onClick={() => onForget(fact.id)}
                            disabled={busy}
                            aria-label={`Forget "${fact.text}"`}
                            title="Forget this fact completely"
                          >
                            Forget
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : null}

        {stale.length > 0 ? (
          <section className="ws-mem-stale-section" aria-labelledby="ws-mem-stale-heading">
            <div className="ws-mem-stale-header">
              <div className="ws-mem-stale-header-title">
                <Icon name="clock" size={16} />
                <h3 id="ws-mem-stale-heading" className="ws-mem-stale-title">
                  Stale memories
                </h3>
              </div>
              {stale.length > 1 ? (
                <button
                  type="button"
                  className="ws-mem-btn ws-mem-btn--clear-all"
                  onClick={() => {
                    for (const item of stale) {
                      onForget(item.id);
                    }
                  }}
                  disabled={busy}
                  aria-label="Clear all stale memories"
                >
                  Clear all stale
                </button>
              ) : null}
            </div>
            <p className="ws-mem-stale-desc">
              These facts have not come up recently. You can clear them or keep any that are still true.
            </p>
            <ul className="ws-mem-stale-list">
              {stale.map((item) => (
                <li key={item.id} className="ws-mem-stale-item">
                  <div className="ws-mem-item-main">
                    <p className="ws-mem-item-text">{item.text}</p>
                    <div className="ws-mem-item-meta">
                      <span className="ws-mem-source">Learned from {item.source}</span>
                      <span className="ws-mem-last-seen">
                        Last seen {formatTimeAgo(item.lastSeen, now)}
                      </span>
                    </div>
                  </div>
                  <div className="ws-mem-actions">
                    <button
                      type="button"
                      className="ws-mem-btn ws-mem-btn--keep"
                      onClick={() => onPin(item.id, true)}
                      disabled={busy}
                      aria-label={`Keep "${item.text}"`}
                      title="Keep this fact so it never goes stale"
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      className="ws-mem-btn ws-mem-btn--forget"
                      onClick={() => onForget(item.id)}
                      disabled={busy}
                      aria-label={`Clear stale memory "${item.text}"`}
                    >
                      Clear
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Modal>
  );
}
