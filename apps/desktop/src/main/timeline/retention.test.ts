import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, thin, totalBytes, type StoredCapture } from "./retention.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-08-30T12:00:00.000Z");

function capture(at: number, bytes = 40_000, checkpoint: string | null = null): StoredCapture {
  return { at, bytes, checkpoint };
}

describe("what the timeline keeps", () => {
  it("keeps everything from the last hour", () => {
    const captures = [
      capture(NOW - 60_000),
      capture(NOW - 600_000),
      capture(NOW - 1_800_000),
      capture(NOW - 3_000_000)
    ];

    const plan = thin(captures, NOW);

    expect(plan.keep).toHaveLength(4);
    expect(plan.drop).toHaveLength(0);
  });

  /**
   * Each of these anchors the set with a capture from a minute ago.
   *
   * Without it the oldest-and-only capture is also the newest one, which is
   * exempt from thinning, and the test measures that exemption instead of the
   * bucket it meant to measure. `anchored` returns just the survivors from the
   * period under test.
   */
  const anchor = () => capture(NOW - 60_000, 1024);
  const anchored = (plan: { keep: readonly StoredCapture[] }) =>
    plan.keep.filter((kept) => kept.at !== NOW - 60_000);

  it("thins yesterday down to one per hour", () => {
    // Six captures inside one hour, six hours ago.
    const sixHoursAgo = NOW - 6 * HOUR;
    const captures = [anchor(), ...[0, 1, 2, 3, 4, 5].map((n) => capture(sixHoursAgo + n * 60_000))];

    const survivors = anchored(thin(captures, NOW));

    expect(survivors).toHaveLength(1);
    // The newest in the bucket survives, because it is the one that describes
    // the folder as it was left.
    expect(survivors[0]?.at).toBe(sixHoursAgo + 5 * 60_000);
  });

  it("thins last week down to one per day", () => {
    const fiveDaysAgo = NOW - 5 * DAY;
    const captures = [anchor(), ...[0, 1, 2, 3].map((n) => capture(fiveDaysAgo + n * 2 * HOUR))];

    const survivors = anchored(thin(captures, NOW));

    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.at).toBe(fiveDaysAgo + 6 * HOUR);
  });

  it("thins beyond a month down to one per week", () => {
    const longAgo = NOW - 90 * DAY;
    const captures = [anchor(), ...[0, 1, 2, 3, 4, 5, 6].map((n) => capture(longAgo + n * DAY))];

    // Seven consecutive days that long ago collapse to the one or two week
    // buckets they happen to straddle.
    const survivors = anchored(thin(captures, NOW));

    expect(survivors.length).toBeLessThanOrEqual(2);
    expect(survivors.length).toBeGreaterThan(0);
  });

  it("never thins a checkpoint someone named", () => {
    const longAgo = NOW - 200 * DAY;
    const captures = [
      capture(longAgo, 40_000, "before the GST filing"),
      capture(longAgo + 60_000),
      capture(longAgo + 120_000)
    ];

    const plan = thin(captures, NOW);

    expect(plan.keep.map((c) => c.checkpoint)).toContain("before the GST filing");
  });

  it("always keeps the newest capture, whatever the policy says", () => {
    // It is the folder's current known state and every diff is measured from
    // it. Thinning it away would mean re-walking the whole folder to say
    // anything at all.
    const plan = thin([capture(NOW - 400 * DAY)], NOW);

    expect(plan.keep).toHaveLength(1);
    expect(plan.drop).toHaveLength(0);
  });

  it("decides nothing about an empty timeline", () => {
    const plan = thin([], NOW);

    expect(plan.keep).toEqual([]);
    expect(plan.drop).toEqual([]);
    expect(plan.hitCeiling).toBe(false);
  });
});

describe("the byte ceiling", () => {
  it("evicts the oldest unnamed capture first", () => {
    const captures = [
      capture(NOW - 3 * HOUR, 60 * 1024 * 1024),
      capture(NOW - 2 * HOUR, 60 * 1024 * 1024),
      capture(NOW - 60_000, 60 * 1024 * 1024)
    ];

    const plan = thin(captures, NOW);

    expect(plan.hitCeiling).toBe(true);
    expect(totalBytes(plan.keep)).toBeLessThanOrEqual(DEFAULT_POLICY.ceilingBytes);
    // Oldest went; the sparse end of the timeline is where a deletion costs
    // the least information.
    expect(plan.drop[0]?.at).toBe(NOW - 3 * HOUR);
  });

  it("says when the ceiling and not the schedule did the deleting", () => {
    const roomy = thin([capture(NOW - 60_000, 1024)], NOW);

    expect(roomy.hitCeiling).toBe(false);
  });

  it("goes over the ceiling rather than deleting a named checkpoint", () => {
    // The correct failure. Someone asked us to hold these; silently deleting
    // them to respect a number they never saw would be the app overruling its
    // owner. hitCeiling is what lets the UI say so instead.
    const captures = [
      capture(NOW - 5 * DAY, 100 * 1024 * 1024, "before the GST filing"),
      capture(NOW - 4 * DAY, 100 * 1024 * 1024, "before the audit"),
      capture(NOW - 60_000, 1024)
    ];

    const plan = thin(captures, NOW);

    expect(plan.keep).toHaveLength(3);
    expect(totalBytes(plan.keep)).toBeGreaterThan(DEFAULT_POLICY.ceilingBytes);
  });

  /**
   * W1.3's done-when, run as written: a synthetic month of a folder that is
   * worked in all day, thinned after every capture the way the store will do
   * it, with the ceiling asserted at every single step rather than at the end.
   */
  it("never exceeds the ceiling across a synthetic month", () => {
    const start = Date.parse("2026-07-01T09:00:00.000Z");
    let live: StoredCapture[] = [];
    let ceilingEverBroken = false;

    // Every 10 minutes for 30 days: 4,320 captures of a 10,000-file folder.
    for (let step = 0; step < 30 * 24 * 6; step += 1) {
      const at = start + step * 10 * 60_000;
      live.push(capture(at, 1_400_000));

      const plan = thin(live, at);
      live = [...plan.keep];

      if (totalBytes(live) > DEFAULT_POLICY.ceilingBytes) {
        ceilingEverBroken = true;
        break;
      }
    }

    expect(ceilingEverBroken).toBe(false);
    // And it is still a useful timeline rather than one surviving capture.
    expect(live.length).toBeGreaterThan(20);
  });

  it("keeps a month's shape: dense today, sparse in July", () => {
    const start = Date.parse("2026-07-01T09:00:00.000Z");
    const end = start + 30 * DAY;
    let live: StoredCapture[] = [];

    for (let step = 0; step < 30 * 24 * 6; step += 1) {
      const at = start + step * 10 * 60_000;
      live.push(capture(at, 40_000));
      live = [...thin(live, at).keep];
    }

    const lastHour = live.filter((c) => c.at > end - HOUR).length;
    const firstWeek = live.filter((c) => c.at < start + 7 * DAY).length;

    // Resolution falls off with age, which is how memory of a folder works:
    // this afternoon you want every version, three weeks ago you want one a day.
    expect(lastHour).toBeGreaterThan(firstWeek / 2);
    expect(firstWeek).toBeLessThan(30);
  });
});
