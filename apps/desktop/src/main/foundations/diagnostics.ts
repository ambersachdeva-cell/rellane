/**
 * Diagnostics: a ring buffer in memory, and a redacted bundle on request.
 *
 * When something goes wrong on someone else's Mac, the only thing that helps
 * is knowing what actually ran. But a log from a tool that reads files is full
 * of the user's life — folder names, client names, invoice numbers — and
 * shipping that to a developer is a worse outcome than the bug.
 *
 * So: everything is recorded, nothing is written to disk unless asked for, and
 * what leaves is redacted and previewable. The user sees the exact text before
 * it goes anywhere.
 */

import { homedir } from "node:os";

/** Kept small enough to hold in memory for a long session without growing. */
export const RING_SIZE = 500;

export type Level = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly at: number;
  readonly level: Level;
  /** Which part of the app. Used to filter a bundle down to what matters. */
  readonly area: string;
  readonly message: string;
  /** Structured detail. Values are redacted on the way out, not on the way in. */
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Redaction.
 *
 * Paths keep their shape but lose their content: a reader needs to know that
 * three files moved from one folder to another, not what the folder was
 * called. The home directory is collapsed first so a username never survives
 * even inside an otherwise-harmless path.
 */
export function redact(text: string): string {
  const home = homedir();
  return text
    .split(home)
    .join("~")
    /**
     * Any absolute path becomes its depth and its extension.
     *
     * Segments may contain **spaces**, which the previous pattern excluded — so
     * `~/Documents/Patel Hardware/Invoice 12.pdf` redacted to
     * `~…/ Hardware…/ 12.pdf`, leaking a customer's name into a bundle the owner
     * hands to somebody else. macOS paths have spaces constantly; this app's own
     * backup folder is "Cadrane Backups".
     *
     * A path ends at a quote, a colon, a comma, a bracket, a newline, or two
     * spaces. That over-redacts a little where a path sits mid-sentence, which
     * is the correct direction to be wrong in: a bundle that hides a stray word
     * costs nothing, and one that names a client cannot be taken back.
     */
    .replace(/(~|\/)(?:[^\n"':,()]|(?<! ) (?! ))*/gu, (match) => {
      if (!match.includes("/")) {
        return match;
      }
      const segments = match.trimEnd().split("/").filter((s) => s.length > 0);
      const last = segments[segments.length - 1] ?? "";
      const dot = last.lastIndexOf(".");
      const extension = dot > 0 ? last.slice(dot) : "";
      return `${match.startsWith("~") ? "~" : ""}/…${segments.length} deep/…${extension}`;
    })
    /**
     * The identifiers this business actually runs on, before the generic rules
     * get a chance to miss them.
     *
     * A GSTIN is fifteen characters, so the 24-character token rule below never
     * saw one, and it has no long digit run — `06AABCS1429B1ZP` went into an
     * exportable diagnostics bundle intact. It identifies a company exactly,
     * which is the whole point of it. PAN is ten characters and identifies a
     * person. A UPI id is somebody's payment handle.
     *
     * These are worth naming individually because each has an exact format, so
     * matching them is precise rather than a guess. **A person's name has no
     * format and is not caught here** — the rule for that one is that a name
     * must not reach a log at the call site, because no pattern can take it out
     * afterwards.
     *
     * Ordered before the email rule: a UPI id is shaped like an email and would
     * otherwise be redacted to `…@…`, which is fine, but says the wrong thing
     * about what was removed.
     */
    .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/gu, "…GSTIN…")
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/gu, "…PAN…")
    .replace(/\b[\w.-]{2,}@(?:okhdfcbank|oksbi|okicici|okaxis|ybl|paytm|upi|apl|ibl)\b/gu, "…UPI…")
    // Email addresses and bearer-looking tokens.
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/gu, "…@…")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/gu, "…token…")
    // Long digit runs, **including grouped ones**. `\d{7,}` missed every phone
    // number as people actually write them here — `+91 98765 43210`,
    // `98765-43210` — which is to say it missed the thing it was written for.
    .replace(/\d[\d\s-]{5,}\d/gu, "…digits…");
}

