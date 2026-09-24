import { Icon, Modal } from "./ui.js";

export interface SubscriptionUsage {
  readonly providerId: string;
  readonly label: string;
  readonly asked: number;
  readonly finished: number;
  readonly stopped: number;
  readonly failed: number;
  readonly totalMs: number;
  readonly longest: string;
  readonly lastUsed: string;
  readonly busiestDay: string | null;
  readonly models: readonly { readonly id: string; readonly asked: number }[];
}

export interface UsageView {
  readonly window: "today" | "week" | "month";
  readonly headline: string;
  readonly subscriptions: readonly SubscriptionUsage[];
  readonly totalAsked: number;
  readonly quietest: string | null;
  readonly note: string;
}

export interface UsagePanelProps {
  readonly view: UsageView | null;
  readonly window: "today" | "week" | "month";
  readonly onWindow: (next: "today" | "week" | "month") => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

const WINDOW_TABS = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
] as const;

function formatQuietest(quietest: string, window: "today" | "week" | "month"): string {
  if (quietest.startsWith("You ")) {
    return quietest;
  }
  const period = window === "today" ? "today" : window === "week" ? "this week" : "this month";
  return `You have barely used ${quietest} ${period}.`;
}

export function UsagePanel({
  view,
  window,
  onWindow,
  onClose,
  busy,
}: UsagePanelProps) {
  return (
    <Modal title="What you have used" eyebrow="Your subscriptions" onClose={onClose}>
      <div className={`ws-usage-panel ${view === null ? "ws-usage-panel--counting" : ""}`} aria-busy={busy}>
        <div className="ws-usage-tabs" role="tablist" aria-label="Usage period">
          {WINDOW_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={window === tab.id}
              className={`ws-usage-tab ${window === tab.id ? "ws-usage-tab--active" : ""}`}
              onClick={() => onWindow(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {view === null ? (
          <div className="ws-usage-counting">
            <Icon name="clock" size={18} />
            <p className="ws-usage-counting-text">Still counting</p>
          </div>
        ) : (
          <div className="ws-usage-content">
            <p className="ws-usage-headline">{view.headline}</p>

            <div className="ws-usage-list">
              {view.subscriptions.map((sub) => {
                const barWidth =
                  view.totalAsked > 0 && sub.asked > 0
                    ? Math.min(100, Math.max(0, (sub.asked / view.totalAsked) * 100))
                    : 0;

                return (
                  <div
                    key={sub.providerId}
                    className={`ws-usage-row ${sub.asked === 0 ? "ws-usage-row--zero" : ""}`}
                  >
                    <div className="ws-usage-row-header">
                      <span className="ws-usage-row-label">{sub.label}</span>
                      <div className="ws-usage-bar-track" aria-hidden="true">
                        <div
                          className="ws-usage-bar-fill"
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      <span className="ws-usage-row-count">
                        {sub.asked === 0 ? "not yet" : sub.asked}
                      </span>
                    </div>

                    <details className="ws-usage-disclosure">
                      <summary className="ws-usage-disclosure-summary">
                        <span className="ws-usage-disclosure-title">Details</span>
                        <Icon name="chevron" size={14} />
                      </summary>
                      <div className="ws-usage-disclosure-body">
                        <dl className="ws-usage-stats">
                          <div className="ws-usage-stat">
                            <dt className="ws-usage-stat-label">Finished</dt>
                            <dd className="ws-usage-stat-value">{sub.finished}</dd>
                          </div>
                          <div className="ws-usage-stat">
                            <dt className="ws-usage-stat-label">Stopped</dt>
                            <dd className="ws-usage-stat-value">{sub.stopped}</dd>
                          </div>
                          <div className="ws-usage-stat">
                            <dt className="ws-usage-stat-label">Failed</dt>
                            <dd className="ws-usage-stat-value">{sub.failed}</dd>
                          </div>
                          <div className="ws-usage-stat">
                            <dt className="ws-usage-stat-label">Longest run</dt>
                            <dd className="ws-usage-stat-value">{sub.longest}</dd>
                          </div>
                          <div className="ws-usage-stat">
                            <dt className="ws-usage-stat-label">Last used</dt>
                            <dd className="ws-usage-stat-value">{sub.lastUsed}</dd>
                          </div>
                          <div className="ws-usage-stat">
                            <dt className="ws-usage-stat-label">Busiest day</dt>
                            <dd className="ws-usage-stat-value">{sub.busiestDay ?? "none"}</dd>
                          </div>
                        </dl>

                        <div className="ws-usage-models">
                          <span className="ws-usage-models-heading">Models</span>
                          {sub.models.length === 0 ? (
                            <p className="ws-usage-models-empty">None</p>
                          ) : (
                            <ul className="ws-usage-models-list">
                              {sub.models.map((model) => (
                                <li key={model.id} className="ws-usage-models-item">
                                  <span className="ws-usage-model-name">{model.id}</span>
                                  <span className="ws-usage-model-count">{model.asked}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </details>
                  </div>
                );
              })}
            </div>

            {view.quietest !== null ? (
              <p className="ws-usage-quietest">
                {formatQuietest(view.quietest, window)}
              </p>
            ) : null}

            <p className="ws-usage-note">{view.note}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
