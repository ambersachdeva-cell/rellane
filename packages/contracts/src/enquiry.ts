/** A suggested print brief must keep its evidence and its human review separate. */
import { z } from "zod";

export const ENQUIRY_FIELDS = [
  { id: "item", label: "What is being printed?", question: "What item needs printing?" },
  { id: "quantities", label: "Quantities and options", question: "Which quantity or quantity options should be quoted?" },
  { id: "dimensions", label: "Finished size", question: "What finished size is needed?" },
  { id: "printing", label: "Sides and colour", question: "Which sides and colours need printing?" },
  { id: "stock", label: "Paper or material", question: "Which paper or material is needed?" },
  { id: "finish", label: "Finishing", question: "Is any finishing needed?" },
  { id: "fulfilment", label: "Pickup or delivery", question: "Will this be picked up or delivered?" },
  { id: "timing", label: "Requested timing", question: "What exact date is required, and is it flexible?" },
  { id: "destination", label: "Delivery location", question: "What is the complete delivery address, if delivery is needed?" },
  { id: "artwork", label: "Artwork and approval", question: "Is print-ready artwork available and approved?" },
  { id: "invoice", label: "Invoice request", question: "Is a GST invoice requested?" },
  { id: "changes", label: "Changes or cancellations", question: "Do any earlier instructions need replacing or cancelling?" },
  { id: "other", label: "Other requirements", question: "Are there any other requirements to confirm?" }
] as const;
export type EnquiryFieldId = typeof ENQUIRY_FIELDS[number]["id"];
export const EnquiryFieldIdSchema = z.enum(ENQUIRY_FIELDS.map(field => field.id));
const Quote = z.string().min(1).max(400).refine(text => text.trim().length > 0, "Use an exact, nonempty excerpt.").nullable();
export const EnquiryValuesSchema = z.strictObject({
  item: Quote, quantities: Quote, dimensions: Quote, printing: Quote,
  stock: Quote, finish: Quote, fulfilment: Quote, timing: Quote,
  destination: Quote, artwork: Quote, invoice: Quote, changes: Quote, other: Quote
});
export const EnquirySuggestionSchema = z.strictObject({
  scope: z.enum(["one_job", "multiple_jobs", "unclear"]),
  fields: EnquiryValuesSchema
});
export type EnquirySuggestion = z.infer<typeof EnquirySuggestionSchema>;
export const CaseEnquiryRequestSchema = z.strictObject({
  id: z.string().min(1).max(64), operationId: z.uuid(),
  modelId: z.string().min(1).max(512), sourceTurnId: z.uuid()
});
export type CaseEnquiryRequest = z.infer<typeof CaseEnquiryRequestSchema>;
export const EnquiryProposalSchema = z.strictObject({
  version: z.literal(1), sourceTurnId: z.uuid(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  modelId: z.string().min(1).max(512), operationId: z.uuid(),
  suggestion: EnquirySuggestionSchema
});
export type EnquiryProposal = z.infer<typeof EnquiryProposalSchema>;
export const CaseEnquirySaveSchema = z.strictObject({
  id: z.string().min(1).max(64), proposalTurnId: z.uuid(), operationId: z.uuid(),
  fields: EnquiryValuesSchema,
  notNeeded: z.array(EnquiryFieldIdSchema).max(ENQUIRY_FIELDS.length)
    .refine(ids => new Set(ids).size === ids.length, "Review each field once."),
  reviewedSource: z.literal(true),
  oneJob: z.literal(true)
});
export type CaseEnquirySave = z.infer<typeof CaseEnquirySaveSchema>;
/** Only the fields needed to reopen a review; additional stored evidence stays literal. */
export const EnquiryReviewSnapshotSchema = z.object({
  kind: z.literal("Print enquiry reviewed by the owner"), version: z.literal(1),
  proposalId: z.uuid(), sourceId: z.uuid(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  fields: z.array(z.object({
    field: EnquiryFieldIdSchema, quote: Quote,
    state: z.enum(["source_excerpt_reviewed", "not_needed_by_reviewer", "unknown"])
  }).refine(value => (value.state === "source_excerpt_reviewed") === (value.quote !== null)))
    .length(ENQUIRY_FIELDS.length)
    .refine(fields => new Set(fields.map(field => field.field)).size === ENQUIRY_FIELDS.length)
});
export const ENQUIRY_PROPOSAL_SEAT = "Enquiry · Suggested fields";
export const ENQUIRY_REVIEW_SEAT = "Source · Reviewed print enquiry";
