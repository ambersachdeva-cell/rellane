import { afterEach, expect, it, vi } from "vitest";
import { askWithKey } from "../subscription-brain/api-key.js";
import { discoverProvider } from "../subscription-brain/cli-discovery.js";
import { runProcess } from "../subscription-brain/cli-invoker.js";
import { askEngine } from "./ask.js";

vi.mock("../subscription-brain/api-key.js", async importOriginal => ({
  ...await importOriginal<typeof import("../subscription-brain/api-key.js")>(),
  askWithKey: vi.fn().mockRejectedValue(new Error("Unexpected fictional keyed dispatch"))
}));
vi.mock("../subscription-brain/cli-discovery.js", () => ({ discoverProvider: vi.fn() }));
vi.mock("../subscription-brain/cli-invoker.js", () => ({ runProcess: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it.each(["anthropic-api", "google-api"])("cannot send an agent request through the legacy %s fallback", async engineId => {
  const secrets = { get: vi.fn().mockRejectedValue(new Error("Unexpected fictional credential read")) };
  await expect(askEngine({ engineId, modelId: "fictional-model", system: "Fictional brief", prompt: "Fictional question",
    signal: new AbortController().signal, secrets: secrets as never })).rejects.toThrow("not an engine that can be asked directly");
  expect(askWithKey).not.toHaveBeenCalled();
  expect(secrets.get).not.toHaveBeenCalled();
  expect(discoverProvider).not.toHaveBeenCalled();
  expect(runProcess).not.toHaveBeenCalled();
});
