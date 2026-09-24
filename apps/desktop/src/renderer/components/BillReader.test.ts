import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { BillProposal } from "./BillReader.js";

it("shows literal supporting excerpts, unknowns, precise paise and a separate replacement action", () => {
  const unknown = { value: null, from: null };
  const onApply = vi.fn();
  const proposal = { source: '<script>bad()</script> [external](https://example.com) amount 1,050.50',
    method: "Pasted text", result: { ok: true, said: "Check each field.", disagreement: "These amounts disagree.",
      bill: { partyName: { value: '<script>bad()</script>', from: '<script>bad()</script>' }, number: unknown,
        issuedOn: unknown, dueOn: unknown, subtotalPaise: { value: 105050, from: "1,050.50" },
        taxPaise: { value: null, from: "GST", problem: "Could not parse the amount." }, totalPaise: unknown } } };
  const html = renderToStaticMarkup(createElement(BillProposal, { proposal, applied: false, onApply }));
  expect(html).toContain("₹1,050.50"); expect(html).toContain("<blockquote>1,050.50</blockquote>");
  expect(html).toContain("Unknown"); expect(html).toContain("Could not parse the amount.");
  expect(html).toContain("These amounts disagree."); expect(html).toContain("Unknowns become empty fields");
  expect(html).toContain("Apply to the bill form"); expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>"); expect(html).not.toContain('href="https:');
  expect(onApply).not.toHaveBeenCalled();
  const applied = renderToStaticMarkup(createElement(BillProposal, { proposal, applied: true, onApply }));
  expect(applied).toMatch(/<button[^>]+disabled=""[^>]*>Applied to the bill form/);
});
