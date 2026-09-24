/** One part of a split request, and who is taking it. */
export interface CrewPart {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly seatId: string;
  readonly seatLabel: string;
  readonly dependsOn: readonly string[];
}

export type CrewPartState = "waiting" | "claimed" | "working" | "answered" | "refining" | "done" | "failed" | "stopped";

export interface CrewPartView {
  readonly id: string;
  readonly title: string;
  readonly seatLabel: string;
  readonly state: CrewPartState;
  readonly line: string;
  readonly elapsed: string;
  readonly answerTurnId: string | null;
  readonly refinedFrom: readonly string[];
  readonly canStop: boolean;
}

export interface CrewRunView {
  readonly runId: string;
  readonly caseId: string;
  readonly request: string;
  readonly parts: readonly CrewPartView[];
  readonly round: "splitting" | "working" | "reading-each-other" | "done" | "stopped" | "failed";
  readonly headline: string;
  readonly canStop: boolean;
}

/** What one seat learned, written back so the next round starts with it. */
export interface CrewNote {
  readonly partId: string;
  readonly seatLabel: string;
  readonly finding: string;
  readonly confidence: "stated" | "inferred" | "uncertain";
  readonly at: number;
}

export interface AgentSource {
  readonly id: string;
  readonly origin: "bundled" | "mine";
  readonly markdown: string;
  readonly updatedAt: number;
}

export interface Agent {
  readonly id: string;
  readonly origin: "bundled" | "mine";
  readonly name: string;
  readonly summary: string;
  readonly instructions: string;
  readonly sections: readonly { readonly heading: string; readonly body: string }[];
  readonly updatedAt: number;
  readonly warnings: readonly string[];
}

export interface AgentDraftCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly hints: readonly string[];
}

interface HeadingMatch {
  readonly level: number;
  readonly title: string;
  readonly lineIndex: number;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripFrontMatter(markdown: string): string {
  const normalized = normalizeNewlines(markdown);
  const lines = normalized.split("\n");
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") {
    start++;
  }
  if (start < lines.length && lines[start]!.trim() === "---") {
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") {
        return lines.slice(i + 1).join("\n");
      }
    }
  }
  return normalized;
}

function extractHeadings(lines: readonly string[]): readonly HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
    if (!inFence && fenceMatch && fenceMatch[2]) {
      inFence = true;
      fenceChar = fenceMatch[2][0]!;
      fenceLength = fenceMatch[2].length;
      continue;
    }
    if (inFence && fenceMatch && fenceMatch[2]) {
      if (fenceMatch[2][0] === fenceChar && fenceMatch[2].length >= fenceLength) {
        inFence = false;
        fenceChar = "";
        fenceLength = 0;
      }
      continue;
    }
    if (inFence) {
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch && headingMatch[1] && headingMatch[2] !== undefined) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].replace(/\s*#+\s*$/, "").trim();
      if (title.length > 0) {
        headings.push({ level, title, lineIndex: i });
      }
    }
  }

  return headings;
}

function formatIdAsReadable(id: string): string {
  const segments = id.split("/").filter((part) => part.length > 0);
  const lastSegment = segments.length > 0 ? segments[segments.length - 1]! : id;
  const words = lastSegment
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return id;
  }
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function extractFirstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const sentenceMatch = trimmed.match(/^([\s\S]+?[.!?])(?:\s|$)/);
  if (sentenceMatch && sentenceMatch[1] !== undefined) {
    return sentenceMatch[1].trim();
  }
  return trimmed;
}

function extractSummary(lines: readonly string[]): string {
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  const paragraphLines: string[] = [];
  let foundParagraph = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
    if (!inFence && fenceMatch && fenceMatch[2]) {
      inFence = true;
      fenceChar = fenceMatch[2][0]!;
      fenceLength = fenceMatch[2].length;
      continue;
    }
    if (inFence && fenceMatch && fenceMatch[2]) {
      if (fenceMatch[2][0] === fenceChar && fenceMatch[2].length >= fenceLength) {
        inFence = false;
        fenceChar = "";
        fenceLength = 0;
      }
      continue;
    }
    if (inFence) {
      continue;
    }

    const isHeading = /^#{1,6}\s+/.test(line);
    const trimmed = line.trim();

    if (isHeading) {
      if (foundParagraph && paragraphLines.length > 0) {
        break;
      }
      continue;
    }

    if (trimmed.length === 0) {
      if (foundParagraph && paragraphLines.length > 0) {
        break;
      }
      continue;
    }

    foundParagraph = true;
    paragraphLines.push(trimmed);
  }

  if (paragraphLines.length === 0) {
    return "";
  }

  return extractFirstSentence(paragraphLines.join(" "));
}

export function readAgent(source: AgentSource): Agent {
  const stripped = stripFrontMatter(source.markdown);
  const instructions = stripped.trim();
  const lines = normalizeNewlines(stripped).split("\n");
  const headings = extractHeadings(lines);

  const warnings: string[] = [];
  let name = "";

  if (headings.length > 0) {
    name = headings[0]!.title;
  } else {
    name = formatIdAsReadable(source.id);
    warnings.push("No heading found on the page; name was taken from the id.");
  }

  const summary = extractSummary(lines);

  const sections: { readonly heading: string; readonly body: string }[] = [];
  if (headings.length > 1) {
    const subsequentHeadings = headings.slice(1);
    let minLevel = 6;
    for (const h of subsequentHeadings) {
      if (h.level < minLevel) {
        minLevel = h.level;
      }
    }
    const sectionHeadings = subsequentHeadings.filter((h) => h.level <= minLevel);
    for (let i = 0; i < sectionHeadings.length; i++) {
      const current = sectionHeadings[i]!;
      const startLine = current.lineIndex + 1;
      const nextHeading = i + 1 < sectionHeadings.length ? sectionHeadings[i + 1] : undefined;
      const endLine = nextHeading !== undefined ? nextHeading.lineIndex : lines.length;
      const body = lines.slice(startLine, endLine).join("\n").trim();
      sections.push({
        heading: current.title,
        body,
      });
    }
  }

  return {
    id: source.id,
    origin: source.origin,
    name,
    summary,
    instructions,
    sections,
    updatedAt: source.updatedAt,
    warnings,
  };
}

