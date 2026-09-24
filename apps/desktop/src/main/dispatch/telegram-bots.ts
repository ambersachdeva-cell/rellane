/**
 * Telegram bots and their required inputs.
 *
 * Amber wants distinct, capable bots on his phone rather than a general-purpose
 * box that guesses poorly. Each bot here defines its specific job, its cost
 * footprint in subscription calls, and what input it needs before it can run.
 */

export type BotId = "research" | "catch-up" | "check-this" | "draft" | "second-opinion";

export interface BotNeeds {
  readonly wants: "a question" | "nothing" | "an address or a file" | "a thing to write" | "something you already have";
  readonly askFor: string;
}

export interface Bot {
  readonly id: BotId;
  readonly name: string;
  readonly line: string;
  readonly needs: BotNeeds;
  readonly usesSubscriptions: number;
  readonly slow: boolean;
}

export const BOTS: readonly Bot[] = [
  {
    id: "research",
    name: "Research",
    line: "Finds answers by reading across the web and checking sources.",
    needs: {
      wants: "a question",
      askFor: "Send your question and I will look into it."
    },
    usesSubscriptions: 3,
    slow: true
  },
  {
    id: "catch-up",
    name: "Catch up",
    line: "Shows what changed across your work since you last looked.",
    needs: {
      wants: "nothing",
      askFor: "Nothing is needed to catch you up."
    },
    usesSubscriptions: 1,
    slow: false
  },
  {
    id: "check-this",
    name: "Check this",
    line: "Reads a link or file and tells you what matters in it.",
    needs: {
      wants: "an address or a file",
      askFor: "Send me the address and I will read it."
    },
    usesSubscriptions: 1,
    slow: false
  },
  {
    id: "draft",
    name: "Draft",
    line: "Writes what you need using what is already in your work.",
    needs: {
      wants: "a thing to write",
      askFor: "Tell me what to write and I will draft it for you."
    },
    usesSubscriptions: 1,
    slow: false
  },
  {
    id: "second-opinion",
    name: "Second opinion",
    line: "Challenges the last answer with a second independent view.",
    needs: {
      wants: "something you already have",
      askFor: "Send me the answer you want reviewed and I will challenge it."
    },
    usesSubscriptions: 2,
    slow: false
  }
];

const BOT_MAP: ReadonlyMap<BotId, Bot> = new Map(
  BOTS.map((bot) => [bot.id, bot])
);

function findBot(id: BotId): Bot {
  const bot = BOT_MAP.get(id);
  if (!bot) {
    throw new Error(`Bot not configured: ${id}`);
  }
  return bot;
}

/**
 * Verifies whether text represents a single standalone URL rather than prose.
 */
function isBareUrl(text: string): boolean {
  if (/\s/.test(text)) {
    return false;
  }
  const clean = text.replace(/^<|>$/g, "");
  if (/^https?:\/\/\S+$/i.test(clean)) {
    try {
      const parsed = new URL(clean);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  if (/^www\.\S+\.[a-z]{2,}(?:\/\S*)?$/i.test(clean)) {
    try {
      const parsed = new URL(`https://${clean}`);
      return parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Checks whether incoming text includes an address, file path, or document.
 */
/**
 * Strips a leading slash command, and only that. The lookahead matters: a real
 * path like "/Users/amber/report.pdf" has no space after its first segment, so
 * it is left alone.
 */
function withoutLeadingCommand(text: string): string {
  return text.replace(/^\s*\/[A-Za-z][A-Za-z0-9_-]*(?:@[A-Za-z0-9_]+)?(?=\s|$)/, "");
}

function hasAddressOrFile(text: string): boolean {
  if (/https?:\/\/\S+/i.test(text) || /\bwww\.\S+/i.test(text)) {
    return true;
  }
  if (/\b\S+\.(pdf|docx?|xlsx?|csv|tsv|json|txt|md|png|jpg|jpeg|webp|html?)\b/i.test(text)) {
    return true;
  }
  if (/(?:^|\s)(?:\/|~\/|\.\/)\S+/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * Resolves an inbound Telegram message to a designated bot.
 *
 * Mapping is strictly deterministic. Explicit slash commands are honoured first,
 * followed by unambiguous message shapes (bare links, question length, fixed
 * trigger phrases). Anything unclear returns null so the caller displays buttons
 * instead of guessing.
 */
export function botFor(text: string): Bot | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith("/")) {
    const match = /^\/([a-z0-9_-]+)(?:@\w+)?(?:\s+.*)?$/i.exec(trimmed);
    if (match && match[1]) {
      const command = match[1].toLowerCase();
      switch (command) {
        case "research":
          return findBot("research");
        case "catch-up":
        case "catchup":
        case "catch_up":
          return findBot("catch-up");
        case "check-this":
        case "checkthis":
        case "check_this":
        case "check":
          return findBot("check-this");
        case "draft":
          return findBot("draft");
        case "second-opinion":
        case "secondopinion":
        case "second_opinion":
          return findBot("second-opinion");
        default:
          return null;
      }
    }
  }

  const lower = trimmed.toLowerCase();

  if (isBareUrl(trimmed)) {
    return findBot("check-this");
  }

  if (
    lower.includes("are you sure") ||
    lower.includes("check that") ||
    lower.includes("second opinion")
  ) {
    return findBot("second-opinion");
  }

  if (
    lower.includes("what's new") ||
    lower.includes("whats new") ||
    lower.includes("what is new") ||
    lower.includes("catch me up") ||
    lower === "catch up"
  ) {
    return findBot("catch-up");
  }

  if (
    lower.startsWith("write me") ||
    lower.startsWith("draft") ||
    lower === "draft" ||
    /\bwrite me\b/i.test(lower)
  ) {
    return findBot("draft");
  }

  if (lower.startsWith("check this") || lower === "check") {
    return findBot("check-this");
  }

  if (trimmed.includes("?")) {
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length > 6) {
      return findBot("research");
    }
  }

  return null;
}

/**
 * Determines whether the chosen bot lacks the input it needs to proceed.
 *
 * Returns null when the bot can proceed immediately, or the plain sentence
 * asking for the missing input.
 */
export function whatIsMissing(bot: Bot, text: string): string | null {
  switch (bot.needs.wants) {
    case "nothing":
      return null;

    case "an address or a file": {
      /**
       * The command has to come off first. "/check-this" is indistinguishable
       * from an absolute path to the file matcher below, so a bare command was
       * read as its own argument and the bot went off to read a file called
       * "/check-this" instead of asking for the address.
       */
      if (hasAddressOrFile(withoutLeadingCommand(text))) {
        return null;
      }
      return bot.needs.askFor;
    }

    case "a question": {
      const stripped = text
        .replace(/^\/research(?:@\w+)?/i, "")
        .trim();
      if (stripped.length > 0) {
        return null;
      }
      return bot.needs.askFor;
    }

    case "a thing to write": {
      const stripped = text
        .replace(/^\/draft(?:@\w+)?/i, "")
        .replace(/^\s*(?:write\s+me|draft)\b/i, "")
        .trim();
      if (stripped.length > 0) {
        return null;
      }
      return bot.needs.askFor;
    }

    case "something you already have": {
      if (text.trim().length > 0) {
        return null;
      }
      return bot.needs.askFor;
    }
  }
}
