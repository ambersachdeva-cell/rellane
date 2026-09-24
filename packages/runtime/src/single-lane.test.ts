import { describe, expect, it } from "vitest";
import { RuntimeBoundaryError } from "./errors.js";
import { SingleLaneScheduler } from "./single-lane.js";

describe("SingleLaneScheduler", () => {
  it("serializes GPU-heavy operations", async () => {
    const scheduler = new SingleLaneScheduler();
    const events: string[] = [];

    const first = scheduler.enqueue("first", async () => {
      events.push("first:start");
      await Promise.resolve();
      events.push("first:end");
      return 1;
    });
    const second = scheduler.enqueue("second", async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("cancels queued work before it executes", async () => {
    const scheduler = new SingleLaneScheduler();
    let release = () => {};
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = scheduler.enqueue("first", async () => {
      await blocker;
      return "done";
    });
    const second = scheduler.enqueue("second", async () => "should-not-run");

    expect(scheduler.cancel("second")).toBe(true);
    await expect(second).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
    release();
    await expect(first).resolves.toBe("done");
  });

  it("rejects overload after a bounded number of queued operations", async () => {
    const scheduler = new SingleLaneScheduler(2);
    let release = () => {};
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = scheduler.enqueue("active", async () => {
      await blocker;
      return "done";
    });
    const queued = [
      scheduler.enqueue("queued-1", async () => "one"),
      scheduler.enqueue("queued-2", async () => "two")
    ];

    await expect(
      scheduler.enqueue("overflow", async () => "never")
    ).rejects.toMatchObject({
      detail: { code: "BUSY" }
    });

    release();
    await expect(active).resolves.toBe("done");
    await expect(Promise.all(queued)).resolves.toEqual(["one", "two"]);
  });

  it("permanently rejects active, queued, and future work after poison", async () => {
    const scheduler = new SingleLaneScheduler();
    let queuedRan = false;
    const active = scheduler.enqueue("active", (signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true
        });
      })
    );
    const queued = scheduler.enqueue("queued", async () => {
      queuedRan = true;
      return "unsafe";
    });
    const poison = new RuntimeBoundaryError({
      code: "RUNTIME_UNAVAILABLE",
      message: "Native process cleanup was not confirmed.",
      retryable: false
    });

    scheduler.poison(poison);

    await expect(active).rejects.toBe(poison);
    await expect(queued).rejects.toBe(poison);
    await expect(
      scheduler.enqueue("future", async () => "unsafe")
    ).rejects.toBe(poison);
    expect(queuedRan).toBe(false);
    expect(scheduler.isPoisoned()).toBe(true);
  });

  it("runs a native cleanup barrier ahead of ordinary queued work", async () => {
    const scheduler = new SingleLaneScheduler();
    const gate = deferred<void>();
    const events: string[] = [];
    const active = scheduler.enqueue("active", async () => {
      events.push("active");
      await gate.promise;
    });
    const ordinary = scheduler.enqueue("ordinary", async () => {
      events.push("ordinary");
    });
    const barrier = scheduler.enqueuePriorityBarrier(
      "internal-cleanup",
      async () => {
        events.push("barrier");
      }
    );
    const later = scheduler.enqueue("later", async () => {
      events.push("later");
    });

    gate.resolve(undefined);
    await Promise.all([active, ordinary, barrier, later]);

    expect(events).toEqual(["active", "barrier", "ordinary", "later"]);
  });

  it("overrides an active fetch-like retryable cancellation with permanent poison", async () => {
    const scheduler = new SingleLaneScheduler();
    const active = scheduler.enqueue("external-fetch", (signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new RuntimeBoundaryError({
            code: "CANCELLED",
            message: "The loopback fetch was cancelled.",
            retryable: true
          }));
        }, { once: true });
      })
    );
    const poison = new RuntimeBoundaryError({
      code: "RUNTIME_UNAVAILABLE",
      message: "Native cleanup was not confirmed.",
      retryable: false
    });

    scheduler.poison(poison);

    await expect(active).rejects.toBe(poison);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
