/**
 * Mark — the loop that joins a phone to a Mac.
 *
 * A message arrives on a channel, becomes a task in the queue, runs through the
 * skill host, and the answer goes back the way it came. Everything here is the
 * joining; the parts being joined are already tested on their own.
 *
 * The rule that shapes all of it: **the person always hears back**. On accept,
 * on completion, on failure, on refusal, and on expiry. The failure mode this
 * exists to prevent is not a crash — it is silence, which is indistinguishable
 * from being ignored.
 */

import { randomUUID } from "node:crypto";
import type { SkillHost } from "../skills/host.js";
import { completionReply, DispatchQueue, type DispatchTask, type Presence } from "./queue.js";
import { screen } from "../security/injection.js";
import type { OutboundLock } from "./outbound-lock.js";
import { diagnostics } from "../foundations/diagnostics.js";

/**
 * Anything that can carry a message back to a person.
 *
 * `delivery` is the half that matters and the half a naive interface hides.
 * Telegram sends: the message is gone the moment `send` resolves. WhatsApp
 * cannot — there is no official personal API, and the only implementation that
 * could auto-send is an unofficial library holding a live session, which puts a
 * send path outside the approval gate and the owner's number at ban risk
 * (D-033). So WhatsApp *stages*: `send` composes the message and opens WhatsApp
 * with it prefilled, and a person presses send.
 *
 * Both are legitimate. What is not legitimate is a staging channel resolving
 * from a method called `send` and letting the rest of the system record
 * "delivered" — so the difference is declared here, in the type, and every
 * caller that reports an outcome has to read it.
 */
export interface Channel {
  readonly name: DispatchTask["channel"];
  /**
   * `"sends"` — resolved means it left the Mac.
   * `"stages"` — resolved means it is composed and waiting for a person to tap
   * send. Nothing has left the Mac yet, and it may never.
   */
  readonly delivery: "sends" | "stages";
  send(to: string, text: string): Promise<void>;
}

export interface Intent {
  readonly skill: string;
  /** Why this message was read as that skill, for the reply. */
  readonly because: string;
}

/**
 * What a message means.
 *
 * Deterministic, and it stays that way. This runs on every inbound message,
 * and a model deciding what "organise my downloads" means would add fourteen
 * seconds and a way to be wrong to something a keyword table answers exactly.
 */
export function readIntent(text: string): Intent | null {
  const lowered = text.toLowerCase();
  const table: readonly { skill: string; words: readonly string[]; because: string }[] = [
    {
      skill: "librarian",
      words: ["organise", "organize", "tidy", "clean up", "sort", "file my", "downloads"],
      because: "you asked me to tidy a folder"
    }
  ];
  for (const row of table) {
    if (row.words.some((word) => lowered.includes(word))) {
      return { skill: row.skill, because: row.because };
    }
  }
  return null;
}

export interface MarkOptions {
  readonly host: SkillHost;
  readonly channels: readonly Channel[];
  /**
   * Who this Mac is willing to contact.
   *
   * Required, and there is no "allow everything" value. A Mark built without a
   * lock could reply to anyone who messaged it, which is precisely the property
   * an attacker wants — so the absence of a lock is not a permissive default,
   * it is a construction that does not exist.
   */
  readonly lock: OutboundLock;
  /** Injectable for tests. */
  readonly now?: () => number;
}

export class Mark {
  private readonly queue = new DispatchQueue();
  private readonly host: SkillHost;
  private channels: Map<string, Channel>;
  private lock: OutboundLock;
  private readonly now: () => number;
  private draining: Promise<void> | null = null;

