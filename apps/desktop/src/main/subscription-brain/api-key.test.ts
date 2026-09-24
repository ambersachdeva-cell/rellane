/**
 * The fallback path: a key the owner pays per token for.
 *
 * These are mostly about what must *not* happen. A keyed engine is the one
 * place in this product that holds a credential for the length of a request,
 * and every test here is a way that could go wrong.
 */

import { describe, expect, it, vi } from "vitest";
import { askWithKey, KEYED_ENGINES, keyedEngine, KeyedEngineError } from "./api-key.js";
import type { SecretStore } from "../security/secrets.js";

const store = (value: string | null): SecretStore =>
  ({ get: async () => value }) as unknown as SecretStore;

const replies = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;

const ask = {
  modelId: "claude-sonnet-4",
  system: "Be careful.",
  prompt: "What is outstanding?",
  signal: new AbortController().signal
} as const;

describe("the key itself", () => {
  it("goes in a header and nowhere else", async () => {
    const fetcher = vi.fn(replies({ content: [{ text: "Nothing." }] }));

    await askWithKey(
      { ...ask, engineId: "anthropic-api" },
      store("sk-secret-value"),
      fetcher as unknown as typeof fetch
    );

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("sk-secret-value");
    expect((init as RequestInit).body).not.toContain("sk-secret-value");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "sk-secret-value" });
  });

  it("says where to put one rather than failing obscurely", async () => {
    await expect(
      askWithKey({ ...ask, engineId: "anthropic-api" }, store(null), replies({}))
    ).rejects.toThrow(/No API key is stored/u);
  });

  it("points back at the subscription, which is still the preferred route", async () => {
    // D-022's order survives contact with the fallback: somebody paying for
    // Claude Pro must not quietly end up paying per token as well.
    await expect(
      askWithKey({ ...ask, engineId: "anthropic-api" }, store("   "), replies({}))
    ).rejects.toThrow(/subscription you already pay for/u);
  });
});

describe("what comes back", () => {
  it("reads an answer out of each vendor's own shape", async () => {
    expect(
      await askWithKey(
        { ...ask, engineId: "anthropic-api" },
        store("k"),
        replies({ content: [{ text: "Seven " }, { text: "thousand." }] })
      )
    ).toBe("Seven thousand.");

    expect(
      await askWithKey(
        { ...ask, engineId: "google-api" },
        store("k"),
        replies({ candidates: [{ content: { parts: [{ text: "Seven thousand." }] } }] })
      )
    ).toBe("Seven thousand.");
  });

  it("treats a 200 with no answer in it as unreadable, not as silence", async () => {
    // Silence on the record looks like the model considered the question and
    // had nothing to say, which is a different and more misleading thing.
    await expect(
      askWithKey({ ...ask, engineId: "anthropic-api" }, store("k"), replies({ content: [] }))
    ).rejects.toThrow(/not an answer/u);
  });

  it("never repeats the vendor's error body, which can echo the prompt", async () => {
    const echoing = (async () =>
      new Response(JSON.stringify({ error: { message: "bad request: What is outstanding?" } }), {
        status: 400
      })) as unknown as typeof fetch;

    await expect(
      askWithKey({ ...ask, engineId: "anthropic-api" }, store("k"), echoing)
    ).rejects.toThrow(/answered with 400/u);
    await expect(
      askWithKey({ ...ask, engineId: "anthropic-api" }, store("k"), echoing)
    ).rejects.not.toThrow(/What is outstanding/u);
  });

  it("blames the key when the vendor refuses it, and the network when it cannot be reached", async () => {
    const refused = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const offline = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(
      askWithKey({ ...ask, engineId: "anthropic-api" }, store("k"), refused)
    ).rejects.toThrow(/refused that key/u);
    await expect(
      askWithKey({ ...ask, engineId: "anthropic-api" }, store("k"), offline)
    ).rejects.toThrow(/usually the network/u);
  });
});

describe("the shelf", () => {
  it("offers exactly the two engines that can be keyed", () => {
    expect(KEYED_ENGINES.map((engine) => engine.id)).toEqual(["anthropic-api", "google-api"]);
    expect(keyedEngine("anthropic-api")?.keysAt).toContain("anthropic.com");
    expect(keyedEngine("nonsense")).toBeUndefined();
  });

  it("only ever throws its own error type, so callers can report it as one thing", async () => {
    await expect(
      askWithKey(
        { ...ask, engineId: "nonsense" as "anthropic-api" },
        store("k"),
        replies({})
      )
    ).rejects.toBeInstanceOf(KeyedEngineError);
  });
});
