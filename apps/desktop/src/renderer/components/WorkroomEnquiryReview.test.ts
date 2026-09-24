/** Reopening must show the human's saved corrections, never silently replace them with AI suggestions. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENQUIRY_FIELDS, ENQUIRY_PROPOSAL_SEAT, ENQUIRY_REVIEW_SEAT, type CaseRoom, type EnquiryProposal } from "@cadrane/contracts";
import { WorkroomEnquiryReview } from "./WorkroomEnquiryReview.js";
const sourceId = "c3453d66-0d37-42e1-a9d3-8da6de578011";
const proposalId = "92371aaa-07ef-4239-a282-2d04f605b9ab";
const reviewId = "d679976f-b482-40f8-ae30-b11d9c4d8549";
const proposal: EnquiryProposal = {
  version: 1, sourceTurnId: sourceId, sourceSha256: "a".repeat(64),
  modelId: "qwen", operationId: "bc182e70-aa2f-46cf-87dd-09ce6113670c",
  suggestion: { scope: "one_job", fields: {
    item: "cards", quantities: "250 or 500", dimensions: null, printing: null,
    stock: null, finish: null, fulfilment: "Pickup", timing: null, destination: null,
    artwork: null, invoice: null, changes: null, other: null
  } }
};
function fixture(linkedProposalId = proposalId): CaseRoom {
  return {
    case: null, artifacts: [], exports: [],
    turns: [
      { id: sourceId, seq: 1, seat: "owner", kind: "verbatim",
        body: '250 or 500 cards. Pickup. Artwork not approved. <img src="https://example.invalid">', at: 1, compactedFrom: null },
      { id: proposalId, seq: 2, seat: ENQUIRY_PROPOSAL_SEAT, kind: "finding",
        body: JSON.stringify(proposal), at: 2, compactedFrom: null },
      { id: reviewId, seq: 3, seat: ENQUIRY_REVIEW_SEAT, kind: "verbatim",
        body: JSON.stringify({
          kind: "Print enquiry reviewed by the owner", version: 1, proposalId: linkedProposalId,
          sourceId, sourceSha256: proposal.sourceSha256,
          fields: ENQUIRY_FIELDS.map(field => ({
            field: field.id,
            quote: field.id === "artwork" ? "Artwork not approved" : proposal.suggestion.fields[field.id],
            state: field.id === "artwork" || proposal.suggestion.fields[field.id] !== null
              ? "source_excerpt_reviewed" : field.id === "destination" ? "not_needed_by_reviewer" : "unknown"
          }))
        }), at: 3, compactedFrom: null }
    ]
  };
}
function render(room: CaseRoom): string {
  return renderToStaticMarkup(createElement(WorkroomEnquiryReview, {
    room, localRunning: false, onUpdate: () => {}, onPrepared: () => {}, onReveal: () => {}, onDirty: () => {}
  }));
}
describe("saved enquiry review", () => {
  it("reopens corrected excerpts and not-needed decisions while original source markup stays text", () => {
    const html = render(fixture());
    expect(html).toContain("Your saved review is shown");
    expect(html).toMatch(/id="enquiry-artwork"[^>]*>Artwork not approved<\/textarea>/);
    expect(html).toMatch(/Delivery location<span>Not needed · your choice/);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
  it("does not apply a different proposal's reviewed fields to this suggestion", () => {
    const html = render(fixture("d9656207-21b6-4202-93c9-eb8d915a8317"));
    expect(html).not.toContain("Your saved review is shown");
    expect(html).toMatch(/id="enquiry-artwork"[^>]*><\/textarea>/);
    expect(html).toContain("Delivery location<span>Unknown");
  });
});
