/**
 * The Engine Room — one honest answer to "what can this thing think with?"
 *
 * It exists because of a specific complaint about a specific screen: the header
 * said `Engine OFF`, in two words, with no explanation and no way to act. That
 * is the failure DESIGN.md principle 4 names — *"Ready is clickable to the probe
 * that decided it"* — and it is most of why the app felt like it was hiding
 * something.
 *
 * So every row here carries the probe that produced it: what was run, what came
 * back, when, and where the binary was found. A green light nobody can inspect
 * is a rumour, and a red light with no next step is just bad news.
 *
 * Three rules the assembly follows:
 *
 *   1. **Never report readiness we have not observed.** An engine is `ready`
 *      only after a runtime check. A CLI version proves presence (`detected`),
 *      never sign-in, model access or permission to send a request.
 *   2. **A red light always carries a fix.** `fixHint` is non-null on every
 *      state a person could do something about.
 *   3. **Local-only is a working state, not a degraded one.** Someone who
 *      deliberately runs on-device must never be nagged about a subscription
 *      they chose not to connect.
 */

import type {
  EngineModel,
  EngineRoomStatus,
  EngineStatus
} from "@cadrane/contracts";
import { CATALOGUE, ACCESS_LABELS, TIER_LABELS, type CatalogueEngine } from "./catalogue.js";
import { discoverProvider } from "./cli-discovery.js";
import { providerDefinition } from "./providers.js";
import type { BrainProviderId } from "./types.js";
import { localRuntimeStatus } from "../runtime-status.js";

/** What the bundled on-device model is called on the shelf. */
const LOCAL_MODEL: EngineModel = {
  id: "bundled",
  label: "Qwen3 4B",
  tier: "on-device",
  tierLabel: TIER_LABELS["on-device"],
  note: "Runs on this Mac. Nothing leaves, and it costs nothing.",
  includedInSubscription: false
};

/**
 * Asks every engine whether it is there, in parallel.
 *
 * Parallel because a serial sweep across three CLIs that each take a few
 * hundred milliseconds is a visible stall on a screen whose entire job is to
 * feel instant and truthful.
 */
export async function readEngineRoom(now = Date.now()): Promise<EngineRoomStatus> {
  const checkedAt = new Date(now).toISOString();

  const engines = await Promise.all(
    CATALOGUE.map((entry) =>
      entry.providerId === "local"
        ? Promise.resolve(localEngine(entry, checkedAt))
        : cliEngine(entry, entry.providerId, checkedAt)
    )
  );

  const ready = engines.filter((engine) => engine.state === "ready");

  return {
    engines,
    // The first ready engine in catalogue order, and its first model. Catalogue
    // order is a default rather than a policy — a pinned choice will override
    // this once the picker writes one.
    active:
      ready[0] === undefined || ready[0].models[0] === undefined
        ? null
        : { engineId: ready[0].id, modelId: ready[0].models[0].id },
    checkedAt,
    allUnavailable: ready.length === 0
  };
}

/** Tool presence only. This does not check an account or send a model prompt. */
async function cliEngine(
  entry: CatalogueEngine,
  providerId: BrainProviderId,
  checkedAt: string
): Promise<EngineStatus> {
  const definition = providerDefinition(providerId);
  const method = `Ran ${definition.binary} ${definition.versionArgs.join(" ")}`;

  let found: Awaited<ReturnType<typeof discoverProvider>> = null;
  let problem: string | null = null;
  try {
    found = await discoverProvider(definition);
  } catch (error) {
    problem = error instanceof Error ? error.message : "The check itself failed.";
  }

  const models: readonly EngineModel[] = [];

  if (problem !== null) {
    return {
      id: entry.providerId,
      label: entry.label,
      access: entry.access,
      accessLabel: ACCESS_LABELS[entry.access],
      state: "problem",
      summary: `The ${entry.label} tool check did not complete.`,
      fixHint: "Use Local models to set up work on this Mac. Installing this tool alone will not enable subscription requests.",
      evidence: { checkedAt, method, result: problem, executablePath: null },
      models
    };
  }

  if (found === null) {
    return {
      id: entry.providerId,
      label: entry.label,
      access: entry.access,
      accessLabel: ACCESS_LABELS[entry.access],
      state: "not-installed",
      // Not an error. Most people have not installed most CLIs, and a status
      // board that treats absence as failure teaches its reader to ignore red.
      summary: `No responding ${definition.binary} tool was found.`,
      fixHint: "Use Local models to set up work on this Mac. Installing this tool alone will not enable subscription requests.",
      evidence: { checkedAt, method, result: "No executable answered.", executablePath: null },
      models
    };
  }

  return {
    id: entry.providerId,
    label: entry.label,
    access: entry.access,
    accessLabel: ACCESS_LABELS[entry.access],
    state: "detected",
    summary: `Found the ${definition.binary} tool. Sign-in and model access have not been checked.`,
    fixHint: null,
    evidence: {
      checkedAt,
      method,
      result: found.version.length > 0 ? found.version : "answered, but printed no version",
      executablePath: found.executablePath
    },
    models
  };
}

/**
 * The model running on this Mac.
 *
 * Its state comes from the startup probe rather than from a fresh check: the
 * bundled runtime is a long-lived server this process started, and asking it
 * again here would be a second source of truth about the same fact.
 */
function localEngine(entry: CatalogueEngine, checkedAt: string): EngineStatus {
  const runtime = localRuntimeStatus();

  if (runtime.available) {
    return {
      id: entry.providerId,
      label: entry.label,
      access: entry.access,
      accessLabel: ACCESS_LABELS[entry.access],
      state: "ready",
      summary: "Running on this Mac. Nothing it reads leaves the machine.",
      fixHint: null,
      evidence: {
        checkedAt,
        method: "Checked the bundled runtime this app started",
        result: "Answered on the private loopback port.",
        executablePath: null
      },
      models: [LOCAL_MODEL]
    };
  }

  return {
    id: entry.providerId,
    label: entry.label,
    access: entry.access,
    accessLabel: ACCESS_LABELS[entry.access],
    state: runtime.problem === null ? "checking" : "problem",
    summary:
      runtime.problem === null
        ? "Starting up."
        : "The local model is unavailable in this workspace. Its startup details are below.",
    fixHint: runtime.problem === null ? null : "View Local models for installation status. You can still work with sources and saved outputs.",
    evidence:
      runtime.problem === null
        ? null
        : {
            checkedAt,
            method: "Checked the bundled runtime this app started",
            result: runtime.problem,
            executablePath: null
          },
    models: []
  };
}

/**
 * One sentence for the header, replacing `Engine OFF`.
 *
 * Names a verified default, never an active request inferred from tool presence.
 */
export function describeEngineRoom(room: EngineRoomStatus): string {
  if (room.active === null) {
    return "No verified model";
  }
  const engine = room.engines.find((candidate) => candidate.id === room.active?.engineId);
  const model = engine?.models.find((candidate) => candidate.id === room.active?.modelId);
  if (engine?.state !== "ready" || model === undefined) {
    return "No verified model";
  }
  return `${engine.label} · ${model.label}`;
}
