export type AgentRunState =
  | "planning"
  | "awaiting-approval"
  | "running"
  | "stopping"
  | "done"
  | "stopped"
  | "failed";

export interface AgentStepView {
  readonly index: number;
  readonly kind: "thought" | "tool" | "answer" | "refusal";
  readonly title: string;
  readonly detail: string;
  readonly toolLabel: string | null;
  readonly at: number;
  readonly durationMs: number | null;
  readonly ok: boolean | null;
}

export interface AgentRunView {
  readonly runId: string;
  readonly caseId: string;
  readonly goal: string;
  readonly state: AgentRunState;
  readonly steps: readonly AgentStepView[];
  readonly headline: string;
  readonly stepsUsed: number;
  readonly stepsAllowed: number;
  readonly canStop: boolean;
}

export interface RawAgentStep {
  readonly index: number;
  readonly thought: string;
  readonly toolName: string | null;
  readonly toolArgs: string;
  readonly toolResult: string;
  readonly toolFailed: boolean;
  readonly answer: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface BuildAgentRunViewInput {
  readonly runId: string;
  readonly caseId: string;
  readonly goal: string;
  readonly state: AgentRunState;
  readonly stepsAllowed: number;
  readonly steps: readonly RawAgentStep[];
  readonly failure?: string;
  readonly now: number;
}

interface TitleResolution {
  readonly title: string;
  readonly isUnknownTool: boolean;
}

function cleanNounForTitle(rawNoun: string | null): string | null {
  if (rawNoun === null) {
    return null;
  }
  let s = rawNoun.trim();
  if (s.length === 0) {
    return null;
  }

  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1).trim();
  } else if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    s = s.slice(1, -1).trim();
  }

  if (s.length === 0) {
    return null;
  }

  // Raw JSON blobs must never enter a human-readable title
  if (s.startsWith("{") || s.startsWith("[") || s.includes('":') || s.includes("':")) {
    return null;
  }

  // Convert file paths into clean basenames so internal directory structures remain hidden
  if (s.includes("/") || s.includes("\\")) {
    const parts = s.split(/[/\\]+/);
    const last = parts[parts.length - 1];
    s = last !== undefined ? last.trim() : "";
  }

  if (s.length === 0) {
    return null;
  }

  // Prevent cryptic identifiers or oversized labels from cluttering the title
  if (s.length > 40) {
    return null;
  }

  if (s.includes("/") || s.includes("\\") || s.includes("{") || s.includes("}")) {
    return null;
  }

  return s;
}

function extractArgString(rawArgs: string, keys: readonly string[]): string | null {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of keys) {
        const val = record[key];
        if (typeof val === "string" && val.trim().length > 0) {
          return val.trim();
        }
        if (typeof val === "number") {
          return String(val);
        }
      }
    }
  } catch {
    // LLM outputs frequently drop quotes or braces; recover with regex before giving up
  }

  for (const key of keys) {
    const pattern = new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']([^"'\\r\\n]+)["']`, "i");
    const match = pattern.exec(trimmed);
    if (match !== null) {
      const captured = match[1];
      if (captured !== undefined && captured.trim().length > 0) {
        return captured.trim();
      }
    }
  }

  return null;
}

function isRefusal(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t.startsWith("i cannot") ||
    t.startsWith("i can't") ||
    t.startsWith("i am unable") ||
    t.startsWith("i'm unable") ||
    t.startsWith("i decline") ||
    t.startsWith("i will not") ||
    t.startsWith("refusal") ||
    t.includes("cannot assist") ||
    t.includes("cannot answer") ||
    t.includes("refuse to")
  );
}

function truncateDetail(text: string, maxChars = 2000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  const ellipsis = "...";
  const maxContent = maxChars - ellipsis.length;
  if (maxContent <= 0) {
    return ellipsis.slice(0, maxChars);
  }

  const chunk = trimmed.slice(0, maxContent);
  const lastWhitespace = chunk.search(/\s+[^\s]*$/);
  if (lastWhitespace > 0) {
    return chunk.slice(0, lastWhitespace).trimEnd() + ellipsis;
  }
  return chunk + ellipsis;
}

