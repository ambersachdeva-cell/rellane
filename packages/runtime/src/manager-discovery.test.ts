/** Cold model verification must not turn a working engine into a global timeout. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeDescriptor } from "@cadrane/contracts";
import type { LocalRuntimeAdapter } from "./adapters/types.js";
import { LocalRuntimeManager } from "./manager.js";
import { SingleLaneScheduler } from "./single-lane.js";

afterEach(() => vi.useRealTimers());

function ready(id = "cadrane-local-loopback"): Extract<RuntimeDescriptor, { kind: "lm-studio" }> {
  return {
    id, kind: "lm-studio", name: "Rellane Local",
    baseUrl: "http://127.0.0.1:12340", state: "available", version: null,
    models: [{ id: "qwen", displayName: "Qwen", sizeBytes: null, loaded: true }],
    detail: "The local model responded.", checkedAt: new Date().toISOString()
  };
}

function adapter(id: string, probe: () => Promise<RuntimeDescriptor>): LocalRuntimeAdapter {
  return {
    id, kind: "lm-studio",
    identity: { name: "Rellane Local", baseUrl: "http://127.0.0.1:12340" },
    probe,
    async chat() { throw new Error("No inference should run during discovery."); }
  };
}

function gate() {
  let resolve!: (value: RuntimeDescriptor) => void;
  const promise = new Promise<RuntimeDescriptor>((finish) => { resolve = finish; });
  return { promise, resolve };
}

describe("independent local-engine readiness", () => {
  it("returns a working bundled engine within four seconds while managed verification continues", async () => {
    vi.useFakeTimers();
    const lane = new SingleLaneScheduler();
    const slow = gate();
    const available = ready();
    const managed: LocalRuntimeAdapter = {
      ...adapter("managed", () => slow.promise), kind: "managed-llama",
      identity: { name: "Managed engine", baseUrl: null },
      scheduling: { owner: "adapter", lane }
    };
    const manager = new LocalRuntimeManager([
      adapter("cadrane-local-loopback", async () => available), managed
    ], lane);
    let observed: RuntimeDescriptor[] | undefined;
    void manager.discover().then((value) => { observed = value; });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(observed?.[0]).toEqual(available);
    expect(observed?.[1]).toMatchObject({
      id: "managed", kind: "managed-llama", name: "Managed engine", baseUrl: null,
      state: "attention", models: [], version: null,
      detail: expect.stringMatching(/still being checked/i)
    });
    // Let background verification finish without changing the already-returned answer.
    slow.resolve({ ...ready(), id: "managed", kind: "managed-llama", baseUrl: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(observed?.[1]?.state).toBe("attention");
  });

  it("contains both rejected and synchronous failed probes without exposing their error text", async () => {
    const manager = new LocalRuntimeManager([
      adapter("ready", async () => ready("ready")),
      adapter("rejected", async () => { throw new Error("private path and token"); }),
      adapter("thrown", () => { throw new Error("private path and token"); })
    ]);
    const results = await manager.discover();
    expect(results.map(({ state }) => state)).toEqual(["available", "attention", "attention"]);
    expect(results.slice(1).every(({ models }) => models.length === 0)).toBe(true);
    expect(JSON.stringify(results)).not.toContain("private path and token");
  });

  it("shares unfinished probes across refreshes and performs a fresh check after they settle", async () => {
    vi.useFakeTimers();
    const slow = gate();
    const probe = vi.fn().mockImplementationOnce(() => slow.promise)
      .mockResolvedValue({ ...ready(), state: "unavailable", models: [] });
    const manager = new LocalRuntimeManager([adapter("cadrane-local-loopback", probe)]);
    const first = manager.discover();
    const second = manager.discover();
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await first)[0]?.state).toBe("attention");
    expect((await second)[0]?.state).toBe("attention");
    expect((await manager.discover())[0]?.models).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(1);
    slow.resolve(ready());
    await vi.advanceTimersByTimeAsync(0);
    expect((await manager.discover())[0]?.state).toBe("unavailable");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("does not leave an old green model visible when the next check stalls", async () => {
    vi.useFakeTimers();
    const slow = gate();
    const probe = vi.fn().mockResolvedValueOnce(ready()).mockImplementation(() => slow.promise);
    const manager = new LocalRuntimeManager([adapter("cadrane-local-loopback", probe)]);
    expect((await manager.discover())[0]?.models).toHaveLength(1);
    const next = manager.discover();
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await next)[0]).toMatchObject({ state: "attention", models: [], version: null });
    slow.resolve(ready());
  });

  it("refuses a probe that claims a different registered engine or address", async () => {
    const manager = new LocalRuntimeManager([
      adapter("wrong-id", async () => ready("another-engine")),
      adapter("wrong-address", async () => ({ ...ready("wrong-address"), baseUrl: "http://127.0.0.1:1234" }))
    ]);
    const results = await manager.discover();
    expect(results.map(({ id, state, models, baseUrl }) => ({ id, state, models, baseUrl })))
      .toEqual([
        { id: "wrong-id", state: "attention", models: [], baseUrl: "http://127.0.0.1:12340" },
        { id: "wrong-address", state: "attention", models: [], baseUrl: "http://127.0.0.1:12340" }
      ]);
  });

  it("does not publish readiness after shutdown starts or wait forever for a hung probe to close", async () => {
    vi.useFakeTimers();
    const slow = gate();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const manager = new LocalRuntimeManager([{ ...adapter("cadrane-local-loopback", () => slow.promise), shutdown }]);
    const discovery = expect(manager.discover()).rejects.toMatchObject({ detail: { code: "RUNTIME_UNAVAILABLE" } });
    await manager.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(1);
    await expect(manager.discover()).rejects.toMatchObject({ detail: { code: "RUNTIME_UNAVAILABLE" } });
    await vi.advanceTimersByTimeAsync(4_000);
    await discovery;
    slow.resolve(ready());
  });
});
