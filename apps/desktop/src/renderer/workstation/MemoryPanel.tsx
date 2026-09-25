import { useState } from "react";
import type {
  GovernedProjectMemoryItem,
  GovernedProjectMemoryView
} from "@cadrane/contracts";
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

export interface MemoryProposalDraft {
  readonly kind: GovernedProjectMemoryItem["kind"];
  readonly text: string;
  readonly id?: string;
  readonly expectedRevision?: number;
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
  readonly projectId?: string | null;
  readonly governedView?: GovernedProjectMemoryView | null;
  readonly governedLoading?: boolean;
  readonly governedError?: string | null;
  readonly proposalDraft?: MemoryProposalDraft;
  readonly onProposalDraftChange?: (draft: MemoryProposalDraft) => void;
  readonly onReload?: () => Promise<void>;
  readonly onPropose?: (proposal: {
    kind: GovernedProjectMemoryItem["kind"];
    text: string;
    id?: string;
    expectedRevision?: number;
  }) => Promise<void>;
  readonly onReview?: (
    id: string,
    expectedRevision: number,
    decision: "approve" | "reject",
    reason?: string
  ) => Promise<void>;
  readonly onForgetGoverned?: (
    id: string,
    expectedRevision: number,
    reason?: string
  ) => Promise<void>;
  readonly onSelectProject?: () => void;
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
  projectId = null,
  governedView = null,
  governedLoading = false,
  governedError = null,
  proposalDraft,
  onProposalDraftChange,
  onReload,
  onPropose,
  onReview,
  onForgetGoverned,
  onSelectProject,
}: MemoryPanelProps) {
  const [internalDraftsByProject, setInternalDraftsByProject] = useState<
    Record<string, MemoryProposalDraft>
  >({});
  const [savingProposal, setSavingProposal] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [forgettingId, setForgettingId] = useState<string | null>(null);
  const [clearingStale, setClearingStale] = useState(false);
  const [itemReasons, setItemReasons] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const currentKey = projectId ?? "__no_project__";
  const currentDraft: MemoryProposalDraft = proposalDraft ?? (internalDraftsByProject[currentKey] ?? {
    kind: "instruction",
    text: ""
  });

  const updateDraft = (draft: MemoryProposalDraft) => {
    if (onProposalDraftChange) {
      onProposalDraftChange(draft);
    } else {
      setInternalDraftsByProject((prev) => ({
        ...prev,
        [currentKey]: draft
      }));
    }
  };

  const setDraftText = (text: string) => {
    updateDraft({ ...currentDraft, text });
  };

  const setDraftKind = (kind: GovernedProjectMemoryItem["kind"]) => {
    updateDraft({ ...currentDraft, kind });
  };

  const isGovernedUnavailable = !governedView && governedError !== null;
  const isBusy = busy || governedLoading || savingProposal || reviewingId !== null || forgettingId !== null;
  const isGovernedDisabled = isBusy || isGovernedUnavailable;
  const safeGovernedView =
    governedView && governedView.projectId === projectId ? governedView : null;

  const eyebrowText =
    projectTitle.trim().length > 0 ? `For ${projectTitle.trim()}` : "For this project";

  const activeKinds: readonly LearnedKind[] = CANONICAL_KINDS.filter((kind) =>
    facts.some((f) => f.kind === kind)
  );

  const hasAnyLegacy = facts.length > 0 || stale.length > 0;

  async function handleSaveProposal() {
    if (!onPropose || !currentDraft.text.trim() || !projectId) return;
    setSavingProposal(true);
    setActionError(null);
    try {
      await onPropose({
        kind: currentDraft.kind,
        text: currentDraft.text,
        ...(currentDraft.id ? { id: currentDraft.id, expectedRevision: currentDraft.expectedRevision } : {})
      });
      updateDraft({
        kind: currentDraft.kind,
        text: ""
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to propose memory.");
    } finally {
      setSavingProposal(false);
    }
  }

  async function handleReview(
    id: string,
    expectedRevision: number,
    decision: "approve" | "reject",
    reason?: string
  ) {
    if (!onReview || reviewingId || forgettingId || isBusy) return;
    setReviewingId(id);
    setActionError(null);
    try {
      if (reason !== undefined) {
        await onReview(id, expectedRevision, decision, reason);
      } else {
        await onReview(id, expectedRevision, decision);
      }
      setItemReasons((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Failed to ${decision} candidate.`);
    } finally {
      setReviewingId(null);
    }
  }

  async function handleForgetGoverned(id: string, expectedRevision: number, reason?: string) {
    if (!onForgetGoverned || reviewingId || forgettingId || isBusy) return;
    setForgettingId(id);
    setActionError(null);
    try {
      if (reason !== undefined) {
        await onForgetGoverned(id, expectedRevision, reason);
      } else {
        await onForgetGoverned(id, expectedRevision);
      }
      setItemReasons((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete memory record.");
    } finally {
      setForgettingId(null);
    }
  }

  async function handleClearAllStale() {
    if (clearingStale || busy) return;
    setClearingStale(true);
    try {
      for (const item of stale) {
        await Promise.resolve(onForget(item.id));
      }
    } finally {
      setClearingStale(false);
    }
  }

  return (
    <Modal title="What it has worked out" eyebrow={eyebrowText} wide onClose={onClose}>
      <div className="ws-mem-container">
        <section className="ws-mem-section ws-mem-governed" aria-label="Approved project governance">
          <div className="ws-mem-governed-header">
            <h3 className="ws-mem-section-title">Approved project governance</h3>
            <p className="ws-mem-intro">
              Authoritative memory for this project. Decisions, instructions, and exclusions are approved explicitly. Findings remain unapproved evidence unless reviewed.
            </p>
          </div>

          {!projectId ? (
            <div className="ws-mem-empty" role="region" aria-label="Project selection guidance">
              <span className="ws-mem-empty-icon" aria-hidden="true">
                <Icon name="folder" size={24} />
              </span>
              <p className="ws-mem-empty-text">
                Approved memory and project governance require an explicit project. Select or create a project to review and manage governed instructions, decisions, and exclusions.
              </p>
              {onSelectProject ? (
                <button
                  type="button"
                  className="ws-mem-btn ws-mem-btn--keep"
                  onClick={onSelectProject}
                >
                  Choose project
                </button>
              ) : null}
            </div>
          ) : (
            <>
              {governedLoading ? (
                <div className="ws-mem-loading" role="status">
                  Loading project memory…
                </div>
              ) : null}

              {governedError || actionError ? (
                <div className="ws-inline-problem" role="alert">
                  <span>{actionError ?? governedError}</span>
                  {isGovernedUnavailable ? (
                    <span className="ws-mem-source" style={{ display: "block", marginTop: "4px" }}>
                      Canonical project memory actions are unavailable. Legacy observations below remain accessible.
                    </span>
                  ) : null}
                  {onReload ? (
                    <button
                      type="button"
                      className="ws-mem-btn ws-mem-btn--keep"
                      style={{ marginTop: "4px" }}
                      onClick={() => void onReload()}
                      disabled={isBusy}
                    >
                      Refresh
                    </button>
                  ) : null}
                </div>
              ) : null}

              {safeGovernedView && safeGovernedView.items.length > 0 ? (
                <ul className="ws-mem-list ws-mem-governed-list">
                  {safeGovernedView.items.map((item) => {
                    const hasCandidate = item.candidate !== null;
                    const hasActive = item.active !== null;
                    return (
                      <li key={item.id} className="ws-mem-item ws-mem-item--governed">
                        <div className="ws-mem-item-main">
                          <div className="ws-mem-item-meta">
                            <span className={`ws-mem-badge ws-mem-badge--${item.kind}`}>
                              {item.kind === "instruction"
                                ? "Instruction"
                                : item.kind === "decision"
                                ? "Decision"
                                : item.kind === "exclusion"
                                ? "Exclusion"
                                : "Observed Finding"}
                            </span>
                            {item.kind === "finding" && !hasActive ? (
                              <span className="ws-mem-source">
                                (Finding - not an approved decision or instruction)
                              </span>
                            ) : null}
                          </div>

                          {hasActive ? (
                            <div className="ws-mem-revision ws-mem-revision--active">
                              <div className="ws-mem-item-meta">
                                <span className="ws-mem-badge ws-mem-badge--pinned">
                                  <Icon name="check" size={12} /> {item.kind === "finding" ? `Accepted finding (v${item.active!.revision})` : `Approved (v${item.active!.revision})`}
                                </span>
                                {hasCandidate ? (
                                  <span className="ws-mem-source">{item.kind === "finding" ? "Prior accepted finding" : "Prior approved active"}</span>
                                ) : null}
                              </div>
                              <p className="ws-mem-item-text">{item.active!.text}</p>
                              <div className="ws-mem-item-meta">
                                <span className="ws-mem-source">
                                  {item.kind === "finding" ? `Accepted by ${item.active!.approverId ?? "owner"}` : `Approved by ${item.active!.approverId ?? "owner"}`}
                                </span>
                                {item.active!.reason ? (
                                  <span className="ws-mem-count">Reason: {item.active!.reason}</span>
                                ) : null}
                              </div>
                            </div>
                          ) : null}

                          {hasCandidate ? (
                            <div className="ws-mem-revision ws-mem-revision--candidate">
                              <div className="ws-mem-item-meta">
                                <span className="ws-mem-badge ws-mem-badge--hidden">
                                  Proposed candidate (v{item.candidate!.revision})
                                </span>
                                {hasActive ? (
                                  <span className="ws-mem-source">
                                    Awaiting review (prior approved v{item.active!.revision} remains active)
                                  </span>
                                ) : null}
                              </div>
                              <p className="ws-mem-item-text">{item.candidate!.text}</p>
                              <div className="ws-mem-item-meta">
                                <span className="ws-mem-source">
                                  Proposed by {item.candidate!.createdBy}
                                </span>
                              </div>
                            </div>
                          ) : null}
                        </div>

                        <div className="ws-mem-actions">
                          <input
                            type="text"
                            className="ws-mem-reason-input"
                            placeholder="Optional reason"
                            value={itemReasons[item.id] ?? ""}
                            onChange={(e) => {
                              const val = e.target.value;
                              setItemReasons((prev) => ({ ...prev, [item.id]: val }));
                            }}
                            disabled={isGovernedDisabled || reviewingId === item.id || forgettingId === item.id}
                            aria-label={`Optional reason for action on "${(item.active ?? item.candidate)?.text ?? item.id}"`}
                          />
                          {hasCandidate ? (
                            <>
                              <button
                                type="button"
                                className="ws-mem-btn ws-mem-btn--keep"
                                onClick={() =>
                                  void handleReview(
                                    item.id,
                                    item.headRevision,
                                    "approve",
                                    itemReasons[item.id]?.trim() || undefined
                                  )
                                }
                                disabled={isGovernedDisabled || reviewingId === item.id}
                                aria-label={`Approve candidate "${item.candidate!.text}"`}
                              >
                                {reviewingId === item.id ? "Reviewing…" : "Approve"}
                              </button>
                              <button
                                type="button"
                                className="ws-mem-btn ws-mem-btn--hide"
                                onClick={() =>
                                  void handleReview(
                                    item.id,
                                    item.headRevision,
                                    "reject",
                                    itemReasons[item.id]?.trim() || undefined
                                  )
                                }
                                disabled={isGovernedDisabled || reviewingId === item.id}
                                aria-label={`Reject candidate "${item.candidate!.text}"`}
                                title="Discard this proposed candidate revision without deleting the active record."
                              >
                                Reject
                              </button>
                            </>
                          ) : null}
                          <button
                            type="button"
                            className="ws-mem-btn ws-mem-btn--keep"
                            onClick={() => {
                              updateDraft({
                                kind: item.kind,
                                text: item.active?.text ?? item.candidate?.text ?? "",
                                id: item.id,
                                expectedRevision: item.headRevision
                              });
                            }}
                            disabled={isGovernedDisabled}
                            aria-label={`Propose revision for "${(item.active ?? item.candidate)?.text ?? item.id}"`}
                          >
                            Propose revision
                          </button>
                          <button
                            type="button"
                            className="ws-mem-btn ws-mem-btn--forget"
                            onClick={() =>
                              void handleForgetGoverned(
                                item.id,
                                item.headRevision,
                                itemReasons[item.id]?.trim() || undefined
                              )
                            }
                            disabled={isGovernedDisabled || forgettingId === item.id}
                            aria-label={
                              item.active && item.candidate
                                ? `Delete entire memory record "${item.active.text}" including pending revision`
                                : `Delete entire memory record "${(item.active ?? item.candidate)?.text ?? item.id}"`
                            }
                            title="Delete this entire memory record, including approved and pending revisions. This removes the record from project governance and does not erase or unsend original provider messages."
                          >
                            {forgettingId === item.id ? "Deleting…" : "Delete entire record"}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : safeGovernedView && safeGovernedView.items.length === 0 && !governedLoading ? (
                <p className="ws-mem-empty-text">
                  No approved or proposed memory entries for this project yet. Propose one below.
                </p>
              ) : null}

              <div className="ws-mem-proposal-form" role="region" aria-label="Propose project memory">
                <h4 className="ws-mem-section-title">
                  {currentDraft.id ? "Propose revision to memory entry" : "Propose memory entry"}
                </h4>
                {currentDraft.id ? (
                  <p className="ws-mem-intro">
                    Proposing revision to entry (expected revision {currentDraft.expectedRevision}). Active revision remains in effect until the new revision candidate is reviewed and approved.
                  </p>
                ) : null}
                <div className="ws-mem-item-meta">
                  <label htmlFor="ws-mem-kind-select">Kind:</label>
                  <select
                    id="ws-mem-kind-select"
                    value={currentDraft.kind}
                    onChange={(e) =>
                      setDraftKind(e.target.value as GovernedProjectMemoryItem["kind"])
                    }
                    disabled={isGovernedDisabled}
                  >
                    <option value="instruction">Instruction</option>
                    <option value="decision">Decision</option>
                    <option value="exclusion">Exclusion</option>
                    <option value="finding">Finding</option>
                  </select>
                </div>
                <textarea
                  className="ws-mem-item-text"
                  aria-label="Propose memory text"
                  placeholder="Propose an instruction, decision, exclusion, or finding for this project…"
                  value={currentDraft.text}
                  onChange={(e) => setDraftText(e.target.value)}
                  disabled={isGovernedDisabled}
                  rows={3}
                />
                <div className="ws-mem-actions">
                  <button
                    type="button"
                    className="ws-mem-btn ws-mem-btn--keep"
                    onClick={() => void handleSaveProposal()}
                    disabled={isGovernedDisabled || !currentDraft.text.trim()}
                  >
                    {savingProposal ? "Saving…" : currentDraft.id ? "Save revision proposal" : "Save proposal"}
                  </button>
                  {currentDraft.id ? (
                    <button
                      type="button"
                      className="ws-mem-btn ws-mem-btn--hide"
                      onClick={() => {
                        updateDraft({
                          kind: "instruction",
                          text: ""
                        });
                      }}
                      disabled={isGovernedDisabled}
                    >
                      Cancel revision
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </section>

        <div className="ws-mem-stale-header">
          <h3 className="ws-mem-section-title">Unapproved observations (Legacy)</h3>
        </div>
        <p className="ws-mem-intro">
          These are things worked out from your work, which are put in front of your subscriptions when relevant, and you can strike out any of them.
        </p>

        {!hasAnyLegacy ? (
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
                  onClick={() => void handleClearAllStale()}
                  disabled={busy || clearingStale}
                  aria-label="Clear all stale memories"
                >
                  {clearingStale ? "Clearing…" : "Clear all stale"}
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
