/**
 * Deciding how to load a local model on this particular machine.
 *
 * The runtime used to launch with `--n-gpu-layers 99` — "put everything on the
 * GPU" — hardcoded. On Apple Silicon that is right and harmless. On a Windows
 * machine with a discrete card it is the bug that makes a 14B model unusable on
 * an 8 GB GPU: llama.cpp tries to place every layer in VRAM, fails to allocate
 * or thrashes, and the owner concludes the app is broken.
 *
 * This file replaces the constant with a decision, and the decision is shaped by
 * three facts that are easy to get wrong.
 *
 * ## 1. Unified memory changes the question entirely
 *
 * On Apple Silicon the GPU and CPU address the same physical RAM at the same
 * bandwidth. There is no "offload to system RAM" — it is already there. So on
 * Metal the split is always "all on GPU", and choosing a *mode* means choosing a
 * bigger model, not a different placement. Presenting a VRAM/RAM slider on a Mac
 * would be a control that does nothing, which is worse than no control.
 *
 * ## 2. Generation degrades gently; reading the prompt does not
 *
 * Token generation is memory-bandwidth-bound: every weight is read once per
 * token, so moving a quarter of the layers to system RAM costs roughly 3–4x.
 * That is survivable — a 14B at ~13 tok/s still outruns reading speed.
 *
 * Prompt processing is **compute**-bound, and a CPU has far less of it. Offload
 * costs 20–30x there, not 3–4x. A 30,000-token prompt is about fifteen seconds
 * on a GPU and several minutes on a CPU.
 *
 * That matters more here than it would in a chat app, because this product's
 * work is agents reading files: long prompts, short answers. The workload sits
 * exactly on the expensive side of that split, so a mode that offloads is
 * offered with its real cost named rather than as a free upgrade.
 *
 * ## 3. The cliff is swap, not the CPU
 *
 * Offloading to system RAM is a slope. Exceeding physical RAM and landing in SSD
 * swap is a cliff — tens of times slower, and it takes the whole machine down
 * with it. So a plan that would not fit in real memory is refused rather than
 * attempted, and that refusal is the one hard "no" in this file.
 */

import type { HardwareProfile, QualityMode } from "@cadrane/contracts";

/** Every layer, as far as llama.cpp is concerned. */
export const ALL_LAYERS = 99;

/**
 * Left for the KV cache, scratch buffers and the compute graph.
 *
 * llama.cpp needs working memory beyond the weights, and a plan that fills VRAM
 * to the brim loads and then fails on the first long prompt — which reads as a
 * random crash rather than as a model that was always too big.
 */
export const GPU_OVERHEAD_BYTES = 1_200_000_000;

/**
 * The share of system RAM a plan may consume.
 *
 * Not a tuning knob: the rest is the operating system, the browser the owner has
 * open, and this Electron app. Crossing it means swap, which is the cliff.
 */
export const SAFE_RAM_SHARE = 0.7;

export interface LoadPlan {
  /** What to pass as `--n-gpu-layers`. */
  readonly gpuLayers: number;
  readonly ctxSize: number;
  readonly threads: number;
  /** Whether any of the model will sit in system RAM. */
  readonly offloads: boolean;
  /** What the owner should expect, in their words. Never a number of seconds. */
  readonly expectation: string;
  /** Set when the plan is possible but will disappoint. */
  readonly warning: string | null;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: LoadPlan }
  | { readonly ok: false; readonly why: string };

/** Whether this machine's GPU shares memory with the CPU. */
export function isUnifiedMemory(profile: HardwareProfile): boolean {
  // Metal is the reliable signal. A null `dedicatedGpuMemoryBytes` alone is not:
  // it also means "we could not measure it", and treating unknown as unified
  // would place every layer on a card that cannot hold them.
  return profile.acceleration === "metal";
}

/**
 * How many of a model's layers fit in dedicated VRAM.
 *
 * Proportional rather than exact: llama.cpp layers are not uniform in size, and
 * a precise count would need the GGUF metadata. Rounding down is the safe
 * direction — one layer too few costs a little speed, one too many costs an
 * allocation failure.
 */
export function layersThatFit(
  modelBytes: number,
  vramBytes: number,
  totalLayers = 32
): number {
  const usable = vramBytes - GPU_OVERHEAD_BYTES;
  if (usable <= 0 || modelBytes <= 0) {
    return 0;
  }
  if (usable >= modelBytes) {
    return ALL_LAYERS;
  }
  return Math.max(0, Math.floor((usable / modelBytes) * totalLayers));
}

