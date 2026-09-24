/**
 * What a Telegram message means, decided by a deterministic keyword table.
 *
 * Deterministic, no model call, and no clock. An inbound chat message from
 * phone to Mac must never add latency or hallucination risks for decisions
 * that a structured table answers definitively.
 */

export type WorkVerb = "ask" | "status" | "stop" | "agents" | "help";

export interface WorkIntent {
  readonly verb: WorkVerb;
  readonly body: string;
  readonly seats: readonly string[];
  readonly because: string;
}

const BOT_PATTERN = /\b(chatgpt|claude|codex|gemini(?:[\s-]*[1-3])?)\b/gi;
const BOT_TOKEN = "(?:chatgpt|claude|codex|gemini(?:[\\s-]*[1-3])?)";
const BOTS_LIST = `(?:${BOT_TOKEN}(?:\\s*(?:,|and|&|\\+)\\s*${BOT_TOKEN})*)`;

const LEADING_BOTS_PATTERN = new RegExp(
  `^(?:/ask\\s+)?(?:(?:ask|tell|have|get)\\s+)?${BOTS_LIST}\\s*(?:[,:\\-]\\s*|\\s+)`,
  "i"
);
const TRAILING_BOTS_PATTERN = new RegExp(
  `\\s+(?:with|using|for|via)\\s+${BOTS_LIST}\\s*[.?!]?$`,
  "i"
);
const TRAILING_PARENS_PATTERN = new RegExp(`\\s*\\(${BOTS_LIST}\\)\\s*$`, "i");

const STOP_REGEX = /^\/(stop|cancel|abort|halt)(?:\b|@)|\b(stop|cancel|abort|halt)\b/i;
const STOP_STRIP = /^\/(stop|cancel|abort|halt)(?:@\w+)?\b|\b(stop\s+everything|stop\s+all|stop|cancel|abort|halt)\b/gi;

const STATUS_REGEX = /^\/status(?:\b|@)|\b(how'?s\s+it\s+going|how\s+is\s+it\s+going|what'?s\s+happening|what\s+is\s+happening|any\s+update|done\s+yet|status)\b/i;
const STATUS_STRIP = /^\/status(?:@\w+)?\b|\b(how'?s\s+it\s+going|how\s+is\s+it\s+going|what'?s\s+happening|what\s+is\s+happening|any\s+update|done\s+yet|status)\b/gi;

const AGENTS_REGEX = /^\/agents(?:\b|@)|\b(which\s+bots|who\s+can|list\s+bots|what\s+agents|agents)\b/i;
const AGENTS_STRIP = /^\/agents(?:@\w+)?\b|\b(which\s+bots|who\s+can|list\s+bots|what\s+agents|agents)\b/gi;

const HELP_SLASH_REGEX = /^\/help(?:\b|@)/i;
const HELP_STRIP = /^\/help(?:@\w+)?\b|\b(what\s+can\s+you\s+do|what\s+can\s+u\s+do|help\s+me|help)\b/gi;

const ASK_KEYWORD_REGEX = /^\/ask(?:\b|@)|^\s*ask\b|\b(work\s+on|look\s+at|find\s+out|draft|write\s+me|summari[sz]e|compare)\b/i;

const QUESTION_STARTERS: readonly string[] = [
  "who", "what", "where", "when", "why", "how", "which",
  "can", "could", "would", "should", "is", "are", "was", "were",
  "do", "does", "did", "will", "shall", "may", "might"
];

function extractSeats(text: string): readonly string[] {
  const matches = text.matchAll(BOT_PATTERN);
  const seats: string[] = [];
  for (const match of matches) {
    const raw = match[1];
    if (raw === undefined) continue;
    const lower = raw.toLowerCase().trim();
    let seat: string;
    if (lower === "chatgpt") {
      // The owner's subscription provider for ChatGPT models is Codex
      seat = "codex";
    } else if (/^gemini[\s-]*[1-3]$/.test(lower)) {
      // Normalise numeric Gemini subscriptions to standard space format
      seat = lower.replace(/[\s-]+([1-3])$/, " $1");
    } else {
      seat = lower;
    }
    if (!seats.includes(seat)) {
      seats.push(seat);
    }
  }
  return seats;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((token) => token.length > 0).length;
}

function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.includes("?")) return true;
  const words = trimmed.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  const first = words[0];
  if (first === undefined) return false;
  const cleaned = first.replace(/^[^a-z]+|[^a-z]+$/g, "");
  return QUESTION_STARTERS.includes(cleaned);
}

