/** Exercise real HTTP classification before the separately tested workroom
 * retry loop consumes it; no runtime server or credential is contacted. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeBoundaryError } from "../errors.js";
import { LmStudioAdapter } from "./lm-studio.js";
import { requestJson } from "./safe-fetch.js";

const SYNTHETIC_BEARER = "a".repeat(43);

function bundled() {
  vi.stubEnv("CADRANE_LOCAL_BASE_URL", "http://127.0.0.1:12340");
  return new LmStudioAdapter(requestJson, SYNTHETIC_BEARER);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("bundled model loading responses", () => {
  it("reports a bounded HTTP 503 as unavailable, then returns only freshly observed models", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"Loading model"}}', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "fixture-model" }] }));
    vi.stubGlobal("fetch", fetch);
    const adapter = bundled();
    await expect(adapter.probe()).resolves.toMatchObject({ state: "unavailable", models: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(adapter.probe()).resolves.toMatchObject({
      state: "available",
      models: [{ id: "fixture-model", displayName: "fixture-model", sizeBytes: null, loaded: null }]
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetch.mock.calls) {
      expect(url.toString()).toBe("http://127.0.0.1:12340/v1/models");
      expect(options.method).toBe("GET");
      expect(options.body).toBeUndefined();
    }
  });

  it("keeps a 503 from an unrelated LM Studio endpoint in attention", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not the bundled server", { status: 503 })));
    await expect(new LmStudioAdapter().probe()).resolves.toMatchObject({
      state: "attention", models: []
    });
  });

  it.each([401, 403, 404, 500])("does not retry HTTP %s as ordinary startup", async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response("do not expose this body", { status }));
    vi.stubGlobal("fetch", fetch);
    const adapter = bundled();
    await expect(adapter.probe()).resolves.toMatchObject({ state: "attention", models: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not mistake malformed success or oversized loading responses for readiness", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ wrong: "shape" }))
      .mockResolvedValueOnce(new Response("not JSON"))
      .mockResolvedValueOnce(new Response("x".repeat(1_000_001), { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const adapter = bundled();
    for (let index = 0; index < 3; index += 1) {
      await expect(adapter.probe()).resolves.toMatchObject({ state: "attention", models: [] });
    }
  });

  it("treats a rejected security boundary as attention, not startup", async () => {
    const adapter = new LmStudioAdapter(async () => {
      throw new RuntimeBoundaryError({ code: "SECURITY_BOUNDARY", message: "refused", retryable: false });
    }, SYNTHETIC_BEARER);
    await expect(adapter.probe()).resolves.toMatchObject({ state: "attention", models: [] });
  });
});
