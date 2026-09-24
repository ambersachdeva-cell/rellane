/**
 * Model Scout — finds models that will actually run on *this* machine.
 *
 * Replaces the hand-maintained seven-model catalog, which was a generation
 * stale on inspection (Qwen3 and Gemma 3 while the world had moved to Qwen3.5
 * and Gemma 4) and five of whose entries failed their own provenance schema.
 * A fixed list is structurally wrong: it is stale the week it ships.
 *
 * Ranking is explainable on purpose. Every candidate carries the sentence that
 * justifies its position, so the user is never asked to trust a number they
 * cannot see the reason for.
 */

import type { HardwareProfile } from "@cadrane/contracts";
import { assessFit, type Fit, type QuantKind } from "./fit.js";
import { classifyFromTags, type LicenceVerdict } from "./licence.js";
import { parseParameters, searchModels, type HfModel } from "./hf-client.js";

export type ScoutRole =
  | "agentic"
  | "vision-doc"
  | "embedding"
  | "reranker"
  | "speech";

export interface ScoutQuery {
  readonly role: ScoutRole;
  readonly profile: HardwareProfile;
  readonly quant?: QuantKind | undefined;
  readonly contextTokens?: number | undefined;
  /**
   * Whether this install may run non-commercially licensed models. Default
   * false: Rellane is sold, and a non-commercial model inside a sold product
   * is a liability, not a feature.
   */
  readonly allowNonCommercial?: boolean | undefined;
  readonly limit?: number | undefined;
}

export interface ScoutCandidate {
  readonly id: string;
  readonly role: ScoutRole;
  readonly downloads: number;
  readonly likes: number;
  readonly parametersBillions: number;
  readonly activeParametersBillions: number | null;
  readonly licence: LicenceVerdict;
  readonly fit: Fit;
  readonly score: number;
  /** Why it ranks here, in one sentence. Shown verbatim in the UI. */
  readonly rationale: string;
}

export interface ScoutResult {
  readonly role: ScoutRole;
  readonly recommended: ScoutCandidate | null;
  readonly alternatives: readonly ScoutCandidate[];
  /** Considered but excluded, with the reason. Never silently dropped. */
  readonly rejected: readonly { id: string; reason: string }[];
}

/** How each role is found on the hub. */
const ROLE_QUERY: Readonly<Record<ScoutRole, { filter?: string; pipelineTag?: string; search?: string }>> =
  Object.freeze({
    agentic: { filter: "gguf", search: "instruct" },
    "vision-doc": { pipelineTag: "image-text-to-text" },
    embedding: { pipelineTag: "feature-extraction" },
    reranker: { search: "reranker" },
    speech: { pipelineTag: "automatic-speech-recognition" }
  });

/**
 * Roles whose models are small encoders called on every item.
 *
 * For these, smaller genuinely is better: a 0.13B embedder does the same job as
 * an 8B one at a fraction of the latency, and it runs on every document you
 * index. Scoring these like a chat model recommends an 8B embedder, which is
 * absurd — caught by the live run, not by the mocks.
 */
const LIGHTWEIGHT_ROLES: ReadonlySet<ScoutRole> = new Set(["embedding", "reranker"]);

/**
 * Roles that run through llama.cpp and therefore need a GGUF build.
 *
 * The hub's `filter=gguf` is not reliable enough on its own — a live run
 * surfaced an AWQ-only repo at the top, which llama.cpp cannot load at all.
 * Check the tags the API actually returns.
 */
const GGUF_REQUIRED: ReadonlySet<ScoutRole> = new Set(["agentic"]);

/**
 * Community re-tunes that should never be a *default* recommendation.
 *
 * "abliterated" and "uncensored" builds have their refusal training removed.
 * They are legitimate to run deliberately, but shipping one as the out-of-box
 * model in a product sold to businesses is a decision nobody asked for. They
 * stay available, ranked below stock builds.
 */
const MODIFIED_BUILD = /(abliterated|uncensored|nsfw|jailbr|decensor)/iu;

const FOREIGN_QUANT = /[-_.](awq|gptq|mlx|exl2|onnx|fp8|bnb|int4|int8)(\b|[-_.])/iu;

function hasGgufBuild(model: HfModel): boolean {
  // A repo can carry a `gguf` tag while the artefact itself is AWQ or MLX.
  // The name is the more reliable signal about what is actually in it.
  if (FOREIGN_QUANT.test(model.id)) {
    return false;
  }
  return model.tags.includes("gguf") || model.libraryName === "gguf" || /gguf/iu.test(model.id);
}

export async function scout(
  query: ScoutQuery,
  options: { signal?: AbortSignal } = {}
): Promise<ScoutResult> {
  const quant: QuantKind = query.quant ?? "Q4_K_M";
  const contextTokens = query.contextTokens ?? 8_192;
  const allowNonCommercial = query.allowNonCommercial ?? false;

  const models = await searchModels(
    { ...ROLE_QUERY[query.role], limit: query.limit ?? 40 },
    options.signal === undefined ? {} : { signal: options.signal }
  );

  const candidates: ScoutCandidate[] = [];
  const rejected: { id: string; reason: string }[] = [];

  for (const model of models) {
    const verdict = evaluate(model, {
      role: query.role,
      quant,
      contextTokens,
      profile: query.profile,
      allowNonCommercial
    });
    if ("reason" in verdict) {
      rejected.push({ id: model.id, reason: verdict.reason });
    } else {
      candidates.push(verdict);
    }
  }

  // Downloads are the community's verdict, and only mean something next to the
  // other candidates in the same search. Rescore against the field before sorting.
  const peak = candidates.reduce((max, c) => Math.max(max, c.downloads), 1);
  const ranked = candidates
    .map((c) => ({ ...c, score: c.score + relativePopularity(c.downloads, peak, query.role) }))
    .sort((a, b) => b.score - a.score || b.downloads - a.downloads);

  return {
    role: query.role,
    recommended: ranked[0] ?? null,
    alternatives: ranked.slice(1, 6),
    rejected: rejected.slice(0, 12)
  };
}

