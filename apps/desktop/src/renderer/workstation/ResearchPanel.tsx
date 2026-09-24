/** ResearchPanel provides live inspection of a research run as it reads sources. */
import type { ReactElement } from "react";
import { Icon, IconButton } from "./ui.js";

export interface ResearchStepView {
  readonly id?: string;
  readonly title: string;
  readonly live: boolean;
}

export interface ResearchRunView {
  readonly id?: string;
  readonly question: string;
  readonly status: string;
  readonly steps: readonly ResearchStepView[];
  readonly answer: string | null;
  readonly canStop: boolean;
}

export interface ResearchPanelProps {
  readonly view: ResearchRunView | null;
  readonly sources: readonly {
    readonly label: string;
    readonly url: string | null;
    readonly notes: number;
  }[];
  readonly unanswered: readonly string[];
  readonly now: number;
  readonly onStop: () => void;
  readonly onKeep: () => void;
  readonly onOpenSource: (url: string) => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

/** Converts raw URLs in step titles into clean human-readable words or source labels. */
function formatStepTitle(
  title: string,
  sources: readonly { readonly label: string; readonly url: string | null }[]
): string {
  let cleaned = title;

  for (const source of sources) {
    if (source.url && cleaned.includes(source.url)) {
      cleaned = cleaned.replaceAll(source.url, source.label);
    }
  }

  const urlPattern = /https?:\/\/[^\s)]+/g;
  cleaned = cleaned.replaceAll(urlPattern, (matchedUrl) => {
    try {
      const url = new URL(matchedUrl);
      const host = url.hostname.replace(/^www\./, "");
      const segments = url.pathname
        .split("/")
        .filter((seg) => seg.length > 0)
        .map((seg) => decodeURIComponent(seg).replace(/[-_]/g, " "));
      if (segments.length > 0) {
        return `${host} (${segments.join(" / ")})`;
      }
      return host;
    } catch {
      return "source";
    }
  });

  return cleaned;
}

export function ResearchPanel({
  view,
  sources,
  unanswered,
  onStop,
  onKeep,
  onOpenSource,
  onClose,
  busy,
}: ResearchPanelProps): ReactElement {
  const canStop = view !== null && view.canStop;
  const questionText = view !== null ? view.question : "Getting started";
  const statusText = view !== null ? view.status : "Getting started";

  return (
    <aside
      className={`ws-research-panel ${busy ? "ws-research-panel--busy" : ""}`}
      aria-label="Research panel"
    >
      <header className="ws-research-header">
        <div className="ws-research-header-top">
          <span className="ws-research-eyebrow">Research</span>
          <div className="ws-research-actions">
            <button
              type="button"
              className="ws-research-button ws-research-button--stop"
              onClick={() => {
                if (canStop) {
                  onStop();
                }
              }}
              disabled={!canStop}
              title={canStop ? "Stop research" : "Research cannot be stopped"}
              aria-label="Stop research"
            >
              <Icon name="stop" size={14} />
              <span>Stop</span>
            </button>
            <IconButton
              icon="close"
              label="Close research panel"
              onClick={onClose}
              className="ws-research-close"
            />
          </div>
        </div>
        <h2 className="ws-research-question">{questionText}</h2>
        <p className="ws-research-status">{statusText}</p>
        {busy ? <span className="ws-research-busy-indicator" aria-hidden="true" /> : null}
      </header>

      <div className="ws-research-body">
        <div className="ws-research-columns">
          <div className="ws-research-column ws-research-column--trace">
            <div className="ws-research-section-header">
              <Icon name="spark" size={16} />
              <h3 className="ws-research-section-title">Live trace</h3>
            </div>

            {view === null ? (
              <p className="ws-research-trace-getting-started">Getting started</p>
            ) : view.steps.length === 0 ? (
              <p className="ws-research-trace-getting-started">{statusText || "Getting started"}</p>
            ) : (
              <ol className="ws-research-trace-list">
                {view.steps.map((step, index) => {
                  const isLive = step.live;
                  const formattedTitle = formatStepTitle(step.title, sources);
                  const key = step.id ?? `${step.title}-${index}`;
                  return (
                    <li
                      key={key}
                      className={`ws-research-step ${
                        isLive ? "ws-research-step--live" : "ws-research-step--done"
                      }`}
                      aria-current={isLive ? "step" : undefined}
                    >
                      <span className="ws-research-step-marker" aria-hidden="true">
                        {isLive ? <Icon name="spark" size={14} /> : <Icon name="check" size={14} />}
                      </span>
                      <span className="ws-research-step-title">{formattedTitle}</span>
                      {isLive ? <span className="ws-research-step-badge">Live</span> : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          <div className="ws-research-column ws-research-column--sources">
            <div className="ws-research-section-header">
              <Icon name="file" size={16} />
              <h3 className="ws-research-section-title">Sources read</h3>
            </div>

            {sources.length === 0 ? (
              <p className="ws-research-sources-empty">No sources read yet</p>
            ) : (
              <ul className="ws-research-source-list">
                {sources.map((source, index) => {
                  const key = source.url ?? `${source.label}-${index}`;
                  const noteCountText = `${source.notes} ${
                    source.notes === 1 ? "note" : "notes"
                  }`;
                  return (
                    <li key={key} className="ws-research-source-item">
                      {source.url !== null ? (
                        <button
                          type="button"
                          className="ws-research-source-button"
                          onClick={() => onOpenSource(source.url!)}
                          title={`Open ${source.label}`}
                        >
                          <Icon name="paperclip" size={14} />
                          <span className="ws-research-source-label">{source.label}</span>
                        </button>
                      ) : (
                        <span className="ws-research-source-button ws-research-source-button--static">
                          <Icon name="file" size={14} />
                          <span className="ws-research-source-label">{source.label}</span>
                        </span>
                      )}
                      <span className="ws-research-source-notes">{noteCountText}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <section
          className="ws-research-section ws-research-unanswered"
          aria-labelledby="ws-research-unanswered-heading"
        >
          <div className="ws-research-section-header">
            <Icon name="help" size={16} />
            <h3 id="ws-research-unanswered-heading" className="ws-research-section-title">
              Could not answer
            </h3>
          </div>
          {unanswered.length === 0 ? (
            <p className="ws-research-unanswered-empty">Nothing left unanswered</p>
          ) : (
            <ul className="ws-research-unanswered-list">
              {unanswered.map((item, index) => (
                <li key={index} className="ws-research-unanswered-item">
                  {item}
                </li>
              ))}
            </ul>
          )}
        </section>

        {view !== null && view.answer !== null && view.answer.trim().length > 0 ? (
          <section
            className="ws-research-section ws-research-answer"
            aria-labelledby="ws-research-answer-heading"
          >
            <div className="ws-research-answer-header">
              <div className="ws-research-section-header">
                <Icon name="spark" size={16} />
                <h3 id="ws-research-answer-heading" className="ws-research-section-title">
                  Answer
                </h3>
              </div>
              <button
                type="button"
                className="ws-research-button ws-research-button--keep"
                onClick={onKeep}
              >
                <Icon name="check" size={14} />
                <span>Keep as output</span>
              </button>
            </div>
            <div className="ws-research-answer-body">
              <p className="ws-research-answer-text">{view.answer}</p>
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
