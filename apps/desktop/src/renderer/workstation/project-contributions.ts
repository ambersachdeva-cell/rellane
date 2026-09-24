export interface ContributionTurn {
  readonly caseId: string;
  readonly caseTitle: string;
  readonly seat: string;
  readonly kind: string;
  readonly at: number;
  readonly chars: number;
  readonly producedOutput: boolean;
}

export interface Contributor {
  readonly seat: string;
  readonly label: string;
  readonly answers: number;
  readonly outputs: number;
  readonly chars: number;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly works: readonly string[];
  /** Plain sentence: "4 answers across 2 pieces of work, 2 saved as outputs." */
  readonly line: string;
}

export interface ContributionView {
  readonly contributors: readonly Contributor[];
  readonly headline: string;
  readonly workCount: number;
  readonly span: string;
}

function isBookkeeping(kind: string): boolean {
  const normalized = kind.trim().toLowerCase();
  return (
    normalized === "receipt" ||
    normalized === "receipts" ||
    normalized === "permission" ||
    normalized === "permissions" ||
    normalized === "bookkeeping" ||
    normalized.startsWith("receipt") ||
    normalized.startsWith("permission")
  );
}

function isAnswer(kind: string): boolean {
  const normalized = kind.trim().toLowerCase();
  return normalized === "answer" || normalized === "answers";
}

function stripPrefix(raw: string): string {
  let s = raw.trim();
  const colonIndex = s.lastIndexOf(":");
  if (colonIndex !== -1) {
    s = s.slice(colonIndex + 1).trim();
  }
  const slashIndex = s.lastIndexOf("/");
  if (slashIndex !== -1) {
    s = s.slice(slashIndex + 1).trim();
  }
  const prefixMatch = /^(?:provider|seat|ai|sub|subscription|internal|model)[-_](.+)$/iu.exec(s);
  if (prefixMatch && prefixMatch[1]) {
    s = prefixMatch[1].trim();
  }
  return s;
}

function humaniseSeat(seat: string): string {
  const stripped = stripPrefix(seat);
  const lower = stripped.toLowerCase();

  if (
    lower === "user" ||
    lower === "owner" ||
    lower === "you" ||
    lower === "human" ||
    lower === "self" ||
    lower === "me"
  ) {
    return "You";
  }

  if (lower === "codex") {
    return "Codex";
  }
  if (lower === "claude") {
    return "Claude";
  }
  if (lower === "qwen" || lower === "local-qwen" || lower === "local_qwen") {
    return "Qwen";
  }

  const geminiMatch = /^gemini[-_\s]?([123])$/iu.exec(stripped);
  if (geminiMatch && geminiMatch[1]) {
    return `Gemini (Profile ${geminiMatch[1]})`;
  }
  if (lower === "gemini") {
    return "Gemini";
  }

  const words = stripped
    .replace(/[-_]+/gu, " ")
    .trim()
    .split(/\s+/gu)
    .filter(Boolean);

  if (words.length === 0) {
    return "Assistant";
  }

  return words
    .map((word) => {
      const first = word.charAt(0).toUpperCase();
      const rest = word.slice(1).toLowerCase();
      return `${first}${rest}`;
    })
    .join(" ");
}

function formatContributorLine(answers: number, worksCount: number, outputs: number): string {
  const answerText = `${answers} ${answers === 1 ? "answer" : "answers"}`;
  const workText = `${worksCount} ${worksCount === 1 ? "piece of work" : "pieces of work"}`;
  const outputText = `${outputs} saved as ${outputs === 1 ? "output" : "outputs"}`;
  return `${answerText} across ${workText}, ${outputText}.`;
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  const localSame =
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate();
  const utcSame =
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate();
  return localSame || utcSame;
}

