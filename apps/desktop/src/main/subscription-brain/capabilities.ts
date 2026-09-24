/**
 * What the product can do once a brain is docked.
 *
 * The rule this file exists to enforce: a capability is reported available only
 * after its probe has actually run and produced a usable answer. Nothing here
 * returns a hardcoded `true`. If a probe cannot be written honestly, the
 * capability does not belong in this list yet.
 *
 * Titles are outcomes in the owner's language. They never name a vendor or a
 * model, because the owner is not buying a model.
 */

import type { BrainCapability, BrainRunner } from "./types.js";

const PROBE_TIMEOUT_MS = 90_000;

/** Pulls the first JSON object out of a reply that may be fenced or prefaced. */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function fail(message: string): never {
  throw new Error(message);
}

export const BRAIN_CAPABILITIES: readonly BrainCapability[] = Object.freeze([
  {
    id: "structured-extraction",
    title: "Read a messy enquiry",
    detail: "Pull item, quantity, material and city out of Hinglish or shorthand",
    async probe(runner: BrainRunner, signal?: AbortSignal): Promise<void> {
      const result = await runner.ask({
        prompt:
          "Reply with ONLY a JSON object, no prose and no markdown fence. " +
          'Keys: item (string), quantity (integer or null), city (string or null).\n\n' +
          'Enquiry: "sir mujhe 2000 rigid box chahiye noida me delivery"',
        timeoutMs: PROBE_TIMEOUT_MS,
        signal
      });
      const parsed = extractJsonObject(result.content);
      if (parsed === null) {
        fail("Did not return usable JSON.");
      }
      if (parsed["quantity"] !== 2000) {
        fail("Read the quantity incorrectly.");
      }
    }
  },
  {
    id: "drafting",
    title: "Draft a reply in your language",
    detail: "Writes back to buyers the way you actually talk to them",
    async probe(runner: BrainRunner, signal?: AbortSignal): Promise<void> {
      const result = await runner.ask({
        prompt:
          "Write one short WhatsApp line, in Hinglish, telling a buyer their " +
          "rigid box quotation is being prepared. Reply with the line only.",
        timeoutMs: PROBE_TIMEOUT_MS,
        signal
      });
      if (result.content.trim().length < 10) {
        fail("Returned an empty draft.");
      }
    }
  },
  {
    id: "rule-authoring",
    title: "Turn a sentence into a rule",
    detail: 'Say "small card jobs come to me" and get a working rule',
    async probe(runner: BrainRunner, signal?: AbortSignal): Promise<void> {
      const result = await runner.ask({
        prompt:
          "Convert this instruction into ONLY a JSON object with keys " +
          '"field", "operator", "value".\n\n' +
          'Instruction: "flag any enquiry over 5000 pieces"',
        timeoutMs: PROBE_TIMEOUT_MS,
        signal
      });
      const parsed = extractJsonObject(result.content);
      if (parsed === null) {
        fail("Did not return a usable rule.");
      }
      if (typeof parsed["field"] !== "string" || parsed["value"] !== 5000) {
        fail("Built the rule incorrectly.");
      }
    }
  }
]);
