import { Icon, Modal } from "./ui.js";
import type { IconName } from "./ui.js";

export type Severity = "working" | "attention" | "broken" | "unknown";

export interface Finding {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly line: string;
  readonly fix: string | null;
}

export interface SelfCheck {
  readonly headline: string;
  readonly findings: readonly Finding[];
  readonly checkedAt: number;
}

export interface DiagnosticsPanelProps {
  readonly check: SelfCheck | null;
  readonly now: number;
  readonly running: boolean;
  readonly onRun: () => void;
  readonly onCopy: (text: string) => void;
  readonly onClose: () => void;
}

// Checks older than five minutes are stale because tool configurations or subscriptions may have changed.
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function isCheckStale(checkedAt: number, now: number): boolean {
  return now - checkedAt >= STALE_THRESHOLD_MS;
}

export function formatCheckedAt(checkedAt: number, now: number): string {
  const diffMs = Math.max(0, now - checkedAt);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "checked just now";
  }
  if (minutes === 1) {
    return "checked 1 minute ago";
  }
  if (minutes < 60) {
    return `checked ${minutes} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 1) {
    return "checked 1 hour ago";
  }
  if (hours < 24) {
    return `checked ${hours} hours ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return "checked 1 day ago";
  }
  return `checked ${days} days ago`;
}

// Four states must be distinguishable without colour. Unknown is explicitly unverified, never a pass or fault.
export function severityLabel(severity: Severity): string {
  switch (severity) {
    case "broken":
      return "Not working";
    case "attention":
      return "Needs attention";
    case "unknown":
      return "Not checked";
    case "working":
      return "Working";
  }
}

export function severityIconName(severity: Severity): IconName {
  switch (severity) {
    case "broken":
      return "close";
    case "attention":
      return "help";
    case "unknown":
      return "minus";
    case "working":
      return "check";
  }
}

// Faults demand immediate attention, followed by warnings, unverified checks, and confirmed working items.
const SEVERITY_WEIGHT: Record<Severity, number> = {
  broken: 0,
  attention: 1,
  unknown: 2,
  working: 3,
};

export function sortFindingsWorstFirst(findings: readonly Finding[]): readonly Finding[] {
  return [...findings].sort((a, b) => SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity]);
}

export function formatFindingForReport(finding: Finding): string {
  const state = severityLabel(finding.severity);
  const fixPart = finding.fix !== null && finding.fix.trim() !== "" ? ` - Fix: ${finding.fix}` : "";
  return `[${state}] ${finding.title}: ${finding.line}${fixPart}`;
}

// Builds the plain text report so what is copied matches the sorted view observed on screen.
export function buildReportText(check: SelfCheck): string {
  const sorted = sortFindingsWorstFirst(check.findings);
  const lines: string[] = [check.headline];
  for (const finding of sorted) {
    lines.push(formatFindingForReport(finding));
  }
  return lines.join("\n");
}

export function DiagnosticsPanel({
  check,
  now,
  running,
  onRun,
  onCopy,
  onClose,
}: DiagnosticsPanelProps) {
  const isStale = check !== null && isCheckStale(check.checkedAt, now);

  return (
    <Modal title="How things are" eyebrow="Your setup" wide onClose={onClose}>
      <div className="ws-diag-panel">
        {check === null ? (
          <div className={`ws-diag-initial ${running ? "ws-diag-initial--running" : ""}`}>
            <p className="ws-diag-initial-lead">
              {running
                ? "Checking your setup now. This inspects your subscriptions and tools to see what is working."
                : "Check your AI subscriptions, local tools, and connections to see what is working and what needs attention."}
            </p>
            <div className="ws-diag-actions">
              <button
                type="button"
                className="ws-diag-button ws-diag-button--primary"
                onClick={onRun}
                disabled={running}
              >
                <Icon name="refresh" size={16} />
                <span>{running ? "Checking..." : "Run check"}</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            <header className="ws-diag-header">
              <div className="ws-diag-header-text">
                <h3 className="ws-diag-headline">{check.headline}</h3>
                <p className="ws-diag-timestamp">{formatCheckedAt(check.checkedAt, now)}</p>
              </div>
              <div className="ws-diag-actions">
                <button
                  type="button"
                  className="ws-diag-button ws-diag-button--primary"
                  onClick={onRun}
                  disabled={running}
                >
                  <Icon name="refresh" size={16} />
                  <span>{running ? "Checking..." : "Run check again"}</span>
                </button>
                <button
                  type="button"
                  className="ws-diag-button ws-diag-button--secondary"
                  onClick={() => onCopy(buildReportText(check))}
                >
                  <Icon name="copy" size={16} />
                  <span>Copy report</span>
                </button>
              </div>
            </header>

            {isStale ? (
              <div className="ws-diag-stale" role="status">
                <div className="ws-diag-stale-message">
                  <Icon name="clock" size={16} />
                  <span>This check was run more than 5 minutes ago and may be out of date.</span>
                </div>
                <button
                  type="button"
                  className="ws-diag-button ws-diag-button--stale"
                  onClick={onRun}
                  disabled={running}
                >
                  Run check again
                </button>
              </div>
            ) : null}

            {check.findings.length === 0 ? (
              <p className="ws-diag-empty">No findings recorded for this check.</p>
            ) : (
              <ul className="ws-diag-list" role="list">
                {sortFindingsWorstFirst(check.findings).map((finding) => (
                  <li key={finding.id} className={`ws-diag-row ws-diag-row--${finding.severity}`}>
                    <div className="ws-diag-row-header">
                      <span className={`ws-diag-status ws-diag-status--${finding.severity}`}>
                        <span className={`ws-diag-marker ws-diag-marker--${finding.severity}`} aria-hidden="true">
                          <Icon name={severityIconName(finding.severity)} size={16} />
                        </span>
                        <span className="ws-diag-state-word">{severityLabel(finding.severity)}</span>
                      </span>
                      <h4 className="ws-diag-title">{finding.title}</h4>
                    </div>

                    <p className="ws-diag-line">{finding.line}</p>

                    {finding.fix !== null && finding.fix.trim() !== "" ? (
                      <div className="ws-diag-fix">
                        <span className="ws-diag-fix-label">What to do</span>
                        <p className="ws-diag-fix-body">{finding.fix}</p>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
