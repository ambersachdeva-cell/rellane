/**
 * What this machine can actually run, read without asking anything else.
 *
 * There is a richer `system.profile` from the daemon, and it is the right source
 * for the Models screen. It is the wrong source here: the local runtime starts
 * independently of the daemon, so depending on it would mean the model cannot
 * load until something unrelated is up — and would fail in a way that looks like
 * the model is broken rather than like a startup ordering mistake.
 *
 * So this reads only what the operating system will tell us directly, and is
 * honest about what it cannot see. **Unknown is reported as unknown**, never as
 * zero and never as a guess, because the planner treats those differently: an
 * unmeasurable graphics card must not be assumed to be unified memory, or every
 * layer gets placed on a card that cannot hold them.
 */

import { cpus, totalmem } from "node:os";
import { runProcess } from "../subscription-brain/cli-invoker.js";
import type { HardwareProfile } from "@cadrane/contracts";

/** nvidia-smi should answer instantly. If it does not, it is not usable here. */
const SMI_TIMEOUT_MS = 4_000;

/**
 * How much dedicated video memory the machine has, or null if unknown.
 *
 * Only NVIDIA is probed, and only through `nvidia-smi`, which ships with the
 * driver. AMD and Intel are left as null rather than guessed — a wrong number
 * here produces a plan that fails at load, which is worse than a conservative
 * plan that runs.
 */
export async function dedicatedVramBytes(): Promise<number | null> {
  if (process.platform === "darwin") {
    // Apple Silicon has no dedicated video memory. Reporting a number would be
    // inventing a boundary that does not exist on this hardware.
    return null;
  }
  try {
    const result = await runProcess({
      executablePath: "nvidia-smi",
      args: ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      timeoutMs: SMI_TIMEOUT_MS
    });
    if (result.code !== 0) {
      return null;
    }
    // Megabytes, one line per card. The first is the one llama.cpp will use by
    // default, and summing them would be wrong — a model does not span cards
    // without being told to.
    const megabytes = Number.parseInt(result.stdout.trim().split("\n")[0] ?? "", 10);
    return Number.isFinite(megabytes) && megabytes > 0 ? megabytes * 1024 * 1024 : null;
  } catch {
    // Not installed, not on PATH, no NVIDIA card. All the same answer: we do
    // not know, and the planner should behave conservatively.
    return null;
  }
}

/** Which backend llama.cpp will use, as far as can be told without running it. */
export function accelerationFor(vram: number | null): HardwareProfile["acceleration"] {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "metal";
  }
  return vram === null ? "cpu" : "cuda";
}

/**
 * Enough of a profile to plan a load.
 *
 * Deliberately not the whole `HardwareProfile`: the fields this does not measure
 * are filled with honest placeholders rather than invented values, and nothing
 * in the planner reads them.
 */
export async function readHardwareProfile(): Promise<HardwareProfile> {
  const vram = await dedicatedVramBytes();
  const cores = cpus().length;

  return {
    platform:
      process.platform === "darwin" || process.platform === "linux" || process.platform === "win32"
        ? process.platform
        : "other",
    operatingSystem: `${process.platform} ${process.arch}`,
    architecture: process.arch,
    chip: cpus()[0]?.model ?? "unknown",
    gpuName: null,
    dedicatedGpuMemoryBytes: vram,
    // Never zero: a machine reporting no cores would make the thread count
    // collapse to the floor and run everything single-threaded.
    logicalCores: Math.max(1, cores),
    memoryBytes: totalmem(),
    freeDiskBytes: 0,
    acceleration: accelerationFor(vram),
    recommendation: "balanced",
    recommendationReason: "Read from this machine at startup, without the daemon.",
    measuredAt: new Date().toISOString()
  };
}
