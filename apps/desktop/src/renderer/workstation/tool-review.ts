/** What turning tools on actually widens, summarised for review before any token is spent. */

export interface ReviewToolsLike {
  readonly enabled: boolean;
  readonly toolNames: readonly string[];
  readonly skillIds: readonly string[];
  readonly sources: readonly { readonly label: string; readonly chars: number }[];
  readonly totalSourceChars: number;
  readonly reachNote: string;
  readonly freshSessionNote: string;
}

export interface ToolReviewRow {
  readonly label: string;
  readonly detail: string;
}

export interface ToolReviewSummary {
  readonly sessionLine: string;
  readonly heading: string;
  readonly reachLine: string;
  readonly sourceRows: readonly ToolReviewRow[];
  readonly toolRows: readonly ToolReviewRow[];
  readonly skillNames: readonly string[];
  readonly totalLine: string;
}

const KNOWN_TOOLS: Readonly<Record<string, ToolReviewRow>> = {
  rellane_list_sources: {
    label: "List your sources",
    detail: "Names the sources you selected and how long each one is.",
  },
  rellane_read_source: {
    label: "Read a source",
    detail: "Reads one selected source, a page at a time.",
  },
  hermes_list_skills: {
    label: "List bundled procedures",
    detail: "Names the procedures bundled with this app.",
  },
  hermes_read_skill: {
    label: "Read a bundled procedure",
    detail: "Reads one procedure bundled with this app.",
  },
  hermes_check_citations: {
    label: "Check citations",
    detail: "Checks a draft's citations against your selected sources.",
  },
};

function formatSkillName(skillId: string): string {
  const lastSlash = skillId.lastIndexOf("/");
  const segment = lastSlash >= 0 ? skillId.slice(lastSlash + 1) : skillId;
  const withSpaces = segment.replace(/[-_]+/g, " ").trim();
  if (withSpaces.length === 0) return "";
  return withSpaces
    .split(/\s+/)
    .map((word) => {
      const first = word.charAt(0);
      return first ? first.toUpperCase() + word.slice(1) : "";
    })
    .join(" ");
}

/**
 * Summarises native tool review details. Returns null when tools are disabled.
 * The model can call back during the turn to read selected sources page by page in full,
 * and starts a new native session, so this review describes those consequences clearly.
 */
export function summariseToolReview(tools: ReviewToolsLike): ToolReviewSummary | null {
  if (!tools.enabled) {
    return null;
  }

  const toolCount = tools.toolNames.length;
  const heading =
    toolCount === 0
      ? "No tools will be available for this session"
      : `${toolCount} ${toolCount === 1 ? "tool" : "tools"} for this session`;

  const trimmedReach = tools.reachNote.trim();
  const reachLine =
    trimmedReach.length > 0
      ? trimmedReach
      : "The selected sources below become readable in full during this session, beyond the excerpt in the request.";

  const trimmedSession = tools.freshSessionNote.trim();
  const sessionLine =
    trimmedSession.length > 0
      ? trimmedSession
      : "This starts a new native session rather than continuing a saved one.";

  const sourceRows: ToolReviewRow[] = tools.sources.map((source) => {
    const trimmed = source.label.trim();
    return {
      label: trimmed.length > 0 ? trimmed : "Untitled source",
      detail:
        source.chars === 1
          ? "1 character"
          : `${source.chars.toLocaleString("en-GB")} characters`,
    };
  });

  const toolRows: ToolReviewRow[] = tools.toolNames.map((name) => {
    const known = KNOWN_TOOLS[name];
    if (known !== undefined) {
      return known;
    }
    return {
      label: name,
      detail: "This version of Rellane does not recognise this tool.",
    };
  });

  const skillNames: string[] = tools.skillIds.map(formatSkillName);

  let totalLine: string;
  if (tools.sources.length === 0) {
    totalLine = "no sources selected";
  } else {
    const sourceCount = tools.sources.length;
    const sourceWord = sourceCount === 1 ? "source" : "sources";
    const formattedChars = tools.totalSourceChars.toLocaleString("en-GB");
    const charWord = tools.totalSourceChars === 1 ? "character" : "characters";
    totalLine = `${formattedChars} ${charWord} across ${sourceCount.toLocaleString("en-GB")} ${sourceWord}`;
  }

  return {
    sessionLine,
    heading,
    reachLine,
    sourceRows,
    toolRows,
    skillNames,
    totalLine,
  };
}
