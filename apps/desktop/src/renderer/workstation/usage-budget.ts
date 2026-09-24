export interface BudgetRule {
  readonly providerId: string;
  /** He sets this. Zero means no limit for this one. */
  readonly askedPerDay: number;
}

export interface BudgetCheck {
  readonly providerId: string;
  readonly label: string;
  readonly askedToday: number;
  readonly limit: number; // 0 when none
  readonly state: "fine" | "close" | "over" | "no-limit";
  readonly line: string; // one plain sentence
}

export interface BudgetReport {
  readonly checks: readonly BudgetCheck[];
  readonly headline: string;
  /** A subscription he should use instead, when one he is leaning on is close. */
  readonly suggestInstead: string | null;
  readonly note: string; // what this is and is not. Always present.
}

const BUDGET_NOTE =
  "This counts what Rellane asked today against your own limit, not the provider's. This app cannot see your real provider quota or limit.";

function buildCheckLine(
  label: string,
  asked: number,
  limit: number,
  state: "fine" | "close" | "over" | "no-limit",
): string {
  if (state === "no-limit") {
    if (asked === 0) {
      return `You have not asked ${label} today; no daily limit is set.`;
    }
    if (asked === 1) {
      return `You have asked ${label} once today; no daily limit is set.`;
    }
    return `You have asked ${label} ${asked} times today; no daily limit is set.`;
  }

  if (state === "over") {
    if (asked === limit) {
      return `You have reached your daily limit of ${limit} for ${label} today.`;
    }
    return `You have asked ${label} ${asked} times today, exceeding your daily limit of ${limit}.`;
  }

  if (state === "close") {
    if (asked === 1) {
      return `You have asked ${label} once today, nearing your daily limit of ${limit}.`;
    }
    return `You have asked ${label} ${asked} times today, nearing your daily limit of ${limit}.`;
  }

  if (asked === 0) {
    return `You have not asked ${label} today; your daily limit is ${limit}.`;
  }
  if (asked === 1) {
    return `You have asked ${label} once today of your daily limit of ${limit}.`;
  }
  return `You have asked ${label} ${asked} times today of your daily limit of ${limit}.`;
}

export function checkBudgets(input: {
  readonly rules: readonly BudgetRule[];
  readonly askedToday: readonly { readonly providerId: string; readonly label: string; readonly asked: number }[];
  readonly usableProviderIds: readonly string[];
  readonly now: number;
}): BudgetReport {
  // Group rules by provider so the lowest positive limit wins;
  // negative numbers are treated as no configured limit.
  const rulesByProvider = new Map<string, number[]>();
  for (const rule of input.rules) {
    const list = rulesByProvider.get(rule.providerId);
    if (list) {
      list.push(rule.askedPerDay);
    } else {
      rulesByProvider.set(rule.providerId, [rule.askedPerDay]);
    }
  }

  function getEffectiveLimit(providerId: string): number {
    const limits = rulesByProvider.get(providerId);
    if (!limits || limits.length === 0) {
      return 0;
    }
    const positiveLimits = limits
      .filter((v) => Number.isFinite(v) && v > 0)
      .map((v) => Math.floor(v));
    if (positiveLimits.length === 0) {
      return 0;
    }
    return Math.min(...positiveLimits);
  }

  const aggregatedAsked = new Map<string, { label: string; asked: number }>();
  const providerOrder: string[] = [];

  for (const entry of input.askedToday) {
    const existing = aggregatedAsked.get(entry.providerId);
    const validAsked = Number.isFinite(entry.asked) ? Math.max(0, Math.floor(entry.asked)) : 0;
    if (existing) {
      existing.asked += validAsked;
      if (!existing.label && entry.label) {
        existing.label = entry.label;
      }
    } else {
      aggregatedAsked.set(entry.providerId, {
        label: entry.label || entry.providerId,
        asked: validAsked,
      });
      providerOrder.push(entry.providerId);
    }
  }

  // A provider defined in rules without prior turns today still counts as zero asks.
  for (const rule of input.rules) {
    if (!aggregatedAsked.has(rule.providerId)) {
      aggregatedAsked.set(rule.providerId, {
        label: rule.providerId,
        asked: 0,
      });
      providerOrder.push(rule.providerId);
    }
  }

  const checks: BudgetCheck[] = [];

  for (const providerId of providerOrder) {
    const data = aggregatedAsked.get(providerId);
    if (!data) {
      continue;
    }
    const limit = getEffectiveLimit(providerId);
    let state: "fine" | "close" | "over" | "no-limit";

    if (limit <= 0) {
      state = "no-limit";
    } else if (data.asked >= limit) {
      state = "over";
    } else if (data.asked >= limit * 0.8) {
      state = "close";
    } else {
      state = "fine";
    }

    const line = buildCheckLine(data.label, data.asked, limit, state);

    checks.push({
      providerId,
      label: data.label,
      askedToday: data.asked,
      limit,
      state,
      line,
    });
  }

  const overChecks = checks.filter((c) => c.state === "over");
  const closeChecks = checks.filter((c) => c.state === "close");
  const hasConfiguredLimit = checks.some((c) => c.limit > 0);

  let headline: string;
  if (!hasConfiguredLimit || checks.length === 0) {
    headline = "No daily limits are set.";
  } else if (overChecks.length > 0) {
    if (overChecks.length === 1) {
      const firstOver = overChecks[0]!;
      headline = `You have reached your daily limit for ${firstOver.label}.`;
    } else {
      headline = `You have reached your daily limit on ${overChecks.length} subscriptions.`;
    }
  } else if (closeChecks.length > 0) {
    if (closeChecks.length === 1) {
      const firstClose = closeChecks[0]!;
      headline = `You are nearing your daily limit for ${firstClose.label}.`;
    } else {
      headline = `You are nearing your daily limit on ${closeChecks.length} subscriptions.`;
    }
  } else {
    headline = "All subscriptions are within your daily limits.";
  }

  let suggestInstead: string | null = null;
  const stressedChecks = [...overChecks, ...closeChecks];

  if (stressedChecks.length > 0) {
    let mostStressed = stressedChecks[0]!;
    for (const check of stressedChecks) {
      if (check.askedToday > mostStressed.askedToday) {
        mostStressed = check;
      }
    }

    const checkByProvider = new Map<string, BudgetCheck>();
    for (const check of checks) {
      checkByProvider.set(check.providerId, check);
    }

    interface SuggestionCandidate {
      readonly providerId: string;
      readonly askedToday: number;
    }
    const candidates: SuggestionCandidate[] = [];

    for (const usableId of input.usableProviderIds) {
      if (usableId === mostStressed.providerId) {
        continue;
      }

      const existingCheck = checkByProvider.get(usableId);
      if (existingCheck) {
        // A candidate that is already near its own cap must never be recommended.
        if (existingCheck.state === "close" || existingCheck.state === "over") {
          continue;
        }
        if (existingCheck.askedToday < mostStressed.askedToday) {
          candidates.push({
            providerId: usableId,
            askedToday: existingCheck.askedToday,
          });
        }
      } else if (0 < mostStressed.askedToday) {
        candidates.push({
          providerId: usableId,
          askedToday: 0,
        });
      }
    }

    if (candidates.length > 0) {
      let best = candidates[0]!;
      for (const candidate of candidates) {
        if (candidate.askedToday < best.askedToday) {
          best = candidate;
        }
      }
      suggestInstead = best.providerId;
    }
  }

  return {
    checks,
    headline,
    suggestInstead,
    note: BUDGET_NOTE,
  };
}
