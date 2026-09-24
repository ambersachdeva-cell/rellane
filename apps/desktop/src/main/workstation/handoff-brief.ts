export interface TurnLike {
  readonly id: string;
  readonly seat: string;
  readonly kind: string;
  readonly body: string;
}

export interface HandoffBrief {
  /** The text to prepend to the next provider's packet. Empty when there is nothing to carry. */
  readonly text: string;
  /** Turn ids this was built from, so the owner can check every line. */
  readonly evidence: readonly string[];
  readonly chars: number;
  /** True when earlier turns were left out to fit the budget. */
  readonly trimmed: boolean;
}

export const HANDOFF_BUDGET_CHARS = 4_000;
export const ELISION_MARKER = "[... elided ...]";

const DEFAULT_MAX_BODY_CHARS = 1_000;

interface ProcessedTurn {
  readonly originalIndex: number;
  readonly turn: TurnLike;
  readonly formatted: string;
  readonly wasElided: boolean;
}

function isOwnerRequest(turn: TurnLike): boolean {
  const kind = turn.kind.trim().toLowerCase();
  return kind === "verbatim";
}

function isCarryable(turn: TurnLike, excludedIds: ReadonlySet<string>): boolean {
  if (excludedIds.has(turn.id)) {
    return false;
  }
  if (turn.body.trim().length === 0) {
    return false;
  }
  const kind = turn.kind.trim().toLowerCase();
  // Carry owner verbatim requests and AI answers; receipts, permissions, and host records are bookkeeping.
  return (
    kind === "verbatim" ||
    kind === "answer" ||
    kind === "response" ||
    kind.endsWith("-answer") ||
    kind.endsWith("_answer")
  );
}

function formatTurnEntry(seat: string, body: string): string {
  const trimmedSeat = seat.trim();
  const trimmedBody = body.trim();
  if (trimmedSeat.length === 0) {
    return trimmedBody;
  }
  return `${trimmedSeat}: ${trimmedBody}`;
}

function elideBody(
  body: string,
  maxChars: number
): { readonly text: string; readonly elided: boolean } {
  const trimmed = body.trim();
  if (trimmed.length <= maxChars) {
    return { text: trimmed, elided: false };
  }

  const marker = `\n${ELISION_MARKER}\n`;
  if (maxChars <= marker.length + 8) {
    // Under severe space limits, keep at least one character at each end so origin remains visible.
    const head = trimmed.slice(0, 1);
    const tail = trimmed.slice(-1);
    return { text: `${head}${marker}${tail}`, elided: true };
  }

  const available = maxChars - marker.length;
  const half = Math.floor(available / 2);
  const headCandidate = trimmed.slice(0, half).trimEnd();
  const tailCandidate = trimmed.slice(trimmed.length - half).trimStart();
  const head = headCandidate.length > 0 ? headCandidate : trimmed.slice(0, 1);
  const tail = tailCandidate.length > 0 ? tailCandidate : trimmed.slice(-1);

  return { text: `${head}${marker}${tail}`, elided: true };
}

