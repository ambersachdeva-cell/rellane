import { expect, it, vi } from "vitest";
import { createLocalShortcutRequest } from "./local-shortcut.js";

it("a Stop before begin returns cancels only the late handle and never dispatches", async () => {
  let release!: (value: { handle: string }) => void;
  const api = { begin: vi.fn(() => new Promise<{ handle: string }>(r => { release = r; })), stop: vi.fn(async (_input: { handle: string }) => ({ stopped: true })) };
  const request = createLocalShortcutRequest(api, "bill-text"), task = vi.fn(async () => "must not run");
  const run = request.run(task); request.stop(); release({ handle: "first-host-handle" });
  expect(await run).toBeNull(); expect(task).not.toHaveBeenCalled();
  expect(api.stop).toHaveBeenCalledExactlyOnceWith({ handle: "first-host-handle" });
});

it("a stopped in-flight result is never offered for application, including a late rejection", async () => {
  for (const fail of [false, true]) {
    const api = { begin: vi.fn(async () => ({ handle: "exact-host-handle" })), stop: vi.fn(async (_input: { handle: string }) => ({ stopped: true })) };
    let finish!: () => void;
    const request = createLocalShortcutRequest(api, "bill-file");
    const task = vi.fn(() => new Promise<string>((resolve, reject) => { finish = () => fail ? reject(new Error("late")) : resolve("late"); }));
    const run = request.run(task);
    await vi.waitFor(() => expect(task).toHaveBeenCalledExactlyOnceWith("exact-host-handle"));
    request.stop(); finish(); expect(await run).toBeNull();
    expect(api.stop.mock.calls.every(args => args[0].handle === "exact-host-handle")).toBe(true);
  }
});

it("preserves ordinary errors, releases unused dispatch reservations and refuses reuse", async () => {
  const api = { begin: vi.fn(async () => ({ handle: "host" })), stop: vi.fn(async (_input: { handle: string }) => ({ stopped: true })) };
  const request = createLocalShortcutRequest(api, "agent-brief");
  await expect(request.run(async () => { throw new Error("dispatch failed"); })).rejects.toThrow("dispatch failed");
  expect(api.stop).toHaveBeenCalledWith({ handle: "host" });
  await expect(request.run(async () => "again")).rejects.toThrow("already started");
  const stopped = createLocalShortcutRequest(api, "agent-brief"); stopped.stop();
  expect(await stopped.run(async () => "no")).toBeNull();
  expect(api.begin).toHaveBeenCalledTimes(1);
});
