export interface UsageReceipt {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string | null;
  readonly status: "completed" | "stopped" | "failed" | "interrupted";
  readonly startedAt: number;
  readonly endedAt: number;
  readonly caseId: string;
}

export interface SubscriptionUsage {
  readonly providerId: string;
  readonly label: string;
  readonly asked: number;
  readonly finished: number;
  readonly stopped: number;
  readonly failed: number;
  readonly totalMs: number;
  readonly longest: string;
  readonly lastUsed: string;
  readonly busiestDay: string | null;
  readonly models: readonly { readonly id: string; readonly asked: number }[];
}

export interface UsageView {
  readonly window: "today" | "week" | "month";
  readonly headline: string;
  readonly subscriptions: readonly SubscriptionUsage[];
  readonly totalAsked: number;
  readonly quietest: string | null;
  readonly note: string;
}

interface MutableDayStat {
  count: number;
  latestTime: number;
}

interface MutableProviderUsage {
  readonly providerId: string;
  readonly label: string;
  readonly orderIndex: number;
  asked: number;
  finished: number;
  stopped: number;
  failed: number;
  totalMs: number;
  longestMs: number;
  latestStartedAt: number;
  readonly dayCounts: Map<string, MutableDayStat>;
  readonly modelCounts: Map<string, number>;
}

const DAYS: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const SMALL_NUMBERS: readonly string[] = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

const HONEST_NOTE =
  "This counts what Rellane asked. How much of each subscription is left is something only that provider can tell you.";

function getWindowStart(window: "today" | "week" | "month", now: number): number {
  const d = new Date(now);
  switch (window) {
    case "today": {
      // Calendar start of the active local day
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
      return start.getTime();
    }
    case "week": {
      // British calendar week begins on Monday
      const dayOfWeek = d.getDay();
      const daysSinceMonday = (dayOfWeek + 6) % 7;
      const start = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate() - daysSinceMonday,
        0,
        0,
        0,
        0,
      );
      return start.getTime();
    }
    case "month": {
      // Calendar start of the active month
      const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
      return start.getTime();
    }
  }
}

