export interface TrailTurn {
  readonly id: string;
  readonly seat: string;
  readonly kind: string;
  readonly body: string;
  readonly at: number;
}

export interface AuditDocument {
  readonly title: string;
  readonly markdown: string;
  readonly entryCount: number;
  readonly approvals: number;
  readonly toolCalls: number;
  readonly truncated: boolean;
}

export const MAX_BODY_CHARS = 4_000;
export const MAX_ENTRIES = 400;

const TRUNCATION_MARKER = "\n\n[Truncated: body exceeded 4,000 characters]";

interface TurnClassification {
  readonly seatLabel: string;
  readonly kindLabel: string;
  readonly isApproval: boolean;
  readonly isToolCall: boolean;
}

function formatSeatLabel(seat: string): string {
  const trimmed = seat.trim();
  const normalised = trimmed.toLowerCase();

  if (normalised === "user" || normalised === "owner" || normalised === "you") {
    return "You";
  }
  if (
    normalised === "rellane" ||
    normalised === "system" ||
    normalised === "app" ||
    normalised === "host" ||
    normalised === ""
  ) {
    return "Rellane";
  }
  if (normalised === "codex") {
    return "Codex";
  }
  if (normalised === "claude") {
    return "Claude";
  }
  if (normalised === "gemini1" || normalised === "gemini-1" || normalised === "gemini 1") {
    return "Gemini 1";
  }
  if (normalised === "gemini2" || normalised === "gemini-2" || normalised === "gemini 2") {
    return "Gemini 2";
  }
  if (normalised === "gemini3" || normalised === "gemini-3" || normalised === "gemini 3") {
    return "Gemini 3";
  }
  if (normalised === "gemini") {
    return "Gemini";
  }
  if (normalised === "qwen") {
    return "Qwen";
  }

  // Preserve casing if already provided with capitalisation, or capitalise first letter.
  if (trimmed === trimmed.toLowerCase()) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
  return trimmed;
}

function classifyTurn(turn: TrailTurn): TurnClassification {
  const seatLabel = formatSeatLabel(turn.seat);
  const rawKind = turn.kind.trim().toLowerCase();
  const rawBody = turn.body.trim().toLowerCase();

  const hasDeclineIndicator =
    rawKind === "decline" ||
    rawKind.startsWith("decline") ||
    rawKind === "rejected" ||
    rawKind.startsWith("reject") ||
    rawKind === "denied" ||
    /\b(declined|rejected|denied|refused|not approved|unapproved)\b/iu.test(rawBody);

  const isExplicitApprovalKind =
    rawKind === "approval" ||
    rawKind === "approved" ||
    rawKind.startsWith("approval");

  const hasApprovalText =
    /\b(approved|approval|permission granted|allowed)\b/iu.test(rawBody);

  const isPromptKind =
    rawKind === "prompt" ||
    rawKind === "request" ||
    rawKind === "ask" ||
    rawKind === "question" ||
    rawKind === "user_input" ||
    rawKind === "input";

  const isResponseKind =
    rawKind === "response" ||
    rawKind === "reply" ||
    rawKind === "answer" ||
    rawKind === "completion" ||
    rawKind === "output";

  // Check approval receipts first; declined actions must never count as approvals.
  if (!hasDeclineIndicator) {
    if (isExplicitApprovalKind) {
      return { seatLabel, kindLabel: "Approval", isApproval: true, isToolCall: false };
    }
    if (!isPromptKind && !isResponseKind && hasApprovalText) {
      return { seatLabel, kindLabel: "Approval", isApproval: true, isToolCall: false };
    }
  }

  // When an action or permission was explicitly declined, record it as Declined.
  if (
    hasDeclineIndicator &&
    (rawKind === "decision" ||
      rawKind === "permission" ||
      rawKind.startsWith("decline") ||
      rawKind.startsWith("reject") ||
      rawKind === "receipt")
  ) {
    return { seatLabel, kindLabel: "Declined", isApproval: false, isToolCall: false };
  }

  const isExplicitToolKind = rawKind === "tool" || rawKind.startsWith("tool");

  const hasToolText =
    /\b(tool call|tool called|ran tool|running tool|tool execution|called tool)\b/iu.test(rawBody) ||
    /^tool:\s+/iu.test(rawBody) ||
    /^tool call:\s+/iu.test(rawBody);

  if (isExplicitToolKind || (!isPromptKind && !isResponseKind && hasToolText)) {
    return { seatLabel, kindLabel: "Tool call", isApproval: false, isToolCall: true };
  }

  if (isPromptKind || (seatLabel === "You" && !isResponseKind)) {
    return { seatLabel, kindLabel: "Request", isApproval: false, isToolCall: false };
  }

  if (isResponseKind || (seatLabel !== "You" && seatLabel !== "Rellane")) {
    return { seatLabel, kindLabel: "Response", isApproval: false, isToolCall: false };
  }

  return { seatLabel, kindLabel: "Record", isApproval: false, isToolCall: false };
}

function formatUtcTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    return "1970-01-01 00:00:00";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "1970-01-01 00:00:00";
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatBody(body: string): string {
  let text = body;
  if (text.length > MAX_BODY_CHARS) {
    text = text.slice(0, MAX_BODY_CHARS) + TRUNCATION_MARKER;
  }

  if (text.includes("`")) {
    let maxRun = 0;
    let currentRun = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charAt(i) === "`") {
        currentRun++;
        if (currentRun > maxRun) {
          maxRun = currentRun;
        }
      } else {
        currentRun = 0;
      }
    }
    // CommonMark code fences must be at least 3 characters and longer than any consecutive backtick sequence inside.
    const fenceLength = Math.max(3, maxRun + 1);
    const fence = "`".repeat(fenceLength);
    return `${fence}\n${text}\n${fence}`;
  }

  return text;
}

export function buildAuditDocument(workTitle: string, turns: readonly TrailTurn[]): AuditDocument {
  const title = workTitle;
  const headingTitle = title.trim().length > 0 ? title.trim() : "Untitled work";

  if (turns.length === 0) {
    return {
      title,
      markdown: `# ${headingTitle}\n\nThere is nothing recorded yet.\n`,
      entryCount: 0,
      approvals: 0,
      toolCalls: 0,
      truncated: false
    };
  }

  // Chronological order ensures the exported audit document is a faithful narrative from start to finish.
  const sortedTurns = [...turns].sort((a, b) => a.at - b.at);
  const truncated = sortedTurns.length > MAX_ENTRIES;
  const visibleTurns = truncated ? sortedTurns.slice(0, MAX_ENTRIES) : sortedTurns;
  const leftOutCount = truncated ? sortedTurns.length - MAX_ENTRIES : 0;

  let approvals = 0;
  let toolCalls = 0;

  const entryBlocks: string[] = [];

  for (const turn of visibleTurns) {
    const classification = classifyTurn(turn);
    if (classification.isApproval) {
      approvals++;
    }
    if (classification.isToolCall) {
      toolCalls++;
    }

    const timeStr = formatUtcTimestamp(turn.at);
    const bodyStr = formatBody(turn.body);
    const header = `## ${timeStr} — ${classification.seatLabel} — ${classification.kindLabel}`;

    entryBlocks.push(bodyStr.length > 0 ? `${header}\n\n${bodyStr}` : header);
  }

  const entryNoun = visibleTurns.length === 1 ? "entry" : "entries";
  const approvalNoun = approvals === 1 ? "approval" : "approvals";
  const toolCallNoun = toolCalls === 1 ? "tool call" : "tool calls";

  const summaryLine = truncated
    ? `Record of ${visibleTurns.length} ${entryNoun} (${leftOutCount} left out): ${approvals} ${approvalNoun}, ${toolCalls} ${toolCallNoun}.`
    : `Record of ${visibleTurns.length} ${entryNoun}: ${approvals} ${approvalNoun}, ${toolCalls} ${toolCallNoun}.`;

  let markdown = `# ${headingTitle}\n\n${summaryLine}\n\n${entryBlocks.join("\n\n")}\n`;

  if (truncated) {
    const leftOutNoun = leftOutCount === 1 ? "entry was" : "entries were";
    markdown += `\n---\n*${leftOutCount} ${leftOutNoun} left out because this record is limited to ${MAX_ENTRIES} entries.*\n`;
  }

  return {
    title,
    markdown,
    entryCount: visibleTurns.length,
    approvals,
    toolCalls,
    truncated
  };
}
