/**
 * Will this model actually run on this machine?
 *
 * The honest answer is not "params < RAM". Three things eat the budget: the
 * quantised weights, the KV cache (which grows with context), and the memory
 * the rest of the computer still needs. And on Apple Silicon the GPU cannot
 * wire all of unified memory — macOS caps it, so a 16 GB Mac has roughly 12 GB
 * to spend, not 16.
 *
 * Pure functions. No I/O, no clock. Everything is passed in.
 */

const GIB = 1024 ** 3;

/**
 * Effective bytes per parameter by quantisation, including the block scales
 * that make the real file bigger than the nominal bit-width implies.
 *
 * Calibrated against published GGUF sizes rather than derived from bit-width:
 * Qwen2.5-7.61B Q4_K_M ships at 4.68 GB (0.615 GB/B), 14.7B at 8.99 GB
 * (0.611), 32.5B at 19.8 GB (0.609). 0.61 tracks reality across the range.
 */
export const BYTES_PER_PARAM: Readonly<Record<QuantKind, number>> = Object.freeze({
  Q4_K_M: 0.61 * GIB / 1e9,
  Q5_K_M: 0.73 * GIB / 1e9,
  Q6_K: 0.86 * GIB / 1e9,
  Q8_0: 1.12 * GIB / 1e9,
  F16: 2.0 * GIB / 1e9
});

export type QuantKind = "Q4_K_M" | "Q5_K_M" | "Q6_K" | "Q8_0" | "F16";

export interface FitInput {
  /** Total parameters in billions. For MoE this is the full count, not active. */
  readonly parametersBillions: number;
  /** Active parameters for a mixture-of-experts model. Drives speed, not memory. */
  readonly activeParametersBillions?: number | undefined;
  readonly quant: QuantKind;
  /** Context window the user actually intends to run. */
  readonly contextTokens: number;
  readonly memoryBytes: number;
  readonly freeDiskBytes: number;
  readonly acceleration: string;
  /** Present on discrete GPUs; on unified-memory Macs this is null. */
  readonly dedicatedGpuMemoryBytes?: number | null | undefined;
}

export type FitVerdict = "comfortable" | "tight" | "will-not-fit" | "no-disk";

export interface Fit {
  readonly verdict: FitVerdict;
  readonly weightsBytes: number;
  readonly kvCacheBytes: number;
  readonly requiredBytes: number;
  readonly usableBytes: number;
  /** Plain sentence for the UI. Never a number the caller has to interpret. */
  readonly reason: string;
}

/**
 * How much memory the accelerator can actually use.
 *
 * Apple Silicon shares one pool and macOS wires about 75% of it for the GPU by
 * default (`iogpu.wired_mem_limit`, unset on a stock machine). A discrete GPU
 * has its own VRAM and that number is the ceiling instead.
 */
export function usableAcceleratorBytes(input: {
  readonly memoryBytes: number;
  readonly acceleration: string;
  readonly dedicatedGpuMemoryBytes?: number | null | undefined;
}): number {
  if (input.acceleration === "metal") {
    return Math.floor(input.memoryBytes * 0.75);
  }
  const dedicated = input.dedicatedGpuMemoryBytes ?? 0;
  if (dedicated > 0) {
    return dedicated;
  }
  // CPU inference: leave the operating system room to breathe.
  return Math.floor(input.memoryBytes * 0.6);
}

/**
 * KV cache size. Scales with context and, roughly, with model depth — which
 * tracks parameter count closely enough for a fit estimate.
 *
 * Deliberately generous. Telling someone a model fits when it then swaps is a
 * far worse failure than telling them it is tight when it would have been fine.
 */
export function kvCacheBytes(parametersBillions: number, contextTokens: number): number {
  const perTokenBytes = 40_000 * Math.cbrt(Math.max(parametersBillions, 0.1)) / 10;
  return Math.round(perTokenBytes * Math.max(contextTokens, 0));
}

export function weightsBytes(parametersBillions: number, quant: QuantKind): number {
  return Math.round(parametersBillions * 1e9 * BYTES_PER_PARAM[quant]);
}

export function assessFit(input: FitInput): Fit {
  const weights = weightsBytes(input.parametersBillions, input.quant);
  const kv = kvCacheBytes(input.parametersBillions, input.contextTokens);
  const required = weights + kv;
  const usable = usableAcceleratorBytes(input);

  // The download has to land before it can run.
  if (input.freeDiskBytes < weights * 1.15) {
    return {
      verdict: "no-disk",
      weightsBytes: weights,
      kvCacheBytes: kv,
      requiredBytes: required,
      usableBytes: usable,
      reason: `Needs about ${gib(weights)} of free space and there is ${gib(input.freeDiskBytes)}.`
    };
  }

  if (required > usable) {
    return {
      verdict: "will-not-fit",
      weightsBytes: weights,
      kvCacheBytes: kv,
      requiredBytes: required,
      usableBytes: usable,
      reason: `Needs about ${gib(required)} but this computer can give a model about ${gib(usable)}.`
    };
  }

  if (required > usable * 0.8) {
    return {
      verdict: "tight",
      weightsBytes: weights,
      kvCacheBytes: kv,
      requiredBytes: required,
      usableBytes: usable,
      reason: `Fits, but only just — ${gib(required)} of the ${gib(usable)} available. Expect other apps to feel slower.`
    };
  }

  const moe = input.activeParametersBillions;
  const speedNote =
    moe !== undefined && moe < input.parametersBillions
      ? ` Only about ${trim(moe)}B parameters are active per token, so it runs far faster than its size suggests.`
      : "";

  return {
    verdict: "comfortable",
    weightsBytes: weights,
    kvCacheBytes: kv,
    requiredBytes: required,
    usableBytes: usable,
    reason: `Fits comfortably — ${gib(required)} of the ${gib(usable)} available.${speedNote}`
  };
}

export function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
