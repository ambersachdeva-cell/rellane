/**
 * Which inference backend to use, decided rather than configured.
 *
 * On Apple Silicon, MLX leads llama.cpp by 20–87% for models under 14B and the
 * two converge above 27B where memory bandwidth becomes the bottleneck. Ollama
 * switched its Apple Silicon engine to MLX in March 2026 for the same reason.
 * Every model that fits on a 16 GB Mac is in the band where MLX wins, so the
 * default matters.
 *
 * It is a preference, never a requirement. llama.cpp is bundled and verified
 * against a pinned hash; MLX is a Python package that may or may not be present
 * and can break with an OS update. The bundled runtime is therefore always the
 * floor, and MLX is used only when it has been observed working.
 */

export type BackendId = "mlx" | "llama-cpp";

export interface BackendCapability {
  readonly id: BackendId;
  readonly available: boolean;
  /** Version string when available; the reason when not. */
  readonly detail: string;
}

export interface MachineFacts {
  readonly platform: string;
  readonly architecture: string;
  readonly acceleration: string;
}

/**
 * MLX is Apple-Silicon only. Asking a Windows or Intel machine to look for it
 * wastes a subprocess on every launch and can only ever answer no.
 */
export function mlxIsPossible(machine: MachineFacts): boolean {
  return (
    machine.platform === "darwin" &&
    machine.architecture === "arm64" &&
    machine.acceleration === "metal"
  );
}

export interface BackendChoice {
  readonly backend: BackendId;
  /** Shown to the user. Never a claim about speed that was not measured. */
  readonly reason: string;
}

/**
 * Picks a backend for one model.
 *
 * The size threshold is where the published benchmarks stop showing a
 * difference: below roughly 14B parameters MLX is meaningfully faster, above
 * about 27B the two converge. Between them either is defensible, so the
 * bundled one wins because it is the one whose bytes we verified.
 */
export function chooseBackend(input: {
  readonly parametersBillions: number;
  readonly backends: readonly BackendCapability[];
  /** Measured tokens/sec per backend, when a benchmark has been run. */
  readonly measured?: Readonly<Partial<Record<BackendId, number>>> | undefined;
}): BackendChoice {
  const available = new Map(input.backends.filter((b) => b.available).map((b) => [b.id, b]));

  if (!available.has("mlx")) {
    const mlx = input.backends.find((b) => b.id === "mlx");
    return {
      backend: "llama-cpp",
      reason: mlx === undefined ? "Using the bundled engine." : `Using the bundled engine — ${mlx.detail}`
    };
  }

  // A measurement on this machine beats any published benchmark.
  const measured = input.measured;
  if (measured?.mlx !== undefined && measured["llama-cpp"] !== undefined) {
    const faster: BackendId = measured.mlx >= measured["llama-cpp"] ? "mlx" : "llama-cpp";
    const [fast, slow] =
      faster === "mlx"
        ? [measured.mlx, measured["llama-cpp"]]
        : [measured["llama-cpp"], measured.mlx];
    const gain = slow > 0 ? Math.round(((fast - slow) / slow) * 100) : 0;
    return {
      backend: faster,
      reason:
        gain <= 2
          ? `Both engines measured about the same here (${Math.round(fast)} tokens/sec).`
          : `Measured ${Math.round(fast)} tokens/sec on this Mac, ${gain}% faster than the alternative.`
    };
  }

  if (input.parametersBillions < 14) {
    return {
      backend: "mlx",
      reason: "MLX is typically faster than the bundled engine for a model this size."
    };
  }
  return {
    backend: "llama-cpp",
    reason: "Above roughly 27B the two engines perform alike, so the verified bundled one is used."
  };
}

/** Tokens per second, from a run that actually happened. */
export interface Benchmark {
  readonly backend: BackendId;
  readonly modelId: string;
  readonly tokensPerSecond: number;
  readonly promptTokens: number;
  readonly generatedTokens: number;
  readonly measuredAt: string;
}

export function tokensPerSecond(generatedTokens: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || generatedTokens <= 0) {
    return 0;
  }
  return (generatedTokens / elapsedMs) * 1000;
}

/**
 * One sentence about speed, or an honest absence of one.
 *
 * Rellane does not quote a number it has not observed on this machine. Claimed
 * throughput from a vendor page is marketing; a number from a run here is a
 * fact, and the difference is the whole point of measuring at all.
 */
export function describeSpeed(benchmark: Benchmark | null): string {
  if (benchmark === null) {
    return "Not measured on this Mac yet.";
  }
  return `${Math.round(benchmark.tokensPerSecond)} tokens/sec, measured here on ${new Date(
    benchmark.measuredAt
  ).toLocaleDateString()}.`;
}
