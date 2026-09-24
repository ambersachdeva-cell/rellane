/**
 * A real model's answer, frozen.
 *
 * This fixture is not invented. It is what a frontier model actually returned
 * when given `ENQUIRY_SYSTEM` verbatim and a realistic Indian print-shop
 * enquiry, on 13 September 2026, during the first live check of that prompt.
 *
 * The first run returned a **flat** object — `{scope, item, quantities, ...}` —
 * which `parseEnquirySuggestion` rejects. The prompt said only "as JSON with
 * scope and fields", and a model reading it without the bundled server's
 * response grammar took that to mean a flat object. The grammar was hiding a
 * prompt that never stated its own envelope. One sentence fixed it; this file
 * is what stops it coming back the next time somebody edits that prompt without
 * a model to hand.
 */
import { describe, expect, it } from "vitest";
import { parseEnquirySuggestion } from "../workroom/enquiry.js";
import { proposeLines } from "./enquiry-lines.js";

const SOURCE =
  "Hi, need rate for 1,000 letterheads A4 size, 100gsm bond paper, single side printing black only. Also please quote 500 visiting cards separately later, not now. Delivery to Naraina Industrial Area Phase 1 by 22nd. Artwork is ready but not approved by client yet. Budget around Rs 8000. GST bill needed.";

/** Verbatim, from the second live run. */
const REPLY = JSON.stringify({
  scope: "one_job",
  fields: {
    item: "letterheads",
    quantities: "1,000",
    dimensions: "A4 size",
    printing: "single side printing black only",
    stock: "100gsm bond paper",
    finish: null,
    fulfilment: "Delivery",
    timing: "by 22nd",
    destination: "Naraina Industrial Area Phase 1",
    artwork: "Artwork is ready but not approved by client yet",
    invoice: "GST bill needed",
    changes: "Also please quote 500 visiting cards separately later, not now",
    other: "Budget around Rs 8000"
  }
});

/** What the same model returned before the prompt stated its envelope. */
const FLAT_REPLY = JSON.stringify({
  scope: "one_job",
  item: "letterheads",
  quantities: "1,000"
});

describe("what a real model actually returns", () => {
  it("parses, with every excerpt exact text from the message", () => {
    const enquiry = parseEnquirySuggestion(REPLY, SOURCE);
    expect(enquiry.scope).toBe("one_job");
    expect(enquiry.fields.item).toBe("letterheads");
    expect(enquiry.fields.stock).toBe("100gsm bond paper");
  });

  it("still rejects the flat shape the prompt used to invite", () => {
    expect(() => parseEnquirySuggestion(FLAT_REPLY, SOURCE)).toThrow(
      /unsupported or missing enquiry fields/
    );
  });

  it("becomes one priced-by-the-owner line", () => {
    const [line] = proposeLines(parseEnquirySuggestion(REPLY, SOURCE));
    expect(line?.description.value).toBe("letterheads, A4 size, 100gsm bond paper");
    expect(line?.quantity.value).toBe(1000);
  });

  it("keeps the deferred job out of the line, because it was not asked for now", () => {
    // "quote 500 visiting cards separately later, not now" landed in `changes`,
    // and nothing in the pricing path reads `changes`. A second line here would
    // quote a customer for work they explicitly postponed.
    const lines = proposeLines(parseEnquirySuggestion(REPLY, SOURCE));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.description.value).not.toContain("visiting cards");
  });

  it("leaves the customer's budget out of the quotation entirely", () => {
    // "Budget around Rs 8000" is in `other`. Nothing in the pricing path reads
    // it, so a stated budget can never become the shop's rate.
    const [line] = proposeLines(parseEnquirySuggestion(REPLY, SOURCE));
    expect(JSON.stringify(line)).not.toContain("8000");
  });
});
