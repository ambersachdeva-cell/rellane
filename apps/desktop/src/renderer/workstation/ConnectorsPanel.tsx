import { Icon, Modal } from "./ui.js";

export type ConnectorState = "ready" | "starting" | "unreachable" | "blocked" | "off";

export interface ConnectorView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly state: ConnectorState;
  readonly detail: string;
  readonly toolCount: number | null;
  readonly lastReachedAt: number | null;
  readonly licence: string | null;
  readonly local: boolean;
}

export interface ConnectorsPanelProps {
  readonly connectors: readonly ConnectorView[];
  readonly now: number;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onEnable: (id: string) => void;
  readonly onDisable: (id: string) => void;
  readonly onRecheck: (id: string) => void;
  readonly onClose: () => void;
}

function formatState(state: ConnectorState): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "starting":
      return "Starting";
    case "unreachable":
      return "Unreachable";
    case "blocked":
      return "Blocked";
    case "off":
      return "Off";
  }
}

function formatToolCount(count: number | null): string {
  if (count === null) {
    return "never reached";
  }
  if (count === 1) {
    return "1 tool";
  }
  return `${count} tools`;
}

function formatLastReached(lastReachedAt: number | null, now: number): string {
  if (lastReachedAt === null || lastReachedAt <= 0) {
    return "never";
  }
  const diffMs = now - lastReachedAt;
  if (diffMs < 0) {
    return "just now";
  }
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) {
    return "just now";
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return diffMin === 1 ? "1 minute ago" : `${diffMin} minutes ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return diffDays === 1 ? "1 day ago" : `${diffDays} days ago`;
}

export function ConnectorsPanel({
  connectors,
  now,
  busy,
  problem,
  onEnable,
  onDisable,
  onRecheck,
  onClose,
}: ConnectorsPanelProps) {
  return (
    <Modal title="Outside tools" eyebrow="What this app can reach" wide onClose={onClose}>
      <div className="ws-conn-panel">
        {problem ? (
          <div className="ws-conn-problem" role="alert">
            <Icon name="shield" size={16} />
            <span className="ws-conn-problem-text">{problem}</span>
          </div>
        ) : null}

        {connectors.length === 0 ? (
          <div className="ws-conn-empty">
            <p className="ws-conn-empty-title">
              Connectors are outside tools this app can use to assist with your work.
            </p>
            <p className="ws-conn-empty-subtitle">
              None are set up on this Mac yet.
            </p>
          </div>
        ) : (
          <ul className="ws-conn-list">
            {connectors.map((connector) => (
              <li
                key={connector.id}
                className={`ws-conn-card ws-conn-card--${connector.state}`}
              >
                <div className="ws-conn-observed">
                  <div className="ws-conn-observed-status">
                    <span
                      className={`ws-conn-state ws-conn-state--${connector.state}`}
                    >
                      {formatState(connector.state)}
                    </span>
                    <span
                      className={`ws-conn-locality ws-conn-locality--${
                        connector.local ? "local" : "remote"
                      }`}
                    >
                      {connector.local ? "Runs on this Mac" : "Reaches out"}
                    </span>
                  </div>
                  <p className="ws-conn-detail">{connector.detail}</p>
                </div>

                {/* Untrusted text from external servers must not masquerade as headings */}
                <div className="ws-conn-claims">
                  <div className="ws-conn-claim-line">
                    <span className="ws-conn-claim-marker">It calls itself</span>
                    <span className="ws-conn-claim-text ws-conn-claim-text--name">
                      {connector.name}
                    </span>
                  </div>
                  <div className="ws-conn-claim-line">
                    <span className="ws-conn-claim-marker">It says</span>
                    <span className="ws-conn-claim-text ws-conn-claim-text--summary">
                      {connector.summary}
                    </span>
                  </div>
                </div>

                <div className="ws-conn-metrics">
                  <div className="ws-conn-metric">
                    <span className="ws-conn-metric-label">Tools offered:</span>
                    <span className="ws-conn-metric-value">
                      {formatToolCount(connector.toolCount)}
                    </span>
                  </div>
                  <div className="ws-conn-metric">
                    <span className="ws-conn-metric-label">Last reached:</span>
                    <span className="ws-conn-metric-value">
                      {formatLastReached(connector.lastReachedAt, now)}
                    </span>
                  </div>
                  <div className="ws-conn-metric">
                    <span className="ws-conn-metric-label">Licence:</span>
                    <span className="ws-conn-metric-value">
                      {connector.licence ?? "unknown"}
                    </span>
                  </div>
                </div>

                <div className="ws-conn-actions">
                  {connector.state === "off" ? (
                    <button
                      type="button"
                      className="ws-conn-btn ws-conn-btn--enable"
                      onClick={() => onEnable(connector.id)}
                      disabled={busy}
                    >
                      Enable
                    </button>
                  ) : null}

                  {/* Blocked connectors cannot be enabled or disabled until verified */}
                  {connector.state !== "off" && connector.state !== "blocked" ? (
                    <button
                      type="button"
                      className="ws-conn-btn ws-conn-btn--disable"
                      onClick={() => onDisable(connector.id)}
                      disabled={busy}
                    >
                      Disable
                    </button>
                  ) : null}

                  {connector.state !== "off" ? (
                    <button
                      type="button"
                      className="ws-conn-btn ws-conn-btn--recheck"
                      onClick={() => onRecheck(connector.id)}
                      disabled={busy}
                    >
                      Check now
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
