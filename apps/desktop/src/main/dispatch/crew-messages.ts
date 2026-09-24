/**
 * Pure message builders for notifications sent to Telegram.
 * Messages are plain, calm, second-person British English and strictly under 600 characters.
 */

export type CrewEvent =
  | { readonly kind: "staged"; readonly request: string; readonly seatLabels: readonly string[] }
  | { readonly kind: "started"; readonly partCount: number; readonly seatLabels: readonly string[] }
  | { readonly kind: "part-done"; readonly partTitle: string; readonly seatLabel: string; readonly words: number }
  | { readonly kind: "needs-you"; readonly what: string }
  | { readonly kind: "finished"; readonly partCount: number; readonly agreed: number; readonly contested: number }
  | { readonly kind: "failed"; readonly partTitle: string; readonly reason: string }
  | { readonly kind: "stopped"; readonly partCount: number }
  | { readonly kind: "refused"; readonly reason: string };

const SMALL_NUMBERS: readonly string[] = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

function formatNumber(n: number): string {
  if (Number.isInteger(n) && n >= 0 && n <= 10) {
    return SMALL_NUMBERS[n]!;
  }
  return String(n);
}

function formatPartsCount(count: number): string {
  if (count === 1) {
    return "one part";
  }
  return `${formatNumber(count)} parts`;
}

function formatSeats(seatLabels: readonly string[]): string {
  if (seatLabels.length === 0) {
    return "";
  }
  if (seatLabels.length === 1) {
    return seatLabels[0]!;
  }
  if (seatLabels.length === 2) {
    return `${seatLabels[0]!} and ${seatLabels[1]!}`;
  }
  const leading = seatLabels.slice(0, -1).join(", ");
  const last = seatLabels[seatLabels.length - 1]!;
  return `${leading} and ${last}`;
}

/**
 * Strips file paths, tokens, stack traces, and internal technical terms
 * so sensitive details never leave the Mac.
 */
