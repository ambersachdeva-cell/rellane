import { afterEach, expect, it, vi } from "vitest";
import { createLocalShortcuts } from "./local-shortcuts.js";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
afterEach(() => vi.useRealTimers());

it("claims before awaiting and admits only its owner's one-use matching kind", async () => {
  const host = createLocalShortcuts(), owner = {}, other = {}, wait = deferred<string>();
  const { handle } = host.begin(owner, "bill-text");
  expect(() => host.begin(other, "bill-file")).toThrow("still finishing");
  expect(host.stop(other, handle)).toEqual({ stopped: false });
  const task = vi.fn(async () => wait.promise);
  await expect(host.run(other, handle, "bill-text", task, () => {})).rejects.toThrow("expired");
  await expect(host.run(owner, handle, "agent-brief", task, () => {})).rejects.toThrow("expired");
  expect(task).not.toHaveBeenCalled();
  const run = host.run(owner, handle, "bill-text", task, () => {});
  await expect(host.run(owner, handle, "bill-text", task, () => {})).rejects.toThrow("already used");
  expect(task).toHaveBeenCalledTimes(1);
  wait.resolve("review only"); expect(await run).toBe("review only");
  await expect(host.run(owner, handle, "bill-text", task, () => {})).rejects.toThrow("expired");
});

it("stops an exact active request, retains admission while it unwinds and refuses its late answer", async () => {
  const host = createLocalShortcuts(), owner = {}, wait = deferred<string>();
  const first = host.begin(owner, "bill-text"); let signal!: AbortSignal;
  const run = host.run(owner, first.handle, "bill-text", async value => { signal = value; return wait.promise; }, () => {});
  const rejected = expect(run).rejects.toThrow("Stopped");
  expect(host.stop(owner, first.handle)).toEqual({ stopped: true });
  expect(signal.aborted).toBe(true);
  expect(() => host.begin(owner, "bill-text")).toThrow("still finishing");
  wait.resolve("late bill"); await rejected;
  const second = host.begin(owner, "bill-text");
  expect(second.handle).not.toBe(first.handle);
  expect(host.stop(owner, first.handle)).toEqual({ stopped: false });
  expect(await host.run(owner, second.handle, "bill-text", async () => "new result", () => {})).toBe("new result");
});

it("expires unused handles and discards reservations on owner navigation", async () => {
  let now = 0; const host = createLocalShortcuts(() => now), owner = {};
  const first = host.begin(owner, "agent-brief"); now = 60_001;
  const task = vi.fn(async () => "not dispatched");
  await expect(host.run(owner, first.handle, "agent-brief", task, () => {})).rejects.toThrow("expired");
  const next = host.begin(owner, "agent-brief"); host.discard(owner);
  await expect(host.run(owner, next.handle, "agent-brief", task, () => {})).rejects.toThrow("expired");
  expect(task).not.toHaveBeenCalled();
  expect(host.begin({}, "bill-file").handle).not.toBe(next.handle);
});

it("checks owner after awaited work and sends deadline cancellation to the running task", async () => {
  const host = createLocalShortcuts(), owner = {}, wait = deferred<string>(); let valid = true;
  const { handle } = host.begin(owner, "bill-file");
  const run = host.run(owner, handle, "bill-file", async () => wait.promise, () => { if (!valid) throw new Error("changed owner"); });
  const rejected = expect(run).rejects.toThrow("changed owner"); valid = false; wait.resolve("stale document"); await rejected;
  vi.useFakeTimers();
  const timed = createLocalShortcuts(Date.now, 10), pending = deferred<string>(); let signal!: AbortSignal;
  const request = timed.begin(owner, "bill-text");
  const timeout = timed.run(owner, request.handle, "bill-text", async value => { signal = value; return pending.promise; }, () => {});
  const ended = expect(timeout).rejects.toThrow("too long");
  await vi.advanceTimersByTimeAsync(11); expect(signal.aborted).toBe(true);
  pending.resolve("late model"); await ended;
});

it("gives file selection its own bounded wait before starting the work deadline once", async () => {
  vi.useFakeTimers();
  const host = createLocalShortcuts(), owner = {}, picked = deferred<void>(), model = deferred<string>();
  const { handle } = host.begin(owner, "bill-file");
  let signal!: AbortSignal, start!: () => void;
  const run = host.run(owner, handle, "bill-file", async (value, check, startReading) => {
    signal = value; start = startReading;
    await picked.promise; check(); startReading();
    return model.promise;
  }, () => {});
  const ended = expect(run).rejects.toThrow("too long");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(signal.aborted).toBe(false);
  expect(() => host.begin(owner, "bill-text")).toThrow("still finishing");
  picked.resolve(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(89_999);
  expect(signal.aborted).toBe(false);
  expect(() => start()).toThrow("already started");
  await vi.advanceTimersByTimeAsync(1);
  expect(signal.aborted).toBe(true);
  model.resolve("late result"); await ended;
});

it("expires an abandoned picker and refuses a later selection before file work", async () => {
  vi.useFakeTimers();
  const host = createLocalShortcuts(), owner = {}, picked = deferred<void>(), work = vi.fn();
  const { handle } = host.begin(owner, "bill-file");
  const run = host.run(owner, handle, "bill-file", async (_signal, _check, startReading) => {
    await picked.promise; startReading(); work(); return "not read";
  }, () => {});
  const ended = expect(run).rejects.toThrow("File selection expired");
  await vi.advanceTimersByTimeAsync(300_001);
  picked.resolve(); await ended;
  expect(work).not.toHaveBeenCalled();
  expect(host.begin(owner, "bill-text").handle).not.toBe(handle);
});

it("does not let Stop restart a selected file's deadline", async () => {
  const host = createLocalShortcuts(), owner = {}, picked = deferred<void>(), work = vi.fn();
  const { handle } = host.begin(owner, "bill-file");
  const run = host.run(owner, handle, "bill-file", async (_signal, _check, startReading) => {
    await picked.promise; startReading(); work(); return "not read";
  }, () => {});
  const ended = expect(run).rejects.toThrow("Stopped");
  host.stop(owner, handle); picked.resolve(); await ended;
  expect(work).not.toHaveBeenCalled();
});
