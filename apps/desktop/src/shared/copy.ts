/**
 * Small helpers for text a person reads.
 *
 * These exist because "1 rows" is the cheapest possible signal that nobody
 * looked at the screen. It costs a reader nothing to notice and it costs us
 * their confidence in everything else on the page — a product that gets the
 * easy sentence wrong is not one you trust with your Downloads folder.
 *
 * Kept in `shared` so main and renderer produce the same sentence rather than
 * two subtly different ones.
 */

/**
 * A count with its noun, agreeing.
 *
 *   plural(0, "file")  → "0 files"
 *   plural(1, "file")  → "1 file"
 *   plural(4, "entry", "entries") → "4 entries"
 *
 * Zero takes the plural, which is correct in English and is why this cannot
 * simply be `n === 1 ? singular : singular + "s"` written inline each time.
 */
export function plural(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/**
 * The verb for a count. "1 file **is**", "3 files **are**".
 *
 * Separate from `plural` because the noun and the verb are often not adjacent —
 * "all 3 files are already where they should be" has four words between them.
 */
export function verb(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/**
 * A byte count at the precision a person can act on.
 *
 *   size(940)        → "940 bytes"
 *   size(64_000)     → "63 KB"
 *   size(67_108_864) → "64.0 MB"
 *
 * MB keeps one decimal and KB keeps none, because the decision a reader makes
 * from "1.4 GB" and from "1.4 MB" are different decisions, while nobody has
 * ever needed "63.4 KB". Base 1024 throughout, matching what the executor
 * measures and what `FALLBACK_MAX_BYTES` is expressed in — a sentence that says
 * MB while the ceiling counts MiB is how an off-by-5% refusal surprises someone.
 */
export function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "an unknown amount";
  }
  if (bytes < 1024) {
    return plural(Math.round(bytes), "byte");
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${Math.round(kb)} KB`;
  }
  const mb = kb / 1024;
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * A list read aloud: "a", "a and b", "a, b and c".
 *
 * No Oxford comma, matching the rest of the product's copy.
 */
export function list(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What went wrong, in words written for a person.
 *
 * Electron wraps anything thrown in a handler before it reaches the renderer:
 * a carefully worded sentence arrives as *"Error invoking remote method
 * 'cadrane:v4:automation-snapshot': RuntimeBoundaryError: Flows are locked…"*.
 * The sentence is still in there, behind two pieces of plumbing and a channel
 * name — which is enough to make a considered explanation read as a crash.
 *
 * So every message crossing that boundary comes through here. It strips the
 * wrapper and the error-class prefix and leaves what was actually written. It
 * never invents: something with no recognisable message falls through to the
 * caller's own fallback, because a generic apology in place of a real reason is
 * how a product stops being worth reading.
 */
export function said(problem: unknown, fallback: string): string {
  const raw = problem instanceof Error ? problem.message : typeof problem === "string" ? problem : "";
  const unwrapped = raw.replace(new RegExp("^Error invoking remote method '[^']*':\\s*", "u"), "");
  // Only a class name, which is `Name:` or `NameError:` at the very start. A
  // colon inside the sentence itself — "Flows are locked: the key…" — must
  // survive, so the prefix has to look like an identifier and nothing else.
  const named = unwrapped.replace(/^(?:Error|[A-Z][A-Za-z0-9]*Error):\s*/u, "");
  const trimmed = named.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}
