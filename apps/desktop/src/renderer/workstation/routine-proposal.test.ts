import { describe, expect, it } from "vitest";
import {
  MAX_OFFERS,
  PREVIEW_CHARS,
  presentProposal,
  proposalKey,
  shouldOffer
} from "./routine-proposal.js";
import type { DismissalRecord, ProposalLike } from "./routine-proposal.js";

const sampleProposal: ProposalLike = {
  title: "Summarise research notes",
  description: "Produce a structured brief from uploaded research notes.",
  prompt:
    "Please read the attached notes, extract the key findings, and format them as an executive brief.",
  sourceHint: "Select notes to ground this routine.",
  outputLabel: "Executive brief",
  because: "Observed two sources used to produce an executive brief.",
  evidence: ["turn-1", "turn-2", "turn-3"]
};

describe("proposalKey", () => {
  it("produces identical keys for prompts differing only in casing and whitespace", () => {
    // Tests that whitespace collapsing and case normalisation unify identical routine intents.
    const proposalA: ProposalLike = {
      ...sampleProposal,
      prompt: "  Extract   KEY   findings\n\tand format as a brief.  "
    };
    const proposalB: ProposalLike = {
      ...sampleProposal,
      prompt: "extract key findings and format as a brief."
    };

    expect(proposalKey(proposalA)).toBe(proposalKey(proposalB));
  });

  it("produces different keys for distinct prompt contents", () => {
    // Tests that distinct routine templates do not collide and falsely inherit dismissals.
    const proposalA: ProposalLike = {
      ...sampleProposal,
      prompt: "Extract key findings and format as an executive brief."
    };
    const proposalB: ProposalLike = {
      ...sampleProposal,
      prompt: "Draft an introductory response email for a new project client."
    };

    expect(proposalKey(proposalA)).not.toBe(proposalKey(proposalB));
  });

  it("is deterministic across repeated calls with identical input", () => {
    // Guarantees stable identity across rendering cycles and application reloads.
    const keyFirst = proposalKey(sampleProposal);
    const keySecond = proposalKey(sampleProposal);

    expect(keyFirst).toBe(keySecond);
  });
});

describe("shouldOffer", () => {
  it("returns false for a null proposal", () => {
    // Prevents offering UI from activating when no repeatable routine was detected.
    expect(shouldOffer(null, [])).toBe(false);
  });

  it("returns false when the prompt is shorter than 40 characters", () => {
    // Short prompts lack sufficient specificity to warrant creating a reusable routine.
    const shortProposal: ProposalLike = {
      ...sampleProposal,
      prompt: "Summarise notes." // 16 characters
    };
    expect(shouldOffer(shortProposal, [])).toBe(false);

    const boundary39Proposal: ProposalLike = {
      ...sampleProposal,
      prompt: "This prompt has thirty-nine characters!" // exactly 39 characters
    };
    expect(shouldOffer(boundary39Proposal, [])).toBe(false);
  });

  it("returns true for a qualifying prompt dismissed once", () => {
    // An owner ignoring an offer once should still have another opportunity before suppression.
    const key = proposalKey(sampleProposal);
    const dismissals: readonly DismissalRecord[] = [
      { key, count: 1, lastAt: 1_700_000_000 }
    ];

    expect(shouldOffer(sampleProposal, dismissals)).toBe(true);
  });

  it("returns false when the proposal has been dismissed twice or more", () => {
    // Respects the boundary where ignoring a routine twice permanently silences it.
    const key = proposalKey(sampleProposal);
    const dismissalsTwice: readonly DismissalRecord[] = [
      { key, count: MAX_OFFERS, lastAt: 1_700_000_000 }
    ];
    const dismissalsThrice: readonly DismissalRecord[] = [
      { key, count: 3, lastAt: 1_700_000_000 }
    ];

    expect(shouldOffer(sampleProposal, dismissalsTwice)).toBe(false);
    expect(shouldOffer(sampleProposal, dismissalsThrice)).toBe(false);
  });

  it("ignores dismissal records associated with different proposal keys", () => {
    // Ensures dismissal of one routine never suppresses an unrelated routine.
    const dismissals: readonly DismissalRecord[] = [
      { key: "unrelated-key-hash", count: 5, lastAt: 1_700_000_000 }
    ];

    expect(shouldOffer(sampleProposal, dismissals)).toBe(true);
  });
});