/**
 * How popular this is next to the best-known option for the same job.
 *
 * Weighted hardest for agentic models, where an unknown repo winning on size
 * alone is the failure this exists to prevent.
 */
function relativePopularity(downloads: number, peak: number, role: ScoutRole): number {
  const share = Math.sqrt(Math.max(downloads, 0) / Math.max(peak, 1));
  return share * (role === "agentic" ? 0.9 : 0.4);
}

function evaluate(
  model: HfModel,
  context: {
    role: ScoutRole;
    quant: QuantKind;
    contextTokens: number;
    profile: HardwareProfile;
    allowNonCommercial: boolean;
  }
): ScoutCandidate | { reason: string } {
  if (model.gated) {
    return { reason: "Access is gated — it needs an approved request on Hugging Face first." };
  }

  if (GGUF_REQUIRED.has(context.role) && !hasGgufBuild(model)) {
    return { reason: "No GGUF build, so the local runtime cannot load it." };
  }

  const licence = classifyFromTags(model.tags);
  if (!licence.commercialSafe && !context.allowNonCommercial) {
    return { reason: `${licence.label}: ${licence.note}` };
  }

  const parsed = parseParameters(model.id);
  const lightweight = LIGHTWEIGHT_ROLES.has(context.role);
  if (parsed === null && !lightweight) {
    return { reason: "The repository name does not state a size, so it cannot be sized safely." };
  }

  // Small encoders: assume a sub-billion footprint rather than refusing them.
  const totalBillions = parsed?.totalBillions ?? 0.4;
  const activeBillions = parsed?.activeBillions ?? null;

  const fit = assessFit({
    parametersBillions: totalBillions,
    activeParametersBillions: activeBillions ?? undefined,
    quant: context.quant,
    contextTokens: lightweight ? 512 : context.contextTokens,
    memoryBytes: context.profile.memoryBytes,
    freeDiskBytes: context.profile.freeDiskBytes,
    acceleration: context.profile.acceleration,
    dedicatedGpuMemoryBytes: context.profile.dedicatedGpuMemoryBytes
  });

  if (fit.verdict === "will-not-fit" || fit.verdict === "no-disk") {
    return { reason: fit.reason };
  }

  const score = scoreOf({ model, fit, licence, totalBillions, activeBillions, role: context.role });

  return {
    id: model.id,
    role: context.role,
    downloads: model.downloads,
    likes: model.likes,
    parametersBillions: totalBillions,
    activeParametersBillions: activeBillions,
    licence,
    fit,
    score,
    rationale: rationaleFor({ fit, licence, totalBillions, activeBillions, downloads: model.downloads })
  };
}

/**
 * Capability is approximated by size, popularity by downloads, and headroom by
 * fit. Weighted so that a model which merely fits never outranks one that fits
 * comfortably *and* is widely used — a tight fit that swaps is a bad
 * recommendation even if the model is better on paper.
 */
function scoreOf(input: {
  model: HfModel;
  fit: Fit;
  licence: LicenceVerdict;
  totalBillions: number;
  activeBillions: number | null;
  role: ScoutRole;
}): number {
  const popularity = Math.log10(Math.max(input.model.downloads, 1)) / 8; // 0..~1
  const sizeTerm = Math.min(Math.log2(Math.max(input.totalBillions, 0.1) + 1) / 6, 1);
  // For encoders that run on every item, latency is the product. Invert.
  const capability = LIGHTWEIGHT_ROLES.has(input.role) ? 1 - sizeTerm : sizeTerm;
  const headroom = input.fit.verdict === "comfortable" ? 1 : 0.45;
  const licenceBonus = input.licence.klass === "permissive" ? 1 : 0.85;
  // MoE gives capability without the speed cost, so it earns a small premium.
  // Stock builds win ties against guardrail-stripped re-tunes.
  const stockBonus = MODIFIED_BUILD.test(input.model.id) ? 0.55 : 1;
  const moeBonus =
    input.activeBillions !== null && input.activeBillions < input.totalBillions ? 1.08 : 1;

  return (popularity * 0.35 + capability * 0.4 + headroom * 0.25) * licenceBonus * moeBonus * stockBonus;
}

function rationaleFor(input: {
  fit: Fit;
  licence: LicenceVerdict;
  totalBillions: number;
  activeBillions: number | null;
  downloads: number;
}): string {
  const size =
    input.activeBillions !== null
      ? `${trim(input.totalBillions)}B total, ${trim(input.activeBillions)}B active`
      : `${trim(input.totalBillions)}B`;
  return `${size} · ${input.licence.label} · ${input.fit.reason} Downloaded ${format(input.downloads)} times.`;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function format(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}
