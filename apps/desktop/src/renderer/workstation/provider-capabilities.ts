/** One provider observed from the local environment and its CLI adapter. */
export interface ObservedProvider {
  readonly id: string;
  readonly label: string;
  readonly family: "codex" | "claude" | "gemini" | "local";
  readonly detected: boolean;
  readonly detail: string;
  readonly models: readonly { readonly id: string; readonly label: string }[];
  readonly canApproveTools: boolean;
}

export type CapabilityId =
  | "long-context"
  | "reads-files"
  | "asks-before-acting"
  | "reasons-in-steps"
  | "reads-images"
  | "writes-code"
  | "stays-on-this-mac"
  | "picks-effort";

export interface Capability {
  readonly id: CapabilityId;
  readonly title: string;        // 2 to 4 words, his language
  readonly line: string;         // one short sentence
  readonly observed: boolean;    // true only when something actually told us
  readonly because: string;      // how we know, in plain words
}

export interface ProviderMenu {
  readonly id: string;
  readonly label: string;
  readonly family: string;
  readonly usable: boolean;
  readonly unusableBecause: string | null;
  readonly capabilities: readonly Capability[];
  readonly models: readonly { readonly id: string; readonly label: string; readonly note: string }[];
  readonly effortLevels: readonly { readonly id: string; readonly label: string; readonly line: string }[];
  readonly summary: string;      // one sentence: what this one is good for, from what we observed
}

// OpenAI Codex CLI adapter is currently the only frontier adapter supporting reasoning effort levels.
const CODEX_EFFORT_LEVELS: readonly {
  readonly id: string;
  readonly label: string;
  readonly line: string;
}[] = [
  {
    id: "low",
    label: "Low",
    line: "Faster answers with lighter reasoning steps.",
  },
  {
    id: "medium",
    label: "Medium",
    line: "Balanced thinking for everyday tasks.",
  },
  {
    id: "high",
    label: "High",
    line: "Thorough reasoning for complex problems.",
  },
];

function buildModels(
  models: readonly { readonly id: string; readonly label: string }[],
): readonly { readonly id: string; readonly label: string; readonly note: string }[] {
  if (models.length === 0) {
    return [
      {
        id: "default",
        label: "Subscription default",
        note: "Only the subscription's own default is available",
      },
    ];
  }

  const seenIds = new Set<string>();
  const results: { readonly id: string; readonly label: string; readonly note: string }[] = [];

  for (const m of models) {
    const trimmedId = m.id.trim();
    if (trimmedId.length === 0 || seenIds.has(trimmedId)) {
      continue;
    }
    seenIds.add(trimmedId);

    const trimmedLabel = m.label.trim();
    const label = trimmedLabel.length > 0 ? trimmedLabel : trimmedId;

    // Notes reflect only what the provider itself explicitly appended in the label, avoiding guessing.
    let note = "";
    const parenMatch = /\(([^)]+)\)/.exec(label);
    if (parenMatch && parenMatch.length > 1) {
      note = parenMatch[1]!.trim();
    } else {
      const dashParts = label.split(/\s+[-–—]\s+/);
      if (dashParts.length > 1) {
        note = dashParts[1]!.trim();
      }
    }

    results.push({
      id: trimmedId,
      label,
      note,
    });
  }

  if (results.length === 0) {
    return [
      {
        id: "default",
        label: "Subscription default",
        note: "Only the subscription's own default is available",
      },
    ];
  }

  return results;
}