function resolveToolLabel(kind: "thought" | "tool" | "answer" | "refusal", toolName: string | null): string | null {
  if (kind !== "tool" || toolName === null) {
    return null;
  }
  const norm = toolName.trim().toLowerCase();
  if (norm === "rellane_list_sources" || norm === "list_sources") {
    return "Sources";
  }
  if (norm === "rellane_read_source" || norm === "read_source") {
    return "Source";
  }
  if (norm === "hermes_list_skills" || norm === "list_skills") {
    return "Procedures";
  }
  if (norm === "hermes_read_skill" || norm === "read_skill") {
    return "Procedure";
  }
  if (norm === "hermes_check_citations" || norm === "check_citations") {
    return "Citations";
  }
  if (norm === "duckdb_query" || norm === "sql" || norm === "duckdb" || norm === "run_sql") {
    return "Spreadsheet";
  }
  if (norm === "run_sandbox" || norm === "wasm" || norm === "sandbox") {
    return "Scratchpad";
  }
  return "Tool";
}

function resolveTitle(
  kind: "thought" | "tool" | "answer" | "refusal",
  toolName: string | null,
  toolArgs: string,
): TitleResolution {
  if (kind === "answer") {
    return { title: "Prepared your answer", isUnknownTool: false };
  }
  if (kind === "refusal") {
    return { title: "Declined to answer", isUnknownTool: false };
  }
  if (kind === "thought" || toolName === null) {
    return { title: "Thought through the next step", isUnknownTool: false };
  }

  const norm = toolName.trim().toLowerCase();

  if (norm === "rellane_list_sources" || norm === "list_sources") {
    return { title: "Looked at which files you had chosen", isUnknownTool: false };
  }

  if (norm === "rellane_read_source" || norm === "read_source") {
    const rawNoun = extractArgString(toolArgs, [
      "name",
      "sourceName",
      "source_name",
      "sourceId",
      "source_id",
      "id",
      "path",
      "filePath",
      "file_path",
      "filename",
      "file",
      "title",
      "source",
    ]);
    const cleanNoun = cleanNounForTitle(rawNoun);
    if (cleanNoun !== null) {
      return { title: `Read "${cleanNoun}"`, isUnknownTool: false };
    }
    return { title: "Read a chosen source", isUnknownTool: false };
  }

  if (norm === "hermes_list_skills" || norm === "list_skills") {
    return { title: "Checked which procedures it knows", isUnknownTool: false };
  }

  if (norm === "hermes_read_skill" || norm === "read_skill") {
    const rawNoun = extractArgString(toolArgs, [
      "skill",
      "skillName",
      "skill_name",
      "name",
      "id",
      "procedure",
    ]);
    const cleanNoun = cleanNounForTitle(rawNoun);
    if (cleanNoun !== null) {
      return { title: `Followed the "${cleanNoun}" procedure`, isUnknownTool: false };
    }
    return { title: "Followed a known procedure", isUnknownTool: false };
  }

  if (norm === "hermes_check_citations" || norm === "check_citations") {
    return { title: "Checked every claim against your sources", isUnknownTool: false };
  }

  if (norm === "duckdb_query" || norm === "sql" || norm === "duckdb" || norm === "run_sql") {
    return { title: "Asked a question of your spreadsheet", isUnknownTool: false };
  }

  if (norm === "run_sandbox" || norm === "wasm" || norm === "sandbox") {
    return { title: "Worked something out in a sealed scratchpad", isUnknownTool: false };
  }

  return { title: "Used a tool it has", isUnknownTool: true };
}

function resolveDetail(
  kind: "thought" | "tool" | "answer" | "refusal",
  step: RawAgentStep,
  isUnknownTool: boolean,
): string {
  const parts: string[] = [];

  // Put unknown raw tool names into detail so diagnostics remain possible without showing tech debt in the header
  if (isUnknownTool && step.toolName !== null && step.toolName.trim().length > 0) {
    parts.push(step.toolName.trim());
  }

  if (step.thought.trim().length > 0) {
    parts.push(step.thought.trim());
  }

  if (kind === "answer" || kind === "refusal") {
    if (step.answer.trim().length > 0) {
      parts.push(step.answer.trim());
    }
  }

  if (step.toolFailed && step.toolResult.trim().length > 0) {
    parts.push(step.toolResult.trim());
  }

  const combined = parts.join("\n\n");
  return truncateDetail(combined, 2000);
}

function formatPlainFailure(failure?: string): string {
  if (failure === undefined) {
    return "";
  }
  let s = failure.trim();
  if (s.length === 0) {
    return "";
  }
  s = s.replace(/^error:\s*/i, "");
  const first = s[0];
  const second = s[1];
  if (first !== undefined && second !== undefined && first === first.toUpperCase() && second === second.toLowerCase()) {
    s = first.toLowerCase() + s.slice(1);
  }
  s = s.replace(/[.!?]+$/, "").trim();
  return s;
}

