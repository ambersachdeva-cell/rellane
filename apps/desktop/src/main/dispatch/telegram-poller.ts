/** The loop that lets Mark hear a phone. Long-polls Telegram; never opens a port.
 *
 * Telegram is the owner reaching their own desk, not a channel customers write
 * to. N10 fixes the verb list at **ask, status, stop, notify** — read-only,
 * except `stop`, which only ever subtracts. Nothing that arrives here can
 * approve anything, change a file, send a message or grant a permission, and
 * that boundary lives in `Mark.receive` and the outbound lock rather than in
 * this file. This one only carries messages across.
 *
 * ## Why a poll and not a webhook
 *
 * A bot that long-polls needs no inbound port, no VPS and no certificate: the
 * Mac reaches out and holds the connection. That is the whole reason Telegram
 * goes first among the three channels — it is the only one that is free,
 * private enough, and shippable without renting anything.
 *
 * ## It must not be killable by a stranger
 *
 * Anyone who learns the bot's username can send it anything. A malformed
 * sticker, a message type nothing parses, a flood. So: a failure in one message
 * never ends the loop and never blocks the rest of the batch, and a transport
 * failure backs off rather than spinning. A poller that dies on a bad update is
 * a denial of service against `stop`, which is the one verb that has to work.
 *
 * ## The local stop
 *
 * `stop()` is on the Mac and does not go through Telegram. If the channel can
 * be flooded, the kill switch cannot live only inside it.
 */

import { diagnostics } from "../foundations/diagnostics.js";
import { backoffMs, TelegramConflict, type TelegramMessage } from "./telegram.js";

export interface TelegramPollDeps {
  /** Long-polls once and advances its own offset. */
  poll(signal: AbortSignal): Promise<readonly TelegramMessage[]>;
  /** Hands one message to Mark. Its refusals are Mark's, not this loop's. */
  deliver(message: TelegramMessage): Promise<void>;
  /**
   * Injected so a test does not wait out a real backoff.
   *
   * Takes the signal because `stop()` during a backoff must end the loop now.
   * An uncancellable sleep here means quitting waits out a wait that exists
   * only because Telegram was already unreachable.
   */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface TelegramPoll {
  /** Local, and not routed through Telegram. */
  stop(): void;
  /** Resolves when the loop has finished, however it ended. */
  readonly done: Promise<void>;
}

export function startTelegramPoll(deps: TelegramPollDeps): TelegramPoll {
  const controller = new AbortController();
  let failures = 0;

  // `.catch` rather than a bare promise: nothing at the call site awaits this,
  // and an escaping rejection in the main process takes the app with it.
  const done = (async () => {
    while (!controller.signal.aborted) {
      let batch: readonly TelegramMessage[];
      try {
        batch = await deps.poll(controller.signal);
        failures = 0;
      } catch (problem) {
        if (controller.signal.aborted) {
          return;
        }
        if (problem instanceof TelegramConflict) {
          // A second poller on the same token. That is a misconfiguration, not
          // a blip: retrying would have the two of them steal each other's
          // updates for ever, and each would look intermittently broken.
          diagnostics.warn("dispatch", "another Telegram poller is using this bot; stopping", {});
          return;
        }
        failures += 1;
        // Wrapped: this is the loop's own error path, and a throw from inside it
        // escapes the async function entirely. Nothing awaits `done` at the call
        // site, so that surfaces as an unhandled rejection rather than a stopped
        // poller — the process dies instead of the feature.
        try {
          const wait = backoffMs(problem, failures);
          diagnostics.warn("dispatch", "the Telegram poll failed; backing off", {
            failures,
            waitMs: wait
          });
          await deps.sleep(wait, controller.signal);
        } catch {
          if (controller.signal.aborted) {
            return;
          }
          // Backing off is itself failing. Stopping is honest; spinning is not.
          diagnostics.warn("dispatch", "the Telegram poll could not back off; stopping", {});
          return;
        }
        continue;
      }

      for (const message of batch) {
        if (controller.signal.aborted) {
          return;
        }
        try {
          await deps.deliver(message);
        } catch (problem) {
          // One message, one failure. The offset has already moved past it, so
          // this is not retried: a message that makes delivery throw would
          // otherwise be redelivered for ever and nothing after it would run.
          diagnostics.warn("dispatch", "a Telegram message could not be handled", {
            why: problem instanceof Error ? problem.name : "unknown"
          });
        }
      }
    }
  })();

  return {
    stop(): void {
      controller.abort();
    },
    done: done.catch((problem: unknown) => {
      diagnostics.warn("dispatch", "the Telegram poll ended unexpectedly", {
        why: problem instanceof Error ? problem.name : "unknown"
      });
    })
  };
}
