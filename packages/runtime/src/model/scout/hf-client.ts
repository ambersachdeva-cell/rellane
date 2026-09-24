/**
 * Hugging Face lookups.
 *
 * The public model API answers without a key — verified 2026-08-21:
 * `GET /api/models?filter=gguf&sort=downloads` returns HTTP 200 with
 * id / downloads / likes / tags / pipeline_tag / library_name. No token, no
 * account, no rate-limit key. That is what makes a live scout possible instead
 * of a hand-maintained list that is stale the week it ships.
 *
 * Nothing here is cached to disk and nothing is sent outward except the query.
 */

const HF_API = "https://huggingface.co/api";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface HfModel {
  readonly id: string;
  readonly downloads: number;
  readonly likes: number;
  readonly tags: readonly string[];
  readonly pipelineTag: string | null;
  readonly libraryName: string | null;
  readonly createdAt: string | null;
  readonly gated: boolean;
}

export interface HfSearchQuery {
  /** Free-text search across repo names. */
  readonly search?: string | undefined;
  /** Tag filter, e.g. "gguf". */
  readonly filter?: string | undefined;
  /** e.g. "image-text-to-text", "feature-extraction", "automatic-speech-recognition". */
  readonly pipelineTag?: string | undefined;
  readonly limit?: number | undefined;
}

export class HfUnavailableError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "HfUnavailableError";
    this.cause = cause;
  }
}

function toModel(raw: unknown): HfModel | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = record["id"] ?? record["modelId"];
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  const tags = Array.isArray(record["tags"])
    ? record["tags"].filter((tag): tag is string => typeof tag === "string")
    : [];
  return {
    id,
    downloads: typeof record["downloads"] === "number" ? record["downloads"] : 0,
    likes: typeof record["likes"] === "number" ? record["likes"] : 0,
    tags,
    pipelineTag: typeof record["pipeline_tag"] === "string" ? record["pipeline_tag"] : null,
    libraryName: typeof record["library_name"] === "string" ? record["library_name"] : null,
    createdAt: typeof record["createdAt"] === "string" ? record["createdAt"] : null,
    // The API omits `gated` for ungated repos and sets a string/true otherwise.
    gated: record["gated"] !== undefined && record["gated"] !== false && record["gated"] !== null
  };
}

async function getJson(url: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      throw new HfUnavailableError(
        `Hugging Face returned ${response.status}. Model search is unavailable right now.`
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof HfUnavailableError) {
      throw error;
    }
    throw new HfUnavailableError(
      "Could not reach Hugging Face. Model search needs a network connection; everything already installed still works offline.",
      error
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function searchModels(
  query: HfSearchQuery,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<readonly HfModel[]> {
  const params = new URLSearchParams({
    sort: "downloads",
    direction: "-1",
    limit: String(Math.min(Math.max(query.limit ?? 20, 1), 100))
  });
  if (query.search !== undefined) params.set("search", query.search);
  if (query.filter !== undefined) params.set("filter", query.filter);
  if (query.pipelineTag !== undefined) params.set("pipeline_tag", query.pipelineTag);

  const raw = await getJson(
    `${HF_API}/models?${params.toString()}`,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal
  );
  if (!Array.isArray(raw)) {
    throw new HfUnavailableError("Hugging Face returned an unexpected response.");
  }
  return raw.map(toModel).filter((model): model is HfModel => model !== null);
}

/** Full record for one repo, including the tags the licence check needs. */
export async function fetchModel(
  id: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<HfModel> {
  const raw = await getJson(
    `${HF_API}/models/${encodeURI(id)}`,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal
  );
  const model = toModel(raw);
  if (model === null) {
    throw new HfUnavailableError(`Hugging Face has no readable record for ${id}.`);
  }
  return model;
}

/**
 * Parameter count parsed from a repo name: `Qwen3.5-9B` → 9,
 * `Qwen3.6-35B-A3B` → 35 total with 3 active, `bge-small` → null.
 *
 * A guess from a name is not evidence, so this returns null rather than a
 * default when the name says nothing. Callers must treat null as "unknown"
 * and not as "small".
 */
export function parseParameters(
  id: string
): { totalBillions: number; activeBillions: number | null } | null {
  const name = id.split("/").pop() ?? id;

  // MoE first: the A-suffix would otherwise be read as the total.
  const moe = /(\d+(?:\.\d+)?)\s*B[-_]A(\d+(?:\.\d+)?)\s*B/iu.exec(name);
  if (moe?.[1] !== undefined && moe[2] !== undefined) {
    return { totalBillions: Number(moe[1]), activeBillions: Number(moe[2]) };
  }

  const dense = /(?:^|[-_.])(\d+(?:\.\d+)?)\s*B(?![a-z0-9])/iu.exec(name);
  if (dense?.[1] !== undefined) {
    return { totalBillions: Number(dense[1]), activeBillions: null };
  }

  const millions = /(?:^|[-_.])(\d+(?:\.\d+)?)\s*M(?![a-z0-9])/iu.exec(name);
  if (millions?.[1] !== undefined) {
    return { totalBillions: Number(millions[1]) / 1000, activeBillions: null };
  }

  return null;
}
