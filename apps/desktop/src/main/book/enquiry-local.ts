/** Reading a deal's enquiry on this Mac. Proposals only; nothing is applied.
 *
 * The reading itself is not new. `workroom/enquiry.ts` owns the prompt, the
 * parser and the excerpt validator, and has since before the deal existed —
 * thirteen print-domain fields, negations and quantity alternatives preserved,
 * artwork dates kept apart from delivery dates, and an existing refusal to
 * invent prices, tax rates or availability. All of that is used unchanged.
 *
 * What this adds is the binding. That path reads a *turn* inside a workroom;
 * a deal keeps the customer's words on the enquiry row, so it needs the simpler
 * runner `book/extract.ts` already uses for bills — prepare a local agent, ask,
 * parse — without the workroom's operation ledger and receipts.
 *
 * Nothing here reaches a customer and nothing is saved. The owner sees proposed
 * lines beside the message they came from and decides.
 */

import type { EnquirySuggestion } from "@cadrane/contracts";
import { prepareLocalAgent } from "../agents/local.js";
import { newBrief } from "../agents/brief.js";
import type { LocalWorkroomDeps } from "../workroom/local.js";
import { ENQUIRY_SYSTEM, parseEnquirySuggestion } from "../workroom/enquiry.js";
import { proposeLines, type ProposedQuotationLine } from "./enquiry-lines.js";

export const ENQUIRY_READ_TIMEOUT_MS = 90_000;
/** Matches the workroom's own limit on a single enquiry source. */
export const MAX_ENQUIRY_CHARS = 4_000;

export interface EnquiryReadResult {
  readonly ok: boolean;
  readonly enquiry: EnquirySuggestion | null;
  /** The first quotation line this suggests. Never priced. */
  readonly lines: readonly ProposedQuotationLine[];
  /** What happened, in the owner's words. Shown whether it worked or not. */
  readonly said: string;
}

/**
 * What went wrong, said to a person who came here to quote a printing job.
 *
 * The first version handed back whatever was thrown, and on a Mac with no model
 * installed — which is every Mac on its first day — that read: *"The bundled
 * model is not ready. Check Models and try again. No subscription was
 * contacted."* Four problems in one sentence. "The bundled model" is not a
 * thing the owner has heard of. "Check Models" names a screen that is no longer
 * on the rail. The reassurance answers a worry nobody had. And the whole thing
 * reads as a fault when nothing is broken — a model has simply not been
 * installed, which needs the owner to accept a licence (D-110) and is not
 * something this screen can do for them.
 *
 * Every branch ends the same way, because it is the honest one: add the lines
 * yourself. The reading was always a convenience — the rate is the owner's
 * either way, and nothing here has been changed or saved.
 */
export function saidFor(error: unknown): string {
  const message = error instanceof Error ? error.message : "";

  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "Reading this message took too long and was stopped. Add the lines yourself.";
  }
  if (message.includes("bundled model is not ready")) {
    return "No model is installed on this Mac yet, so Rellane cannot read this message into lines. Add them yourself.";
  }
  if (message.includes("more context than")) {
    return "This message is longer than the reader can hold. Add the lines yourself, or paste just the part that asks for the job.";
  }
  // Includes the excerpt check failing, which is the reader having produced
  // something it could not point at in the message. That is the guard working,
  // and to the owner it is the same answer: do it by hand.
  return "Rellane could not read this message. Add the lines yourself — nothing has been changed.";
}

export async function readEnquiryLocal(
  rawText: string,
  runtime: LocalWorkroomDeps,
  signal = AbortSignal.timeout(ENQUIRY_READ_TIMEOUT_MS)
): Promise<EnquiryReadResult> {
  const refused = (said: string): EnquiryReadResult => ({ ok: false, enquiry: null, lines: [], said });

  if (!rawText.trim()) {
    return refused("There is nothing written down to read.");
  }
  if (rawText.length > MAX_ENQUIRY_CHARS) {
    return refused(
      "This message is longer than the reader takes. Add the lines yourself, or paste the part that asks for the job."
    );
  }

  try {
    const local = await prepareLocalAgent(
      newBrief({
        id: "enquiry-reading",
        name: "Enquiry reading",
        purpose: "Propose what a customer asked for, for review",
        tier: "on-device",
        outbound: "never"
      }),
      runtime,
      signal,
      "print-enquiry-v1"
    );

    const reply = await local.ask({
      engineId: "local",
      modelId: local.room.active!.modelId,
      system: ENQUIRY_SYSTEM,
      prompt: rawText,
      signal
    });
    signal.throwIfAborted();

    // Throws when a field's excerpt is not exact text from the message, which
    // is the whole guard: a composed line reads exactly like a read one.
    const enquiry = parseEnquirySuggestion(reply, rawText);

    if (enquiry.scope !== "one_job") {
      return refused(
        enquiry.scope === "multiple_jobs"
          ? "This message asks about more than one job. Quote them separately; nothing was combined."
          : "It could not tell what is being asked for. Add the lines yourself."
      );
    }

    return {
      ok: true,
      enquiry,
      lines: proposeLines(enquiry),
      said: `Read on this Mac with ${local.room.active!.modelId}. Check every line against the message. Nothing has a price and nothing has been saved.`
    };
  } catch (error) {
    return refused(saidFor(error));
  }
}
