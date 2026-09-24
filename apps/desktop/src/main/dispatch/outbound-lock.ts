/**
 * The outbound lock: who this Mac is willing to contact at all.
 *
 * Staging is not sending, and the handoff channels (D-033, D-034) already put a
 * person's thumb between a composed message and a delivered one. This is a
 * second, earlier gate, and it exists because those two facts are not the same:
 *
 *   - A staged message still *opens a window addressed to somebody*. If an agent
 *     is talked into messaging an attacker — by a document it read, which is the
 *     realistic attack (see `security/injection.ts`) — the owner is presented
 *     with a plausible-looking chat already addressed and already written. The
 *     approval step only works if the thing being approved is not itself the
 *     product of the manipulation.
 *   - The relay in Phase 9 has to send with nobody present. This gate is what
 *     that will lean on, so it is built now, while every channel still stages
 *     and a mistake here costs nothing.
 *
 * ## Refused, never queued
 *
 * A refusal is final and immediate. Queueing a blocked recipient would mean a
 * message sitting in a list that someone later approves in bulk without
 * re-reading who it is for — which converts the lock into a delay.
 *
 * ## Not configurable away
 *
 * There is no "allow everything" setting. The allowlist can be added to, one
 * recipient at a time, by the owner. That is deliberate: a master switch is the
 * first thing an attacker looks for and the first thing a frustrated user
 * reaches for at the exact moment they should not.
 */

import { checkAddress } from "./email.js";
import { toWaNumber } from "./whatsapp.js";
import { diagnostics, redact } from "../foundations/diagnostics.js";
import type { DispatchTask } from "./queue.js";

export type OutboundChannel = DispatchTask["channel"];

export interface Recipient {
  readonly channel: OutboundChannel;
  /** As the owner entered it. Normalised before comparison, never before storage. */
  readonly address: string;
  /** What the owner calls them, for the refusal message and the record. */
  readonly label: string;
}

export type LockVerdict =
  | { readonly allowed: true; readonly label: string }
  | { readonly allowed: false; readonly why: string; readonly reason: string };

/**
 * One comparable form per channel.
 *
 * A phone number written four ways is one recipient, and an allowlist that
 * treats `+91 98765 43210` and `9876543210` as different people is an allowlist
 * that fails open the first time somebody types it differently.
 */
export function normalise(channel: OutboundChannel, address: string): string | null {
  try {
    switch (channel) {
      case "whatsapp":
        return toWaNumber(address);
      case "email":
        return checkAddress(address).toLowerCase();
      case "telegram": {
        // Lowercased, unlike the comment that used to sit here claiming chat ids
        // are already canonical. They are — but people type @Usernames, which
        // Telegram treats case-insensitively, so `@Devgiri` and `@devgiri` would
        // otherwise be two different entries and the list would miss one.
        //
        // Empty is null, not "". Unlike the other two channels this does no
        // validation, so a blank or whitespace address returned `""` — which is
        // not null, so it was registered as the key `telegram:` and `check`
        // would then find it. An allowlist entry matching the empty address is
        // not a contact anybody added.
        const handle = address.trim().toLowerCase();
        return handle === "" ? null : handle;
      }
      default:
        // Unreachable through the type, the IPC enum and the settings coercion,
        // and present anyway because of the direction it fails in. Without it
        // the switch returns `undefined`, every caller tests `=== null`, and the
        // value lands in the map as `channel:undefined` — at which point `check`
        // finds that key and allows *any* address on that channel. A security
        // gate whose unreachable path fails open is one refactor away from being
        // reachable.
        return null;
    }
  } catch {
    // Anything unparseable is not on the list, by definition.
    //
    // Catches everything, not only the two handoff errors: a TypeError escaping
    // from here would abort `new OutboundLock(...)` and take down more than the
    // one bad entry. Refusing one address is a smaller failure than refusing to
    // construct the lock at all.
    return null;
  }
}

/**
 * The lock itself.
 *
 * Holds no state of its own beyond the list it was given, so the caller decides
 * where that list lives and the lock stays testable without a database.
 */
export class OutboundLock {
  private readonly allowed: Map<string, string>;

  constructor(recipients: readonly Recipient[]) {
    this.allowed = new Map();
    for (const recipient of recipients) {
      const key = normalise(recipient.channel, recipient.address);
      if (key === null) {
        // Dropped, and said so. Dropping is right — a half-understood entry in
        // the list that decides who may be contacted must not survive as a
        // guess — but doing it silently means somebody who mistyped a number
        // sees their contact in Settings and cannot work out why messages to
        // them are refused. The address itself is not logged.
        // Redacted, because "the address itself is not logged" was only true of
        // the `address` field. A label is whatever the owner typed, and naming a
        // contact by their phone number is the ordinary thing to do — so the
        // unparseable address arrived here in the label instead, and went
        // straight into a diagnostics bundle the owner hands to somebody else.
        // `redact` removes a number, an email or a UPI handle and leaves a real
        // name, which is the half of this that makes the warning worth having.
        diagnostics.warn("dispatch", "a saved contact could not be read, so it is not on the list", {
          channel: recipient.channel,
          label: redact(recipient.label)
        });
        continue;
      }
      this.allowed.set(`${recipient.channel}:${key}`, recipient.label);
    }
  }

  /**
   * Decides whether this Mac will contact this recipient at all.
   *
   * Every refusal names the recipient and says what would allow it, because a
   * refusal a person cannot act on becomes a bug report.
   */
  check(channel: OutboundChannel, address: string): LockVerdict {
    const key = normalise(channel, address);
    if (key === null) {
      return {
        allowed: false,
        why: `${address} is not a ${channel} address Rellane recognises, so it will not open anything addressed to it.`,
        reason: `address not recognised for ${channel}`
      };
    }
    const label = this.allowed.get(`${channel}:${key}`);
    if (label === undefined) {
      return {
        allowed: false,
        why: `${address} is not on your ${channel} list, so nothing was opened. Add them in Settings if you meant to contact them — and if you did not, something asked Rellane to message a stranger, which is worth looking at.`,
        reason: `recipient not on ${channel} allowlist`
      };
    }
    return { allowed: true, label };
  }

  /** Everyone on the list, for the screen that shows it. */
  size(): number {
    return this.allowed.size;
  }
}