export class Diagnostics {
  private readonly entries: LogEntry[] = [];
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  log(level: Level, area: string, message: string, detail?: Record<string, unknown>): void {
    this.entries.push({
      at: this.now(),
      level,
      area,
      message,
      ...(detail === undefined ? {} : { detail })
    });
    // Oldest out. A long session must not grow without bound, and the recent
    // past is what explains a failure.
    if (this.entries.length > RING_SIZE) {
      this.entries.splice(0, this.entries.length - RING_SIZE);
    }
  }

  debug(area: string, message: string, detail?: Record<string, unknown>): void {
    this.log("debug", area, message, detail);
  }
  info(area: string, message: string, detail?: Record<string, unknown>): void {
    this.log("info", area, message, detail);
  }
  warn(area: string, message: string, detail?: Record<string, unknown>): void {
    this.log("warn", area, message, detail);
  }
  error(area: string, message: string, detail?: Record<string, unknown>): void {
    this.log("error", area, message, detail);
  }

  /** Everything held, newest last. */
  all(): readonly LogEntry[] {
    return [...this.entries];
  }

  /** Just the failures, for the case where that is the whole question. */
  problems(): readonly LogEntry[] {
    return this.entries.filter((entry) => entry.level === "warn" || entry.level === "error");
  }

  clear(): void {
    this.entries.length = 0;
  }

  /**
   * The bundle a user can read and then send.
   *
   * Plain text rather than JSON because the point is that a person can check
   * it before sharing, and nobody proofreads JSON.
   */
  bundle(context: {
    readonly appVersion: string;
    readonly platform: string;
    readonly architecture: string;
    readonly memoryBytes: number;
    readonly engine: string;
    readonly grantedRootCount: number;
    /**
     * The ledger's verdict in one sentence — "41 entries, unbroken", or where
     * it broke. Optional because the ledger may not have started yet.
     *
     * The verdict and nothing else. Ledger entries name the owner's clients and
     * folders; this is the one file in the product designed to be sent to
     * someone, so entry contents must never reach it.
     */
    readonly ledgerIntegrity?: string;
  }): string {
    const header = [
      "CADRANE DIAGNOSTIC REPORT",
      "",
      "Everything below is redacted: folder and file names are replaced by their",
      "depth and extension, addresses and long identifiers by placeholders. Read",
      "it before you send it — nothing leaves this Mac on its own.",
      "",
      `app          ${context.appVersion}`,
      `platform     ${context.platform} ${context.architecture}`,
      `memory       ${(context.memoryBytes / 1024 ** 3).toFixed(1)} GB`,
      `engine       ${context.engine}`,
      `granted      ${context.grantedRootCount} folder${context.grantedRootCount === 1 ? "" : "s"}`,
      `entries      ${this.entries.length}`,
      ...(context.ledgerIntegrity === undefined
        ? []
        : // Redacted like every other line. A verdict describing *where* the
          // record broke can name a folder or a customer, and this was the one
          // string in the bundle interpolated raw.
          [`record       ${redact(context.ledgerIntegrity)}`]),
      "",
      "─".repeat(64),
      ""
    ].join("\n");

    const body = this.entries
      .map((entry) => {
        const time = new Date(entry.at).toISOString().slice(11, 23);
        const detail =
          entry.detail === undefined ? "" : ` ${redact(JSON.stringify(entry.detail))}`;
        return `${time} ${entry.level.toUpperCase().padEnd(5)} ${entry.area.padEnd(14)} ${redact(
          entry.message
        )}${detail}`;
      })
      .join("\n");

    return `${header}${body}\n`;
  }
}

/** One instance for the whole main process. */
export const diagnostics = new Diagnostics();
