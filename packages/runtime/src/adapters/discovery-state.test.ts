import { describe, expect, it } from "vitest";
import { RuntimeBoundaryError } from "../errors.js";
import { LmStudioAdapter } from "./lm-studio.js";
import { OllamaAdapter } from "./ollama.js";

describe("runtime discovery truth states", () => {
  it("reports unavailable when no local service can be reached", async () => {
    const adapter = new OllamaAdapter(async () => {
      throw new RuntimeBoundaryError({
        code: "RUNTIME_UNAVAILABLE",
        message: "offline",
        retryable: true
      });
    });
    await expect(adapter.probe()).resolves.toMatchObject({
      state: "unavailable"
    });
  });

  it("reports attention when a responsive service violates the adapter contract", async () => {
    const adapter = new LmStudioAdapter(async () => ({ unexpected: true }));
    await expect(adapter.probe()).resolves.toMatchObject({
      state: "attention",
      // The distinction that matters: something IS listening on the port, it
      // just is not what we expected. "Nothing there" and "something wrong
      // there" need different words, because they need different actions.
      detail: expect.stringMatching(/responded .* unexpected contract/i)
    });
  });
});
