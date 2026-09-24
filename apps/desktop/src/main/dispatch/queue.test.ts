import { describe, expect, it } from "vitest";
import { completionReply, DispatchQueue, TASK_TTL_MS } from "./queue.js";

const NOW = Date.parse("2026-08-21T10:00:00.000Z");

function send(queue: DispatchQueue, text: string, at = NOW, id = "t1") {
  return queue.accept({ id, channel: "telegram", from: "amber", text }, at);
}

describe("presence is a state, not an error", () => {
  it("refuses honestly when Rellane is not running", () => {
    const queue = new DispatchQueue();
    const result = send(queue, "organise my downloads");
    expect(result.accepted).toBe(false);
    expect(result.reply).toMatch(/not running/u);
  });

  it("queues rather than failing when the Mac is asleep, and says so", () => {
    const queue = new DispatchQueue();
    queue.setPresence("asleep");
    const result = send(queue, "organise my downloads");
    expect(result.accepted).toBe(true);
    expect(result.reply).toMatch(/asleep.*will run the moment it wakes/u);
  });

  it("says how many are ahead rather than a bare acknowledgement", () => {
    const queue = new DispatchQueue();
    queue.setPresence("asleep");
    send(queue, "first", NOW, "a");
    const second = send(queue, "second", NOW, "b");
    expect(second.reply).toMatch(/queued behind 1 other task/iu);
  });

  it("answers plainly when it can start immediately", () => {
    const queue = new DispatchQueue();
    queue.setPresence("awake");
    expect(send(queue, "organise").reply).toBe("On it.");
  });

  it("rejects an empty instruction", () => {
    const queue = new DispatchQueue();
    queue.setPresence("awake");
    expect(send(queue, "   ").accepted).toBe(false);
  });
});

describe("scheduling", () => {
  it("hands out nothing while asleep", () => {
    const queue = new DispatchQueue();
    queue.setPresence("asleep");
    send(queue, "organise");
    expect(queue.next(NOW)).toBeNull();
  });

  it("releases queued work the moment it wakes", () => {
    const queue = new DispatchQueue();
    queue.setPresence("asleep");
    send(queue, "organise");
    queue.setPresence("awake");
    expect(queue.next(NOW)?.text).toBe("organise");
  });

  it("runs one at a time", () => {
    const queue = new DispatchQueue();
    queue.setPresence("awake");
    send(queue, "first", NOW, "a");
    send(queue, "second", NOW, "b");

    const first = queue.next(NOW);
    expect(first?.id).toBe("a");
    queue.markRunning("a", NOW);
    expect(queue.next(NOW)).toBeNull();

    queue.markDone("a", "Filed 47 files.", NOW + 5_000);
    expect(queue.next(NOW + 5_000)?.id).toBe("b");
  });

  it("keeps order oldest first", () => {
    const queue = new DispatchQueue();
    queue.setPresence("awake");
    send(queue, "first", NOW, "a");
    send(queue, "second", NOW + 10, "b");
    expect(queue.pending().map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("expiry is announced, never silent", () => {
  it("drops a task that waited too long and returns it to be reported", () => {
    const queue = new DispatchQueue();
    queue.setPresence("asleep");
    send(queue, "organise my downloads");

    const expired = queue.expire(NOW + TASK_TTL_MS + 1);
    expect(expired).toHaveLength(1);
    expect(expired[0]?.state).toBe("expired");
  });

  it("explains what happened rather than going quiet", () => {
    const queue = new DispatchQueue();
    queue.setPresence("asleep");
    send(queue, "organise my downloads");
    const [expired] = queue.expire(NOW + TASK_TTL_MS + 1);
    expect(completionReply(expired!)).toMatch(/never got to.*stayed asleep.*Send it again/su);
  });

  it("leaves a task alone inside the window", () => {
    const queue = new DispatchQueue();
    queue.setPresence("asleep");
    send(queue, "organise");
    expect(queue.expire(NOW + TASK_TTL_MS - 1)).toHaveLength(0);
  });

  it("does not hand out an expired task once the Mac wakes", () => {
    const queue = new DispatchQueue();
    queue.setPresence("asleep");
    send(queue, "organise");
    queue.setPresence("awake");
    expect(queue.next(NOW + TASK_TTL_MS + 1)).toBeNull();
  });
});

describe("what the person is told at the end", () => {
  it("returns the result on success", () => {
    const queue = new DispatchQueue();
    queue.setPresence("awake");
    send(queue, "organise");
    queue.markRunning("t1", NOW);
    queue.markDone("t1", "Filed 47 files into 6 folders.", NOW + 900);
    expect(completionReply(queue.get("t1")!)).toBe("Filed 47 files into 6 folders.");
  });

  it("says what went wrong on failure", () => {
    const queue = new DispatchQueue();
    queue.setPresence("awake");
    send(queue, "organise");
    queue.markFailed("t1", "no folder has been granted", NOW);
    expect(completionReply(queue.get("t1")!)).toMatch(/did not work: no folder/u);
  });

  it("says so when it was not allowed", () => {
    const queue = new DispatchQueue();
    queue.setPresence("awake");
    send(queue, "email everyone");
    queue.markDeclined("t1", "Anything that leaves this machine always asks.", NOW);
    expect(completionReply(queue.get("t1")!)).toMatch(/leaves this machine/u);
  });
});

describe("memory is bounded", () => {
  it("forgets finished tasks after a day but keeps live ones", () => {
    const queue = new DispatchQueue();
    queue.setPresence("awake");
    send(queue, "old", NOW, "a");
    queue.markDone("a", "done", NOW);
    send(queue, "new", NOW, "b");

    queue.prune(NOW + 25 * 60 * 60_000);
    expect(queue.get("a")).toBeNull();
    expect(queue.get("b")).not.toBeNull();
  });
});
