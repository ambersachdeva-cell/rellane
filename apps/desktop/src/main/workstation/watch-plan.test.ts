import { describe, expect, it } from "vitest";
import {
  CADENCE_INTERVAL_MS,
  isDue,
  judgeChange,
  type Cadence,
  type Watch,
  type WatchTarget,
} from "./watch-plan.js";

function createWatch(options?: {
  readonly id?: string;
  readonly target?: WatchTarget;
  readonly cadence?: Cadence;
  readonly tellMeWhen?: "anything-changes" | "numbers-change" | "something-new-appears";
  readonly quietHours?: boolean;
  readonly lastCheckedAt?: number | null;
  readonly lastChangedAt?: number | null;
  readonly paused?: boolean;
}): Watch {
  return {
    id: options?.id ?? "watch-1",
    target: options?.target ?? {
      kind: "page",
      url: "https://supplier.example.com/prices",
      label: "Supplier Prices",
    },
    cadence: options?.cadence ?? "daily",
    tellMeWhen: options?.tellMeWhen ?? "anything-changes",
    quietHours: options?.quietHours ?? false,
    lastCheckedAt: options?.lastCheckedAt !== undefined ? options.lastCheckedAt : 1_000_000,
    lastChangedAt: options?.lastChangedAt !== undefined ? options.lastChangedAt : 1_000_000,
    paused: options?.paused ?? false,
  };
}

describe("isDue", () => {
  it("triggers immediately when a watch has never been checked", () => {
    const watch = createWatch({ lastCheckedAt: null });
    expect(isDue(watch, 5_000)).toBe(true);
  });

  it("suppresses execution when paused regardless of elapsed time", () => {
    const watch = createWatch({
      paused: true,
      cadence: "hourly",
      lastCheckedAt: 1_000,
    });
    expect(isDue(watch, 1_000 + CADENCE_INTERVAL_MS.hourly * 10)).toBe(false);
  });

  it("respects cadence boundaries for hourly checks", () => {
    const baseTime = 1_000_000;
    const watch = createWatch({
      cadence: "hourly",
      lastCheckedAt: baseTime,
    });
    expect(isDue(watch, baseTime + 1_800_000)).toBe(false);
    expect(isDue(watch, baseTime + 3_600_000)).toBe(true);
  });

  it("respects cadence boundaries for weekly checks", () => {
    const baseTime = 1_000_000;
    const watch = createWatch({
      cadence: "weekly",
      lastCheckedAt: baseTime,
    });
    expect(isDue(watch, baseTime + CADENCE_INTERVAL_MS.weekly - 1)).toBe(false);
    expect(isDue(watch, baseTime + CADENCE_INTERVAL_MS.weekly)).toBe(true);
  });
});

describe("judgeChange baseline and identical comparisons", () => {
  it("records baseline on first check without sending a message", () => {
    const watch = createWatch();
    const verdict = judgeChange({
      watch,
      before: "",
      after: "Widget: £1,240\nShipping: £10",
      now: 1_000_000,
    });

    expect(verdict.changed).toBe(true);
    expect(verdict.worthTelling).toBe(false);
    expect(verdict.what).toBe("First check completed; baseline recorded.");
    expect(verdict.detail).toEqual([]);
  });

  it("reports unchanged state on identical inputs", () => {
    const watch = createWatch();
    const verdict = judgeChange({
      watch,
      before: "Unit price: 1,240",
      after: "Unit price: 1,240",
      now: 1_000_000,
    });

    expect(verdict.changed).toBe(false);
    expect(verdict.worthTelling).toBe(false);
    expect(verdict.what).toBe("Nothing has changed.");
    expect(verdict.detail).toEqual([]);
  });
});

describe("anything-changes mode", () => {
  it("marks date-only changes as changed but not worth telling", () => {
    const watch = createWatch({ tellMeWhen: "anything-changes" });
    const before = "Acme Supply\nLast updated: 14 September 2026 at 10:00\nIn stock: 50 crates";
    const after = "Acme Supply\nLast updated: 15 September 2026 at 09:30\nIn stock: 50 crates";

    const verdict = judgeChange({
      watch,
      before,
      after,
      now: 1_000_000,
    });

    expect(verdict.changed).toBe(true);
    expect(verdict.worthTelling).toBe(false);
    expect(verdict.what).toBe("Only routine dates, counters or session details changed.");
  });

  it("ignores menu reordering when all items remain identical", () => {
    const watch = createWatch({ tellMeWhen: "anything-changes" });
    const before = "Home\nProducts\nAbout Us\nContact";
    const after = "Home\nAbout Us\nProducts\nContact";

    const verdict = judgeChange({
      watch,
      before,
      after,
      now: 1_000_000,
    });

    expect(verdict.changed).toBe(true);
    expect(verdict.worthTelling).toBe(false);
    expect(verdict.what).toBe("List items were reordered with no content changes.");
  });

  it("flags genuine content changes with bounded detail lines", () => {
    const watch = createWatch({ tellMeWhen: "anything-changes" });
    const before = "Product A: In stock\nProduct B: In stock";
    const after = "Product A: Discontinued\nProduct B: In stock";

    const verdict = judgeChange({
      watch,
      before,
      after,
      now: 1_000_000,
    });

    expect(verdict.changed).toBe(true);
    expect(verdict.worthTelling).toBe(true);
    expect(verdict.what).toBe("Content changed on Supplier Prices.");
    expect(verdict.detail.length).toBeGreaterThan(0);
    expect(verdict.detail.length).toBeLessThanOrEqual(5);
  });
});

