import type { ReactNode } from "react";
import { Icon, Modal, ProviderGlyph, type IconName } from "./ui.js";

export interface ContributorLike {
  readonly seat: string;
  readonly label: string;
  readonly answers: number;
  readonly outputs: number;
  readonly chars: number;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly works: readonly string[];
  readonly line: string;
}

export interface ContributionViewLike {
  readonly contributors: readonly ContributorLike[];
  readonly headline: string;
  readonly workCount: number;
  readonly span: string;
}

export interface PackItemLike {
  readonly relativePath: string;
  readonly kind: "output" | "source" | "image" | "record";
  readonly title: string;
  readonly bytes: number;
  readonly sourceId: string | null;
}

export interface PackPlanLike {
  readonly folderName: string;
  readonly items: readonly PackItemLike[];
  readonly totalBytes: number;
  readonly readme: string;
  readonly excluded: readonly { readonly title: string; readonly reason: string }[];
  readonly warnings: readonly string[];
}

export interface ProjectInsightsProps {
  readonly view: ContributionViewLike;
  readonly pack: PackPlanLike | null;
  readonly onPlanPack: () => void;
  readonly onConfirmPack: () => void;
  readonly onOpenWork: (caseId: string) => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getProviderFamily(seat: string, label: string): string {
  const s = seat.toLowerCase();
  const l = label.toLowerCase();
  if (s.includes("gemini") || l.includes("gemini")) {
    return "gemini";
  }
  if (s.includes("claude") || l.includes("claude")) {
    return "claude";
  }
  if (s.includes("qwen") || s.includes("local") || l.includes("qwen")) {
    return "local";
  }
  return "codex";
}

function getPackItemIcon(kind: PackItemLike["kind"]): IconName {
  switch (kind) {
    case "output":
      return "file";
    case "source":
      return "paperclip";
    case "image":
      return "image";
    case "record":
      return "clock";
  }
}

export function ProjectInsights({
  view,
  pack,
  onPlanPack,
  onConfirmPack,
  onOpenWork,
  onClose,
  busy,
}: ProjectInsightsProps): ReactNode {
  // An empty project offers no actions and simply informs that no activity has taken place yet.
  if (view.contributors.length === 0) {
    return (
      <Modal title="Project insights" onClose={onClose} wide={false}>
        <div className="ws-project-insights ws-project-insights--empty">
          <p className="ws-empty-message">There are no contributions in this project yet.</p>
        </div>
      </Modal>
    );
  }

  // Exact optional properties require omitting eyebrow if no headline text is present.
  const eyebrowText =
    view.headline.length > 0
      ? view.span.length > 0 && view.span !== "no activity yet"
        ? `${view.headline} · ${view.span}`
        : view.headline
      : undefined;

  const modalProps = {
    title: "Project insights",
    onClose,
    wide: true,
    ...(eyebrowText ? { eyebrow: eyebrowText } : {}),
  };

  return (
    <Modal {...modalProps}>
      <div className="ws-project-insights">
        {/* Screen readers announce asynchronous planning and writing operations. */}
        <div className="ws-sr-only" role="status" aria-live="polite">
          {busy ? "Working on delivery pack…" : ""}
        </div>

        {/* Contributors are ordered strictly by output provenance without client-side re-sorting. */}
        <section className="ws-project-insights-section" aria-labelledby="contributors-heading">
          <div className="ws-section-header">
            <h3 id="contributors-heading">Contributors</h3>
            <p className="ws-section-description">
              Subscriptions that contributed to this project, and the pieces of work they touched.
            </p>
          </div>

          <ul className="ws-contributor-list" aria-label="Contributors">
            {view.contributors.map((c, index) => {
              // The owner represents direct human decision-making and is distinguished from external models.
              const isOwner = c.label === "You";

              return (
                <li
                  key={`${c.seat}-${index}`}
                  className={`ws-contributor-item ${isOwner ? "ws-contributor-item--owner" : "ws-contributor-item--ai"}`}
                >
                  <div className="ws-contributor-header">
                    <div className="ws-contributor-identity">
                      {isOwner ? (
                        <span className="ws-owner-glyph" aria-hidden="true">
                          <Icon name="edit" size={16} />
                        </span>
                      ) : (
                        <ProviderGlyph family={getProviderFamily(c.seat, c.label)} />
                      )}
                      <span className="ws-contributor-label">{c.label}</span>
                      <span className={`ws-badge ${isOwner ? "ws-badge--owner" : "ws-badge--ai"}`}>
                        {isOwner ? "You" : "AI subscription"}
                      </span>
                    </div>
                  </div>

                  <p className="ws-contributor-line">{c.line}</p>

                  {c.works.length > 0 ? (
                    <div className="ws-contributor-works">
                      <span className="ws-contributor-works-label">Works touched</span>
                      <ul className="ws-work-list" aria-label={`Works touched by ${c.label}`}>
                        {c.works.map((work) => (
                          <li key={work}>
                            <button
                              type="button"
                              className="ws-work-chip"
                              onClick={() => onOpenWork(work)}
                              aria-label={`Open work: ${work}`}
                            >
                              <Icon name="folder" size={14} />
                              <span>{work}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>

        {/* Hand-over packaging requires planning first to verify included and excluded items before writing. */}
        <section
          className="ws-project-insights-section ws-delivery-pack-section"
          aria-labelledby="delivery-pack-heading"
        >
          <div className="ws-section-header">
            <h3 id="delivery-pack-heading">Client delivery pack</h3>
            <p className="ws-section-description">
              Prepare a hand-over folder for your client. Planning shows exactly what will be included
              and excluded before any files are written to disk.
            </p>
          </div>

          {pack === null ? (
            <div className="ws-pack-step ws-pack-step--plan">
              <div className="ws-pack-step-info">
                <span className="ws-pack-step-badge">Step 1 of 2</span>
                <p className="ws-pack-step-text">
                  Plan the pack to review which files will be delivered and verify that your internal
                  notes and draft revisions remain excluded.
                </p>
              </div>
              <div className="ws-pack-actions">
                <button
                  type="button"
                  className="ws-button ws-button--secondary"
                  onClick={onPlanPack}
                  disabled={busy}
                >
                  Plan delivery pack
                </button>
              </div>
            </div>
          ) : (
            <div className="ws-pack-step ws-pack-step--review">
              <div className="ws-pack-step-info">
                <div className="ws-pack-step-header">
                  <span className="ws-pack-step-badge">Step 2 of 2</span>
                  <span className="ws-pack-folder-name">
                    Folder: <code>{pack.folderName}</code> ({formatBytes(pack.totalBytes)})
                  </span>
                </div>
                <p className="ws-pack-step-text">
                  Review the planned contents below. Internal sources and superseded revisions are
                  excluded so your notes stay private.
                </p>
              </div>

              {/* Both included and excluded columns have equal visual prominence for confidentiality audit. */}
              <div className="ws-pack-comparison-grid">
                <div className="ws-pack-column ws-pack-column--included">
                  <div className="ws-pack-column-header">
                    <h4 className="ws-pack-column-title">
                      <Icon name="check" size={16} />
                      <span>Included in pack ({pack.items.length})</span>
                    </h4>
                    <span className="ws-pack-column-subtitle">Files prepared for your client</span>
                  </div>
                  {pack.items.length === 0 ? (
                    <p className="ws-empty-column-message">No files are included in this plan.</p>
                  ) : (
                    <ul className="ws-pack-list" aria-label="Included files">
                      {pack.items.map((item) => (
                        <li key={item.relativePath} className="ws-pack-list-item">
                          <div className="ws-pack-item-main">
                            <span className="ws-pack-item-icon" aria-hidden="true">
                              <Icon name={getPackItemIcon(item.kind)} size={15} />
                            </span>
                            <span className="ws-pack-item-name">{item.relativePath}</span>
                            <span className="ws-pack-item-size">{formatBytes(item.bytes)}</span>
                          </div>
                          {item.title !== item.relativePath ? (
                            <span className="ws-pack-item-detail">{item.title}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="ws-pack-column ws-pack-column--excluded">
                  <div className="ws-pack-column-header">
                    <h4 className="ws-pack-column-title">
                      <Icon name="shield" size={16} />
                      <span>Excluded from pack ({pack.excluded.length})</span>
                    </h4>
                    <span className="ws-pack-column-subtitle">Internal materials kept private</span>
                  </div>
                  {pack.excluded.length === 0 ? (
                    <p className="ws-empty-column-message">No files were excluded from this plan.</p>
                  ) : (
                    <ul className="ws-pack-list ws-pack-list--excluded" aria-label="Excluded files">
                      {pack.excluded.map((item, index) => (
                        <li
                          key={`${item.title}-${index}`}
                          className="ws-pack-list-item ws-pack-list-item--excluded"
                        >
                          <div className="ws-pack-item-main">
                            <span className="ws-pack-item-icon" aria-hidden="true">
                              <Icon name="close" size={15} />
                            </span>
                            <span className="ws-pack-item-name">{item.title}</span>
                          </div>
                          <p className="ws-pack-item-reason">{item.reason}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {/* Warnings must precede confirm actions to ensure critical caveats are read before writing. */}
              {pack.warnings.length > 0 ? (
                <div className="ws-plan-warnings" role="alert" aria-label="Pack warnings">
                  <div className="ws-plan-warnings-header">
                    <Icon name="help" size={16} />
                    <strong>Please review before creating the folder:</strong>
                  </div>
                  <ul className="ws-warning-list">
                    {pack.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* The confirm button avoids autofocus so the user deliberately triggers folder generation. */}
              <div className="ws-pack-confirm-bar">
                <p className="ws-pack-confirm-explanation">
                  Confirming will write this folder and {pack.items.length}{" "}
                  {pack.items.length === 1 ? "file" : "files"} to disk on your Mac.
                </p>
                <div className="ws-pack-actions">
                  <button
                    type="button"
                    className="ws-button ws-button--secondary"
                    onClick={onPlanPack}
                    disabled={busy}
                  >
                    Re-plan pack
                  </button>
                  <button
                    type="button"
                    className="ws-button ws-button--primary"
                    onClick={onConfirmPack}
                    disabled={busy}
                  >
                    Create the folder
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