export function listAgents(sources: readonly AgentSource[]): readonly Agent[] {
  const grouped = new Map<string, { mine?: Agent; bundled?: Agent }>();

  for (const source of sources) {
    const agent = readAgent(source);
    const current = grouped.get(agent.id) ?? {};
    if (agent.origin === "mine") {
      if (!current.mine || agent.updatedAt > current.mine.updatedAt) {
        grouped.set(agent.id, { ...current, mine: agent });
      }
    } else {
      if (!current.bundled || agent.updatedAt > current.bundled.updatedAt) {
        grouped.set(agent.id, { ...current, bundled: agent });
      }
    }
  }

  const resolved: Agent[] = [];
  for (const [id, entry] of grouped.entries()) {
    if (entry.mine && entry.bundled) {
      const shadowWarning = `The bundled agent with id "${id}" is shadowed.`;
      resolved.push({
        ...entry.mine,
        warnings: [...entry.mine.warnings, shadowWarning],
      });
    } else if (entry.mine) {
      resolved.push(entry.mine);
    } else if (entry.bundled) {
      resolved.push(entry.bundled);
    }
  }

  resolved.sort((a, b) => {
    if (a.origin !== b.origin) {
      return a.origin === "bundled" ? -1 : 1;
    }
    if (a.origin === "mine") {
      return b.updatedAt - a.updatedAt;
    }
    return a.name.localeCompare(b.name);
  });

  return resolved;
}

export function checkAgentDraft(markdown: string): AgentDraftCheck {
  const problems: string[] = [];
  const hints: string[] = [];

  const trimmed = markdown.trim();
  if (trimmed.length < 40) {
    problems.push("There are not enough instructions here for a bot to follow.");
  }

  if (markdown.length > 20000) {
    problems.push("This is longer than a bot will reliably follow. Try splitting it.");
  }

  const stripped = stripFrontMatter(markdown);
  const lines = normalizeNewlines(stripped).split("\n");
  const headings = extractHeadings(lines);

  if (headings.length === 0) {
    problems.push("Give it a name on the first line, starting with a #.");
  }

  if (trimmed.length >= 40) {
    const nonHeadingLines: string[] = [];
    let inFence = false;
    let fenceChar = "";
    let fenceLength = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const fenceMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
      if (!inFence && fenceMatch && fenceMatch[2]) {
        inFence = true;
        fenceChar = fenceMatch[2][0]!;
        fenceLength = fenceMatch[2].length;
        continue;
      }
      if (inFence && fenceMatch && fenceMatch[2]) {
        if (fenceMatch[2][0] === fenceChar && fenceMatch[2].length >= fenceLength) {
          inFence = false;
          fenceChar = "";
          fenceLength = 0;
        }
        continue;
      }
      if (inFence) {
        continue;
      }
      if (!/^#{1,6}\s+/.test(line) && line.trim().length > 0) {
        nonHeadingLines.push(line.trim());
      }
    }

    const nonHeadingText = nonHeadingLines.join(" ").trim();
    const isEntirelyQuestion =
      nonHeadingText.endsWith("?") &&
      !nonHeadingText.includes(".") &&
      !nonHeadingText.includes("!");

    if (isEntirelyQuestion) {
      hints.push("Write instructions telling the bot what procedure to follow, rather than asking it a question.");
    }

    const headingTitles = headings.map((h) => h.title.toLowerCase());
    const lowerContent = stripped.toLowerCase();

    const hasFallbackSection =
      headingTitles.some((t) =>
        t.includes("pitfall") ||
        t.includes("fallback") ||
        t.includes("missing") ||
        t.includes("when to use") ||
        t.includes("troubleshoot") ||
        t.includes("error") ||
        t.includes("edge case")
      ) ||
      lowerContent.includes("cannot find") ||
      lowerContent.includes("not found") ||
      lowerContent.includes("if missing") ||
      lowerContent.includes("when missing") ||
      lowerContent.includes("unresolved");

    if (!hasFallbackSection) {
      hints.push("Add a section explaining what the bot should do when it cannot find what it needs.");
    }

    const hasVerificationSection =
      headingTitles.some((t) =>
        t.includes("verification") ||
        t.includes("output") ||
        t.includes("finished") ||
        t.includes("checklist") ||
        t.includes("result") ||
        t.includes("acceptance")
      ) ||
      lowerContent.includes("done when") ||
      lowerContent.includes("verification") ||
      lowerContent.includes("observable completion");

    if (!hasVerificationSection) {
      hints.push("Add a section describing what the finished result should look like.");
    }

    const hasProvenanceGuidance =
      lowerContent.includes("source") ||
      lowerContent.includes("citation") ||
      lowerContent.includes("cite") ||
      lowerContent.includes("provenance") ||
      lowerContent.includes("quote") ||
      lowerContent.includes("reference") ||
      lowerContent.includes("where a claim came from");

    if (!hasProvenanceGuidance) {
      hints.push("Tell the bot to state where each claim or fact came from.");
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    hints,
  };
}