export function buildHandoffBrief(
  turns: readonly TurnLike[],
  options?: { readonly excludeSourceIds?: readonly string[]; readonly budgetChars?: number }
): HandoffBrief {
  if (!Array.isArray(turns) || turns.length === 0) {
    return { text: "", evidence: [], chars: 0, trimmed: false };
  }

  if (options?.budgetChars !== undefined && options.budgetChars <= 0) {
    return { text: "", evidence: [], chars: 0, trimmed: turns.length > 0 };
  }

  const budgetChars =
    options?.budgetChars !== undefined && Number.isFinite(options.budgetChars)
      ? Math.floor(options.budgetChars)
      : HANDOFF_BUDGET_CHARS;

  const excludedIds = new Set(options?.excludeSourceIds ?? []);

  const carryableTurns: TurnLike[] = [];
  for (const turn of turns) {
    if (isCarryable(turn, excludedIds)) {
      carryableTurns.push(turn);
    }
  }

  if (carryableTurns.length === 0) {
    return { text: "", evidence: [], chars: 0, trimmed: false };
  }

  // The turn limit protects the budget from being monopolised by a single long answer.
  const turnMaxBody = Math.min(
    DEFAULT_MAX_BODY_CHARS,
    Math.max(100, Math.floor(budgetChars / 2))
  );

  const processedTurns: ProcessedTurn[] = [];
  for (let i = 0; i < carryableTurns.length; i++) {
    const turn = carryableTurns[i]!;
    const { text: processedBody, elided } = elideBody(turn.body, turnMaxBody);
    const formatted = formatTurnEntry(turn.seat, processedBody);
    processedTurns.push({
      originalIndex: i,
      turn,
      formatted,
      wasElided: elided
    });
  }

  // Locate the owner's original request to prevent conversation drift across handoffs.
  const firstRequestIndex = processedTurns.findIndex(p => isOwnerRequest(p.turn));
  const firstRequest = firstRequestIndex !== -1 ? processedTurns[firstRequestIndex] : undefined;

  let selected: ProcessedTurn[] = [];

  if (firstRequest !== undefined) {
    const otherTurns = processedTurns.filter((_, idx) => idx !== firstRequestIndex);

    // Prefer recent turns over older intermediate context while keeping the original request.
    let fitted = false;
    for (let count = otherTurns.length; count >= 0; count--) {
      const candidateOthers = otherTurns.slice(otherTurns.length - count);
      const candidateCombined = [...candidateOthers, firstRequest];
      candidateCombined.sort((a, b) => a.originalIndex - b.originalIndex);

      const combinedText = candidateCombined.map(c => c.formatted).join("\n\n");
      if (combinedText.length <= budgetChars) {
        selected = candidateCombined;
        fitted = true;
        break;
      }
    }

    if (!fitted) {
      // When even the request plus one recent turn exceeds the budget, carry the request alone.
      if (firstRequest.formatted.length <= budgetChars) {
        selected = [firstRequest];
      } else {
        const seatPrefix =
          firstRequest.turn.seat.trim().length > 0
            ? `${firstRequest.turn.seat.trim()}: `
            : "";
        const maxBody = Math.max(10, budgetChars - seatPrefix.length);
        const { text: tightBody } = elideBody(firstRequest.turn.body, maxBody);
        const formatted = seatPrefix.length > 0 ? `${seatPrefix}${tightBody}` : tightBody;
        selected = [
          {
            originalIndex: firstRequest.originalIndex,
            turn: firstRequest.turn,
            formatted,
            wasElided: true
          }
        ];
      }
    }
  } else {
    // If there is no explicit owner request, retain as many recent turns as the budget allows.
    let fitted = false;
    for (let count = processedTurns.length; count >= 1; count--) {
      const candidate = processedTurns.slice(processedTurns.length - count);
      const combinedText = candidate.map(c => c.formatted).join("\n\n");
      if (combinedText.length <= budgetChars) {
        selected = candidate;
        fitted = true;
        break;
      }
    }

    if (!fitted && processedTurns.length > 0) {
      const latest = processedTurns[processedTurns.length - 1]!;
      const seatPrefix =
        latest.turn.seat.trim().length > 0 ? `${latest.turn.seat.trim()}: ` : "";
      const maxBody = Math.max(10, budgetChars - seatPrefix.length);
      const { text: tightBody } = elideBody(latest.turn.body, maxBody);
      const formatted = seatPrefix.length > 0 ? `${seatPrefix}${tightBody}` : tightBody;
      selected = [
        {
          originalIndex: latest.originalIndex,
          turn: latest.turn,
          formatted,
          wasElided: true
        }
      ];
    }
  }

  let text = selected.map(s => s.formatted).join("\n\n");
  if (text.length > budgetChars) {
    text = text.slice(0, budgetChars);
  }

  const anyTurnOmitted = selected.length < carryableTurns.length;
  const anyTurnElided = selected.some(s => s.wasElided);
  const trimmed = anyTurnOmitted || anyTurnElided;

  const evidence = selected.map(s => s.turn.id);

  return {
    text,
    evidence,
    chars: text.length,
    trimmed
  };
}
