export type ActionId =
  | "new-work"
  | "run-routine"
  | "switch-ai"
  | "add-file"
  | "capture-screen"
  | "export-output"
  | "open-folder"
  | "check-citations"
  | "stop-session"
  | "new-in-project"
  | "show-record";

export interface ActionContext {
  readonly hasOpenWork: boolean;
  readonly workClosed: boolean;
  readonly hasOutput: boolean;
  readonly hasSources: boolean;
  readonly sessionRunning: boolean;
  readonly inProject: boolean;
  readonly providersDetected: number;
}

export interface QuickAction {
  readonly id: ActionId;
  readonly title: string;
  readonly hint: string;
  readonly keywords: readonly string[];
  /** Null when it can run. A sentence when it cannot, so the row explains itself. */
  readonly disabledBecause: string | null;
}

const DEFAULT_ACTION_ORDER: readonly ActionId[] = [
  "new-work",
  "new-in-project",
  "run-routine",
  "switch-ai",
  "add-file",
  "capture-screen",
  "export-output",
  "check-citations",
  "show-record",
  "open-folder",
  "stop-session"
];

function defaultActionPriority(id: ActionId): number {
  const index = DEFAULT_ACTION_ORDER.indexOf(id);
  return index >= 0 ? index : DEFAULT_ACTION_ORDER.length;
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/gu, " ");
}

const RANK_EXACT = 1;
const RANK_PREFIX = 2;
const RANK_SUBSTRING = 3;
const RANK_KEYWORD = 4;

function calculateMatchRank(
  action: QuickAction,
  normalizedQuery: string,
  queryWords: readonly string[]
): number | null {
  const normalizedTitle = normalizeText(action.title);

  if (normalizedTitle === normalizedQuery) {
    return RANK_EXACT;
  }
  if (normalizedTitle.startsWith(normalizedQuery)) {
    return RANK_PREFIX;
  }
  if (normalizedTitle.includes(normalizedQuery)) {
    return RANK_SUBSTRING;
  }

  for (const keyword of action.keywords) {
    const normalizedKeyword = normalizeText(keyword);
    if (normalizedKeyword.length === 0) {
      continue;
    }
    // Allow user to match keywords by typing substrings or prefix tokens
    if (normalizedKeyword.includes(normalizedQuery)) {
      return RANK_KEYWORD;
    }
    // Allow multi-word queries to match multi-word keywords
    if (normalizedKeyword.includes(" ") && normalizedQuery.includes(normalizedKeyword)) {
      return RANK_KEYWORD;
    }
    // Allow multi-word queries containing a keyword word directly
    if (queryWords.includes(normalizedKeyword)) {
      return RANK_KEYWORD;
    }
  }

  return null;
}