function formatSpan(firstAt: number, lastAt: number): string {
  if (!Number.isFinite(firstAt) || !Number.isFinite(lastAt) || firstAt > lastAt) {
    return "no activity yet";
  }

  const diffMs = lastAt - firstAt;
  const dayMs = 24 * 60 * 60 * 1000;

  if (diffMs === 0 || isSameDay(firstAt, lastAt)) {
    return "today";
  }

  const days = Math.round(diffMs / dayMs);
  if (days <= 1) {
    return "over 2 days";
  }

  if (days >= 14 || (days >= 7 && days % 7 === 0)) {
    const weeks = Math.round(days / 7);
    return `over ${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }

  return `over ${days} days`;
}

function formatHeadline(aiCount: number, hasOwner: boolean, workCount: number): string {
  let who = "";
  if (aiCount > 0 && hasOwner) {
    who = `${aiCount === 1 ? "1 AI" : `${aiCount} AIs`} and you`;
  } else if (aiCount > 0) {
    who = aiCount === 1 ? "1 AI" : `${aiCount} AIs`;
  } else if (hasOwner) {
    who = "You";
  } else {
    return "";
  }

  const pieceText = workCount === 1 ? "piece of work" : "pieces of work";
  return `${who}, across ${workCount} ${pieceText}`;
}

export function summariseContributions(
  turns: readonly ContributionTurn[],
  now: number
): ContributionView {
  void now;

  const validTurns: ContributionTurn[] = [];
  for (const turn of turns) {
    if (!isBookkeeping(turn.kind)) {
      validTurns.push(turn);
    }
  }

  if (validTurns.length === 0) {
    return {
      contributors: [],
      headline: "",
      workCount: 0,
      span: "no activity yet",
    };
  }

  const overallWorks = new Set<string>();
  let overallFirstAt = Number.POSITIVE_INFINITY;
  let overallLastAt = Number.NEGATIVE_INFINITY;

  const seatOrder: string[] = [];
  const turnsBySeat = new Map<string, ContributionTurn[]>();

  for (const turn of validTurns) {
    const seat = turn.seat;
    let list = turnsBySeat.get(seat);
    if (!list) {
      list = [];
      turnsBySeat.set(seat, list);
      seatOrder.push(seat);
    }
    list.push(turn);

    const workKey = turn.caseTitle.trim() || turn.caseId.trim();
    if (workKey.length > 0) {
      overallWorks.add(workKey);
    }

    if (turn.at < overallFirstAt) {
      overallFirstAt = turn.at;
    }
    if (turn.at > overallLastAt) {
      overallLastAt = turn.at;
    }
  }

  const contributors: Contributor[] = [];

  for (const seat of seatOrder) {
    const seatTurns = turnsBySeat.get(seat);
    if (!seatTurns || seatTurns.length === 0) {
      continue;
    }

    let answers = 0;
    let outputs = 0;
    let chars = 0;
    let firstAt = Number.POSITIVE_INFINITY;
    let lastAt = Number.NEGATIVE_INFINITY;
    const seatWorks: string[] = [];
    const seenSeatWorks = new Set<string>();

    for (const turn of seatTurns) {
      if (isAnswer(turn.kind)) {
        answers += 1;
      }
      if (turn.producedOutput) {
        outputs += 1;
      }
      if (turn.chars > 0) {
        chars += turn.chars;
      }
      if (turn.at < firstAt) {
        firstAt = turn.at;
      }
      if (turn.at > lastAt) {
        lastAt = turn.at;
      }

      const workTitle = turn.caseTitle.trim() || turn.caseId.trim();
      if (workTitle.length > 0 && !seenSeatWorks.has(workTitle)) {
        seenSeatWorks.add(workTitle);
        seatWorks.push(workTitle);
      }
    }

    const label = humaniseSeat(seat);
    const line = formatContributorLine(answers, seatWorks.length, outputs);

    contributors.push({
      seat,
      label,
      answers,
      outputs,
      chars,
      firstAt: Number.isFinite(firstAt) ? firstAt : 0,
      lastAt: Number.isFinite(lastAt) ? lastAt : 0,
      works: seatWorks,
      line,
    });
  }

  contributors.sort((a, b) => {
    if (b.outputs !== a.outputs) {
      return b.outputs - a.outputs;
    }
    if (b.answers !== a.answers) {
      return b.answers - a.answers;
    }
    if (b.lastAt !== a.lastAt) {
      return b.lastAt - a.lastAt;
    }
    return a.seat.localeCompare(b.seat);
  });

  const aiContributors = contributors.filter((c) => c.label !== "You");
  const hasOwner = contributors.some((c) => c.label === "You");
  const aiCount = aiContributors.length;
  const workCount = overallWorks.size;

  const headline = formatHeadline(aiCount, hasOwner, workCount);
  const span = formatSpan(overallFirstAt, overallLastAt);

  return {
    contributors,
    headline,
    workCount,
    span,
  };
}
