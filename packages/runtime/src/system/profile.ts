import { execFile } from "node:child_process";
import os from "node:os";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  HardwareProfileSchema,
  type HardwareProfile,
  type QualityMode
} from "@cadrane/contracts";

const execFileAsync = promisify(execFile);

export async function profileHardware(dataDir: string): Promise<HardwareProfile> {
  const memoryBytes = os.totalmem();
  const freeDiskBytes = await readFreeDiskBytes(dataDir);
  const platform = normalizePlatform(process.platform);
  const chip = await readChipName();
  const graphics = await readGraphics(platform, chip);
  const recommendation = recommendQualityMode(memoryBytes, freeDiskBytes);

  return HardwareProfileSchema.parse({
    platform,
    operatingSystem: `${os.type()} ${os.release()}`.trim(),
    architecture: process.arch,
    chip,
    gpuName: graphics.name,
    dedicatedGpuMemoryBytes: graphics.memoryBytes,
    logicalCores: Math.max(1, os.cpus().length),
    memoryBytes,
    freeDiskBytes,
    acceleration: graphics.acceleration,
    recommendation: recommendation.mode,
    recommendationReason: recommendation.reason,
    measuredAt: new Date().toISOString()
  });
}

export function recommendQualityMode(
  memoryBytes: number,
  freeDiskBytes: number
): { mode: QualityMode; reason: string } {
  const memoryGiB = memoryBytes / 1024 ** 3;
  const freeDiskGiB = freeDiskBytes / 1024 ** 3;

  if (memoryGiB >= 28 && freeDiskGiB >= 24) {
    return {
      mode: "quality",
      reason: "This computer has room for a larger quality-focused local model while keeping the system responsive."
    };
  }
  if (memoryGiB >= 14 && freeDiskGiB >= 10) {
    return {
      mode: "balanced",
      reason: "Balanced keeps useful quality and leaves memory for the rest of your work."
    };
  }
  return {
    mode: "fast",
    reason: "Fast uses a smaller local model to protect responsiveness and available storage."
  };
}

interface GraphicsProfile {
  name: string | null;
  memoryBytes: number | null;
  acceleration: HardwareProfile["acceleration"];
}

async function readGraphics(
  platform: HardwareProfile["platform"],
  chip: string
): Promise<GraphicsProfile> {
  if (platform === "darwin" && process.arch === "arm64") {
    return {
      name: chip,
      memoryBytes: null,
      acceleration: "metal"
    };
  }

  if (platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const powershell = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    try {
      const result = await execFileAsync(powershell, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"
      ], {
        timeout: 4_000,
        maxBuffer: 128_000,
        windowsHide: true
      });
      return parseWindowsGraphics(result.stdout);
    } catch {
      return { name: null, memoryBytes: null, acceleration: "cpu" };
    }
  }

  if (platform === "linux") {
    try {
      const result = await execFileAsync("/usr/bin/nvidia-smi", [
        "--query-gpu=name,memory.total",
        "--format=csv,noheader,nounits"
      ], {
        timeout: 3_000,
        maxBuffer: 64_000
      });
      const [firstLine] = result.stdout.trim().split("\n");
      const [name, memoryMiBText] = firstLine?.split(",").map((value) => value.trim()) ?? [];
      const memoryMiB = Number(memoryMiBText);
      return {
        name: name?.slice(0, 512) || "NVIDIA GPU",
        memoryBytes: Number.isFinite(memoryMiB) ? Math.max(0, memoryMiB) * 1024 ** 2 : null,
        acceleration: "unknown"
      };
    } catch {
      return { name: null, memoryBytes: null, acceleration: "cpu" };
    }
  }

  return { name: null, memoryBytes: null, acceleration: "cpu" };
}

export function parseWindowsGraphics(rawJson: string): GraphicsProfile {
  const parsed = JSON.parse(rawJson) as unknown;
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const items = candidates.flatMap((value) => {
    if (typeof value !== "object" || value === null) {
      return [];
    }
    const record = value as Record<string, unknown>;
    const name = typeof record.Name === "string" ? record.Name.trim().slice(0, 512) : "";
    const adapterRam = typeof record.AdapterRAM === "number" ? record.AdapterRAM : null;
    return name.length > 0 ? [{ name, adapterRam }] : [];
  });
  const preferred = items.find((item) => /nvidia/i.test(item.name))
    ?? items.find((item) => /amd|radeon/i.test(item.name))
    ?? items[0];
  if (preferred === undefined) {
    return { name: null, memoryBytes: null, acceleration: "cpu" };
  }
  return {
    name: preferred.name,
    memoryBytes: preferred.adapterRam !== null && preferred.adapterRam > 0
      ? preferred.adapterRam
      : null,
    acceleration: "unknown"
  };
}

async function readChipName(): Promise<string> {
  if (process.platform === "darwin") {
    try {
      const result = await execFileAsync("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"], {
        timeout: 2_000,
        maxBuffer: 16_000
      });
      const value = result.stdout.trim();
      if (value.length > 0) {
        return value.slice(0, 256);
      }
    } catch {
      // Fall through to Node's static CPU description.
    }
  }
  return os.cpus()[0]?.model.slice(0, 256) || `${process.arch} processor`;
}

async function readFreeDiskBytes(dataDir: string): Promise<number> {
  try {
    const result = await statfs(dataDir);
    return Math.max(0, Number(result.bavail) * Number(result.bsize));
  } catch {
    return 0;
  }
}

function normalizePlatform(value: NodeJS.Platform): HardwareProfile["platform"] {
  if (value === "darwin" || value === "linux" || value === "win32") {
    return value;
  }
  return "other";
}
