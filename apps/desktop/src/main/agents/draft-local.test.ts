import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalChatRequest, LocalChatResult, RuntimeDescriptor } from "@cadrane/contracts";
import type { LocalWorkroomDeps } from "../workroom/local.js";
import { draftLocalBrief } from "./draft.js";

const external = vi.hoisted(() => ({ ask: vi.fn(), discover: vi.fn() }));
vi.mock("./ask.js", () => ({ askEngine: external.ask }));
vi.mock("../subscription-brain/engine-room.js", () => ({ readEngineRoom: external.discover }));
const descriptor: RuntimeDescriptor = {
  id: "cadrane-local-loopback", name: "Bundled", kind: "lm-studio", baseUrl: "http://127.0.0.1:12340",
  state: "available", version: null, detail: "Ready", checkedAt: "2026-09-08T00:00:00Z",
  models: [{ id: "actual-local-model", displayName: "Actual model", loaded: true, sizeBytes: 100 }]
};
const proposed = { name: "Local reader", purpose: "Read the chosen note", instructions: "Keep negations.",
  folders: ["/fixture", "/outside"], capabilities: ["read_text", "send_message"],
  tier: "frontier", maxSteps: 999, maxMinutes: 999, outbound: "always" };
function answer(request: LocalChatRequest): LocalChatResult {
  return { operationId: request.operationId, runtimeId: request.runtimeId, modelId: request.modelId,
    content: JSON.stringify(proposed), localOnly: true,
    startedAt: "2026-09-08T00:00:00Z", finishedAt: "2026-09-08T00:00:01Z" };
}
function deps(): LocalWorkroomDeps {
  return { discover: vi.fn(async () => [descriptor]), chat: vi.fn(async request => answer(request)), cancel: vi.fn(async () => undefined) };
}
afterEach(() => {
  expect(external.ask).not.toHaveBeenCalled();
  expect(external.discover).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
describe("local brief creation", () => {
  it("uses the actual bundled model and returns a bounded reviewable brief without widening scope", async () => {
    const runtime = deps();
    const result = await draftLocalBrief("Read one chosen file", ["/fixture"], runtime);
    expect(result.ok).toBe(true);
    expect(result.draft).toMatchObject({ name: "Local reader", instructions: "Keep negations.",
      folders: ["/fixture"], capabilities: ["read_text"], tier: "on-device",
      maxSteps: 60, maxMinutes: 30, outbound: "never" });
    expect(runtime.chat).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: descriptor.id,
      modelId: "actual-local-model", responseProfile: "local-draft-v1", maxTokens: 1024 }));
    expect(result.said).toContain("draft grants no access");
  });
  it("fails closed for unavailable local inference, malformed output and oversized input", async () => {
    const runtime = deps();
    runtime.discover = vi.fn(async () => []);
    const missing = await draftLocalBrief("Read one file", ["/fixture"], runtime);
    expect(missing).toMatchObject({ ok: false, draft: null });
    expect(missing.said).toContain("No subscription was contacted");
    expect(runtime.chat).not.toHaveBeenCalled();
    const oversized = await draftLocalBrief("x".repeat(2001), [], runtime);
    expect(oversized.said).toContain("shorter request");
    runtime.discover = async () => [descriptor];
    runtime.chat = async request => ({ ...answer(request), content: "no usable object" });
    expect(await draftLocalBrief("Read one file", [], runtime)).toMatchObject({ ok: false, draft: null });
  });
  it("cancels the owned request and discards its late proposed brief", async () => {
    const runtime = deps();
    const stop = new AbortController();
    let complete!: (value: LocalChatResult) => void;
    let sent!: LocalChatRequest;
    runtime.chat = vi.fn(request => { sent = request; return new Promise<LocalChatResult>(resolve => { complete = resolve; }); });
    const pending = draftLocalBrief("Read one file", [], runtime, stop.signal).catch(error => error);
    await vi.waitFor(() => expect(runtime.chat).toHaveBeenCalled(), { timeout: 200 });
    stop.abort();
    complete(answer(sent));
    expect(await pending).toMatchObject({ ok: false, draft: null });
    expect(runtime.cancel).toHaveBeenCalledWith(sent.operationId);
  });
});
