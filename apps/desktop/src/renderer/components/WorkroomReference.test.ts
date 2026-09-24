import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENQUIRY_FIELDS, ENQUIRY_PROPOSAL_SEAT, ENQUIRY_REVIEW_SEAT, type CaseTurnView, type EnquirySuggestion } from "@cadrane/contracts";
import { readEnquirySummary, referencePreview, savedAgentOutcome, WorkroomConversationGuide, WorkroomReference } from "./WorkroomReference.js";

function fixture(): CaseTurnView[] {
  const source: CaseTurnView = { id: "39c5cb8a-a6a5-4b59-b9f1-bb62679cb975", seq: 1,
    seat: "owner", kind: "verbatim", at: 1, compactedFrom: null,
    body: '250 or 500 cards. Pickup; no delivery. Artwork not approved. <img src="https://example.invalid/image">' };
  const values: EnquirySuggestion["fields"] = {
    item: "cards", quantities: "250 or 500", dimensions: null, printing: null, stock: null,
    finish: null, fulfilment: "Pickup; no delivery", timing: null, destination: null,
    artwork: 'Artwork not approved. <img src="https://example.invalid/image">', invoice: null, changes: null, other: null
  };
  const proposal: CaseTurnView = { ...source, id: "20c58f85-ff5b-4d35-b2b0-98b2a00429bf", seq: 2,
    seat: ENQUIRY_PROPOSAL_SEAT, kind: "finding", body: JSON.stringify({
      version: 1, sourceTurnId: source.id, sourceSha256: "a".repeat(64), modelId: "local",
      operationId: "5a8f9d87-6504-4c88-aabe-c72f376ae219", suggestion: { scope: "one_job", fields: values }
    }) };
  const review: CaseTurnView = { ...source, id: "628d043e-15b4-4f99-827d-634c3dd6f3f6", seq: 3,
    seat: ENQUIRY_REVIEW_SEAT, body: JSON.stringify({
      kind: "Print enquiry reviewed by the owner", version: 1, sourceId: source.id,
      sourceSha256: "a".repeat(64), proposalId: proposal.id,
      fields: ENQUIRY_FIELDS.map(field => ({ field: field.id, quote: values[field.id],
        state: values[field.id] !== null ? "source_excerpt_reviewed" : field.id === "destination" ? "not_needed_by_reviewer" : "unknown" }))
    }, null, 2) };
  return [source, proposal, review];
}
function render(turn: CaseTurnView, turns: CaseTurnView[]) {
  return renderToStaticMarkup(createElement(WorkroomReference, { turn, turns }));
}
function guide(turns: CaseTurnView[], hasAnswers = false) {
  return renderToStaticMarkup(createElement(WorkroomConversationGuide, { turns, hasAnswers, onSources: () => {}, onActivity: () => {} }));
}

