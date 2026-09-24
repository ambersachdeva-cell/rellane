import { describe, expect, it } from "vitest";
import { buildBoard } from "./crew-board.js";
import type { SeatInput } from "./crew-board.js";

function makeSeat(
  providerId: string,
  overrides?: {
    readonly providerLabel?: string;
    readonly detected?: boolean;
    readonly session?: SeatInput["session"];
    readonly finishedToday?: number;
    readonly lastUsedAt?: number;
  }
): SeatInput {
  return {
    providerId,
    providerLabel: overrides?.providerLabel ?? providerId.toUpperCase(),
    detected: overrides?.detected ?? true,
    session: overrides?.session ?? null,
    finishedToday: overrides?.finishedToday ?? 0,
    lastUsedAt: overrides?.lastUsedAt ?? 0
  };
}

function makeSession(
  status: string,
  options?: {
    readonly caseId?: string;
    readonly caseTitle?: string;
    readonly startedAt?: number;
    readonly waitingTitle?: string | null;
  }
): NonNullable<SeatInput["session"]> {
  return {
    caseId: options?.caseId ?? "case-1",
    caseTitle: options?.caseTitle ?? "General work",
    status,
    startedAt: options?.startedAt ?? 1_000,
    waitingTitle: options?.waitingTitle ?? null
  };
}