/**
 * Plans a load, or refuses with a reason.
 *
 * `mode` is what the owner asked for, not what they get: a machine that cannot
 * hold a model in the mode requested is told so rather than quietly given
 * something slower and left to wonder.
 */
export function planLoad(
  profile: HardwareProfile,
  modelBytes: number,
  mode: QualityMode
): PlanResult {
  // The hard no. Everything else on this screen is a trade-off; this is not.
  const roomInRam = profile.memoryBytes * SAFE_RAM_SHARE;
  if (modelBytes > roomInRam) {
    return {
      ok: false,
      why: `This model needs about ${gb(modelBytes)} and this Mac has ${gb(
        profile.memoryBytes
      )} of memory. Loading it would push the whole machine into swapping, which is far slower than any setting can recover. Pick a smaller model.`
    };
  }

  const threads = threadsFor(profile);

  if (isUnifiedMemory(profile)) {
    // Nothing to split. The GPU already addresses this memory, so every layer
    // goes to it and the mode changes which model is chosen, not how it loads.
    return {
      ok: true,
      plan: {
        gpuLayers: ALL_LAYERS,
        ctxSize: contextFor(mode),
        threads,
        offloads: false,
        expectation:
          "This Mac shares memory between its processor and graphics, so the whole model runs on the graphics side.",
        warning: null
      }
    };
  }

  const vram = profile.dedicatedGpuMemoryBytes;
  if (vram === null || vram === 0) {
    return {
      ok: true,
      plan: {
        gpuLayers: 0,
        ctxSize: contextFor(mode),
        threads,
        offloads: true,
        expectation: "There is no graphics card to use, so this runs on the processor.",
        warning:
          "Answers will arrive slower than you read, and anything that has to read a long document first will take minutes rather than seconds."
      }
    };
  }

  const layers = layersThatFit(modelBytes, vram);
  if (layers === ALL_LAYERS) {
    return {
      ok: true,
      plan: {
        gpuLayers: ALL_LAYERS,
        ctxSize: contextFor(mode),
        threads,
        offloads: false,
        expectation: "The whole model fits on the graphics card.",
        warning: null
      }
    };
  }

  // The interesting case, and the one the mode exists for.
  if (mode === "fast") {
    return {
      ok: false,
      why: `This model is about ${gb(modelBytes)} and the graphics card holds ${gb(
        vram
      )}. In Fast mode Rellane only runs models that fit on the card. Switch to Careful to run it anyway, or choose a smaller model.`
    };
  }

  const share = Math.round((layers / 32) * 100);
  return {
    ok: true,
    plan: {
      gpuLayers: layers,
      ctxSize: contextFor(mode),
      threads,
      offloads: true,
      expectation: `About ${share}% of this model fits on the graphics card; the rest runs on the processor.`,
      // The honest warning, and the one specific to this product: the penalty
      // for reading a long document is far worse than the penalty for writing
      // an answer, and agents here mostly read.
      warning:
        "Answers stay readable, but anything that reads a long document first will be much slower — that part runs on the processor, where it costs far more than generating the reply does."
    }
  };
}

/**
 * How many threads to give llama.cpp.
 *
 * The naive `logicalCores / 2` is right for x86 and **wrong for Apple Silicon**,
 * which has no simultaneous multithreading — its logical cores *are* physical
 * cores. Halving them on an M1 Pro gives 5 where 8 is correct, which is a real
 * slowdown that nobody would trace back to a thread count.
 *
 * Apple Silicon also mixes performance and efficiency cores, and scheduling this
 * work onto the efficiency cores makes it slower rather than faster: the whole
 * batch waits for the slowest thread. So the efficiency cores are left out.
 * Every current Apple Silicon part has exactly two of them except the base M1/M2
 * with four, and being one thread conservative costs far less than oversubscribing.
 */
export function threadsFor(profile: HardwareProfile): number {
  if (profile.acceleration === "metal") {
    // Physical cores, minus the efficiency ones.
    return Math.max(2, Math.min(16, profile.logicalCores - 2));
  }
  // x86 with SMT: logical cores are double the physical, and hyperthreads add
  // contention rather than throughput on a memory-bound workload.
  return Math.max(2, Math.min(16, Math.floor(profile.logicalCores / 2)));
}

/**
 * How much context to give it.
 *
 * Bigger contexts cost memory that then cannot hold layers, so this is a real
 * trade and not a free number. Fast stays small deliberately; Careful is the
 * mode where somebody is already accepting slowness for capability.
 */
function contextFor(mode: QualityMode): number {
  switch (mode) {
    case "fast":
      return 4_096;
    case "balanced":
      return 8_192;
    case "quality":
      return 16_384;
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
