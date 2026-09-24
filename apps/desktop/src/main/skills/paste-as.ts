/**
 * Paste As — the clipboard, reshaped for wherever it is going.
 *
 * Copy a messy WhatsApp enquiry; paste it into Numbers and get a row, into
 * Mail and get a draft, into a terminal and get the command. One hotkey, and
 * the destination decides the shape.
 *
 * The reshaping is deterministic wherever it can be, and that is not a
 * compromise. This runs on every paste, so it has to feel instant — a
 * fourteen-second round trip to turn a list into CSV would make the feature
 * unusable, and the transformation is not ambiguous enough to need a model.
 * A model is reserved for the genuinely fuzzy case: turning prose into fields.
 *
 * Pure functions. Clipboard and frontmost-app detection live in the caller.
 */

import { plural } from "../../shared/copy.js";

/** What the copied text appears to be. */
export type SourceShape =
  | "table"
  | "list"
  | "keyvalue"
  | "json"
  | "url"
  | "code"
  | "prose";

/** What the destination wants. */
export type Target =
  | "spreadsheet"
  | "terminal"
  | "editor"
  | "mail"
  | "notes"
  | "plain";

export interface PasteResult {
  readonly text: string;
  /** What happened, for the confirmation. Never a claim it did not do. */
  readonly summary: string;
  readonly shape: SourceShape;
  readonly target: Target;
  /** True when the text was returned unchanged. */
  readonly unchanged: boolean;
}

/** Bundle ids mapped to what that application actually wants pasted into it. */
const TARGETS: Readonly<Record<string, Target>> = Object.freeze({
  "com.apple.numbers": "spreadsheet",
  "com.microsoft.excel": "spreadsheet",
  "com.google.chrome.app.sheets": "spreadsheet",
  "com.apple.terminal": "terminal",
  "com.googlecode.iterm2": "terminal",
  "dev.warp.warp-stable": "terminal",
  "com.apple.mail": "mail",
  "com.microsoft.outlook": "mail",
  "com.apple.notes": "notes",
  "md.obsidian": "notes",
  "com.microsoft.vscode": "editor",
  "com.apple.dt.xcode": "editor",
  "com.todesktop.230313mzl4w4u92": "editor"
});

export function targetFor(bundleId: string | null): Target {
  if (bundleId === null) {
    return "plain";
  }
  return TARGETS[bundleId.toLowerCase()] ?? "plain";
}

const URL_ONLY = /^https?:\/\/\S+$/u;
const CODE_HINT = /(^|\n)\s*(const |let |var |function |class |def |import |from |#include|<\?php|SELECT |curl )/u;

export function detectShape(text: string): SourceShape {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "prose";
  }
  if (URL_ONLY.test(trimmed)) {
    return "url";
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return "json";
    }
  } catch {
    /* not JSON; keep looking */
  }

  const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);

  // A table is several lines that agree on how many columns they have — using
  // ONE delimiter for the whole block. Trying tab, spaces and comma
  // simultaneously splits "red, matte" inside a tab-separated cell and makes
  // the row counts disagree, so a perfectly good table reads as prose.
  if (lines.length >= 2 && delimiterFor(lines) !== null) {
    return "table";
  }

  // Key: value on most lines.
  if (lines.length >= 2 && lines.filter((line) => /^[^:\n]{1,40}:\s+\S/u.test(line)).length >= lines.length * 0.7) {
    return "keyvalue";
  }

  if (CODE_HINT.test(trimmed)) {
    return "code";
  }

  if (lines.length >= 2 && lines.every((line) => /^\s*([-*•]|\d+[.)])\s+/u.test(line))) {
    return "list";
  }

  return "prose";
}

/**
 * The one delimiter this block is separated by, or null when the lines do not
 * agree on a column count under any of them.
 *
 * Tried in order of how unambiguous they are: a tab is almost never inside a
 * cell, two spaces sometimes are, a comma frequently is.
 */