describe("buildBoard", () => {
  it("orders seats so waiting is above working above idle above stopped above unavailable", () => {
    const seats: readonly SeatInput[] = [
      makeSeat("codex", {
        session: makeSession("running"),
        lastUsedAt: 100
      }),
      makeSeat("claude", {
        session: makeSession("needs-approval"),
        lastUsedAt: 200
      }),
      makeSeat("gemini1", {
        session: null,
        lastUsedAt: 300
      }),
      makeSeat("gemini2", {
        session: makeSession("completed"),
        lastUsedAt: 400
      }),
      makeSeat("gemini3", {
        detected: false,
        session: null,
        lastUsedAt: 500
      })
    ];

    const board = buildBoard(seats, 5_000);
    const states = board.seats.map((seat) => seat.state);

    expect(states).toEqual(["waiting", "working", "idle", "stopped", "unavailable"]);
  });

  it("breaks ties within a state group by prioritizing the most recently used seat", () => {
    const seats: readonly SeatInput[] = [
      makeSeat("gemini1", { session: null, lastUsedAt: 100 }),
      makeSeat("gemini2", { session: null, lastUsedAt: 300 }),
      makeSeat("gemini3", { session: null, lastUsedAt: 200 })
    ];

    const board = buildBoard(seats, 5_000);
    const order = board.seats.map((seat) => seat.providerId);

    expect(order).toEqual(["gemini2", "gemini3", "gemini1"]);
  });

  it("marks an undetected seat as unavailable and prevents it from starting", () => {
    const seats: readonly SeatInput[] = [
      makeSeat("local-qwen", {
        detected: false,
        session: makeSession("running")
      })
    ];

    const board = buildBoard(seats, 5_000);
    expect(board.seats.length).toBe(1);
    const seat = board.seats[0]!;

    expect(seat.state).toBe("unavailable");
    expect(seat.canStart).toBe(false);
    expect(seat.line).toBe("Not detected on this Mac");
  });

  it("formats elapsed duration in words and falls back to just now for negative or non-finite values", () => {
    // A realistic clock. At now = 100_000 every "four minutes ago" computes to a
    // negative epoch timestamp, which the module refuses on purpose — the
    // fixture was testing the guard rather than the formatting.
    const now = 1_789_000_000_000;
    const seats: readonly SeatInput[] = [
      makeSeat("just-started", {
        session: makeSession("running", { startedAt: now - 30_000 })
      }),
      makeSeat("four-minutes", {
        session: makeSession("running", { startedAt: now - 4 * 60_000 })
      }),
      makeSeat("one-hour", {
        session: makeSession("running", { startedAt: now - 60 * 60_000 })
      }),
      makeSeat("hour-and-min", {
        session: makeSession("running", { startedAt: now - (62 * 60_000) })
      }),
      makeSeat("negative-diff", {
        session: makeSession("running", { startedAt: now + 50_000 })
      }),
      makeSeat("non-finite", {
        session: makeSession("running", { startedAt: Number.NaN })
      }),
      makeSeat("idle-seat", {
        session: null
      })
    ];

    const board = buildBoard(seats, now);
    const byId = new Map(board.seats.map((s) => [s.providerId, s.elapsed]));

    expect(byId.get("just-started")).toBe("just now");
    expect(byId.get("four-minutes")).toBe("4 min");
    expect(byId.get("one-hour")).toBe("1 hr");
    expect(byId.get("hour-and-min")).toBe("1 hr 2 min");
    expect(byId.get("negative-diff")).toBe("just now");
    expect(byId.get("non-finite")).toBe("just now");
    expect(byId.get("idle-seat")).toBe("");
  });

  it("truncates long lines at a word boundary with an ellipsis under eighty characters", () => {
    const longTitle = "Investigate intermittent socket disconnection during peer discovery over local network interface";
    const seats: readonly SeatInput[] = [
      makeSeat("working", {
        session: makeSession("running", { caseTitle: longTitle })
      }),
      makeSeat("short", {
        session: makeSession("running", { caseTitle: "Brief task" })
      })
    ];

    const board = buildBoard(seats, 5_000);
    expect(board.seats.length).toBe(2);
    // By id, not by index: the board orders for usefulness, so an index here
    // was asserting the ordering by accident rather than the truncation.
    const longSeat = board.seats.find((seat) => seat.providerId === "working")!;
    const shortSeat = board.seats.find((seat) => seat.providerId === "short")!;
    expect(longSeat).toBeDefined();
    expect(shortSeat).toBeDefined();

    expect(longSeat.line.length).toBeLessThanOrEqual(80);
    expect(longSeat.line.endsWith("…")).toBe(true);
    expect(longSeat.line).not.toContain("interface");
    expect(shortSeat.line).toBe("Brief task");
  });

  it("handles badge count as absent when zero or below, singular for one, and plural for higher counts", () => {
    const seats: readonly SeatInput[] = [
      makeSeat("zero", { finishedToday: 0 }),
      makeSeat("negative", { finishedToday: -2 }),
      makeSeat("one", { finishedToday: 1 }),
      makeSeat("many", { finishedToday: 3 })
    ];

    const board = buildBoard(seats, 5_000);
    const byId = new Map(board.seats.map((s) => [s.providerId, s.badge]));

    expect(byId.get("zero")).toBeNull();
    expect(byId.get("negative")).toBeNull();
    expect(byId.get("one")).toBe("1 today");
    expect(byId.get("many")).toBe("3 today");
  });

  it("omits zero categories from headline and applies singular grammar where appropriate", () => {
    const allCategories: readonly SeatInput[] = [
      makeSeat("w1", { session: makeSession("running") }),
      makeSeat("w2", { session: makeSession("running") }),
      makeSeat("req", { session: makeSession("needs-approval") }),
      makeSeat("f1", { session: null }),
      makeSeat("f2", { session: null })
    ];
    expect(buildBoard(allCategories, 5_000).headline).toBe("2 working, 1 needs you, 2 free");

    const omittedWaiting: readonly SeatInput[] = [
      makeSeat("w1", { session: makeSession("running") }),
      makeSeat("w2", { session: makeSession("running") }),
      makeSeat("f1", { session: null }),
      makeSeat("f2", { session: null })
    ];
    expect(buildBoard(omittedWaiting, 5_000).headline).toBe("2 working, 2 free");

    const omittedWorking: readonly SeatInput[] = [
      makeSeat("req", { session: makeSession("needs-approval") }),
      makeSeat("f1", { session: null }),
      makeSeat("f2", { session: null })
    ];
    expect(buildBoard(omittedWorking, 5_000).headline).toBe("1 needs you, 2 free");

    const pluralWaiting: readonly SeatInput[] = [
      makeSeat("req1", { session: makeSession("needs-approval") }),
      makeSeat("req2", { session: makeSession("needs-approval") })
    ];
    expect(buildBoard(pluralWaiting, 5_000).headline).toBe("2 need you");

    const singleFree: readonly SeatInput[] = [
      makeSeat("f1", { session: null })
    ];
    expect(buildBoard(singleFree, 5_000).headline).toBe("1 free");
  });

  it("handles empty input gracefully and reports nothing running", () => {
    const board = buildBoard([], 5_000);

    expect(board.seats).toEqual([]);
    expect(board.headline).toBe("Nothing running");
    expect(board.busy).toBe(0);
    expect(board.free).toBe(0);
  });
});
