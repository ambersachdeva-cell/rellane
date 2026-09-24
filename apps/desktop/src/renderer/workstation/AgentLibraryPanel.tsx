import { useState } from "react";
import { Icon, Modal } from "./ui.js";

export interface AgentCard {
  readonly id: string;
  readonly origin: "bundled" | "mine";
  readonly name: string;
  readonly summary: string;
  readonly updatedAt: number;
}

export interface AgentLibraryPanelProps {
  readonly agents: readonly AgentCard[];
  readonly now: number;
  readonly onOpen: (id: string) => void;
  readonly onDuplicate: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onNew: () => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

function formatRelativeTime(updatedAt: number, now: number): string {
  const diffMs = now - updatedAt;
  if (diffMs < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }
  const weeks = Math.floor(days / 7);
  if (days < 30) {
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

export function AgentLibraryPanel({
  agents,
  now,
  onOpen,
  onDuplicate,
  onDelete,
  onNew,
  onClose,
  busy,
}: AgentLibraryPanelProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const mineAgents = agents.filter((agent) => agent.origin === "mine");
  const bundledAgents = agents.filter((agent) => agent.origin === "bundled");
  const isEmpty = agents.length === 0;

  return (
    <Modal title="Your agents" eyebrow="Instructions a bot follows" wide onClose={onClose}>
      <div className="ws-agents-panel">
        <div className="ws-agents-header-actions">
          <button
            type="button"
            className="ws-agents-new-button"
            onClick={onNew}
            disabled={busy}
          >
            <Icon name="plus" />
            <span>New agent</span>
          </button>
        </div>

        {isEmpty ? (
          <div className="ws-agents-empty">
            <p className="ws-agents-empty-lead">An agent is a page of instructions a bot follows.</p>
            <p className="ws-agents-empty-detail">
              You can write your own instructions to guide how a bot works, or start from an existing one.
            </p>
            <div className="ws-agents-empty-actions">
              <button
                type="button"
                className="ws-agents-empty-button"
                onClick={onNew}
                disabled={busy}
              >
                <Icon name="plus" />
                <span>Start an agent</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="ws-agents-groups">
            {mineAgents.length > 0 ? (
              <section className="ws-agents-section" aria-labelledby="ws-agents-heading-mine">
                <h3 id="ws-agents-heading-mine" className="ws-agents-section-heading">
                  Agents you wrote
                </h3>
                <ul className="ws-agents-list" role="list">
                  {mineAgents.map((agent) => {
                    const isConfirming = confirmDeleteId === agent.id;
                    return (
                      <li key={agent.id} className="ws-agents-card ws-agents-card--mine">
                        <div className="ws-agents-card-header">
                          <h4 className="ws-agents-card-name">{agent.name}</h4>
                          <span className="ws-agents-card-updated">
                            <span className="ws-agents-card-updated-label">Updated </span>
                            <span className="ws-agents-card-updated-time">
                              {formatRelativeTime(agent.updatedAt, now)}
                            </span>
                          </span>
                        </div>
                        {agent.summary ? (
                          <p className="ws-agents-card-summary">{agent.summary}</p>
                        ) : null}
                        <div className="ws-agents-card-actions">
                          {isConfirming ? (
                            <div
                              className="ws-agents-card-confirm"
                              role="group"
                              aria-label={`Confirm deleting ${agent.name}`}
                            >
                              <span className="ws-agents-card-confirm-prompt">
                                Delete {agent.name}?
                              </span>
                              <div className="ws-agents-card-confirm-actions">
                                <button
                                  type="button"
                                  className="ws-agents-card-confirm-button"
                                  onClick={() => {
                                    setConfirmDeleteId(null);
                                    onDelete(agent.id);
                                  }}
                                  disabled={busy}
                                  aria-label={`Confirm delete ${agent.name}`}
                                >
                                  Delete
                                </button>
                                <button
                                  type="button"
                                  className="ws-agents-card-cancel-button"
                                  onClick={() => setConfirmDeleteId(null)}
                                  disabled={busy}
                                  aria-label={`Cancel deleting ${agent.name}`}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="ws-agents-card-button ws-agents-card-button--open"
                                onClick={() => onOpen(agent.id)}
                                disabled={busy}
                                aria-label={`Open ${agent.name}`}
                              >
                                <Icon name="edit" />
                                <span>Open</span>
                              </button>
                              <button
                                type="button"
                                className="ws-agents-card-button ws-agents-card-button--duplicate"
                                onClick={() => onDuplicate(agent.id)}
                                disabled={busy}
                                aria-label={`Duplicate ${agent.name}`}
                              >
                                <Icon name="copy" />
                                <span>Duplicate</span>
                              </button>
                              <button
                                type="button"
                                className="ws-agents-card-button ws-agents-card-button--delete"
                                onClick={() => setConfirmDeleteId(agent.id)}
                                disabled={busy}
                                aria-label={`Delete ${agent.name}`}
                              >
                                <Icon name="close" />
                                <span>Delete</span>
                              </button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {bundledAgents.length > 0 ? (
              <section className="ws-agents-section" aria-labelledby="ws-agents-heading-bundled">
                <h3 id="ws-agents-heading-bundled" className="ws-agents-section-heading">
                  Came with the app
                </h3>
                <ul className="ws-agents-list" role="list">
                  {bundledAgents.map((agent) => (
                    <li key={agent.id} className="ws-agents-card ws-agents-card--bundled">
                      <div className="ws-agents-card-header">
                        <h4 className="ws-agents-card-name">{agent.name}</h4>
                      </div>
                      {agent.summary ? (
                        <p className="ws-agents-card-summary">{agent.summary}</p>
                      ) : null}
                      <div className="ws-agents-card-actions">
                        <button
                          type="button"
                          className="ws-agents-card-button ws-agents-card-button--open"
                          onClick={() => onOpen(agent.id)}
                          disabled={busy}
                          aria-label={`Open ${agent.name}`}
                        >
                          <Icon name="edit" />
                          <span>Open</span>
                        </button>
                        <button
                          type="button"
                          className="ws-agents-card-button ws-agents-card-button--duplicate"
                          onClick={() => onDuplicate(agent.id)}
                          disabled={busy}
                          aria-label={`Start my own from ${agent.name}`}
                        >
                          <Icon name="copy" />
                          <span>Start my own from this</span>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}