describe("reading saved enquiry sources", () => {
  it("shows exact excerpts and distinct unknown/not-needed states with the complete inert record on demand", () => {
    const turns = fixture();
    const review = turns[2]!;
    const original = review.body;
    const html = render(review, turns);
    expect(html).toContain("Saved enquiry brief");
    expect(html).toContain("250 or 500");
    expect(html).toContain("Pickup; no delivery");
    expect(html).toContain("Artwork not approved");
    expect(html).toContain("Unknown · needs follow-up");
    expect(html).toContain("Not needed · your choice");
    expect(html).toContain('<details class="reference-brief__record"><summary>View the complete saved source</summary>');
    expect(html.split("<details")[0]).not.toContain("sourceSha256");
    expect(html).toContain("sourceSha256");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(review.body).toBe(original);
    expect(referencePreview(review, turns)).toContain("250 or 500");
    expect(referencePreview(review, turns)).toContain("Artwork not approved");
    expect(referencePreview(review, turns)).not.toContain(review.id);
    expect(referencePreview(review, turns)).not.toContain("sourceSha256");
  });
  it("falls back to literal source text for malformed, foreign, or nonexact evidence", () => {
    const turns = fixture();
    const review = turns[2]!;
    expect(readEnquirySummary(review, turns)?.sourceSeq).toBe(1);
    for (const available of [turns.slice(1), [turns[0]!, review]]) {
      expect(readEnquirySummary(review, available)).toBeNull();
      const html = render(review, available);
      expect(html).not.toContain("Saved enquiry brief");
      expect(html).toContain("sourceSha256");
    }
    const malformed = { ...review, body: "{incomplete" };
    expect(render(malformed, turns)).toContain("{incomplete");
    const changed = { ...review, body: review.body.replace("250 or 500", "9999") };
    expect(readEnquirySummary(changed, turns)).toBeNull();
    expect(referencePreview(malformed, turns)).toBe("{incomplete");
    expect(render({ ...review, seat: "owner" }, turns)).not.toContain("Saved enquiry brief");
  });
  it("directs a person to their existing sources or review without repeating the empty Add sources step", () => {
    const turns = fixture();
    expect(guide([])).toContain("Add sources →");
    expect(guide([turns[0]!])).toContain("Start with your brief.");
    expect(guide([turns[0]!, { ...turns[0]!, id: "another-note", seq: 2 }])).toContain("Your sources are ready.");
    expect(guide(turns.slice(0, 2))).toContain("Review fields and original message →");
    const reviewed = guide(turns);
    expect(reviewed).toContain("Your reviewed enquiry brief is ready.");
    expect(reviewed).toContain("View your reviewed brief →");
    expect(reviewed).not.toContain("Add sources");
    expect(guide([turns[0]!], true)).toBe("");
    // An unreviewed newer suggestion still requires review, even if an older one was saved.
    expect(guide([...turns, { ...turns[1]!, id: "new-proposal", seq: 4 }])).toContain("Enquiry details are ready for your review.");
  });
});

describe("saved agent outcomes in Conversation", () => {
  const id = "fb36f6fb-78f4-4aa9-b034-885c3e129b78";
  const start: CaseTurnView = { id, seq: 2, seat: "agent run", kind: "receipt", at: 1,
    compactedFrom: null, body: `Agent run ${id} started on this Mac.\nSaved brief.` };
  const terminal = (outcome: string): CaseTurnView => ({ ...start, id: "result", seq: 3,
    body: `Agent run ${id} finished — ${outcome}.\nSaved outcome.` });

  it("distinguishes stopped/failed/refused records from a new or running request", () => {
    for (const [outcome, heading] of [["stopped", "was stopped"], ["failed", "did not finish"], ["refused", "was refused"]]) {
      const turns = [start, terminal(outcome!)];
      const before = JSON.stringify(turns);
      const html = guide(turns);
      expect(html).toContain(heading);
      expect(html).toContain("View the run record →");
      expect(html).not.toContain("Start with");
      expect(html).toContain("does not restart");
      expect(JSON.stringify(turns)).toBe(before);
    }
    expect(savedAgentOutcome([start, terminal("answered")])).toBe("answered");
    expect(guide([start, terminal("answered")], true)).toBe("");
  });

  it("does not infer completion or live execution from a start or another attempt's ending", () => {
    const foreign = { ...terminal("stopped"), body: terminal("stopped").body.replace(id, "9de6e2ab-5c88-4781-b78c-2dfd8cb65bba") };
    for (const turns of [[start], [start, foreign], [start, { ...terminal("stopped"), seq: 1 }],
      [start, terminal("stopped"), { ...terminal("failed"), seq: 4 }]]) {
      expect(savedAgentOutcome(turns)).toBe("unconfirmed");
      expect(guide(turns)).toContain("No completion is recorded");
      expect(guide(turns)).toContain("Check the Agents page");
    }
  });

  it("does not promote source/model text or malformed receipt headers into a run status", () => {
    expect(savedAgentOutcome([{ ...start, seat: "owner" }, terminal("stopped")])).toBeNull();
    expect(savedAgentOutcome([{ ...start, kind: "verbatim" }, terminal("stopped")])).toBeNull();
    expect(savedAgentOutcome([{ ...start, body: start.body.replace(id, "not-a-valid-attempt") }, terminal("stopped")])).toBeNull();
  });
});