function buildHeadline(
  state: AgentRunState,
  stepsUsed: number,
  stepsAllowed: number,
  deduped: readonly RawAgentStep[],
  failure?: string,
): string {
  switch (state) {
    case "planning":
      return "Planning the steps to take.";

    case "awaiting-approval":
      return "Awaiting your approval to continue.";

    case "running": {
      /**
       * The step being worked on is the earliest one that has not finished, not
       * the last one in the list. Steps do not always end in the order they
       * started — a clock that steps backwards is enough — and reading the last
       * entry announced "step 4 of 4" while step 2 was still going.
       */
      let currentStep = 1;
      if (deduped.length > 0) {
        const running = deduped.find((step) => step.endedAt === null);
        if (running !== undefined) {
          currentStep = running.index > 0 ? running.index : 1;
        } else {
          const last = deduped[deduped.length - 1];
          currentStep = last !== undefined && last.index > 0 ? last.index + 1 : deduped.length + 1;
        }
      }
      if (stepsAllowed > 0) {
        const clamped = Math.min(currentStep, stepsAllowed);
        return `Working through step ${clamped} of ${stepsAllowed}.`;
      }
      return `Working through step ${currentStep}.`;
    }

    case "stopping":
      return "Stopping at your request.";

    case "stopped": {
      let stopStep: number | null = null;
      if (deduped.length > 0) {
        const last = deduped[deduped.length - 1];
        if (last !== undefined) {
          stopStep = last.index > 0 ? last.index : deduped.length;
        }
      }
      if (stopStep !== null) {
        return `Stopped at step ${stopStep}, at your request.`;
      }
      return "Stopped at your request.";
    }

    case "done": {
      if (stepsUsed === 1) {
        return "Finished in 1 step.";
      }
      return `Finished in ${stepsUsed} steps.`;
    }

    case "failed": {
      const cleanFailure = formatPlainFailure(failure);
      if (cleanFailure.length > 0) {
        return `Could not finish: ${cleanFailure}.`;
      }
      if (deduped.some((s) => s.toolFailed)) {
        return "Could not finish: a step failed.";
      }
      return "Could not finish: an unexpected problem occurred.";
    }
  }
}

export function buildAgentRunView(input: {
  readonly runId: string;
  readonly caseId: string;
  readonly goal: string;
  readonly state: AgentRunState;
  readonly stepsAllowed: number;
  readonly steps: readonly RawAgentStep[];
  readonly failure?: string;
  readonly now: number;
}): AgentRunView {
  const seenIndexes = new Set<number>();
  const deduped: RawAgentStep[] = [];
  for (const step of input.steps) {
    if (!seenIndexes.has(step.index)) {
      seenIndexes.add(step.index);
      deduped.push(step);
    }
  }
  deduped.sort((a, b) => a.index - b.index);

  const stepsView: AgentStepView[] = deduped.map((step) => {
    const hasTool = step.toolName !== null && step.toolName.trim().length > 0;
    const hasAnswer = step.answer.trim().length > 0;

    let kind: "thought" | "tool" | "answer" | "refusal";
    if (hasTool) {
      kind = "tool";
    } else if (hasAnswer) {
      kind = isRefusal(step.answer) ? "refusal" : "answer";
    } else {
      kind = "thought";
    }

    const { title, isUnknownTool } = resolveTitle(kind, step.toolName, step.toolArgs);
    const detail = resolveDetail(kind, step, isUnknownTool);
    const toolLabel = resolveToolLabel(kind, step.toolName);

    let durationMs: number | null = null;
    if (step.endedAt !== null && step.endedAt >= step.startedAt) {
      durationMs = step.endedAt - step.startedAt;
    }

    let ok: boolean | null = null;
    if (step.endedAt !== null) {
      if (step.toolFailed || kind === "refusal") {
        ok = false;
      } else {
        ok = true;
      }
    }

    return {
      index: step.index,
      kind,
      title,
      detail,
      toolLabel,
      at: step.startedAt,
      durationMs,
      ok,
    };
  });

  const stepsAllowed = Math.max(0, input.stepsAllowed);
  const stepsUsed = deduped.length;
  const canStop = input.state === "running" || input.state === "planning";
  const headline = buildHeadline(input.state, stepsUsed, stepsAllowed, deduped, input.failure);

  return {
    runId: input.runId,
    caseId: input.caseId,
    goal: input.goal,
    state: input.state,
    steps: stepsView,
    headline,
    stepsUsed,
    stepsAllowed,
    canStop,
  };
}
