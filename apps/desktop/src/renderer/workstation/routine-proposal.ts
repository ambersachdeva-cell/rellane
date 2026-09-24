export interface ProposalLike {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly sourceHint: string;
  readonly outputLabel: string;
  readonly because: string;
  readonly evidence: readonly string[];
}

export interface DismissalRecord {
  readonly key: string;
  readonly count: number;
  readonly lastAt: number;
}

export interface ProposalView {
  readonly heading: string;
  /** Why this is being offered, in the owner's words. */
  readonly reason: string;
  /** What accepting would save them, one short sentence. */
  readonly benefit: string;
  readonly previewPrompt: string;
  /** How many turns it was derived from, for "based on" copy. */
  readonly evidenceCount: number;
}

export const MAX_OFFERS = 2;
export const PREVIEW_CHARS = 280;

const MIN_PROMPT_CHARS = 40;
const ELLIPSIS = "…";

/**
 * Normalises prompt text so superficial formatting differences (casing,
 * irregular spacing, tabs, newlines) do not create duplicate proposal keys.
 */
function normalisePrompt(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Generates a deterministic hash in the renderer without importing node:crypto
 * or browser webcrypto, ensuring pure, synchronous, portable key derivation.
 */
function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x27d4eb2f;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ ch, 0x5bd1e995);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 0xc2b2ae35);
  const p1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const p2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${p1}${p2}`;
}

/**
 * A stable identity for one proposal, so dismissals can be remembered.
 * Relies exclusively on normalised prompt content so identical routine suggestions
 * across separate works share the same dismissal lifecycle.
 */
export function proposalKey(proposal: ProposalLike): string {
  return hashString(normalisePrompt(proposal.prompt));
}

/**
 * Guards the presentation layer against presenting irrelevant, overly short,
 * or repeatedly dismissed proposals, preventing suggestion fatigue.
 */
export function shouldOffer(
  proposal: ProposalLike | null,
  dismissals: readonly DismissalRecord[]
): boolean {
  if (proposal === null) {
    return false;
  }
  if (proposal.prompt.trim().length < MIN_PROMPT_CHARS) {
    return false;
  }
  const key = proposalKey(proposal);
  const totalDismissals = dismissals
    .filter((d) => d.key === key)
    .reduce((sum, d) => sum + d.count, 0);

  if (totalDismissals >= MAX_OFFERS) {
    return false;
  }
  return true;
}

/**
 * Truncates long prompts at a clean word boundary under PREVIEW_CHARS,
 * avoiding cut-off words that look corrupted in the preview interface.
 */
function formatPreviewPrompt(prompt: string): string {
  if (prompt.length <= PREVIEW_CHARS) {
    return prompt;
  }
  const slice = prompt.slice(0, PREVIEW_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 0) {
    return `${slice.slice(0, lastSpace).trimEnd()}${ELLIPSIS}`;
  }
  return `${prompt.slice(0, PREVIEW_CHARS - 1).trimEnd()}${ELLIPSIS}`;
}

/**
 * Prepares a proposal for presentation in calm second-person British English,
 * retaining the original evidence text without marketing embellishment.
 */
export function presentProposal(proposal: ProposalLike): ProposalView {
  return {
    heading: proposal.title,
    reason: proposal.because,
    benefit: "You can run this again whenever you need it without retyping the instructions.",
    previewPrompt: formatPreviewPrompt(proposal.prompt),
    evidenceCount: proposal.evidence.length
  };
}
