/** A real room store verifies source custody, review provenance and failure atomicity. */
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENQUIRY_PROPOSAL_SEAT, ENQUIRY_REVIEW_SEAT, type CaseEnquirySave,
  type EnquirySuggestion, type LocalChatRequest, type RuntimeDescriptor
} from "@cadrane/contracts";
import { appendTurn, closeCase, eraseCase, openCase, turnsFor } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { enquirySource, makeEnquiryProposal, parseEnquirySuggestion, saveEnquiryReview } from "./enquiry.js";
import { LocalWorkroom, type LocalWorkroomDeps } from "./local.js";

const sourceText = "250 or 500 business cards, 90 x 50 mm, 300 GSM uncoated. Black ink one side. Pickup, no delivery. Artwork tomorrow; not approved yet. No fixed deadline. No GST invoice needed.";
const suggestion: EnquirySuggestion = { scope: "one_job", fields: {
  item: "business cards", quantities: "250 or 500", dimensions: "90 x 50 mm",
  printing: "Black ink one side", stock: "300 GSM uncoated", finish: null,
  fulfilment: "Pickup, no delivery", timing: "No fixed deadline", destination: null,
  artwork: null, invoice: "No GST invoice needed", changes: null, other: null
} };
const runtime: RuntimeDescriptor = {
  id: "cadrane-local-loopback", kind: "lm-studio", name: "Bundled",
  baseUrl: "http://127.0.0.1:12340", state: "available", version: null,
  detail: "Observed", checkedAt: "2026-09-08T00:00:00.000Z",
  models: [{ id: "qwen", displayName: "Qwen", loaded: true, sizeBytes: null }]
};
let db: DatabaseSync;
let id: string;
let sourceId: string;
beforeEach(() => {
  db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  id = openCase(db, { title: "Synthetic enquiry", question: "Review one job" });
  sourceId = appendTurn(db, id, { seat: "owner", kind: "verbatim", body: sourceText });
});
afterEach(() => db.close());
function proposal(scope: EnquirySuggestion["scope"] = "one_job"): string {
  const value = makeEnquiryProposal(db, id, sourceId, "qwen", randomUUID(), JSON.stringify({ ...suggestion, scope }));
  return appendTurn(db, id, { seat: ENQUIRY_PROPOSAL_SEAT, kind: "finding", body: JSON.stringify(value) });
}
function review(proposalTurnId = proposal()): CaseEnquirySave {
  return { id, proposalTurnId, operationId: randomUUID(), fields: { ...suggestion.fields },
    notNeeded: [], reviewedSource: true, oneJob: true };
}
function harness() {
  const requests: LocalChatRequest[] = [];
  const cancelled: string[] = [];
  const deps: LocalWorkroomDeps = {
    discover: async () => [runtime],
    chat: async input => {
      requests.push(input);
      return { operationId: input.operationId, runtimeId: input.runtimeId, modelId: input.modelId,
        localOnly: true, content: JSON.stringify(suggestion),
        startedAt: "2026-09-08T00:00:00.000Z", finishedAt: "2026-09-08T00:00:01.000Z" };
    },
    cancel: async operationId => { cancelled.push(operationId); }
  };
  return { deps, requests, cancelled };
}
describe("bounded enquiry review", () => {
  it("preserves options and negated excerpts while keeping an omitted fact unknown", () => {
    expect(parseEnquirySuggestion(JSON.stringify(suggestion), sourceText)).toEqual(suggestion);
    const hindi = { ...suggestion, fields: { ...suggestion.fields, item: "कार्ड", quantities: "250 या 500", invoice: "GST बिल नहीं" } };
    expect(parseEnquirySuggestion(JSON.stringify(hindi), sourceText + " कार्ड, 250 या 500. GST बिल नहीं").fields.invoice).toBe("GST बिल नहीं");
    expect(parseEnquirySuggestion(JSON.stringify(suggestion), sourceText).fields.artwork).toBeNull();
  });
  it("refuses invented quotes, missing keys, extra instructions and invalid shapes", () => {
    expect(() => parseEnquirySuggestion(JSON.stringify({ ...suggestion, fields: { ...suggestion.fields, artwork: "approved" + " for print" } }), sourceText)).toThrow("not exact");
    const { item: _item, ...missing } = suggestion.fields;
    for (const value of [
      { ...suggestion, fields: missing },
      { ...suggestion, send_message: true },
      { ...suggestion, scope: "safe" },
      { ...suggestion, fields: { ...suggestion.fields, item: ["business cards"] } }
    ]) expect(() => parseEnquirySuggestion(JSON.stringify(value), sourceText)).toThrow("unsupported or missing");
    expect(() => parseEnquirySuggestion("thinking\n" + JSON.stringify(suggestion), sourceText)).toThrow("complete");
    expect(() => parseEnquirySuggestion(" ".repeat(9_001), sourceText)).toThrow("oversized");
  });
  it("refuses duplicate keys including escaped spellings, without treating quoted data as keys", () => {
    const json = JSON.stringify(suggestion);
    expect(() => parseEnquirySuggestion(json.replace('"scope":', '"scope":"unclear","scope":'), sourceText)).toThrow("repeated");
    expect(() => parseEnquirySuggestion(json.replace('"item":', '"item":null,"\\u0069tem":'), sourceText)).toThrow("repeated");
    const text = 'Print "scope": literal';
    expect(parseEnquirySuggestion(JSON.stringify({ ...suggestion, fields: { ...suggestion.fields, other: text } }), sourceText + text).fields.other).toBe(text);
  });
  it("resolves only original sources from this room within the input budget", () => {
    const other = openCase(db, { title: "Other", question: "Private" });
    expect(() => enquirySource(db, other, sourceId)).toThrow("original enquiry");
    for (const seat of ["Local · qwen", "Source · CSV · orders.csv", ENQUIRY_REVIEW_SEAT, "Source · Checked data"]) {
      const turn = appendTurn(db, id, { seat, kind: "verbatim", body: sourceText });
      expect(() => enquirySource(db, id, turn)).toThrow("original enquiry");
    }
    const long = appendTurn(db, id, { seat: "owner", kind: "verbatim", body: "a".repeat(4_001) });
    expect(() => enquirySource(db, id, long)).toThrow("4,000");
  });
  it("saves human corrections, exact ranges, provenance and unresolved questions without accepting an order", () => {
    const input = review();
    input.fields.artwork = "Artwork tomorrow; not approved yet";
    input.notNeeded = ["destination", "finish"];
    const saved = saveEnquiryReview(db, input);
    const turn = turnsFor(db, id).find(one => one.id === saved)!;
    expect(turn.seat).toBe(ENQUIRY_REVIEW_SEAT);
    const evidence = JSON.parse(turn.body) as {
      sourceId: string; sourceSha256: string;
      fields: { field: string; quote: string | null; changedByReviewer: boolean; sourceRange: { start: number; end: number } | null; state: string }[];
      suggestedClarifications: string[]; limits: string;
    };
    expect(evidence.sourceId).toBe(sourceId);
    expect(evidence.sourceSha256).toBe(createHash("sha256").update(sourceText).digest("hex"));
    const artwork = evidence.fields.find(field => field.field === "artwork")!;
    expect(artwork.changedByReviewer).toBe(true);
    expect(sourceText.slice(artwork.sourceRange!.start, artwork.sourceRange!.end)).toBe(artwork.quote);
    expect(evidence.fields.find(field => field.field === "destination")?.state).toBe("not_needed_by_reviewer");
    expect(evidence.suggestedClarifications).not.toContain("What is the complete delivery address, if delivery is needed?");
    expect(evidence.suggestedClarifications).toContain("Are there any other requirements to confirm?");
    expect(evidence.limits).toContain("not a confirmed order or quote");
    expect(turnsFor(db, id).at(-1)?.body).toContain(input.operationId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM case_artifact_version").get()?.["n"]).toBe(0);
  });
  it("requires explicit review, one supported job, an item and consistent not-needed choices", () => {
    const input = review();
    expect(() => saveEnquiryReview(db, { ...input, reviewedSource: false } as unknown as CaseEnquirySave)).toThrow();
    expect(() => saveEnquiryReview(db, { ...input, oneJob: false } as unknown as CaseEnquirySave)).toThrow();
    expect(() => saveEnquiryReview(db, { ...input, fields: { ...input.fields, item: null } })).toThrow("printed item");
    expect(() => saveEnquiryReview(db, { ...input, notNeeded: ["item"] })).toThrow("also be marked");
    for (const scope of ["multiple_jobs", "unclear"] as const)
      expect(() => saveEnquiryReview(db, review(proposal(scope)))).toThrow("Separate");
  });
  it("refuses a foreign proposal, mismatched source and duplicate save without extra evidence", () => {
    const input = review();
    const other = openCase(db, { title: "Other", question: "Private" });
    expect(() => saveEnquiryReview(db, { ...input, id: other })).toThrow("suggestion from this workroom");
    saveEnquiryReview(db, input);
    const before = turnsFor(db, id);
    expect(() => saveEnquiryReview(db, input)).toThrow("already saved");
    expect(turnsFor(db, id)).toEqual(before);
    db.prepare("UPDATE case_turn SET body=? WHERE id=?").run(sourceText + " changed", sourceId);
    expect(() => saveEnquiryReview(db, { ...input, operationId: randomUUID() })).toThrow("no longer matches");
  });
  it("rolls back evidence when its receipt fails and refuses closed or erased rooms", () => {
    const input = review();
    const before = turnsFor(db, id);
    db.exec("CREATE TRIGGER refuse_enquiry BEFORE INSERT ON case_turn WHEN NEW.kind='receipt' BEGIN SELECT RAISE(ABORT, 'receipt refused'); END");
    expect(() => saveEnquiryReview(db, input)).toThrow("receipt refused");
    expect(turnsFor(db, id)).toEqual(before);
    closeCase(db, id, { closedAs: "settled", verdict: "Done" });
    expect(() => saveEnquiryReview(db, input)).toThrow("Open this workroom");
    eraseCase(db, id);
    expect(() => enquirySource(db, id, sourceId)).toThrow("no longer available");
  });
  it("uses the existing local operation and stores suggestions outside reusable model context", async () => {
    const h = harness(); const service = new LocalWorkroom();
    appendTurn(db, id, { seat: "owner", kind: "verbatim", body: "UNSELECTED_PRIVATE" });
    const input = { id, sourceTurnId: sourceId, modelId: "qwen", operationId: randomUUID() };
    await service.prepareEnquiry(db, input, h.deps);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.responseProfile).toBe("print-enquiry-v1");
    expect(h.requests[0]?.messages[1]?.content).toContain(sourceText);
    expect(h.requests[0]?.messages[1]?.content).not.toContain("UNSELECTED_PRIVATE");
    const saved = turnsFor(db, id).at(-2)!;
    expect(saved.kind).toBe("finding");
    expect(saved.seat).toBe(ENQUIRY_PROPOSAL_SEAT);
    expect(turnsFor(db, id).at(-1)?.body).toContain("not reusable evidence");
    await expect(service.run(db, { ...input, question: "Reuse it", sourceTurnIds: [saved.id] }, h.deps)).rejects.toThrow("selected source");
    await expect(service.prepareEnquiry(db, input, h.deps)).rejects.toThrow("already recorded");
    expect(service.current(id)).toBeNull();
  });
  it("retains a failure receipt but no suggestion when extraction is invalid or stopped", async () => {
    const h = harness(); const service = new LocalWorkroom();
    const valid = h.deps.chat;
    h.deps.chat = async payload => ({ ...await valid(payload), content: JSON.stringify({ ...suggestion, fields: { ...suggestion.fields, item: "invented item" } }) });
    await expect(service.prepareEnquiry(db, { id, sourceTurnId: sourceId, modelId: "qwen", operationId: randomUUID() }, h.deps)).rejects.toThrow("not exact");
    expect(turnsFor(db, id).some(turn => turn.seat === ENQUIRY_PROPOSAL_SEAT)).toBe(false);
    expect(turnsFor(db, id).at(-1)?.body).toContain("did not complete");
    const input = { id, sourceTurnId: sourceId, modelId: "qwen", operationId: randomUUID() };
    h.deps.chat = async payload => {
      expect(turnsFor(db, id).at(-1)?.body).toContain("started");
      await expect(service.prepareEnquiry(db, { ...input, operationId: randomUUID() }, h.deps)).rejects.toThrow("already running");
      await service.stop(id, input.operationId, h.deps);
      return valid(payload);
    };
    await expect(service.prepareEnquiry(db, input, h.deps)).rejects.toThrow("late answer");
    expect(turnsFor(db, id).at(-1)?.body).toContain("stop requested; did not complete");
    expect(turnsFor(db, id).some(turn => turn.seat === ENQUIRY_PROPOSAL_SEAT)).toBe(false);
    expect(h.cancelled).toContain(input.operationId);
    expect(service.current(id)).toBeNull();
  });
});
