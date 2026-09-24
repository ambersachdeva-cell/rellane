export type StarterId =
  | "ask"
  | "watch-it-work"
  | "send-to-several"
  | "read-my-files"
  | "ask-a-spreadsheet"
  | "make-an-image"
  | "publish"
  | "continue-on-phone"
  | "routine";

export interface StarterContext {
  readonly providersDetected: number;
  readonly hasSources: boolean;
  readonly hasTabularSource: boolean;
  readonly hasOutput: boolean;
  readonly localModelReady: boolean;
  readonly pairingAvailable: boolean;
  readonly savedRoutines: readonly {
    readonly id: string;
    readonly title: string;
    readonly description: string;
  }[];
  readonly now: number;
}

export interface Starter {
  readonly id: StarterId;
  readonly routineId?: string;
  readonly title: string;
  readonly line: string;
  readonly icon:
    | "chat"
    | "spark"
    | "grid"
    | "file"
    | "folder"
    | "image"
    | "export"
    | "device"
    | "search";
  readonly available: boolean;
  readonly unavailableBecause: string | null;
}

export const BANNED_WORDS = [
  "DuckDB",
  "SQL",
  "Typst",
  "Hermes",
  "vector",
  "embedding",
  "recursive",
  "LLM",
  "agent",
  "token",
  "API",
] as const;

export function hasBannedWord(text: string): boolean {
  const lower = text.toLowerCase();
  for (const banned of BANNED_WORDS) {
    const bLower = banned.toLowerCase();
    // Match as a whole word or common inflection to protect against implementation jargon
    const pattern = new RegExp(`\\b${bLower}(?:s|es)?\\b`, "i");
    if (pattern.test(lower)) {
      return true;
    }
  }
  return false;
}

function formatRoutineTitle(rawTitle: string): string {
  const clean = rawTitle.replace(/[^\w\s-]/g, " ").trim();
  if (clean.length === 0 || hasBannedWord(clean)) {
    return "Run saved routine";
  }

  const words = clean.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) {
    return "Run saved routine";
  }

  // Enforce title length rules: exactly 2 to 4 words and under 24 characters
  if (words.length === 1) {
    const candidate = `${words[0]!} routine`;
    if (candidate.length < 24 && !hasBannedWord(candidate)) {
      return candidate;
    }
    return "Run saved routine";
  }

  if (words.length >= 2 && words.length <= 4 && clean.length < 24) {
    return clean;
  }

  for (const count of [4, 3, 2] as const) {
    if (words.length >= count) {
      const slice = words.slice(0, count).join(" ");
      if (slice.length < 24 && !hasBannedWord(slice)) {
        return slice;
      }
    }
  }

  return "Run saved routine";
}

function formatRoutineLine(rawDescription: string): string {
  const clean = rawDescription.replace(/[!—]/g, " ").trim();
  if (clean.length === 0 || hasBannedWord(clean)) {
    return "Run your saved routine in one click.";
  }

  const formatted = clean.endsWith(".") ? clean : `${clean}.`;
  if (formatted.length < 60 && !hasBannedWord(formatted)) {
    return formatted;
  }

  return "Run your saved routine in one click.";
}

function createStarter(
  id: StarterId,
  title: string,
  line: string,
  icon: Starter["icon"],
  available: boolean,
  unavailableBecause: string | null,
  routineId?: string
): Starter {
  // exactOptionalPropertyTypes requires routineId to be completely absent when undefined
  if (routineId !== undefined) {
    return {
      id,
      routineId,
      title,
      line,
      icon,
      available,
      unavailableBecause,
    };
  }
  return {
    id,
    title,
    line,
    icon,
    available,
    unavailableBecause,
  };
}

interface ScoredStarter {
  readonly starter: Starter;
  readonly score: number;
}