function formatDurationWords(ms: number): string {
  if (ms <= 0) {
    return "0 sec";
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} sec`;
  }
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(ms / 3600_000);
  const remMinutes = Math.round((ms % 3600_000) / 60_000);
  if (remMinutes === 0) {
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (remMinutes >= 60) {
    const adjustedHours = hours + 1;
    return `${adjustedHours} ${adjustedHours === 1 ? "hour" : "hours"}`;
  }
  return `${hours} ${hours === 1 ? "hour" : "hours"} ${remMinutes} min`;
}

function formatTimeAgo(diffMs: number): string {
  if (diffMs < 60_000) {
    return "just now";
  }
  if (diffMs < 3600_000) {
    const mins = Math.max(1, Math.floor(diffMs / 60_000));
    return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  }
  if (diffMs < 86_400_000) {
    const hours = Math.max(1, Math.floor(diffMs / 3600_000));
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.max(1, Math.floor(diffMs / 86_400_000));
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function formatCountWord(n: number): string {
  if (n >= 0 && n < SMALL_NUMBERS.length) {
    return SMALL_NUMBERS[n]!;
  }
  return String(n);
}

function getWindowPhrase(window: "today" | "week" | "month"): string {
  switch (window) {
    case "today":
      return "today";
    case "week":
      return "this week";
    case "month":
      return "this month";
  }
}

function buildHeadline(
  window: "today" | "week" | "month",
  distinctAsked: number,
  totalAsked: number,
): string {
  const windowPhrase = getWindowPhrase(window);
  if (totalAsked === 0) {
    return `You asked no subscriptions ${windowPhrase}.`;
  }
  const subNoun = distinctAsked === 1 ? "subscription" : "subscriptions";
  const timeNoun = totalAsked === 1 ? "1 time" : `${totalAsked} times`;
  return `You asked ${formatCountWord(distinctAsked)} ${subNoun} ${timeNoun} ${windowPhrase}.`;
}

export function tallyUsage(input: {
  readonly receipts: readonly UsageReceipt[];
  readonly known: readonly { readonly id: string; readonly label: string }[];
  readonly window: "today" | "week" | "month";
  readonly now: number;
}): UsageView {
  const { receipts, known, window, now } = input;
  const windowStart = getWindowStart(window, now);

  const providerMap = new Map<string, MutableProviderUsage>();
  const knownIds = new Set<string>();

  for (let i = 0; i < known.length; i++) {
    const k = known[i]!;
    knownIds.add(k.id);
    providerMap.set(k.id, {
      providerId: k.id,
      label: k.label,
      orderIndex: i,
      asked: 0,
      finished: 0,
      stopped: 0,
      failed: 0,
      totalMs: 0,
      longestMs: 0,
      latestStartedAt: -1,
      dayCounts: new Map<string, MutableDayStat>(),
      modelCounts: new Map<string, number>(),
    });
  }

  let totalAsked = 0;
  let unknownCount = 0;

  for (const receipt of receipts) {
    // Receipts outside the window boundary or timestamped in the future are discarded
    if (receipt.startedAt < windowStart || receipt.startedAt > now) {
      continue;
    }

    totalAsked++;

    let entry = providerMap.get(receipt.providerId);
    if (!entry) {
      entry = {
        providerId: receipt.providerId,
        label: receipt.providerId,
        orderIndex: known.length + unknownCount,
        asked: 0,
        finished: 0,
        stopped: 0,
        failed: 0,
        totalMs: 0,
        longestMs: 0,
        latestStartedAt: -1,
        dayCounts: new Map<string, MutableDayStat>(),
        modelCounts: new Map<string, number>(),
      };
      unknownCount++;
      providerMap.set(receipt.providerId, entry);
    }

    entry.asked++;

    switch (receipt.status) {
      case "completed":
        entry.finished++;
        break;
      case "stopped":
      case "interrupted":
        entry.stopped++;
        break;
      case "failed":
        entry.failed++;
        break;
    }

    // Inverted timestamps still increment request counts while duration remains non-negative
    if (receipt.endedAt >= receipt.startedAt) {
      const durationMs = receipt.endedAt - receipt.startedAt;
      entry.totalMs += durationMs;
      if (durationMs > entry.longestMs) {
        entry.longestMs = durationMs;
      }
    }

    if (receipt.startedAt > entry.latestStartedAt) {
      entry.latestStartedAt = receipt.startedAt;
    }

    const receiptDate = new Date(receipt.startedAt);
    const dayName = DAYS[receiptDate.getDay()]!;
    const dayStat = entry.dayCounts.get(dayName);
    if (dayStat) {
      dayStat.count++;
      if (receipt.startedAt > dayStat.latestTime) {
        dayStat.latestTime = receipt.startedAt;
      }
    } else {
      entry.dayCounts.set(dayName, {
        count: 1,
        latestTime: receipt.startedAt,
      });
    }

    const modelKey = receipt.modelId ?? "default";
    const currentModelCount = entry.modelCounts.get(modelKey) ?? 0;
    entry.modelCounts.set(modelKey, currentModelCount + 1);
  }

  const subscriptions: SubscriptionUsage[] = [];
  let distinctAsked = 0;

  for (const entry of providerMap.values()) {
    if (entry.asked > 0) {
      distinctAsked++;
    }

    let busiestDay: string | null = null;
    if (entry.asked > 0) {
      let maxDayCount = 0;
      let latestDayTime = -1;
      for (const [dayName, stat] of entry.dayCounts.entries()) {
        if (
          stat.count > maxDayCount ||
          (stat.count === maxDayCount && stat.latestTime > latestDayTime)
        ) {
          busiestDay = dayName;
          maxDayCount = stat.count;
          latestDayTime = stat.latestTime;
        }
      }
    }

    const modelsList: { readonly id: string; readonly asked: number }[] = [];
    for (const [id, asked] of entry.modelCounts.entries()) {
      modelsList.push({ id, asked });
    }
    modelsList.sort((a, b) => {
      if (b.asked !== a.asked) {
        return b.asked - a.asked;
      }
      return a.id.localeCompare(b.id);
    });

    const lastUsed =
      entry.asked === 0 || entry.latestStartedAt < 0
        ? "not yet"
        : formatTimeAgo(now - entry.latestStartedAt);

    subscriptions.push({
      providerId: entry.providerId,
      label: entry.label,
      asked: entry.asked,
      finished: entry.finished,
      stopped: entry.stopped,
      failed: entry.failed,
      totalMs: entry.totalMs,
      longest: formatDurationWords(entry.longestMs),
      lastUsed,
      busiestDay,
      models: modelsList,
    });
  }

  const orderLookup = new Map<string, number>();
  for (const entry of providerMap.values()) {
    orderLookup.set(entry.providerId, entry.orderIndex);
  }

  subscriptions.sort((a, b) => {
    if (b.asked !== a.asked) {
      return b.asked - a.asked;
    }
    if (b.totalMs !== a.totalMs) {
      return b.totalMs - a.totalMs;
    }
    const orderA = orderLookup.get(a.providerId) ?? 0;
    const orderB = orderLookup.get(b.providerId) ?? 0;
    return orderA - orderB;
  });

  let quietest: string | null = null;
  const detectedCandidates = subscriptions.filter((s) => knownIds.has(s.providerId));
  const pool = detectedCandidates.length > 0 ? detectedCandidates : subscriptions;

  if (pool.length > 1) {
    let minAsked = Number.POSITIVE_INFINITY;
    let maxAsked = Number.NEGATIVE_INFINITY;

    for (const s of pool) {
      if (s.asked < minAsked) {
        minAsked = s.asked;
      }
      if (s.asked > maxAsked) {
        maxAsked = s.asked;
      }
    }

    // Only flag quietest when the peak exceeds minimum volume and quadruple disparity
    if (maxAsked >= Math.max(4, 4 * minAsked)) {
      for (const s of pool) {
        if (s.asked === minAsked) {
          quietest = s.label;
          break;
        }
      }
    }
  }

  return {
    window,
    headline: buildHeadline(window, distinctAsked, totalAsked),
    subscriptions,
    totalAsked,
    quietest,
    note: HONEST_NOTE,
  };
}
