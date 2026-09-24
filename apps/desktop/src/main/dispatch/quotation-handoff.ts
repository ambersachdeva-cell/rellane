/** The quotation leaving by the way it came in, with the lock in front of it.
 *
 * The sixth step of D-111 has two halves. The book records how a deal ended;
 * this is the other half — the message actually reaching the customer. Before
 * it, the shop's day ended with the text pasted into WhatsApp by hand: finding
 * the chat, switching windows, hoping the rupee signs survived.
 *
 * ## It stages and cannot send
 *
 * `whatsAppHandoff` is a `wa.me` link. D-033 settled why, and the reasoning is
 * worth repeating because it is the kind that gets argued away: a library
 * holding a live authenticated session can send without passing the approval
 * gate, so the capability itself is the violation. One retry loop, one queue
 * replay, and a message goes out unapproved. The last tap belongs to a person.
 *
 * ## The lock is in front, and this is where it was tempting not to be
 *
 * The owner typed the number, wrote the price, and pressed the button. No agent
 * was talked into anything by a document it read, which is the attack
 * `outbound-lock.ts` was built for. The argument for skipping the check here is
 * genuinely reasonable and it is still refused: the lock is one list in both
 * directions (D-035), it deliberately has no allow-everything value, and a
 * caller that reasons its way around a security gate is how the gate stops
 * meaning anything to the next caller.
 *
 * What was wrong was the friction, not the gate. So a refusal says whether the
 * owner can fix it by adding this one customer — `canAdd` — rather than making
 * a screen guess from the wording of a sentence.
 *
 * It lives here, apart from the IPC handler, because a security decision that
 * can only be exercised by starting an app is one nobody tests.
 */

import type { Deal } from "@cadrane/contracts";
import { quotationMessage, type ShopIdentity } from "../book/quotation-message.js";
import { OutboundLock, type Recipient } from "./outbound-lock.js";
import type { Channel } from "./mark.js";

export interface HandoffDeps {
  /** Every channel this Mac has. The WhatsApp one must stage, or it is not used. */
  readonly channels: readonly Channel[];
  /** Read fresh: a customer added a moment ago must be on the list now. */
  contacts(): Promise<readonly Recipient[]>;
  /** How the shop signs off. Never guessed. */
  shop(): Promise<ShopIdentity>;
}

export interface HandoffResult {
  readonly opened: boolean;
  /** What happened, in the owner's words. Shown whether it worked or not. */
  readonly said: string;
  /**
   * Whether adding this one customer to the list would let it through.
   *
   * True only when the list is the single reason it was refused and there is a
   * name to put on the row. It is never true for a missing number, an empty
   * quotation, or a channel that is not there — offering "add them" to a person
   * whose quotation has no lines is an answer to a question they did not ask.
   */
  readonly canAdd: boolean;
}

const NO = (said: string): HandoffResult => ({ opened: false, said, canAdd: false });

export async function handoffQuotation(deal: Deal, deps: HandoffDeps): Promise<HandoffResult> {
  const address = deal.partyPhone?.trim() ?? "";
  if (address === "") {
    return NO(
      "There is no number on file for this customer, so there is no chat to open. Copy the message instead."
    );
  }

  const text = quotationMessage(deal, await deps.shop());
  if (text === null) {
    return NO("This quotation has no lines, so there is nothing to send.");
  }

  let verdict;
  try {
    verdict = new OutboundLock(await deps.contacts()).check("whatsapp", address);
  } catch {
    // Failing to read the list is not permission to skip it.
    return NO("Rellane could not read your contact list, so nothing was opened.");
  }
  if (!verdict.allowed) {
    return {
      opened: false,
      said: verdict.why,
      // A number the lock could not even parse is not fixed by adding it, and
      // a row with no name is a list nobody can audit later.
      canAdd:
        verdict.reason === "recipient not on whatsapp allowlist" &&
        (deal.partyName?.trim() ?? "") !== ""
    };
  }

  const channel = deps.channels.find((candidate) => candidate.name === "whatsapp");
  if (channel === undefined) {
    return NO("Rellane cannot open WhatsApp on this Mac.");
  }
  if (channel.delivery !== "stages") {
    // The invariant D-033 protects, checked rather than assumed. A channel that
    // claims to send is not one this path may use, whatever it is called.
    return NO("That WhatsApp channel would send rather than stage, so it was not used.");
  }

  try {
    await channel.send(address, text);
  } catch (problem) {
    // The handoff's own refusals are written for the owner — too long, not a
    // number WhatsApp can open — so they are passed through rather than
    // flattened into something vaguer.
    return NO(problem instanceof Error ? problem.message : "WhatsApp did not open.");
  }

  return {
    opened: true,
    said: `WhatsApp is open with the quotation typed in for ${verdict.label}. Nothing has been sent — press send yourself.`,
    canAdd: false
  };
}
