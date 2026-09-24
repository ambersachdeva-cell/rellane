/**
 * ComparisonView renders multi-provider answers side-by-side.
 * Differences are prioritised so you can immediately see where your bots diverge,
 * followed by shared agreements, and lastly unique observations per bot.
 */
import { Icon, Modal } from "./ui.js";

export interface ComparisonPoint {
  readonly point: string;
  readonly agreedBy: readonly string[];
  readonly missingFrom: readonly string[];
}

export interface Comparison {
  readonly headline: string;
  readonly agreements: readonly ComparisonPoint[];
  readonly differences: readonly ComparisonPoint[];
  readonly only: readonly { readonly label: string; readonly points: readonly string[] }[];
  readonly lengths: readonly { readonly label: string; readonly words: number }[];
  readonly shortest: string;
  readonly longest: string;
}

export interface ComparisonViewProps {
  readonly comparison: Comparison;
  readonly onKeep: (label: string) => void;
  readonly onClose: () => void;
}

export function ComparisonView({
  comparison,
  onKeep,
  onClose,
}: ComparisonViewProps) {
  const hasAgreements = comparison.agreements.length > 0;
  const hasDifferences = comparison.differences.length > 0;
  const hasOnly = comparison.only.some(entry => entry.points.length > 0);
  const hasPoints = hasAgreements || hasDifferences || hasOnly;

  // When no points were extracted or compared, inform the user directly and offer a simple exit.
  if (!hasPoints) {
    return (
      <Modal title="What your bots said" eyebrow="Side by side" wide onClose={onClose}>
        <div className="ws-compare-empty">
          <p className="ws-compare-empty-lead">
            {comparison.headline.trim().length > 0
              ? comparison.headline
              : "There is nothing to compare."}
          </p>
          <p className="ws-compare-empty-detail">
            Send the same brief to two or more bots, and this is where what they
            agreed and disagreed on will appear.
          </p>
          <div className="ws-compare-empty-actions">
            <button
              type="button"
              className="ws-compare-button ws-compare-button--primary"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="What your bots said" eyebrow="Side by side" wide onClose={onClose}>
      <div className="ws-compare">
        {comparison.headline.trim().length > 0 && (
          <p className="ws-compare-headline">{comparison.headline}</p>
        )}

        <div className="ws-compare-content">
          {/* Differences appear first so you see where human judgement is needed before shared consensus. */}
          {hasDifferences && (
            <section className="ws-compare-section ws-compare-section--differences">
              <h3 className="ws-compare-section-heading">Where they differ</h3>
              <ul className="ws-compare-list">
                {comparison.differences.map((diff, index) => (
                  <li
                    key={`diff-${index}-${diff.point}`}
                    className="ws-compare-item ws-compare-item--difference"
                  >
                    <p className="ws-compare-point-text">{diff.point}</p>
                    <div className="ws-compare-chip-group">
                      {diff.agreedBy.length > 0 && (
                        <div className="ws-compare-chip-subgroup">
                          <span className="ws-compare-chip-label">Said by</span>
                          <div className="ws-compare-chip-list">
                            {diff.agreedBy.map(bot => (
                              <span key={bot} className="ws-compare-chip ws-compare-chip--said">
                                {bot}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {diff.missingFrom.length > 0 && (
                        <div className="ws-compare-chip-subgroup">
                          <span className="ws-compare-chip-label">Not said by</span>
                          <div className="ws-compare-chip-list">
                            {diff.missingFrom.map(bot => (
                              <span key={bot} className="ws-compare-chip ws-compare-chip--missing">
                                {bot}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Agreements are shown second in a quieter tone to confirm shared consensus. */}
          {hasAgreements && (
            <section className="ws-compare-section ws-compare-section--agreements">
              <h3 className="ws-compare-section-heading">What they agree on</h3>
              <ul className="ws-compare-list">
                {comparison.agreements.map((agree, index) => (
                  <li
                    key={`agree-${index}-${agree.point}`}
                    className="ws-compare-item ws-compare-item--agreement"
                  >
                    <p className="ws-compare-point-text">{agree.point}</p>
                    <div className="ws-compare-chip-group">
                      {agree.agreedBy.length > 0 && (
                        <div className="ws-compare-chip-subgroup">
                          <span className="ws-compare-chip-label">Agreed by</span>
                          <div className="ws-compare-chip-list">
                            {agree.agreedBy.map(bot => (
                              <span key={bot} className="ws-compare-chip ws-compare-chip--agreed">
                                {bot}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {agree.missingFrom.length > 0 && (
                        <div className="ws-compare-chip-subgroup">
                          <span className="ws-compare-chip-label">Not said by</span>
                          <div className="ws-compare-chip-list">
                            {agree.missingFrom.map(bot => (
                              <span key={bot} className="ws-compare-chip ws-compare-chip--missing">
                                {bot}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Single-bot observations are collapsed by default to avoid visual clutter while remaining accessible. */}
          {hasOnly && (
            <section className="ws-compare-section ws-compare-section--only">
              <details className="ws-compare-details">
                <summary className="ws-compare-summary">
                  <span className="ws-compare-summary-heading">
                    <Icon name="chevron" size={14} />
                    <h3 className="ws-compare-section-heading">Only one bot said this</h3>
                  </span>
                  <span className="ws-compare-summary-hint">Click to show or hide</span>
                </summary>
                <div className="ws-compare-only-groups">
                  {comparison.only.map(group => {
                    if (group.points.length === 0) return null;
                    return (
                      <div key={group.label} className="ws-compare-only-group">
                        <h4 className="ws-compare-bot-heading">{group.label}</h4>
                        <ul className="ws-compare-only-list">
                          {group.points.map((point, index) => (
                            <li
                              key={`only-${group.label}-${index}-${point}`}
                              className="ws-compare-only-item"
                            >
                              <p className="ws-compare-point-text">{point}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </details>
            </section>
          )}
        </div>

        {/* The bottom bar displays word counts and provides a definitive action to select an answer. */}
        {comparison.lengths.length > 0 && (
          <footer className="ws-compare-footer">
            <div className="ws-compare-lengths">
              {comparison.lengths.map(bot => {
                const isShortest =
                  bot.label === comparison.shortest && comparison.lengths.length > 1;
                const isLongest =
                  bot.label === comparison.longest &&
                  comparison.lengths.length > 1 &&
                  comparison.longest !== comparison.shortest;

                return (
                  <div key={bot.label} className="ws-compare-bot-card">
                    <div className="ws-compare-bot-meta">
                      <span className="ws-compare-bot-name">{bot.label}</span>
                      <span className="ws-compare-bot-words">
                        {bot.words} {bot.words === 1 ? "word" : "words"}
                      </span>
                      {isShortest && (
                        <span className="ws-compare-badge ws-compare-badge--shortest">
                          Shortest
                        </span>
                      )}
                      {isLongest && (
                        <span className="ws-compare-badge ws-compare-badge--longest">
                          Longest
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="ws-compare-button ws-compare-button--keep"
                      onClick={() => onKeep(bot.label)}
                    >
                      Keep {bot.label}
                    </button>
                  </div>
                );
              })}
            </div>
          </footer>
        )}
      </div>
    </Modal>
  );
}
