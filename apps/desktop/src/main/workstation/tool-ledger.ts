export type ToolCallOutcome = "ran" | "declined" | "refused" | "failed" | "withheld";

export interface ToolLedgerEntry {
  readonly callId: string;
  readonly tool: string;
  /** Milliseconds since the epoch, from the host's clock. Never read a clock yourself. */
  readonly at: number;
  readonly outcome: ToolCallOutcome;
  /** Short, already-bounded description of what was asked for. May be empty. */
  readonly argumentSummary: string;
  /** UTF-8 bytes handed back to the model. 0 for anything that did not run. */
  readonly resultBytes: number;
  /** Why, for anything that did not run. Empty for "ran". */
  readonly detail: string;
}

export interface ToolLedgerRollup {
  readonly total: number;
  readonly ran: number;
  readonly declined: number;
  readonly refused: number;
  readonly failed: number;
  readonly withheld: number;
  readonly bytesReturned: number;
  readonly toolsUsed: readonly string[];
}

export interface ToolLedger {
  readonly rollup: ToolLedgerRollup;
  /** The receipt text. Empty string when there were no entries at all. */
  readonly receiptText: string;
}

export const MAX_LEDGER_ENTRIES = 64;
export const MAX_ARGUMENT_SUMMARY_CHARS = 200;

function formatUtcTime(at: number): string {
  if (!Number.isFinite(at) || at < 0) {
    return "--:--:--";
  }
  try {
    return new Date(at).toISOString().slice(11, 19);
  } catch {
    return "--:--:--";
  }
}

export function buildToolLedger(entries: readonly ToolLedgerEntry[]): ToolLedger {
  if (entries.length === 0) {
    return {
      rollup: {
        total: 0,
        ran: 0,
        declined: 0,
        refused: 0,
        failed: 0,
        withheld: 0,
        bytesReturned: 0,
        toolsUsed: []
      },
      receiptText: ""
    };
  }

  let ran = 0;
  let declined = 0;
  let refused = 0;
  let failed = 0;
  let withheld = 0;
  let bytesReturned = 0;
  const toolsUsedSet = new Set<string>();

  for (const entry of entries) {
    switch (entry.outcome) {
      case "ran":
        ran += 1;
        if (Number.isFinite(entry.resultBytes) && entry.resultBytes > 0) {
          bytesReturned += entry.resultBytes;
        }
        toolsUsedSet.add(entry.tool);
        break;
      case "declined":
        declined += 1;
        break;
      case "refused":
        refused += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "withheld":
        withheld += 1;
        break;
    }
  }

  const rollup: ToolLedgerRollup = {
    total: entries.length,
    ran,
    declined,
    refused,
    failed,
    withheld,
    bytesReturned,
    toolsUsed: Array.from(toolsUsedSet)
  };

  const outcomeCounts: string[] = [];
  if (ran > 0) outcomeCounts.push(`${ran.toLocaleString("en-GB")} ran`);
  if (declined > 0) outcomeCounts.push(`${declined.toLocaleString("en-GB")} declined`);
  if (refused > 0) outcomeCounts.push(`${refused.toLocaleString("en-GB")} refused`);
  if (failed > 0) outcomeCounts.push(`${failed.toLocaleString("en-GB")} failed`);
  if (withheld > 0) outcomeCounts.push(`${withheld.toLocaleString("en-GB")} withheld`);

  const callWord = rollup.total === 1 ? "call" : "calls";
  const charWord = bytesReturned === 1 ? "character was" : "characters were";
  const line1 = `Tools: ${rollup.total.toLocaleString("en-GB")} ${callWord} — ${outcomeCounts.join(", ")}. ${bytesReturned.toLocaleString("en-GB")} ${charWord} read back.`;

  const renderedLines: string[] = [line1];
  const countToRender = Math.min(entries.length, MAX_LEDGER_ENTRIES);
  const seenCallIds = new Set<string>();

  for (let i = 0; i < countToRender; i++) {
    const entry = entries[i]!;
    const isRepeat = seenCallIds.has(entry.callId);
    seenCallIds.add(entry.callId);

    const time = formatUtcTime(entry.at);
    const prefix = `${time} ${isRepeat ? "[repeat] " : ""}${entry.outcome} ${entry.tool}`;

    const summary =
      entry.argumentSummary.length > MAX_ARGUMENT_SUMMARY_CHARS
        ? `${entry.argumentSummary.slice(0, MAX_ARGUMENT_SUMMARY_CHARS)}…`
        : entry.argumentSummary;

    if (summary.length > 0 && entry.detail.length > 0) {
      renderedLines.push(`${prefix}: ${summary} — ${entry.detail}`);
    } else if (summary.length > 0) {
      renderedLines.push(`${prefix}: ${summary}`);
    } else if (entry.detail.length > 0) {
      renderedLines.push(`${prefix}: ${entry.detail}`);
    } else {
      renderedLines.push(prefix);
    }
  }

  if (entries.length > MAX_LEDGER_ENTRIES) {
    const unlisted = entries.length - MAX_LEDGER_ENTRIES;
    const unlistedWord = unlisted === 1 ? "call is" : "calls are";
    renderedLines.push(`${unlisted.toLocaleString("en-GB")} further ${unlistedWord} not listed.`);
  }

  return {
    rollup,
    receiptText: renderedLines.join("\n")
  };
}
