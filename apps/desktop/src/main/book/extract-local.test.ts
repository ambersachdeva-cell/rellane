import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalChatRequest, LocalChatResult, RuntimeDescriptor } from "@cadrane/contracts";
import type { LocalWorkroomDeps } from "../workroom/local.js";
import { extractLocalBill, parseBillExcerpts } from "./extract.js";

const external = vi.hoisted(() => ({ ask: vi.fn(), discover: vi.fn() }));
vi.mock("../agents/ask.js", () => ({ askEngine: external.ask }));
vi.mock("../subscription-brain/engine-room.js", () => ({ readEngineRoom: external.discover }));
const source = "Fictional Example Studio. Bill S-42. Date 08/09/2026. Subtotal 8,000.00. GST 1,440.00. Total ₹9,440.";
const fields = { partyName: "Example Studio", number: "S-42", issuedOn: "08/09/2026",
  dueOn: null, subtotal: "8,000.00", tax: "1,440.00", total: "₹9,440" };
const proposed = { scope: "one_bill", fields };
const descriptor: RuntimeDescriptor = {
  id: "cadrane-local-loopback", name: "Bundled", kind: "lm-studio", baseUrl: "http://127.0.0.1:12340",
  state: "available", version: null, detail: "Ready", checkedAt: "2026-09-08T00:00:00Z",
  models: [{ id: "actual-local-model", displayName: "Actual model", loaded: true, sizeBytes: 100 }]
};
function answer(request: LocalChatRequest): LocalChatResult {
  return { operationId: request.operationId, runtimeId: request.runtimeId, modelId: request.modelId,
    content: JSON.stringify(proposed), localOnly: true,
    startedAt: "2026-09-08T00:00:00Z", finishedAt: "2026-09-08T00:00:01Z" };
}
function deps(): LocalWorkroomDeps {
  return { discover: vi.fn(async () => [descriptor]), chat: vi.fn(async request => answer(request)), cancel: vi.fn(async () => undefined) };
}
afterEach(() => {
  expect(external.ask).not.toHaveBeenCalled(); expect(external.discover).not.toHaveBeenCalled(); vi.clearAllMocks();
});
describe("local bill proposals", () => {
  it("keeps the bill on the bundled runtime and derives integer paise while preserving unknowns and source quotes", async () => {
    const runtime = deps();
    const result = await extractLocalBill(source, runtime);
    expect(result).toMatchObject({ ok: true, disagreement: null, bill: {
      totalPaise: { value: 944_000, from: "₹9,440" }, subtotalPaise: { value: 800_000 },
      taxPaise: { value: 144_000 }, issuedOn: { value: "2026-09-08" }, dueOn: { value: null, from: null }
    } });
    expect(result.said).toContain("actual-local-model");
    expect(runtime.chat).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: descriptor.id,
      modelId: "actual-local-model", responseProfile: "bill-excerpts-v1", maxTokens: 1024 }));
  });
  it("refuses unavailable inference and oversized sources before dispatch", async () => {
    const runtime = deps();
    const oversized = await extractLocalBill("x".repeat(8001), runtime);
    expect(oversized.ok).toBe(false); expect(oversized.said).toContain("8,000");
    expect(runtime.discover).not.toHaveBeenCalled();
    runtime.discover = vi.fn(async () => []);
    expect(await extractLocalBill(source, runtime)).toMatchObject({ ok: false, bill: null });
    expect(runtime.chat).not.toHaveBeenCalled();
  });
  it("keeps supported fields while an invented quote or unparseable value stays unknown", () => {
    const result = parseBillExcerpts(JSON.stringify({ ...proposed, fields: { ...fields, total: "invented source", tax: "GST" } }), source);
    expect(result.subtotalPaise).toEqual({ value: 800000, from: "8,000.00" });
    expect(result.totalPaise).toMatchObject({ value: null, from: null, problem: expect.stringContaining("not exact") });
    expect(result.taxPaise).toMatchObject({ value: null, from: "GST", problem: expect.stringContaining("could not be read") });
  });
  it("does not infer missing tax/dates/total and keeps a corrected amount in integer paise", () => {
    const text = "Example Studio R-17. Old amount 1,200.00 cancelled. Revised subtotal 1,050.50. Tax and dates unstated.";
    const result = parseBillExcerpts(JSON.stringify({ scope: "one_bill", fields: { ...fields, number: "R-17",
      subtotal: "1,050.50", tax: null, total: null, issuedOn: null } }), text);
    expect(result.subtotalPaise).toEqual({ value: 105050, from: "1,050.50" });
    for (const key of ["taxPaise", "totalPaise", "issuedOn", "dueOn"] as const) expect(result[key]).toEqual({ value: null, from: null });
  });
  it("refuses ambiguous/multiple bills, missing fields, old value/from format and repeated keys", () => {
    for (const scope of ["multiple_bills", "unclear"])
      expect(() => parseBillExcerpts(JSON.stringify({ ...proposed, scope }), source)).toThrow();
    for (const raw of ["{}", "not JSON", JSON.stringify({ ...proposed, extra: "ignored?" }),
      JSON.stringify({ ...proposed, fields: { ...fields, tax: { value: 1440, from: "GST" } } }),
      JSON.stringify(proposed).replace('"scope":"one_bill"', '"scope":"one_bill","sc\\u006fpe":"unclear"'),
      JSON.stringify({ ...proposed, fields: { ...fields, issuedOn: undefined } })])
      expect(() => parseBillExcerpts(raw, source)).toThrow();
    const invalid = parseBillExcerpts(JSON.stringify({ ...proposed, fields: { ...fields, issuedOn: "31/02/2026", total: "9007199254740992.00" } }), source + " 31/02/2026 9007199254740992.00");
    expect(invalid.issuedOn.value).toBeNull(); expect(invalid.totalPaise.value).toBeNull();
  });
  it("shows arithmetic disagreement without changing either quoted amount", async () => {
    const runtime = deps();
    runtime.chat = async request => ({ ...answer(request), content: JSON.stringify({ ...proposed, fields: { ...fields, total: "9,441" } }) });
    const result = await extractLocalBill(source + " Stated total 9,441.", runtime);
    expect(result.disagreement).toContain("do not add up");
    expect(result.bill?.totalPaise.value).toBe(944100);
    expect(result.bill?.taxPaise.value).toBe(144000);
  });
  it("discards a late bill after cancellation instead of offering its values for saving", async () => {
    const runtime = deps(); const stop = new AbortController();
    let complete!: (value: LocalChatResult) => void; let sent!: LocalChatRequest;
    runtime.chat = vi.fn(request => { sent = request; return new Promise<LocalChatResult>(resolve => { complete = resolve; }); });
    const pending = extractLocalBill(source, runtime, stop.signal).catch(error => error);
    await vi.waitFor(() => expect(runtime.chat).toHaveBeenCalled(), { timeout: 200 });
    stop.abort(); complete(answer(sent));
    expect(await pending).toMatchObject({ ok: false, bill: null });
    expect(runtime.cancel).toHaveBeenCalledWith(sent.operationId);
  });
});