  constructor(options: MarkOptions) {
    this.host = options.host;
    this.channels = new Map(options.channels.map((channel) => [channel.name, channel]));
    this.lock = options.lock;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Replaces the list, without rebuilding Mark.
   *
   * Rebuilding would drop whatever is in the queue, so removing one contact
   * would silently discard work already accepted for another.
   */
  /**
   * Swaps the channels this can reply through, without a restart.
   *
   * Telegram is the reason: a Mac that started without a token had no Telegram
   * channel, so saving one connected the poll and left the replies with nowhere
   * to go — messages arriving and being answered into a channel that did not
   * exist.
   */
  setChannels(channels: readonly Channel[]): void {
    this.channels = new Map(channels.map((channel) => [channel.name, channel]));
  }

  setLock(lock: OutboundLock): void {
    this.lock = lock;
  }

  setPresence(presence: Presence): void {
    const woke = this.queue.currentPresence() !== "awake" && presence === "awake";
    this.queue.setPresence(presence);
    // Waking starts the queue. Without this, work accepted while the lid was
    // shut sat there until somebody sent another message — so the reply "this
    // will run the moment it wakes" was not true.
    if (woke) {
      void this.drain();
    }
  }

  presence(): Presence {
    return this.queue.currentPresence();
  }

  pending(): readonly DispatchTask[] {
    return this.queue.pending();
  }

  /**
   * Takes an inbound message and answers immediately.
   *
   * The acceptance reply is sent before any work starts, so "your Mac is
   * asleep, this is queued" arrives while the person is still looking at their
   * phone rather than after the lid opens.
   */
  async receive(input: {
    channel: DispatchTask["channel"];
    from: string;
    text: string;
  }): Promise<void> {
    const now = this.now();

    /**
     * Who is allowed to give this Mac instructions at all.
     *
     * First, before screening and before any work is queued. An earlier version
     * checked only on the way out, which suppressed the reply and *still ran the
     * skill* — a stranger could move the owner's files silently and see nothing
     * come back. That is worse than no lock, because it looks like one.
     *
     * The list is the same list the outbound lock uses. On a personal Mac the
     * people you will message and the people who may ask you for things are the
     * same people, and two lists would drift until one of them was wrong.
     *
     * The reply is silence, not a refusal: telling a stranger they are blocked
     * confirms this Mac is listening, on the stranger's own channel.
     */
    const known = this.lock.check(input.channel, input.from);
    if (!known.allowed) {
      diagnostics.warn("dispatch", "ignored a message from someone not on the list", {
        channel: input.channel,
        why: known.reason
      });
      return;
    }

    // A message from a phone is untrusted text heading for a tool-calling
    // model. Screen it the same way a document is screened.
    const verdict = screen(input.text, { source: "That message" });
    if (verdict.requiresApproval) {
      diagnostics.warn("mark", "refused an inbound message", {
        channel: input.channel,
        signals: verdict.signals.map((signal) => signal.id),
        score: verdict.score
      });
      await this.reply(input.channel, input.from, `${verdict.summary} I have not acted on it.`);
      return;
    }

    const intent = readIntent(input.text);
    if (intent === null) {
      await this.reply(
        input.channel,
        input.from,
        `I do not know how to do that yet. Right now I can tidy a folder — try “organise my downloads”.`
      );
      return;
    }

    const accepted = this.queue.accept(
      { id: randomUUID(), channel: input.channel, from: input.from, text: input.text },
      now
    );
    await this.reply(input.channel, input.from, accepted.reply);

    if (accepted.accepted) {
      void this.drain();
    }
  }

  /**
   * Runs whatever is ready, one at a time, then reports each result.
   *
   * A second caller joins the run in progress rather than starting another or
   * returning early. Returning early looked correct and was not: `receive`
   * starts a drain without awaiting it, so an awaited `drain()` immediately
   * afterwards resolved before any work had happened — the caller believed it
   * had waited when it had not.
   */
  async drain(): Promise<void> {
    if (this.draining !== null) {
      return await this.draining;
    }
    this.draining = this.runQueue().finally(() => {
      this.draining = null;
    });
    return await this.draining;
  }

  private async runQueue(): Promise<void> {
    // Expiry is reported on **every** pass, not once at the start.
    //
    // A drain can take minutes — an agent reading a folder is not quick — and
    // tasks queued behind it can time out while it runs. Reporting once and
    // then calling a `next()` that silently expired the rest meant those
    // senders heard nothing at all, which is the one outcome this file exists
    // to prevent: silence is indistinguishable from being ignored.
    await this.reportExpired();
    let task = this.queue.next(this.now());
    while (task !== null) {
      await this.run(task);
      await this.reportExpired();
      task = this.queue.next(this.now());
    }
  }

  private async run(task: DispatchTask): Promise<void> {
    this.queue.markRunning(task.id, this.now());
    const intent = readIntent(task.text);
    const folder = this.host.grantedRoots()[0];

    if (intent === null || folder === undefined) {
      const reason =
        folder === undefined
          ? "No folder has been granted on your Mac yet, so there is nothing I am allowed to touch."
          : "I lost track of what that meant.";
      this.queue.markDeclined(task.id, reason, this.now());
      await this.report(task.id);
      return;
    }

    try {
      const preview = await this.host.preview(intent.skill, folder, this.now());
      if (preview.steps.length === 0) {
        this.queue.markDone(task.id, `Nothing to do — ${preview.headline}`, this.now());
        await this.report(task.id);
        return;
      }

      /**
       * What actually stops a phone reaching the outside world, stated
       * correctly, because the sentence that used to be here credited the wrong
       * mechanism and would have gone on reassuring a reader after the real
       * guard was removed.
       *
       * It is **not** the hard ceiling. `HARD_CEILING` caps `outbound` and
       * `shell` at `confirm`, and confirm means "ask the approver" — and the
       * approver here answers yes to everything, unattended, because there is
       * nobody at the Mac to ask. A ceiling of `confirm` in front of a blanket
       * yes is not a gate.
       *
       * It is the **skill policy**: `SkillHost.preview` runs the librarian under
       * `{ read: "auto", write: "confirm" }`, and `decide` reads a risk that is
       * absent from `byRisk` as `off` and refuses it outright — before any
       * approver is consulted. Outbound and shell are absent, so they refuse.
       *
       * That is a real guarantee and it is now held by a test rather than by
       * this comment (`mark.test.ts`, "a message from a phone cannot reach the
       * outside world"). The blanket yes is deliberate for `write`: tidying a
       * folder is the entire point of asking from a phone, and every move is
       * undoable and lands in the record.
       */
      const result = await this.host.run(preview.planId, async () => true, this.now());
      const undo = result.canUndo ? " Reply “undo” if that was wrong." : "";
      this.queue.markDone(task.id, `${result.headline}. ${preview.headline}${undo}`, this.now());
    } catch (error) {
      this.queue.markFailed(
        task.id,
        error instanceof Error ? error.message : "something went wrong",
        this.now()
      );
    }
    await this.report(task.id);
  }

  /** Tells the sender their task expired, rather than letting it vanish. */
  private async reportExpired(): Promise<void> {
    for (const expired of this.queue.expire(this.now())) {
      await this.reply(expired.channel, expired.from, completionReply(expired));
    }
  }

  private async report(id: string): Promise<void> {
    const task = this.queue.get(id);
    if (task !== null) {
      await this.reply(task.channel, task.from, completionReply(task));
    }
  }

  private async reply(
    channel: DispatchTask["channel"],
    to: string,
    text: string
  ): Promise<void> {
    const transport = this.channels.get(channel);
    if (transport === undefined) {
      return;
    }
    // The lock sits here, in the one place every reply passes through, rather
    // than in each channel. A gate a caller can route around is not a gate, and
    // a second channel added later would otherwise ship without one.
    const verdict = this.lock.check(channel, to);
    if (!verdict.allowed) {
      diagnostics.warn("dispatch", "refused to contact someone not on the list", {
        channel,
        // The reason, never the address. This line is the record that the lock
        // held, and it may be read by someone other than the owner.
        why: verdict.reason
      });
      return;
    }
    // A channel failing must not take the loop down. The work still happened,
    // and the receipt is still on the Mac.
    // Whether it actually went. The failure was swallowed *before* the log
    // line, so diagnostics recorded "reply sent" for replies that never left —
    // a green light with no probe behind it, on the record somebody would read
    // to work out why a customer heard nothing.
    const went = await transport
      .send(to, text)
      .then(() => true)
      .catch(() => false);
    diagnostics.info(
      "dispatch",
      went
        ? `reply ${transport.delivery === "sends" ? "sent" : "staged"}`
        : "reply could not be delivered",
      {
      channel,
        // Never the message, and never who it was for. This line exists to make
        // "we handed it over" distinguishable from "it went out" in a log a
        // person may hand to someone else.
        delivery: transport.delivery
      }
    );
  }
}
