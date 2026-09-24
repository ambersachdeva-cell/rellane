/** Startup checks should recover naturally, stop finitely, and never publish late readiness. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeDescriptor } from "@cadrane/contracts";
import { checkBundledModel } from "./bundled-model-readiness.js";

afterEach(() => vi.useRealTimers());

function descriptor(state: RuntimeDescriptor["state"]): RuntimeDescriptor {
  return {
    id: "cadrane-local-loopback", kind: "lm-studio", name: "Rellane Local",
    state, baseUrl: "http://127.0.0.1:12340", version: null,
    models: [{ id: "qwen", displayName: "Qwen", sizeBytes: null, loaded: true }],
    detail: "Synthetic readiness check.", checkedAt: new Date().toISOString()
  };
}

describe("bundled model warmup", () => {
  it.each(["unavailable", "empty"] as const)("recovers from %s startup without a manual retry", async (initial) => {
    vi.useFakeTimers();
    const ready = descriptor("available");
    const discover = vi.fn().mockResolvedValueOnce([
      initial === "empty" ? { ...ready, models: [] } : descriptor("unavailable")
    ]).mockResolvedValue([ready]);
    const waiting = vi.fn();
    const result = checkBundledModel(discover, new AbortController().signal, waiting);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toEqual(ready.models);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(waiting).toHaveBeenCalledWith(1, 8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after eight unsuccessful checks and never exposes stale unavailable models", async () => {
    vi.useFakeTimers();
    const discover = vi.fn().mockResolvedValue([descriptor("unavailable")]);
    const result = checkBundledModel(discover, new AbortController().signal, vi.fn());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toEqual([]);
    expect(discover).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(discover).toHaveBeenCalledTimes(8);
  });

  it.each(["attention", "missing"] as const)("does not disguise %s configuration as a warming model", async (state) => {
    vi.useFakeTimers();
    const discover = vi.fn().mockResolvedValue(state === "missing" ? [] : [descriptor("attention")]);
    const waiting = vi.fn();
    expect(await checkBundledModel(discover, new AbortController().signal, waiting)).toEqual([]);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(waiting).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a scheduled recheck when the workroom unmounts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const discover = vi.fn().mockResolvedValue([descriptor("unavailable")]);
    const result = checkBundledModel(discover, controller.signal, vi.fn());
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not publish a late ready response or overlap pending checks", async () => {
    vi.useFakeTimers();
    let finish!: (value: RuntimeDescriptor[]) => void;
    const discover = vi.fn(() => new Promise<RuntimeDescriptor[]>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const waiting = vi.fn();
    const result = checkBundledModel(discover, controller.signal, waiting);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(discover).toHaveBeenCalledTimes(1);
    controller.abort();
    finish([descriptor("available")]);
    await rejected;
    expect(waiting).not.toHaveBeenCalled();
  });

  it("surfaces an isolated-service failure instead of retrying or using another runtime", async () => {
    const discover = vi.fn().mockRejectedValue(new Error("service unavailable"));
    await expect(checkBundledModel(discover, new AbortController().signal, vi.fn()))
      .rejects.toThrow("service unavailable");
    expect(discover).toHaveBeenCalledTimes(1);
  });
});