function delimiterFor(lines: readonly string[]): RegExp | null {
  const candidates: RegExp[] = [
    /\t/u,
    /\s{2,}/u,
    /,(?=(?:[^"]*"[^"]*")*[^"]*$)/u
  ];
  for (const delimiter of candidates) {
    const counts = lines.map((line) => line.split(delimiter).length);
    const first = counts[0] ?? 1;
    if (first >= 2 && counts.every((count) => count === first)) {
      return delimiter;
    }
  }
  return null;
}

/** Splits a table row using the delimiter chosen for the whole block. */
function cells(line: string, delimiter: RegExp): string[] {
  return line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/gu, ""));
}

/** Rows of a block already known to be a table. */
function tableRows(text: string): string[][] {
  const lines = text.trim().split("\n").filter((line) => line.trim().length > 0);
  const delimiter = delimiterFor(lines);
  return delimiter === null ? lines.map((line) => [line]) : lines.map((line) => cells(line, delimiter));
}

function toCsv(rows: readonly string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (/[",\n]/u.test(cell) ? `"${cell.replace(/"/gu, '""')}"` : cell))
        .join(",")
    )
    .join("\n");
}

function stripBullets(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*([-*•]|\d+[.)])\s+/u, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * Reshapes the clipboard for the destination.
 *
 * Returns the text unchanged, and says so, whenever there is no transformation
 * that clearly helps. Silently doing nothing and silently mangling are the two
 * ways this feature loses trust; both are avoided by reporting exactly what it
 * did.
 */
export function pasteAs(text: string, target: Target): PasteResult {
  const shape = detectShape(text);
  const unchangedResult = (summary: string): PasteResult => ({
    text,
    summary,
    shape,
    target,
    unchanged: true
  });

  if (text.trim().length === 0) {
    return unchangedResult("The clipboard is empty.");
  }

  if (target === "spreadsheet") {
    if (shape === "table") {
      const rows = tableRows(text);
      return { text: toCsv(rows), summary: `Turned ${plural(rows.length, "row")} into columns.`, shape, target, unchanged: false };
    }
    if (shape === "list") {
      const items = stripBullets(text);
      return { text: items.join("\n"), summary: `Stripped the bullets off ${plural(items.length, "row")}.`, shape, target, unchanged: false };
    }
    if (shape === "json") {
      const flat = flattenJson(text);
      if (flat !== null) {
        return { text: flat, summary: "Flattened the JSON into columns.", shape, target, unchanged: false };
      }
    }
    return unchangedResult("Nothing here looks like rows and columns.");
  }

  if (target === "terminal") {
    if (shape === "url") {
      return { text: `curl -sS ${text.trim()}`, summary: "Made it a curl command.", shape, target, unchanged: false };
    }
    // Pasting several lines into a shell runs them. Joining with && makes that
    // deliberate and stops halfway on the first failure.
    const lines = stripBullets(text);
    if (lines.length > 1 && shape !== "prose") {
      return {
        text: lines.join(" && "),
        summary: `Joined ${plural(lines.length, "command")} so they stop on the first failure.`,
        shape,
        target,
        unchanged: false
      };
    }
    return unchangedResult("Pasted as-is; nothing here needed changing for a shell.");
  }

  if (target === "notes" || target === "mail") {
    if (shape === "table") {
      const rows = tableRows(text);
      const bulleted = rows.map((row) => `• ${row.join(" — ")}`).join("\n");
      return { text: bulleted, summary: `Turned ${plural(rows.length, "row")} into a list.`, shape, target, unchanged: false };
    }
    if (shape === "keyvalue") {
      const tidy = text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => `• ${line.trim()}`)
        .join("\n");
      return { text: tidy, summary: "Made it a list.", shape, target, unchanged: false };
    }
    return unchangedResult("Pasted as written.");
  }

  if (target === "editor" && shape === "json") {
    const pretty = prettyJson(text);
    if (pretty !== null) {
      return { text: pretty, summary: "Formatted the JSON.", shape, target, unchanged: false };
    }
  }

  return unchangedResult("Pasted as written.");
}

function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text.trim()), null, 2);
  } catch {
    return null;
  }
}

/** An array of flat objects becomes a header row plus one row each. */
function flattenJson(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }
    const keys = [...new Set(parsed.flatMap((row) => (typeof row === "object" && row !== null ? Object.keys(row) : [])))];
    if (keys.length === 0) {
      return null;
    }
    const rows = parsed.map((row) =>
      keys.map((key) => {
        const value = (row as Record<string, unknown>)[key];
        return value === undefined || value === null ? "" : String(value);
      })
    );
    return toCsv([keys, ...rows]);
  } catch {
    return null;
  }
}