function extractKeywordBody(text: string, stripRegex: RegExp, seats: readonly string[]): string {
  let body = text.replace(stripRegex, "").replace(/\b(please|can\s+you|could\s+you)\b/gi, "").trim();
  for (const seat of seats) {
    body = body.replace(new RegExp(`\\b${seat}\\b`, "gi"), "");
  }
  body = body.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "").trim();
  /**
   * "ask claude to review the sheet" leaves "to review the sheet".
   *
   * Taking the bots' names out of the request is right — the bots should not be
   * told to ask themselves — but it leaves the infinitive dangling, and what is
   * left is the request that gets shown to him and sent onward. A leading "to"
   * or "and" is the seam where the names used to be.
   */
  body = body.replace(/^(?:to|and|that|for)\s+/i, "").trim();
  return body.length > 4000 ? body.slice(0, 4000).trim() : body;
}

function extractAskBody(text: string): string {
  let body = text.trim();
  if (LEADING_BOTS_PATTERN.test(body)) {
    body = body.replace(LEADING_BOTS_PATTERN, "");
  } else {
    body = body.replace(/^\/ask\s*/i, "").replace(/^ask\s*[,:\-]?\s*/i, "");
  }
  body = body.replace(TRAILING_BOTS_PATTERN, "").replace(TRAILING_PARENS_PATTERN, "").trim();
  // "ask claude to review the sheet" leaves "to review the sheet": the leading
  // word is the seam where the bots' names used to be. See the note above.
  body = body.replace(/^(?:to|and|that|for)\s+/i, "").trim();
  // Telegram inputs may be lengthy; the dispatch queue caps payload bodies at 4,000 characters
  return body.length > 4000 ? body.slice(0, 4000).trim() : body;
}

export function readWorkIntent(text: string): WorkIntent | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Strip Telegram bot command mention suffix before intent matching
  const cleaned = trimmed.replace(/^\/([a-zA-Z0-9_]+)@[a-zA-Z0-9_]+(?=\s|$)/, "/$1");
  const seats = extractSeats(cleaned);

  // Stop authority outranks every other intent to guarantee immediate cancellation
  if (STOP_REGEX.test(cleaned)) {
    return {
      verb: "stop",
      body: extractKeywordBody(cleaned, STOP_STRIP, seats),
      seats,
      because: "you asked to stop"
    };
  }

  if (/^\/status(?:\b|$)/i.test(cleaned)) {
    return { verb: "status", body: extractKeywordBody(cleaned, STATUS_STRIP, seats), seats, because: "you asked for a status update" };
  }
  if (/^\/agents(?:\b|$)/i.test(cleaned)) {
    return { verb: "agents", body: extractKeywordBody(cleaned, AGENTS_STRIP, seats), seats, because: "you asked which bots are available" };
  }
  if (HELP_SLASH_REGEX.test(cleaned)) {
    return { verb: "help", body: extractKeywordBody(cleaned, HELP_STRIP, seats), seats, because: "you asked for help" };
  }
  if (/^\/ask(?:\b|$)/i.test(cleaned)) {
    return { verb: "ask", body: extractAskBody(cleaned), seats, because: isQuestion(cleaned) ? "you asked a question" : "you asked to start work" };
  }

  if (STATUS_REGEX.test(cleaned)) {
    return { verb: "status", body: extractKeywordBody(cleaned, STATUS_STRIP, seats), seats, because: "you asked for a status update" };
  }

  if (AGENTS_REGEX.test(cleaned)) {
    return { verb: "agents", body: extractKeywordBody(cleaned, AGENTS_STRIP, seats), seats, because: "you asked which bots are available" };
  }

  const bare = cleaned.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "").trim();
  if (/^(help|help\s+me|what\s+can\s+you\s+do|what\s+can\s+u\s+do)$/i.test(bare)) {
    const isWhat = /\bwhat\s+can\s+(you|u)\s+do\b/i.test(bare);
    return { verb: "help", body: extractKeywordBody(cleaned, HELP_STRIP, seats), seats, because: isWhat ? "you asked what I can do" : "you asked for help" };
  }

  if (ASK_KEYWORD_REGEX.test(cleaned) || (isQuestion(cleaned) && wordCount(cleaned) > 4)) {
    return { verb: "ask", body: extractAskBody(cleaned), seats, because: isQuestion(cleaned) ? "you asked a question" : "you asked to start work" };
  }

  // Short messages without recognised verbs default to guidance rather than failing silently
  if (wordCount(cleaned) < 5) {
    return { verb: "help", body: "", seats, because: "you asked for help" };
  }

  // Multi-sentence and long freeform input is captured as a work request
  return { verb: "ask", body: extractAskBody(cleaned), seats, because: isQuestion(cleaned) ? "you asked a question" : "you asked to start work" };
}