function buildCapabilities(provider: ObservedProvider): readonly Capability[] {
  const asksObserved = provider.detected && provider.canApproveTools;
  const staysObserved = provider.family === "local";

  const asksBecause = !provider.detected
    ? "This capability has not been checked because the subscription was not detected on your Mac."
    : provider.canApproveTools
      ? "The CLI adapter confirmed it can pause and ask for your approval."
      : "The provider reported that it cannot pause to ask for tool confirmation.";

  const staysBecause = staysObserved
    ? "Runs directly on your Mac without sending data outside."
    : "Requests are sent to the provider's remote servers, not kept on this Mac.";

  return [
    {
      id: "long-context",
      title: "Long context",
      line: "Holds extensive background material in memory during a case.",
      observed: false,
      because: "This capability has not been checked for this subscription.",
    },
    {
      id: "reads-files",
      title: "Reads files",
      line: "Inspects files on your Mac when working on a case.",
      observed: false,
      because: "This capability has not been checked for this subscription.",
    },
    {
      id: "asks-before-acting",
      title: "Asks before acting",
      line: "Pauses for your confirmation before running tools or making changes.",
      observed: asksObserved,
      because: asksBecause,
    },
    {
      id: "reasons-in-steps",
      title: "Reasons in steps",
      line: "Thinks through multi-step problems before producing a final answer.",
      observed: false,
      because: "This capability has not been checked for this subscription.",
    },
    {
      id: "reads-images",
      title: "Reads images",
      line: "Inspects diagrams, screenshots, and visual references.",
      observed: false,
      because: "This capability has not been checked for this subscription.",
    },
    {
      id: "writes-code",
      title: "Writes code",
      line: "Generates and edits code files directly for your tasks.",
      observed: false,
      because: "This capability has not been checked for this subscription.",
    },
    {
      id: "stays-on-this-mac",
      title: "Stays on this Mac",
      line: "Runs entirely on your machine without sending data outside.",
      observed: staysObserved,
      because: staysBecause,
    },
    {
      id: "picks-effort",
      title: "Picks effort",
      line: "Allows choosing how deeply the model thinks before answering.",
      observed: false,
      because: "This capability has not been checked for this subscription.",
    },
  ];
}

function buildSummary(
  provider: ObservedProvider,
  hasConfiguredModels: boolean,
  hasEffortLevels: boolean,
): string {
  if (!provider.detected) {
    const detail = provider.detail.trim();
    if (detail.length > 0) {
      return `Not available until detected on your Mac: ${detail.replace(/\.$/, "")}.`;
    }
    return "Not available until this subscription is detected on your Mac.";
  }

  if (provider.family === "local") {
    if (provider.canApproveTools) {
      return "Runs directly on your Mac and pauses for your approval before taking actions.";
    }
    return "Runs directly on your Mac without sending your data to outside servers.";
  }

  if (!hasConfiguredModels) {
    return "Ready to use with your subscription's default model.";
  }

  if (provider.canApproveTools && hasEffortLevels) {
    return "Frontier subscription with tool approval and adjustable reasoning effort.";
  }

  if (provider.canApproveTools) {
    return "Frontier subscription that asks for your approval before running tools.";
  }

  if (hasEffortLevels) {
    return "Frontier subscription with adjustable reasoning effort.";
  }

  return "Frontier subscription ready to work on your cases.";
}

/**
 * Builds a presentation menu for an observed provider.
 * Establishes only capabilities that were directly observed, leaving unmeasured ones marked as unobserved.
 */
export function menuFor(provider: ObservedProvider): ProviderMenu {
  const models = buildModels(provider.models);
  const effortLevels = provider.family === "codex" ? CODEX_EFFORT_LEVELS : [];
  const capabilities = buildCapabilities(provider);

  const usable = provider.detected;
  const unusableBecause = usable
    ? null
    : provider.detail.trim().length > 0
      ? provider.detail.trim()
      : "This subscription was not detected on your Mac.";

  const hasConfiguredModels = provider.models.length > 0;
  const summary = buildSummary(provider, hasConfiguredModels, effortLevels.length > 0);

  const rawLabel = provider.label.trim();
  const label = rawLabel.length > 0 ? rawLabel : provider.id;

  return {
    id: provider.id,
    label,
    family: provider.family,
    usable,
    unusableBecause,
    capabilities,
    models,
    effortLevels,
    summary,
  };
}

/** Builds presentation menus for a collection of observed providers. */
export function menusFor(providers: readonly ObservedProvider[]): readonly ProviderMenu[] {
  return providers.map(menuFor);
}
