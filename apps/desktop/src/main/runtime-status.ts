/**
 * Whether the bundled local model came up, and why not.
 *
 * A tiny shared cell rather than a parameter, because the fact is produced in
 * `index.ts` during startup and consumed in `ipc.ts` when the renderer asks —
 * and threading it through `installIpcHandlers` would change a signature that
 * several boundary tests pin deliberately.
 *
 * It exists at all because startup used to reject when the runtime failed,
 * leaving a running process with no window and nothing in the log. Now it
 * starts, records the reason, and the UI can say what happened.
 *
 * ## Why there are three states and not two
 *
 * This was `available: boolean` plus a problem string, and that shape is what
 * made the app lie. `start()` returns as soon as the process is spawned; the
 * model then takes up to ninety seconds to load, and readiness is only known
 * when a health probe answers. With two states the only options at spawn time
 * were "ready" — a claim nobody had checked — or "failed", which was untrue.
 * Startup chose ready, so the Engine Room reported *"Answered on the private
 * loopback port"* for a model that had not answered anything, including when the
 * file was missing entirely.
 *
 * **Checking is the honest state**, and it is the one the house rule requires:
 * never report a readiness that was not observed. Waiting for the probe before
 * drawing the window would have been the other way to be honest and it breaks a
 * different rule — nothing at startup may block the window. So the window opens,
 * the row says it is checking, and it settles when the probe answers.
 */

export type LocalRuntimeState = "checking" | "ready" | "unavailable";

export interface LocalRuntimeStatus {
  /** True only once a health probe has actually answered. */
  readonly available: boolean;
  /** True while the model is loading and nothing is yet known. */
  readonly checking: boolean;
  readonly state: LocalRuntimeState;
  /** Plain sentence, present only when unavailable. */
  readonly problem: string | null;
}

const CHECKING: LocalRuntimeStatus = {
  available: false,
  checking: true,
  state: "checking",
  problem: null
};

// Starts as unavailable rather than checking: before anything has tried to
// start it, "we are checking" would itself be a claim nobody made.
let status: LocalRuntimeStatus = {
  available: false,
  checking: false,
  state: "unavailable",
  problem: null
};

/** The process is up and the health probe has not answered yet. */
export function markLocalRuntimeChecking(): void {
  status = CHECKING;
}

/** A probe answered. This is the only path to a green light. */
export function markLocalRuntimeReady(): void {
  status = { available: true, checking: false, state: "ready", problem: null };
}

export function markLocalRuntimeFailed(problem: string): void {
  status = { available: false, checking: false, state: "unavailable", problem };
}

export function localRuntimeStatus(): LocalRuntimeStatus {
  return status;
}
