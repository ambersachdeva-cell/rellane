import { useState } from "react";
import { Icon, Modal } from "./ui.js";

export type PublishFormat = "html" | "markdown" | "slides";

export interface PublishPreview {
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly files: readonly { readonly relativePath: string; readonly bytes: number }[];
  readonly writtenTo?: string;
}

export interface PublishPanelProps {
  readonly outputTitle: string | null;
  readonly outputWords: number;
  readonly preview: PublishPreview | null;
  readonly onPreview: (format: PublishFormat) => void;
  readonly onWrite: (format: PublishFormat) => void;
  readonly onReveal: () => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

interface FormatOption {
  readonly id: PublishFormat;
  readonly title: string;
  readonly description: string;
}

const FORMAT_OPTIONS: readonly FormatOption[] = [
  {
    id: "html",
    title: "A web page",
    description: "Send it to someone, or print it.",
  },
  {
    id: "slides",
    title: "A slide deck",
    description: "Present to a room, or talk through your findings.",
  },
  {
    id: "markdown",
    title: "A Markdown file",
    description: "Keep your notes in your own editor, or edit elsewhere.",
  },
];

export function formatBytes(bytes: number): string {
  if (bytes <= 0 || !Number.isFinite(bytes)) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const unit = units[unitIndex];
  if (unit === undefined) {
    return `${Math.round(bytes)} B`;
  }
  const formatted =
    value >= 10
      ? Math.round(value).toString()
      : (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return `${formatted} ${unit}`;
}

function formatWords(count: number): string {
  if (count === 1) {
    return "1 word";
  }
  return `${count.toLocaleString("en-GB")} words`;
}

export function PublishPanel({
  outputTitle,
  outputWords,
  preview,
  onPreview,
  onWrite,
  onReveal,
  onClose,
  busy,
}: PublishPanelProps) {
  // Format choice is held locally; preview data and written destination come from bridge props.
  const [format, setFormat] = useState<PublishFormat>("html");

  if (outputTitle === null) {
    return (
      <Modal title="Publish" onClose={onClose}>
        <div className="ws-publish-empty">
          <p className="ws-publish-empty-title">Nothing to publish yet</p>
          <p className="ws-publish-empty-description">
            Save an answer or summary to this case first. You can ask a question in the case, choose an answer to keep, and save it. Once saved, you can publish it as a web page, a slide deck, or a Markdown file.
          </p>
          <div className="ws-publish-actions">
            <button
              type="button"
              className="ws-publish-button-secondary"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  if (preview === null) {
    return (
      <Modal title="Publish" onClose={onClose}>
        <div className="ws-publish-dialog">
          <div
            className="ws-publish-format-grid"
            role="radiogroup"
            aria-label="Publish format"
          >
            {FORMAT_OPTIONS.map((option) => {
              const isSelected = format === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className={`ws-publish-format-card ${isSelected ? "ws-publish-format-card--selected" : ""}`}
                  onClick={() => setFormat(option.id)}
                  disabled={busy}
                >
                  <div className="ws-publish-format-card-header">
                    <span className="ws-publish-format-title">{option.title}</span>
                    {isSelected ? (
                      <span className="ws-publish-format-check">
                        <Icon name="check" size={16} />
                      </span>
                    ) : null}
                  </div>
                  <p className="ws-publish-format-description">
                    {option.description}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="ws-publish-details">
            <div className="ws-publish-meta">
              <span className="ws-publish-meta-label">What will be published</span>
              <span className="ws-publish-output-title">{outputTitle}</span>
              <span className="ws-publish-output-words">
                {formatWords(outputWords)}
              </span>
            </div>

            <div className="ws-publish-actions">
              <button
                type="button"
                className="ws-publish-button-primary"
                onClick={() => onPreview(format)}
                disabled={busy}
              >
                See what will be written
              </button>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  const isWritten = typeof preview.writtenTo === "string";

  return (
    <Modal title="Publish" onClose={onClose}>
      <div className="ws-publish-dialog">
        <div className="ws-publish-preview">
          <p className="ws-publish-summary">{preview.summary}</p>

          {preview.warnings.length > 0 ? (
            <div className="ws-publish-warnings" role="alert">
              <div className="ws-publish-warnings-header">
                <Icon name="shield" size={16} />
                <span>Warnings</span>
              </div>
              <ul className="ws-publish-warnings-list">
                {preview.warnings.map((warning, index) => (
                  <li key={index} className="ws-publish-warning-item">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="ws-publish-files">
            <span className="ws-publish-files-heading">
              {isWritten ? "Written files" : "Files to write"}
            </span>
            <ul className="ws-publish-files-list">
              {preview.files.map((file) => (
                <li key={file.relativePath} className="ws-publish-file-item">
                  <span className="ws-publish-file-name">{file.relativePath}</span>
                  <span className="ws-publish-file-size">{formatBytes(file.bytes)}</span>
                </li>
              ))}
            </ul>
          </div>

          {isWritten ? (
            <div className="ws-publish-written">
              <span className="ws-publish-written-label">Written to folder</span>
              <p className="ws-publish-written-path" tabIndex={0}>
                {preview.writtenTo}
              </p>
            </div>
          ) : null}

          <div className="ws-publish-actions">
            {isWritten ? (
              <>
                <button
                  type="button"
                  className="ws-publish-button-secondary"
                  onClick={onClose}
                  disabled={busy}
                >
                  Close
                </button>
                <button
                  type="button"
                  className="ws-publish-button-primary"
                  onClick={onReveal}
                  disabled={busy}
                >
                  Show me
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="ws-publish-button-secondary"
                  onClick={onClose}
                  disabled={busy}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="ws-publish-button-primary"
                  onClick={() => onWrite(format)}
                  disabled={busy}
                >
                  Write these files
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