describe("numbers-change mode", () => {
  it("names both old and new values when a price changes with thousands separators", () => {
    const watch = createWatch({ tellMeWhen: "numbers-change" });
    const before = "Wholesale rate: £1,240 per carton";
    const after = "Wholesale rate: £1,310 per carton";

    const verdict = judgeChange({
      watch,
      before,
      after,
      now: 1_000_000,
    });

    expect(verdict.changed).toBe(true);
    expect(verdict.worthTelling).toBe(true);
    expect(verdict.what).toContain("1,240");
    expect(verdict.what).toContain("1,310");
    expect(verdict.what).toBe("Price changed from £1,240 to £1,310 on Supplier Prices.");
    expect(verdict.detail).toEqual(["wholesale rate per carton: £1,240 to £1,310"]);
  });

  it("ignores visitor counter increments without alerting", () => {
    const watch = createWatch({ tellMeWhen: "numbers-change" });
    const before = "Catalog\n1,240 views today\nStandard fee: £500";
    const after = "Catalog\n1,310 views today\nStandard fee: £500";

    const verdict = judgeChange({
      watch,
      before,
      after,
      now: 1_000_000,
    });

    expect(verdict.changed).toBe(true);
    expect(verdict.worthTelling).toBe(false);
    expect(verdict.what).toBe("No meaningful numbers changed.");
  });

  it("processes large inputs smoothly without dropping meaningful differences", () => {
    const watch = createWatch({ tellMeWhen: "numbers-change" });
    const filler = "Standard inventory item description line.\n".repeat(10_000);
    const before = `${filler}Price: £1,240\n${filler}`;
    const after = `${filler}Price: £1,310\n${filler}`;

    const verdict = judgeChange({
      watch,
      before,
      after,
      now: 1_000_000,
    });

    expect(verdict.changed).toBe(true);
    expect(verdict.worthTelling).toBe(true);
    expect(verdict.what).toBe("Price changed from £1,240 to £1,310 on Supplier Prices.");
  });
});

describe("something-new-appears mode", () => {
  it("reports added items distinctly from removed items", () => {
    const watch = createWatch({
      tellMeWhen: "something-new-appears",
      target: { kind: "folder", path: "/Documents/Invoices", label: "Invoices" },
    });
    const before = "inv-001.pdf\ninv-002.pdf";
    const after = "inv-001.pdf\ninv-002.pdf\ninv-003.pdf";

    const verdict = judgeChange({
      watch,
      before,
      after,
      now: 1_000_000,
    });

    expect(verdict.changed).toBe(true);
    expect(verdict.worthTelling).toBe(true);
    expect(verdict.what).toBe("1 new file appeared in Invoices.");
    expect(verdict.detail).toEqual(["+ inv-003.pdf"]);
  });

  it("reports removals with dedicated wording", () => {
    const watch = createWatch({
      tellMeWhen: "something-new-appears",
      target: { kind: "folder", path: "/Documents/Invoices", label: "Invoices" },
    });
    const before = "inv-001.pdf\ninv-002.pdf";
    const after = "inv-001.pdf";

    const verdict = judgeChange({
      watch,
      before,
      after,
      now: 1_000_000,
    });

    expect(verdict.changed).toBe(true);
    expect(verdict.worthTelling).toBe(true);
    expect(verdict.what).toBe("1 file was removed from Invoices.");
    expect(verdict.detail).toEqual(["- inv-002.pdf"]);
  });
});

describe("quietHours handling", () => {
  /**
   * Judging is blind to the clock. Holding an alert overnight is the runner's
   * job, because only the runner can deliver it in the morning.
   */
  it("judges the same at 23:00 as at 14:00, and leaves the holding to the runner", () => {
    const watch = createWatch({
      quietHours: true,
      tellMeWhen: "numbers-change",
    });
    const lateNight = new Date(2026, 8, 15, 23, 0, 0).getTime();
    const daytime = new Date(2026, 8, 15, 14, 0, 0).getTime();

    const atNight = judgeChange({
      watch,
      before: "Price: £1,240",
      after: "Price: £1,310",
      now: lateNight,
    });
    const byDay = judgeChange({
      watch,
      before: "Price: £1,240",
      after: "Price: £1,310",
      now: daytime,
    });

    expect(atNight.worthTelling).toBe(true);
    expect(atNight.what).toBe(byDay.what);
    expect(atNight.what).not.toContain("held until morning");
    expect(atNight.what).toContain("1,240");
    expect(atNight.what).toContain("1,310");
  });
});