export function availableActions(context: ActionContext): readonly QuickAction[] {
  // Disabled states teach the owner what prerequisite is missing instead of hiding capabilities
  const stopSessionDisabled = !context.sessionRunning
    ? "You do not have a session running right now."
    : null;

  const exportOutputDisabled = !context.hasOutput
    ? "Generate an output first."
    : null;

  let checkCitationsDisabled: string | null = null;
  if (!context.hasOutput && !context.hasSources) {
    checkCitationsDisabled = "Generate an output and attach sources first.";
  } else if (!context.hasOutput) {
    checkCitationsDisabled = "Generate an output first.";
  } else if (!context.hasSources) {
    checkCitationsDisabled = "Attach sources first.";
  }

  const openWorkDisabled = !context.hasOpenWork
    ? "Open a piece of work first."
    : context.workClosed
      ? "Reopen this piece of work first."
      : null;

  const newInProjectDisabled = !context.inProject
    ? "Open a project first."
    : null;

  const switchAiDisabled = context.providersDetected < 1
    ? "Connect at least one AI provider first."
    : null;

  return [
    {
      id: "new-work",
      title: "New work",
      hint: "Start a fresh piece of work",
      keywords: ["new", "work", "create", "start", "blank", "fresh", "draft", "task", "case"],
      disabledBecause: null
    },
    {
      id: "new-in-project",
      title: "New work in project",
      hint: "Start a new piece of work inside this project",
      keywords: ["project", "inside", "create", "case", "subtask"],
      disabledBecause: newInProjectDisabled
    },
    {
      id: "run-routine",
      title: "Run routine",
      hint: "Start a saved routine on your work",
      keywords: ["routine", "run", "play", "automate", "recipe", "workflow", "prompt", "script", "hermes"],
      disabledBecause: null
    },
    {
      id: "switch-ai",
      title: "Switch AI",
      hint: "Choose a different model or provider",
      keywords: ["switch", "model", "claude", "codex", "gemini", "change", "provider", "llm", "qwen", "subscription"],
      disabledBecause: switchAiDisabled
    },
    {
      id: "add-file",
      title: "Add file",
      hint: "Attach files and documents to your work",
      keywords: ["add", "file", "pdf", "attach", "document", "upload", "import", "source", "text", "context"],
      disabledBecause: openWorkDisabled
    },
    {
      id: "capture-screen",
      title: "Capture screen",
      hint: "Take a screenshot and attach it to your work",
      keywords: ["capture", "screen", "screenshot", "grab", "snip", "image", "snap", "window", "display"],
      disabledBecause: openWorkDisabled
    },
    {
      id: "export-output",
      title: "Export output",
      hint: "Save or send the output to your Mac",
      keywords: ["export", "output", "word", "docx", "send", "save", "download", "markdown", "share", "copy"],
      disabledBecause: exportOutputDisabled
    },
    {
      id: "check-citations",
      title: "Check citations",
      hint: "Verify output statements against your sources",
      keywords: ["check", "citations", "cite", "verify", "sources", "evidence", "factcheck", "proof", "references"],
      disabledBecause: checkCitationsDisabled
    },
    {
      id: "show-record",
      title: "Show record",
      hint: "Inspect the review and approval log for this work",
      keywords: ["record", "log", "audit", "history", "review", "approval", "hash", "evidence", "provenance", "activity"],
      disabledBecause: null
    },
    {
      id: "open-folder",
      title: "Open folder",
      hint: "Reveal files for this work in Finder",
      keywords: ["open", "folder", "finder", "directory", "files", "reveal", "path", "browse"],
      disabledBecause: null
    },
    {
      id: "stop-session",
      title: "Stop session",
      hint: "Halt the running AI session and keep partial work",
      keywords: ["stop", "session", "cancel", "halt", "abort", "kill", "interrupt", "terminate", "pause"],
      disabledBecause: stopSessionDisabled
    }
  ];
}

export function matchActions(
  actions: readonly QuickAction[],
  query: string
): readonly QuickAction[] {
  const normalizedQuery = normalizeText(query);

  // An empty query exposes every action, prioritising those that are actionable right now
  if (normalizedQuery.length === 0) {
    return [...actions].sort((a, b) => {
      const aDisabled = a.disabledBecause !== null ? 1 : 0;
      const bDisabled = b.disabledBecause !== null ? 1 : 0;
      if (aDisabled !== bDisabled) {
        return aDisabled - bDisabled;
      }
      const aPriority = defaultActionPriority(a.id);
      const bPriority = defaultActionPriority(b.id);
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      return a.id.localeCompare(b.id);
    });
  }

  const queryWords = normalizedQuery.split(" ").filter((w) => w.length > 0);
  const matches: { readonly action: QuickAction; readonly rank: number }[] = [];

  for (const action of actions) {
    const rank = calculateMatchRank(action, normalizedQuery, queryWords);
    if (rank !== null) {
      matches.push({ action, rank });
    }
  }

  // Exact matches take precedence, followed by prefix, substring, and keyword hits
  matches.sort((a, b) => {
    if (a.rank !== b.rank) {
      return a.rank - b.rank;
    }
    const aDisabled = a.action.disabledBecause !== null ? 1 : 0;
    const bDisabled = b.action.disabledBecause !== null ? 1 : 0;
    if (aDisabled !== bDisabled) {
      return aDisabled - bDisabled;
    }
    // Deliberately NOT by default priority. That ordering is for the empty
    // query, where there is nothing else to go on. Once somebody has typed,
    // letting an unrelated-but-popular action outrank an equally good match
    // for what they actually typed is the wrong answer; id keeps it stable.
    return a.action.id.localeCompare(b.action.id);
  });

  return matches.map((m) => m.action);
}
