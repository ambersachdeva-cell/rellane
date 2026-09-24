/**
 * Handing something an agent wrote to the person who will send it.
 *
 * This closes a loop the UI has been claiming for a while and the runtime did
 * not have. The Drafts agent's brief says *"asks before anything leaves this
 * Mac"* and the row shows an **asks to send** chip — but `outbound` only ever
 * reached a label and a sentence in the system prompt. There was no path at all
 * from an answer to a channel, so the chip described a flow that did not exist.
 *
 * That is the same defect class as the tool loop: a promise in the interface
 * that the runtime cannot keep. The fix is the same too — build the path, and
 * make the guarantee real rather than quieting the claim.
 *
 * ## What "staging" means here
 *
 * Nothing is sent. `whatsAppHandoff` and `emailHandoff` both declare
 * `delivery: "stages"` (D-033, D-034): they compose the message and open the
 * owner's own app with it filled in. The last action is a person's, on their own
 * account, looking at the text.
 *
 * ## Three gates, in this order
 *
 *   1. **The brief.** An agent whose `outbound` is `"never"` cannot reach this
 *      at all — checked against the brief on this Mac, never against a claim
 *      from the renderer.
 *   2. **The list.** The recipient must be one the owner added (D-035). Read
 *      fresh from settings on every call, so removing somebody takes effect on
 *      the next message and not on the next launch.
 *   3. **The channel.** Address shape, length, and encoding, in the channel's
 *      own module, which refuses before anything opens.
 */

import type { Contact } from "../foundations/settings.js";
import { findAgent, type StoredBrief } from "../agents/roster.js";
import { OutboundLock } from "./outbound-lock.js";
import type { Channel } from "./mark.js";

export interface StageRequest {
  readonly agentId: string;
  readonly channel: Contact["channel"];
  readonly address: string;
  readonly text: string;
}

export interface StageResult {
  readonly staged: boolean;
  /** What happened, in the owner's words. Always set, on success and refusal. */
  readonly said: string;
}

export interface StageDeps {
  /** The channels available, keyed by name. */
  readonly channels: readonly Channel[];
  /** Read fresh per call, never captured, so a removal takes effect at once. */
  contacts(): Promise<readonly Contact[]>;
  /** The folders the agents were built against, for resolving the brief. */
  grantedFolders(): readonly string[];
  /** Briefs the owner wrote. Read fresh, like contacts, so an edit applies now. */
  storedAgents(): Promise<readonly StoredBrief[]>;
  /** Written to the record. A staged message is a thing that happened. */
  record?(entry: { agentId: string; channel: string; label: string }): Promise<void>;
}

/**
 * Stages one message, or refuses and says why.
 *
 * Never throws for an ordinary refusal: every outcome here is a sentence a
 * person reads next to the draft they were about to send.
 */
export async function stageMessage(
  request: StageRequest,
  deps: StageDeps
): Promise<StageResult> {
  const brief = findAgent(deps.grantedFolders(), await deps.storedAgents(), request.agentId);
  if (brief === undefined) {
    return { staged: false, said: "That agent no longer exists on this Mac." };
  }
  // Allowlisted, not denylisted. `!== "never"` would let any new or malformed
  // outbound value through, and the failure direction there is "it sent".
  if (brief.outbound !== "ask") {
    // The brief is the authority, not the request. An agent whose row says
    // "sends nothing" must not be able to send because a renderer asked.
    return {
      staged: false,
      said: `${brief.name} sends nothing — its brief says so, and that is not something this screen can override. Copy the text if you want to send it yourself.`
    };
  }

  const message = request.text.trim();
  if (message.length === 0) {
    return { staged: false, said: "There is nothing to send." };
  }

  let verdict;
  try {
    verdict = new OutboundLock(await deps.contacts()).check(request.channel, request.address);
  } catch {
    // Failing to read the list is not permission to skip it.
    return { staged: false, said: "Rellane could not read your contact list, so nothing was opened." };
  }
  if (!verdict.allowed) {
    return { staged: false, said: verdict.why };
  }

  const channel = deps.channels.find((candidate) => candidate.name === request.channel);
  if (channel === undefined) {
    return {
      staged: false,
      said: `Rellane cannot open ${request.channel} on this Mac.`
    };
  }

  if (channel.delivery !== "stages") {
    // The invariant D-033 exists to protect, finally enforced rather than
    // merely declared. `delivery` was made a required field so nothing could
    // report "delivered" for a window that opened — and then this path called
    // `send` without ever reading it. A channel that actually sends would have
    // put an agent's draft on the wire with no human tap, which is the one
    // thing this product promises cannot happen.
    return {
      staged: false,
      said: `${channel.name} sends immediately rather than opening a message for you to check, and an agent's draft never goes out without you pressing send. Nothing was sent.`
    };
  }

  try {
    await channel.send(request.address, message);
  } catch (error) {
    // The channel's own words: it knows why the address or the length was
    // wrong, and ours would be a guess about somebody else's rule.
    return {
      staged: false,
      said: error instanceof Error ? error.message : "That could not be opened."
    };
  }

  // Recording must not turn a completed staging into a reported failure: the
  // window is already open and telling the owner it failed would have them do
  // it twice.
  try {
    await deps.record?.({ agentId: brief.id, channel: channel.name, label: verdict.label });
  } catch {
    /* the record is best-effort; the staging already happened */
  }

  // Only a staging channel reaches here, so there is one sentence and it is
  // always true. The old conditional had a "Sent to …" branch, which was the
  // shape of the bug: code prepared to claim delivery.
  return {
    staged: true,
    said: `Opened ${channel.name} with the message ready for ${verdict.label}. Nothing has been sent — press send yourself.`
  };
}