describe("presentProposal", () => {
  it("retains the reason byte-identical to the underlying proposal because field", () => {
    // The rationale represents verified turn evidence and must not be paraphrased or distorted.
    const customBecause = "Observed three sources used to produce a detailed analysis.";
    const proposal: ProposalLike = {
      ...sampleProposal,
      because: customBecause
    };

    const view = presentProposal(proposal);
    expect(view.reason).toBe(customBecause);
  });

  it("leaves prompts under PREVIEW_CHARS unchanged without trailing ellipsis", () => {
    // Avoids truncating or decorating prompts that already fit comfortably within the view.
    const shortPrompt = "Draft a concise weekly status summary comparing milestone progress against schedule.";
    expect(shortPrompt.length).toBeLessThan(PREVIEW_CHARS);

    const proposal: ProposalLike = {
      ...sampleProposal,
      prompt: shortPrompt
    };

    const view = presentProposal(proposal);
    expect(view.previewPrompt).toBe(shortPrompt);
    expect(view.previewPrompt.includes("…")).toBe(false);
  });

  it("cuts a 400-character prompt at a word boundary under PREVIEW_CHARS with one ellipsis", () => {
    // Ensures long prompts are readable without dangling mid-word fragments or overflowing length.
    const longPrompt =
      "Please review all project documentation, extract the architecture decisions, " +
      "summarise the main operational trade-offs, identify unresolved risk factors, " +
      "and draft a comprehensive summary report for stakeholders. Make sure to list " +
      "all required team approvals, highlight dependencies that remain on the critical " +
      "path, outline mitigation strategies for high-severity risks, and provide an " +
      "estimated timeline for implementation across each workstream.";

    expect(longPrompt.length).toBeGreaterThan(400);

    const proposal: ProposalLike = {
      ...sampleProposal,
      prompt: longPrompt
    };

    const view = presentProposal(proposal);

    expect(view.previewPrompt.length).toBeLessThanOrEqual(PREVIEW_CHARS);
    expect(view.previewPrompt.endsWith("…")).toBe(true);

    // Verify there is exactly one ellipsis character in the entire preview text.
    const ellipsisCount = (view.previewPrompt.match(/…/g) ?? []).length;
    expect(ellipsisCount).toBe(1);

    // Verify truncation occurred at a word boundary without chopping characters inside a word.
    const textBeforeEllipsis = view.previewPrompt.slice(0, -1);
    expect(longPrompt.startsWith(textBeforeEllipsis)).toBe(true);
    expect(longPrompt.charAt(textBeforeEllipsis.length)).toBe(" ");
  });

  it("ensures no produced string contains 'the owner'", () => {
    // Enforces user-facing copy style guidelines: direct second-person address only.
    const view = presentProposal(sampleProposal);

    expect(view.heading.toLowerCase()).not.toContain("the owner");
    expect(view.reason.toLowerCase()).not.toContain("the owner");
    expect(view.benefit.toLowerCase()).not.toContain("the owner");
    expect(view.previewPrompt.toLowerCase()).not.toContain("the owner");
  });

  it("maps title, benefit, and evidence count faithfully and deterministically", () => {
    // Guarantees all view fields are populated accurately across repeated evaluations.
    const viewA = presentProposal(sampleProposal);
    const viewB = presentProposal(sampleProposal);

    expect(viewA.heading).toBe(sampleProposal.title);
    expect(viewA.evidenceCount).toBe(sampleProposal.evidence.length);
    expect(viewA.benefit.toLowerCase()).toContain("you");
    expect(viewA.benefit).not.toContain("!");
    expect(viewA).toEqual(viewB);
  });
});