function sanitizeText(raw: string): string {
  if (!raw) {
    return "";
  }

  let text = raw;

  // Remove stack traces and line pointers
  text = text.replace(/^\s*at\s+.*$/gm, "");
  text = text.replace(/\s+at\s+[\w$./<>-]+(?::\d+)?/g, "");

  // Web and file links
  text = text.replace(/https?:\/\/\S+/gi, "a link");
  text = text.replace(/file:\/\/\S+/gi, "a file");

  // Windows filesystem paths
  text = text.replace(/\b[a-zA-Z]:[\\/][^\s:,]+/g, "a file");

  // Absolute Unix filesystem paths (e.g. /Users/amber/secret/file.ts)
  text = text.replace(/(?:~|\/)[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+(?::\d+(?::\d+)?)?/g, "a file");

  // Relative filesystem paths with slashes or code extensions, exempting simple conjunctions
  text = text.replace(/(?:\.{1,2}\/)[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+(?::\d+(?::\d+)?)?/g, "a file");
  text = text.replace(/\b(?!(?:and|or|either)\/(?:and|or|either)\b)[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\b/g, "a file");
  text = text.replace(/\b[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|json|py|sh|sql|db|sqlite|log|env|yml|yaml|pem|key|crt)\b/gi, "a file");

  // Authentication tokens, hashes, and identifiers
  /**
   * The same two holes that were found in the other sanitiser, in this one.
   *
   * A Telegram bot token is 6 to 19 digits, and it appears in an API URL as
   * `bot<token>` — where a leading word boundary can never match, because "t"
   * and "1" are both word characters. And GitHub's own tokens use an
   * underscore, not a hyphen, after their prefix. Two sanitisers drifting apart
   * is exactly why there should not be two.
   */
  text = text.replace(/(?:bot)?\d{6,19}:[A-Za-z0-9_-]{30,60}/g, "a token");
  text = text.replace(/\b(?:sk|ghp|gho|ghu|ghs|glpat|xoxb|xoxp)[-_][a-zA-Z0-9_=-]{16,}\b/gi, "a token");
  text = text.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "an identifier");
  text = text.replace(/\b0x[0-9a-fA-F]{8,}\b/g, "an identifier");
  text = text.replace(/\b[0-9a-fA-F]{16,}\b/g, "an identifier");
  text = text.replace(/\b(?:chat[_-]?id|chatId)[:=\s]+-?\d+\b/gi, "chat");
  text = text.replace(/\b[a-zA-Z0-9_-]{20,}\b/g, "an identifier");

  // Implementation names forbidden by style rules
  text = text.replace(/\bduckdb\b/gi, "the database");
  text = text.replace(/\bsqlite\b/gi, "the database");
  text = text.replace(/\btypst\b/gi, "the document engine");
  text = text.replace(/\bhmac\b/gi, "the security check");
  text = text.replace(/\bvector(?:\s+database|\s+search|\s+store)?\b/gi, "search");
  text = text.replace(/\bagent\s+loop\b/gi, "the run");
  text = text.replace(/\bhermes\b/gi, "the assistant");
  text = text.replace(/\belectron\b/gi, "the desktop app");

  /**
   * Collapse what redaction itself produced.
   *
   * A stack frame is a path inside brackets right after the path that threw, so
   * redacting both gave "accessing a file (a file)." — which reads like a bug in
   * the app rather than a file it could not open. The same doubling happens for
   * a token or an identifier repeated across a frame. Fold a bracketed
   * placeholder into the one before it, then fold any adjacent repeat.
   */
  const placeholder = "(?:a file|a token|an identifier)";
  text = text.replace(new RegExp(`(${placeholder})\\s*\\(\\1\\)`, "g"), "$1");
  text = text.replace(new RegExp(`(${placeholder})(?:[\\s,]+\\1\\b)+`, "g"), "$1");
  // A frame that lost its path leaves "at <name>" behind with nothing to point at.
  text = text.replace(new RegExp(`\\s+at\\s+[A-Za-z0-9_.$<>]+\\s*(?=${placeholder}|$|[.,])`, "g"), " ");

  // Strip emojis, exclamation marks, and normalize whitespace
  text = text.replace(/!+/g, ".");
  text = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
  text = text.replace(/[\r\n\t]+/g, " ");
  text = text.replace(/\s{2,}/g, " ");

  return text.trim();
}

/** Quotes at most 120 characters on a word boundary with an ellipsis. */
function truncateRequest(request: string): string {
  const sanitized = sanitizeText(request);
  if (!sanitized) {
    return "";
  }
  if (sanitized.length <= 120) {
    return sanitized;
  }

  const sub = sanitized.slice(0, 117);
  const lastSpace = sub.lastIndexOf(" ");
  const atBoundary = lastSpace > 20 ? sub.slice(0, lastSpace) : sub;
  const cleaned = atBoundary.replace(/[\s,.;:-]+$/, "");
  return `${cleaned}...`;
}

function truncateReason(reason: string, maxLen = 140): string {
  const sanitized = sanitizeText(reason);
  if (!sanitized) {
    return "";
  }
  if (sanitized.length <= maxLen) {
    return sanitized;
  }
  const sub = sanitized.slice(0, maxLen - 3);
  const lastSpace = sub.lastIndexOf(" ");
  const atBoundary = lastSpace > 20 ? sub.slice(0, lastSpace) : sub;
  const cleaned = atBoundary.replace(/[\s,.;:-]+$/, "");
  return `${cleaned}...`;
}

/** Guarantees the message is calm, strictly under 600 characters, and contains no exclamation marks. */
function enforceMessageLimits(msg: string): string {
  let clean = msg.replace(/!+/g, ".");
  clean = clean.replace(/(?<!\.)\.\.(?!\.)/g, ".");
  clean = clean.replace(/\s{2,}/g, " ").trim();

  if (clean.length <= 585) {
    return clean;
  }

  const slice = clean.slice(0, 580);
  const lastSpace = slice.lastIndexOf(" ");
  const atBoundary = lastSpace > 200 ? slice.slice(0, lastSpace) : slice;
  return `${atBoundary.replace(/[\s,.;:-]+$/, "")}...`;
}

export function crewMessage(event: CrewEvent, now: number): string {
  void now;

  switch (event.kind) {
    case "staged": {
      const seats = formatSeats(event.seatLabels);
      const quoted = truncateRequest(event.request);
      let intro = "A plan is staged";
      if (seats && quoted) {
        intro = `A plan for ${seats} is staged: "${quoted}"`;
      } else if (seats) {
        intro = `A plan for ${seats} is staged`;
      } else if (quoted) {
        intro = `A plan is staged: "${quoted}"`;
      }
      return enforceMessageLimits(`${intro}. Nothing has been sent yet, and you review it on your Mac.`);
    }

    case "started": {
      const seats = formatSeats(event.seatLabels);
      if (event.partCount <= 0) {
        return enforceMessageLimits(seats ? `Work has started with ${seats}.` : "Work has started.");
      }
      if (event.partCount === 1) {
        return enforceMessageLimits(
          seats ? `Work has started on one part with ${seats}.` : "Work has started on one part."
        );
      }
      const partsText = formatPartsCount(event.partCount);
      return enforceMessageLimits(
        seats ? `Work has started in ${partsText} with ${seats}.` : `Work has started in ${partsText}.`
      );
    }

    case "part-done": {
      const seat = sanitizeText(event.seatLabel);
      const title = sanitizeText(event.partTitle);
      const wordsText = event.words === 1 ? "one word" : `${formatNumber(event.words)} words`;

      if (seat && title) {
        return enforceMessageLimits(`${seat} finished ${title} (${wordsText}).`);
      }
      if (seat) {
        return enforceMessageLimits(`${seat} finished their part (${wordsText}).`);
      }
      if (title) {
        return enforceMessageLimits(`${title} is finished (${wordsText}).`);
      }
      return enforceMessageLimits(`One part is finished (${wordsText}).`);
    }

    case "needs-you": {
      const what = sanitizeText(event.what);
      if (what) {
        return enforceMessageLimits(`Waiting on your Mac: ${what}. Approvals cannot be done from your phone.`);
      }
      return enforceMessageLimits("Action is waiting on your Mac. Approvals cannot be done from your phone.");
    }

    case "finished": {
      let subject: string;
      if (event.partCount === 2) {
        subject = "Both finished.";
      } else if (event.partCount === 1) {
        subject = "One part finished.";
      } else if (event.partCount === 0) {
        subject = "Finished.";
      } else {
        subject = `All ${formatNumber(event.partCount)} finished.`;
      }

      let agreedText: string;
      if (event.agreed === 0) {
        agreedText = "They agreed on none";
      } else if (event.agreed === 1) {
        agreedText = "They agreed on 1 point";
      } else {
        agreedText = `They agreed on ${event.agreed} points`;
      }

      let contestedText: string;
      if (event.contested === 0) {
        contestedText = "differ on none";
      } else if (event.contested === 1) {
        contestedText = "differ on 1";
      } else {
        contestedText = `differ on ${event.contested}`;
      }

      return enforceMessageLimits(`${subject} ${agreedText} and ${contestedText}.`);
    }

    case "failed": {
      const title = sanitizeText(event.partTitle);
      const reason = truncateReason(event.reason);
      const subject = title || "Work";
      if (reason) {
        const body = reason.endsWith(".") ? reason.slice(0, -1) : reason;
        return enforceMessageLimits(`${subject} failed: ${body}.`);
      }
      return enforceMessageLimits(`${subject} failed.`);
    }

    case "stopped": {
      if (event.partCount <= 0) {
        return enforceMessageLimits("Work was stopped.");
      }
      if (event.partCount === 1) {
        return enforceMessageLimits("Work was stopped on one part.");
      }
      const partsText = formatPartsCount(event.partCount);
      return enforceMessageLimits(`Work was stopped across ${partsText}.`);
    }

    case "refused": {
      const reason = truncateReason(event.reason);
      if (reason) {
        const body = reason.endsWith(".") ? reason.slice(0, -1) : reason;
        return enforceMessageLimits(`Request refused: ${body}.`);
      }
      return enforceMessageLimits("Request refused.");
    }
  }
}

/** Everything the phone may be told about a run, in order, for a "catch me up". */
export function crewDigest(events: readonly CrewEvent[], now: number): string {
  if (events.length === 0) {
    return "Nothing has happened yet.";
  }

  const messages = events.map((event) => crewMessage(event, now));
  const combined = messages.join("\n");

  if (combined.length <= 580) {
    return combined;
  }

  const first = messages[0]!;
  const recent: string[] = [];
  let currentLen = first.length + 5;

  for (let i = messages.length - 1; i >= 1; i--) {
    const msg = messages[i]!;
    if (currentLen + msg.length + 1 > 570) {
      break;
    }
    recent.unshift(msg);
    currentLen += msg.length + 1;
  }

  return enforceMessageLimits([first, "...", ...recent].join("\n"));
}
