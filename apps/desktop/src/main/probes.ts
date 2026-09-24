/**
 * Prove it — re-run the check behind a claim, right now, and say what it found.
 *
 * ## Why this exists
 *
 * `DESIGN.md` principle 4 says every number has a source and "Ready" is
 * clickable to the probe that decided it. What shipped was a *link*: clicking a
 * status navigates to the screen that measured it, at some point in the past.
 * That is better than nothing and it is not what the principle asks for.
 *
 * The gap it leaves is the one D8 named — **invisible rigour reads as
 * cheapness**. There are ~2,000 tests, a tamper-evident ledger, encrypted
 * journals and a restore rehearsal in here, and a person using the app sees a
 * green dot. This turns a claim into something the app does *in front of you*,
 * which for a product whose whole proposition is trust is worth more than any
 * amount of describing it.
 *
 * ## What a probe returns is a sentence and a number
 *
 * Not a terminal. A reviewer was right that dumping shell output into a primary
 * flow is offloading verification onto the reader rather than doing the design
 * work — so a probe answers *"Checked just now — 1,988 tests, all passing, 34
 * seconds"*, and the raw output sits behind a disclosure for the one reader in a
 * hundred who wants it. The re-run is the feature; the terminal is not.
 *
 * ## A probe may fail, and that is a result rather than an error
 *
 * A check that cannot run says so and stays honest about what is still true.
 * "Never report a readiness that was not observed" cuts both ways: a probe that
 * could not be run must never leave the previous green light standing.
 */

export type ProbeOutcome = "passed" | "failed" | "unavailable";

export interface ProbeResult {
  readonly id: string;
  /** What was claimed, in the owner's words. */
  readonly claim: string;
  readonly outcome: ProbeOutcome;
  /** One sentence saying what was actually measured. Never a bare "OK". */
  readonly said: string;
  /** How long the check took, so a slow one is visibly slow. */
  readonly tookMs: number;
  /** When it ran. A result with no time is a claim again. */
  readonly at: number;
  /**
   * The raw output, kept for the disclosure and never shown by default.
   * Trimmed, because a probe that returns a megabyte is a probe nobody reads.
   */
  readonly detail: string;
}

export interface Probe {
  readonly id: string;
  readonly claim: string;
  /**
   * Runs the check. Returns what it measured, or throws — a throw is turned
   * into `unavailable` rather than being allowed to reach the window.
   */
  run(): Promise<{ readonly ok: boolean; readonly said: string; readonly detail?: string }>;
}

const MAX_DETAIL = 8_000;

/**
 * Runs one probe and never throws.
 *
 * The caller is a screen. A probe that throws past this point would take out the
 * surface whose whole job is to tell somebody what is true, which is the worst
 * possible thing for it to do.
 */
export async function runProbe(probe: Probe, now: () => number = () => Date.now()): Promise<ProbeResult> {
  const started = now();
  try {
    const answer = await probe.run();
    return {
      id: probe.id,
      claim: probe.claim,
      outcome: answer.ok ? "passed" : "failed",
      said: answer.said,
      tookMs: now() - started,
      at: now(),
      detail: (answer.detail ?? "").slice(0, MAX_DETAIL)
    };
  } catch (error) {
    return {
      id: probe.id,
      claim: probe.claim,
      outcome: "unavailable",
      // Says what is still true, in the same breath as the refusal — the useful
      // part of "no" is what to do next and what has not changed.
      said: "This check could not run just now, so nothing here has been re-verified.",
      tookMs: now() - started,
      at: now(),
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

/** Runs several, in order, and never lets one failure hide the others. */
export async function runProbes(
  probes: readonly Probe[],
  now: () => number = () => Date.now()
): Promise<readonly ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    results.push(await runProbe(probe, now));
  }
  return results;
}

/**
 * How a result reads on screen, in the product's voice.
 *
 * `DESIGN.md` §7: a control says exactly what happens and the confirmation
 * matches its tense. "Prove it" then "Checked just now", not "Verify" then
 * "Success!".
 */
export function probeSentence(result: ProbeResult): string {
  const when = result.tookMs < 1000
    ? "just now"
    : `just now, in ${Math.round(result.tookMs / 1000)} seconds`;

  if (result.outcome === "unavailable") {
    return result.said;
  }
  return `Checked ${when} — ${result.said}`;
}

/** "1 test", "1,988 tests". Grouped, because four digits unseparated are hard to read. */
export function countWord(n: number, singular: string, plural = `${singular}s`): string {
  const grouped = n.toLocaleString("en-US");
  return `${grouped} ${n === 1 ? singular : plural}`;
}
