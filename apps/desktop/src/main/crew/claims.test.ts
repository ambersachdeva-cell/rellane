import { describe, expect, it } from "vitest";
import { Board, LEASE_MS, MAX_ATTEMPTS } from "./claims.js";

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

const work = (id: string) => ({ id, what: `do ${id}`, doneWhen: `${id} is done` });

describe("two seats never do one job twice", () => {
  it("gives the same job to only one of them", () => {
    const board = new Board(clock().now);
    board.add(work("a"));

    const first = board.claim("gemini · work");
    const second = board.claim("opus · personal");

    expect(first?.id).toBe("a");
    // The whole point: the second seat gets nothing rather than the same job,
    // because two subscriptions spending real quota on one piece of work is the
    // cheapest possible way to waste money.
    expect(second).toBeNull();
  });

  it("hands out different jobs to different seats, oldest first", () => {
    const board = new Board(clock().now);
    board.add(work("a"));
    board.add(work("b"));

    expect(board.claim("one")?.id).toBe("a");
    expect(board.claim("two")?.id).toBe("b");
    expect(board.claim("three")).toBeNull();
  });

  it("ignores the same job being put up twice", () => {
    const board = new Board(clock().now);
    board.add(work("a"));
    board.add({ id: "a", what: "different words", doneWhen: "different" });
    expect(board.all).toHaveLength(1);
  });
});

describe("a seat cannot speak for another seat", () => {
  it("refuses to let one seat finish another's work", () => {
    const board = new Board(clock().now);
    board.add(work("a"));
    board.claim("holder");

    // A seat naming a job it does not hold is a string it got wrong, or was
    // talked into getting wrong. Either way it is not believed.
    expect(board.finish("a", "impostor")).toBe(false);
    expect(board.all[0]?.state).toBe("held");
    expect(board.finish("a", "holder")).toBe(true);
    expect(board.all[0]?.state).toBe("done");
  });

  it("refuses a release and a heartbeat from a seat that is not holding it", () => {
    const board = new Board(clock().now);
    board.add(work("a"));
    board.claim("holder");

    expect(board.release("a", "impostor")).toBe(false);
    expect(board.heartbeat("a", "impostor")).toBe(false);
    expect(board.heartbeat("a", "holder")).toBe(true);
  });

  it("refuses anything at all about a job that does not exist", () => {
    const board = new Board(clock().now);
    expect(board.finish("ghost", "seat")).toBe(false);
    expect(board.release("ghost", "seat")).toBe(false);
    expect(board.heartbeat("ghost", "seat")).toBe(false);
  });
});

describe("a seat that dies does not hold work closed forever", () => {
  it("frees a claim whose lease ran out", () => {
    const time = clock();
    const board = new Board(time.now);
    board.add(work("a"));
    board.claim("died");

    expect(board.claim("other")).toBeNull();
    time.advance(LEASE_MS + 1);
    // Restarted with the same job, which is the OTP idea rather than a novelty.
    expect(board.claim("other")?.id).toBe("a");
  });

  it("keeps a claim alive while the seat is still saying something", () => {
    const time = clock();
    const board = new Board(time.now);
    board.add(work("a"));
    board.claim("working");

    for (let i = 0; i < 5; i += 1) {
      time.advance(LEASE_MS - 1000);
      expect(board.heartbeat("a", "working")).toBe(true);
    }
    expect(board.claim("other")).toBeNull();
  });

  it("gives up rather than retrying forever, and says it needs a person", () => {
    const time = clock();
    const board = new Board(time.now);
    board.add(work("a"));

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      board.claim(`seat${i}`);
      time.advance(LEASE_MS + 1);
    }

    const job = board.all[0];
    expect(job?.state).toBe("abandoned");
    // Quietly re-queueing would spend every budget discovering the same thing.
    expect(job?.gaveUpBecause).toMatch(/needs you/iu);
    expect(board.claim("another")).toBeNull();
  });
});

describe("handing work back", () => {
  it("puts a released job straight back for somebody else", () => {
    const board = new Board(clock().now);
    board.add(work("a"));
    board.claim("cannot-do-it");

    expect(board.release("a", "cannot-do-it")).toBe(true);
    expect(board.claim("someone-else")?.id).toBe("a");
  });
});

describe("what a person reads", () => {
  it("says nothing has been claimed on an empty board", () => {
    expect(new Board(clock().now).sentence).toBe("Nothing claimed yet.");
    expect(new Board(clock().now).settled).toBe(true);
  });

  it("counts what is happening rather than printing a status table", () => {
    const time = clock();
    const board = new Board(time.now);
    board.add(work("a"));
    board.add(work("b"));
    board.add(work("c"));
    board.claim("one");
    board.finish("a", "one");
    board.claim("two");

    expect(board.sentence).toBe("1 being worked on, 1 done, 1 waiting.");
    expect(board.settled).toBe(false);
  });

  it("is singular-aware about work nobody could finish", () => {
    const time = clock();
    const board = new Board(time.now);
    board.add(work("a"));
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      board.claim(`seat${i}`);
      time.advance(LEASE_MS + 1);
    }
    expect(board.sentence).toContain("1 nobody could finish");
    expect(board.settled).toBe(true);
  });
});
