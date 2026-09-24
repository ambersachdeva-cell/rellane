export type SeatState = "idle" | "working" | "waiting" | "stopped" | "unavailable";

export interface SeatInput {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly detected: boolean;
  readonly session: {
    readonly caseId: string;
    readonly caseTitle: string;
    readonly status: string;
    readonly startedAt: number;
    readonly waitingTitle: string | null;
  } | null;
  readonly finishedToday: number;
  readonly lastUsedAt: number;
}

export interface Seat {
  readonly providerId: string;
  readonly label: string;
  readonly state: SeatState;
  readonly line: string;
  readonly elapsed: string;
  readonly badge: string | null;
  readonly canStart: boolean;
}

export interface Board {
  readonly seats: readonly Seat[];
  readonly headline: string;
  readonly busy: number;
  readonly free: number;
}

const STATE_ORDER: Readonly<Record<SeatState, number>> = {
  waiting: 0,
  working: 1,
  idle: 2,
  stopped: 3,
  unavailable: 4
};

function determineState(detected: boolean, session: SeatInput["session"]): SeatState {
  if (!detected) {
    return "unavailable";
  }
  if (!session) {
    return "idle";
  }
  const status = session.status.trim().toLowerCase();
  if (
    status === "needs-approval" ||
    status === "waiting" ||
    status === "needs_approval" ||
    status === "awaiting-approval" ||
    status.includes("approval")
  ) {
    return "waiting";
  }
  if (
    status === "completed" ||
    status === "stopped" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "done" ||
    status === "finished" ||
    status === "cancelled" ||
    status === "canceled"
  ) {
    return "stopped";
  }
  return "working";
}

function truncateLine(raw: string, maxLen = 80): string {
  const text = raw.trim().replace(/\s+/gu, " ");
  if (text.length === 0) {
    return "Free";
  }
  if (text.length <= maxLen) {
    return text;
  }
  const maxPrefix = maxLen - 1;
  if (text.charAt(maxPrefix) === " ") {
    return text.slice(0, maxPrefix).trimEnd() + "…";
  }
  const candidate = text.slice(0, maxPrefix);
  const lastSpace = candidate.lastIndexOf(" ");
  if (lastSpace > 0) {
    return candidate.slice(0, lastSpace).trimEnd() + "…";
  }
  return candidate.trimEnd() + "…";
}

function determineLine(state: SeatState, session: SeatInput["session"]): string {
  switch (state) {
    case "waiting": {
      const waiting = session?.waitingTitle?.trim();
      if (waiting) {
        return truncateLine(waiting);
      }
      const title = session?.caseTitle?.trim();
      if (title) {
        return truncateLine(title);
      }
      return "Needs your approval";
    }
    case "working": {
      const title = session?.caseTitle?.trim() || session?.caseId?.trim();
      return title ? truncateLine(title) : "Working";
    }
    case "idle": {
      return "Free";
    }
    case "stopped": {
      const title = session?.caseTitle?.trim() || session?.caseId?.trim();
      return title ? truncateLine(title) : "Stopped";
    }
    case "unavailable": {
      return "Not detected on this Mac";
    }
  }
}

function formatElapsed(state: SeatState, session: SeatInput["session"], now: number): string {
  if (state === "idle" || !session) {
    return "";
  }
  if (!Number.isFinite(now) || !Number.isFinite(session.startedAt) || session.startedAt < 0) {
    return "just now";
  }
  const diffMs = now - session.startedAt;
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return "just now";
  }
  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 1) {
    return "just now";
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes} min`;
  }
  if (minutes === 0) {
    return `${hours} hr`;
  }
  return `${hours} hr ${minutes} min`;
}

function formatBadge(finishedToday: number): string | null {
  if (!Number.isFinite(finishedToday) || finishedToday <= 0) {
    return null;
  }
  return `${Math.floor(finishedToday)} today`;
}

function formatHeadline(workingCount: number, waitingCount: number, freeCount: number): string {
  const parts: string[] = [];
  if (workingCount > 0) {
    parts.push(`${workingCount} working`);
  }
  if (waitingCount > 0) {
    const verb = waitingCount === 1 ? "needs" : "need";
    parts.push(`${waitingCount} ${verb} you`);
  }
  if (freeCount > 0) {
    parts.push(`${freeCount} free`);
  }
  if (parts.length === 0) {
    return "Nothing running";
  }
  return parts.join(", ");
}

interface EvaluatedSeat {
  readonly seat: Seat;
  readonly lastUsedAt: number;
}

export function buildBoard(seats: readonly SeatInput[], now: number): Board {
  let busy = 0;
  let free = 0;
  let waiting = 0;

  const evaluated: EvaluatedSeat[] = [];

  for (const input of seats) {
    const state = determineState(input.detected, input.session);
    const line = determineLine(state, input.session);
    const elapsed = formatElapsed(state, input.session, now);
    const badge = formatBadge(input.finishedToday);
    const canStart = state === "idle" && input.detected;

    if (state === "working") {
      busy += 1;
    } else if (state === "waiting") {
      waiting += 1;
    } else if (state === "idle") {
      free += 1;
    }

    evaluated.push({
      seat: {
        providerId: input.providerId,
        label: input.providerLabel,
        state,
        line,
        elapsed,
        badge,
        canStart
      },
      lastUsedAt: Number.isFinite(input.lastUsedAt) ? input.lastUsedAt : 0
    });
  }

  // Waiting seats demand immediate human attention so they precede active work.
  evaluated.sort((a, b) => {
    const priDiff = STATE_ORDER[a.seat.state] - STATE_ORDER[b.seat.state];
    if (priDiff !== 0) {
      return priDiff;
    }
    if (b.lastUsedAt !== a.lastUsedAt) {
      return b.lastUsedAt - a.lastUsedAt;
    }
    return a.seat.providerId.localeCompare(b.seat.providerId);
  });

  const sortedSeats: readonly Seat[] = evaluated.map((item) => item.seat);
  const headline = formatHeadline(busy, waiting, free);

  return {
    seats: sortedSeats,
    headline,
    busy,
    free
  };
}