export function homeStarters(context: StarterContext): readonly Starter[] {
  const hasModel = context.providersDetected > 0 || context.localModelReady;
  const candidates: ScoredStarter[] = [];

  // A saved routine becomes a starter with its own title, and at most one appears
  if (context.savedRoutines.length > 0) {
    const routine = context.savedRoutines[0]!;
    const title = formatRoutineTitle(routine.title);
    const line = formatRoutineLine(routine.description);
    const available = hasModel;
    const unavailableBecause = available
      ? null
      : "Connect a subscription to begin.";

    candidates.push({
      starter: createStarter(
        "routine",
        title,
        line,
        "spark",
        available,
        unavailableBecause,
        routine.id
      ),
      score: available ? 82 : 15,
    });
  }

  // Dispatch board: compare answers across multiple subscriptions
  const sendAvailable = context.providersDetected >= 2;
  const sendUnavailableReason = sendAvailable
    ? null
    : "Connect two subscriptions to compare.";
  candidates.push({
    starter: createStarter(
      "send-to-several",
      "Send to several",
      "Compare answers across your subscriptions.",
      "grid",
      sendAvailable,
      sendUnavailableReason
    ),
    score: sendAvailable ? 100 : context.providersDetected === 1 ? 25 : 10,
  });

  // Spreadsheet questions and charts
  const sheetAvailable = context.hasTabularSource;
  const sheetUnavailableReason = sheetAvailable
    ? null
    : "Add a spreadsheet first.";
  candidates.push({
    starter: createStarter(
      "ask-a-spreadsheet",
      "Ask a spreadsheet",
      "Ask questions of a sheet and chart answers.",
      "grid",
      sheetAvailable,
      sheetUnavailableReason
    ),
    score: sheetAvailable ? 95 : 28,
  });

  // Read files and add local notes or documents to the case
  candidates.push({
    starter: createStarter(
      "read-my-files",
      "Read my files",
      "Add documents and notes to your case.",
      "folder",
      true,
      null
    ),
    score: context.hasSources ? 40 : 90,
  });

  // Multi-step assistant with visible steps
  const watchAvailable = hasModel;
  const watchUnavailableReason = watchAvailable
    ? null
    : "Connect a subscription to begin.";
  candidates.push({
    starter: createStarter(
      "watch-it-work",
      "Watch it work",
      "Follow each step as work gets done.",
      "spark",
      watchAvailable,
      watchUnavailableReason
    ),
    score: watchAvailable ? 75 : 22,
  });

  // Standard direct conversation
  const askAvailable = hasModel;
  const askUnavailableReason = askAvailable
    ? null
    : "Connect a subscription to begin.";
  candidates.push({
    starter: createStarter(
      "ask",
      "Ask a question",
      "Get a direct answer to your question.",
      "chat",
      askAvailable,
      askUnavailableReason
    ),
    score: askAvailable ? 70 : 20,
  });

  // Output export: only offered when an output is actually present to share
  if (context.hasOutput) {
    candidates.push({
      starter: createStarter(
        "publish",
        "Publish your work",
        "Format and share your saved output.",
        "export",
        true,
        null
      ),
      score: 88,
    });
  }

  // Phone pairing: only offered when pairing is observed as available
  if (context.pairingAvailable) {
    candidates.push({
      starter: createStarter(
        "continue-on-phone",
        "Continue on phone",
        "Pick up your case on your phone.",
        "device",
        true,
        null
      ),
      score: 55,
    });
  }

  // Creative image generation
  const imageAvailable = hasModel;
  const imageUnavailableReason = imageAvailable
    ? null
    : "Connect a subscription to begin.";
  candidates.push({
    starter: createStarter(
      "make-an-image",
      "Make an image",
      "Create pictures from your description.",
      "image",
      imageAvailable,
      imageUnavailableReason
    ),
    score: imageAvailable ? 45 : 12,
  });

  // Sort by earned priority
  candidates.sort((a, b) => b.score - a.score);

  // Return at most 6, most useful first, and never more than 2 unavailable ones
  const selected: Starter[] = [];
  let unavailableCount = 0;

  for (const item of candidates) {
    if (selected.length >= 6) {
      break;
    }
    if (!item.starter.available) {
      if (unavailableCount >= 2) {
        continue;
      }
      unavailableCount++;
    }
    selected.push(item.starter);
  }

  return selected;
}
