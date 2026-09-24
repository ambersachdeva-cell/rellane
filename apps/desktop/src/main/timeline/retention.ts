/**
 * How long captures are kept, and what is thrown away first.
 *
 * This is a pure decision over a list of stored captures, deliberately separate
 * from the code that deletes files. A retention policy that can only be tested
 * by filling a disk does not get tested, and this one has to hold across a
 * synthetic month before it is allowed near anyone's Mac.
 *
 * It is only honest because the recut in W1.2 made a capture's cost knowable at
 * the moment it is written. Clone storage could not be measured — `du` reports
 * a clone's logical size, and the volume's free space moves by a fraction of it
 * that depends on what the owner edits afterwards — so a ceiling over clones
 * was a number nobody had. A manifest's bytes are the bytes it took.
 *
 * Resolution falls off with age because that is how memory of a folder actually
 * works: this afternoon you want every version, last March you want one.
 */

/** One capture already on disk, as retention needs to judge it. */
export interface StoredCapture {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly bytes: number;
  /**
   * The reason a person named, when they named one.
   *
   * Named checkpoints are never thinned. Someone typed "before the GST filing"
   * into a box, which is a stronger statement about what matters than any rule
   * here, and deleting it to save 40 KB would be the app overruling its owner.
   */
  readonly checkpoint: string | null;
}

export interface RetentionPolicy {
  /** Below this age, every capture is kept. */
  readonly allMs: number;
  /** Below this age, the newest capture in each hour is kept. */
  readonly hourlyMs: number;
  /** Below this age, the newest capture in each day is kept. */
  readonly dailyMs: number;
  /** Older than `dailyMs`, the newest capture in each week is kept. */
  readonly ceilingBytes: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The shipped policy.
 *
 * 128 MB is roughly 12,000 captures of a 10,000-file folder, or about eight
 * months of the thinned schedule below on a folder that changes all day. It is
 * a number chosen to be forgettable: small enough that nobody notices it, large
 * enough that nobody loses a checkpoint to it.
 */
export const DEFAULT_POLICY: RetentionPolicy = {
  allMs: HOUR,
  hourlyMs: DAY,
  dailyMs: 30 * DAY,
  ceilingBytes: 128 * 1024 * 1024
};

export interface RetentionPlan {
  readonly keep: readonly StoredCapture[];
  readonly drop: readonly StoredCapture[];
  /**
   * True when the byte ceiling — not the age schedule — forced the last
   * deletions. Worth surfacing, because it means the timeline is now shorter
   * than the policy promises and the owner should be told why rather than
   * noticing last month has quietly gone.
   */
  readonly hitCeiling: boolean;
}

/**
 * Decides what survives.
 *
 * Two passes, in this order. First the age schedule thins by resolution.
 * Then, if the survivors still exceed the byte ceiling, the oldest unnamed
 * captures are dropped until they fit — oldest first, because the sparse end of
 * the timeline is where a deletion costs the least information.
 *
 * The newest capture is always kept. It is the folder's current known state and
 * every diff is measured from it; a timeline that thinned it away would have to
 * re-walk the whole folder to say anything at all.
 */
export function thin(
  captures: readonly StoredCapture[],
  now: number,
  policy: RetentionPolicy = DEFAULT_POLICY
): RetentionPlan {
  if (captures.length === 0) {
    return { keep: [], drop: [], hitCeiling: false };
  }

  // Newest first, so "the first one in this bucket" is "the newest in it".
  const ordered = [...captures].sort((left, right) => right.at - left.at);
  const newest = ordered[0] as StoredCapture;

  const keep: StoredCapture[] = [];
  const drop: StoredCapture[] = [];
  const claimed = new Set<string>();

  for (const capture of ordered) {
    if (capture === newest || capture.checkpoint !== null) {
      keep.push(capture);
      continue;
    }

    const age = now - capture.at;
    if (age <= policy.allMs) {
      keep.push(capture);
      continue;
    }

    const bucket =
      age <= policy.hourlyMs
        ? `h${Math.floor(capture.at / HOUR)}`
        : age <= policy.dailyMs
          ? `d${Math.floor(capture.at / DAY)}`
          : `w${Math.floor(capture.at / (7 * DAY))}`;

    if (claimed.has(bucket)) {
      drop.push(capture);
    } else {
      claimed.add(bucket);
      keep.push(capture);
    }
  }

  const hitCeiling = enforceCeiling(keep, drop, newest, policy.ceilingBytes);

  // Back to newest-first for the caller; the ceiling pass reorders nothing but
  // it is cheaper to state the guarantee than to rely on it.
  keep.sort((left, right) => right.at - left.at);
  drop.sort((left, right) => right.at - left.at);

  return { keep, drop, hitCeiling };
}

/**
 * Drops the oldest unnamed survivors until the total fits.
 *
 * Named checkpoints and the newest capture are exempt, which means the ceiling
 * can be exceeded by a person who names a great many checkpoints. That is the
 * correct failure: the alternative is silently deleting the thing they asked us
 * to hold, and `hitCeiling` gives the UI what it needs to say so.
 */
function enforceCeiling(
  keep: StoredCapture[],
  drop: StoredCapture[],
  newest: StoredCapture,
  ceilingBytes: number
): boolean {
  let total = keep.reduce((sum, capture) => sum + capture.bytes, 0);
  if (total <= ceilingBytes) {
    return false;
  }

  // Oldest first: the sparse end of the timeline is where losing one capture
  // costs the least, because its neighbours are already days or weeks away.
  const evictable = keep
    .filter((capture) => capture !== newest && capture.checkpoint === null)
    .sort((left, right) => left.at - right.at);

  let evicted = false;
  for (const capture of evictable) {
    if (total <= ceilingBytes) {
      break;
    }
    total -= capture.bytes;
    drop.push(capture);
    evicted = true;
  }

  if (evicted) {
    const dropped = new Set(drop);
    let kept = 0;
    for (const capture of keep) {
      if (!dropped.has(capture)) {
        keep[kept] = capture;
        kept += 1;
      }
    }
    keep.length = kept;
  }
  return evicted;
}

/** Total bytes a set of captures occupies. */
export function totalBytes(captures: readonly StoredCapture[]): number {
  return captures.reduce((sum, capture) => sum + capture.bytes, 0);
}
