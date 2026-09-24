/** One part of a split request, and who is taking it. */
export interface CrewPart {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly seatId: string;
  readonly seatLabel: string;
  readonly dependsOn: readonly string[];
}

export type CrewPartState =
  | "waiting"
  | "claimed"
  | "working"
  | "answered"
  | "refining"
  | "done"
  | "failed"
  | "stopped";

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

export interface RawPart {
  readonly id: string;
  readonly title: string;
  readonly seatLabel: string;
  readonly state: CrewPartState;
  readonly dependsOn: readonly string[];
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly answerTurnId: string | null;
  readonly refinedFrom: readonly string[];
  readonly failure: string | null;
}

function numberToWord(n: number): string {
  switch (n) {
    case 0:
      return "zero";
    case 1:
      return "one";
    case 2:
      return "two";
    case 3:
      return "three";
    case 4:
      return "four";
    case 5:
      return "five";
    case 6:
      return "six";
    case 7:
      return "seven";
    case 8:
      return "eight";
    case 9:
      return "nine";
    case 10:
      return "ten";
    default:
      return String(n);
  }
}

function capitalize(text: string): string {
  if (text.length === 0) {
    return text;
  }
  const first = text.charAt(0).toUpperCase();
  return first + text.slice(1);
}

function formatElapsed(
  startedAt: number | null,
  endedAt: number | null,
  now: number,
): string {
  if (startedAt === null) {
    return "";
  }
  const finish = endedAt !== null ? endedAt : now;
  if (finish < startedAt) {
    return "";
  }
  const diffMs = finish - startedAt;
  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} sec`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  if (remainingMinutes === 0) {
    return `${hours} hr`;
  }
  return `${hours} hr ${remainingMinutes} min`;
}

function formatTitles(titles: readonly string[]): string {
  if (titles.length === 0) {
    return "";
  }
  const first = titles[0];
  if (first === undefined) {
    return "";
  }
  if (titles.length === 1) {
    return first;
  }
  const second = titles[1];
  if (titles.length === 2 && second !== undefined) {
    return `${first} and ${second}`;
  }
  const last = titles[titles.length - 1];
  if (last !== undefined) {
    return `${titles.slice(0, -1).join(", ")} and ${last}`;
  }
  return titles.join(", ");
}

function buildPartLine(
  part: RawPart,
  elapsed: string,
  partsById: ReadonlyMap<string, RawPart>,
): string {
  switch (part.state) {
    case "waiting": {
      const depTitles = part.dependsOn
        .map((id) => partsById.get(id)?.title)
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      if (depTitles.length > 0) {
        return `Waiting for ${formatTitles(depTitles)}.`;
      }
      return "Waiting to start.";
    }
    case "claimed": {
      if (elapsed.length > 0) {
        return `Claimed, ${elapsed} so far.`;
      }
      return "Claimed.";
    }
    case "working": {
      if (elapsed.length > 0) {
        return `Working, ${elapsed} so far.`;
      }
      return "Working.";
    }
    case "answered": {
      return "Answered.";
    }
    case "refining": {
      const refTitles = part.refinedFrom
        .map((id) => partsById.get(id)?.title)
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      if (refTitles.length > 0) {
        return `Reading ${formatTitles(refTitles)} before revising.`;
      }
      return "Reading other answers before revising.";
    }
    case "done": {
      return "Done.";
    }
    case "failed": {
      const reason = part.failure ? part.failure.trim().replace(/\.+$/, "") : "";
      if (reason.length > 0) {
        return `Could not finish: ${reason}.`;
      }
      return "Could not finish: unknown reason.";
    }
    case "stopped": {
      return "Stopped, at your request.";
    }
  }
}

function buildHeadline(
  parts: readonly RawPart[],
  round: CrewRunView["round"],
): string {
  if (parts.length === 0) {
    if (round === "splitting") {
      return "Dividing the work.";
    }
    if (round === "stopped") {
      return "Stopped, at your request.";
    }
    if (round === "failed") {
      return "Could not finish.";
    }
    return "No bots assigned.";
  }

  let workingCount = 0;
  let refiningCount = 0;
  let claimedCount = 0;
  let finishedCount = 0;
  let waitingCount = 0;
  let stoppedCount = 0;
  let failedCount = 0;

  for (const part of parts) {
    switch (part.state) {
      case "working":
        workingCount++;
        break;
      case "refining":
        refiningCount++;
        break;
      case "claimed":
        claimedCount++;
        break;
      case "answered":
      case "done":
        finishedCount++;
        break;
      case "waiting":
        waitingCount++;
        break;
      case "stopped":
        stoppedCount++;
        break;
      case "failed":
        failedCount++;
        break;
    }
  }

  const total = parts.length;

  if (finishedCount === total) {
    if (total === 1) {
      return "One bot finished.";
    }
    if (total === 2) {
      return "Both finished.";
    }
    return `All ${numberToWord(total)} finished.`;
  }

  if (stoppedCount === total || round === "stopped") {
    return "Stopped, at your request.";
  }

  if (workingCount === total) {
    if (total === 1) {
      return "One bot working.";
    }
    if (total === 2) {
      return "Both bots working.";
    }
    return `All ${numberToWord(total)} bots working.`;
  }

  if (waitingCount === total) {
    if (total === 1) {
      return "One bot waiting.";
    }
    if (total === 2) {
      return "Both bots waiting.";
    }
    return `All ${numberToWord(total)} bots waiting.`;
  }

  if (failedCount === total) {
    if (total === 1) {
      return "One bot failed.";
    }
    if (total === 2) {
      return "Both bots failed.";
    }
    return `All ${numberToWord(total)} bots failed.`;
  }

  if (refiningCount === total) {
    if (total === 1) {
      return "One bot refining.";
    }
    if (total === 2) {
      return "Both bots refining.";
    }
    return `All ${numberToWord(total)} bots refining.`;
  }

  if (claimedCount === total) {
    if (total === 1) {
      return "One bot claimed.";
    }
    if (total === 2) {
      return "Both bots claimed.";
    }
    return `All ${numberToWord(total)} bots claimed.`;
  }

  interface Group {
    readonly count: number;
    readonly participle: string;
  }
  const groups: Group[] = [];
  if (workingCount > 0) {
    groups.push({ count: workingCount, participle: "working" });
  }
  if (refiningCount > 0) {
    groups.push({ count: refiningCount, participle: "refining" });
  }
  if (claimedCount > 0) {
    groups.push({ count: claimedCount, participle: "claimed" });
  }
  if (finishedCount > 0) {
    groups.push({ count: finishedCount, participle: "finished" });
  }
  if (waitingCount > 0) {
    groups.push({ count: waitingCount, participle: "waiting" });
  }
  if (stoppedCount > 0) {
    groups.push({ count: stoppedCount, participle: "stopped" });
  }
  if (failedCount > 0) {
    groups.push({ count: failedCount, participle: "failed" });
  }

  const first = groups[0];
  if (first === undefined) {
    return "No bots active.";
  }
  const firstNoun = first.count === 1 ? "bot" : "bots";
  const firstText = `${capitalize(numberToWord(first.count))} ${firstNoun} ${first.participle}`;

  if (groups.length === 1) {
    return `${firstText}.`;
  }

  const remainingPhrases = groups.slice(1).map((g) => `${numberToWord(g.count)} ${g.participle}`);
  return `${firstText}, ${remainingPhrases.join(", ")}.`;
}

function clampLength(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

export function buildCrewRunView(input: {
  readonly runId: string;
  readonly caseId: string;
  readonly request: string;
  readonly round: CrewRunView["round"];
  readonly parts: readonly RawPart[];
  readonly now: number;
}): CrewRunView {
  const partsById = new Map<string, RawPart>();
  for (const part of input.parts) {
    partsById.set(part.id, part);
  }

  const partViews: CrewPartView[] = [];
  for (const part of input.parts) {
    const elapsed = formatElapsed(part.startedAt, part.endedAt, input.now);
    const line = buildPartLine(part, elapsed, partsById);
    const canStop =
      part.state === "claimed" || part.state === "working" || part.state === "refining";

    partViews.push({
      id: part.id,
      title: part.title,
      seatLabel: part.seatLabel,
      state: part.state,
      line,
      elapsed,
      answerTurnId: part.answerTurnId,
      refinedFrom: part.refinedFrom,
      canStop,
    });
  }

  const headline = buildHeadline(input.parts, input.round);
  const canStop = partViews.some((p) => p.canStop);

  return {
    runId: input.runId,
    caseId: input.caseId,
    request: input.request,
    parts: partViews,
    round: input.round,
    headline,
    canStop,
  };
}

/** The same run, as at most five short lines for a phone. */
export function crewStatusLines(view: CrewRunView): readonly string[] {
  const lines: string[] = [];
  lines.push(clampLength(view.headline, 79));

  if (view.parts.length === 0) {
    return lines;
  }

  if (view.parts.length <= 4) {
    for (const part of view.parts) {
      lines.push(clampLength(`${part.title}: ${part.line}`, 79));
    }
    return lines;
  }

  for (const part of view.parts.slice(0, 3)) {
    lines.push(clampLength(`${part.title}: ${part.line}`, 79));
  }

  const remaining = view.parts.length - 3;
  const remainderLabel = remaining === 1 ? "1 more part" : `${remaining} more parts`;
  lines.push(clampLength(`And ${remainderLabel}.`, 79));

  return lines;
}
