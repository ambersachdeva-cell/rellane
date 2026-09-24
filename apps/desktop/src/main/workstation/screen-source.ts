/**
 * Captures windows and screens directly into the workstation as image sources.
 *
 * All capture operations are abstracted through CaptureDeps so they can be
 * driven by desktopCapturer in production or mocked in tests without an
 * active display server.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface CaptureTarget {
  readonly id: string;
  readonly label: string;
  readonly kind: "screen" | "window";
  readonly thumbnailDataUrl: string;
}

export type CaptureOutcome =
  | {
      readonly status: "captured";
      readonly pngPath: string;
      readonly bytes: number;
      readonly width: number;
      readonly height: number;
      readonly label: string;
      readonly at: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason: string;
    };

export const MAX_CAPTURE_BYTES = 16_777_216;

export interface CaptureDeps {
  readonly listSources: (options: {
    readonly types: readonly string[];
    readonly thumbnailSize: { readonly width: number; readonly height: number };
  }) => Promise<
    readonly {
      readonly id: string;
      readonly name: string;
      readonly thumbnail: {
        readonly toPNG: () => Buffer;
        readonly getSize: () => { width: number; height: number };
        readonly isEmpty: () => boolean;
      };
    }[]
  >;
}

export const PREVIEW_THUMBNAIL_SIZE = { width: 320, height: 180 } as const;
export const CAPTURE_THUMBNAIL_SIZE = { width: 1920, height: 1080 } as const;

function detectKind(id: string): "screen" | "window" {
  return id.toLowerCase().startsWith("screen") ? "screen" : "window";
}

export function sanitiseLabel(label: string, fallback: "screen" | "window"): string {
  // Stripping path traversal and directory separators confines writes to outputDir.
  const cleaned = label
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

export async function listCaptureTargets(deps: CaptureDeps): Promise<readonly CaptureTarget[]> {
  let sources: Awaited<ReturnType<CaptureDeps["listSources"]>>;
  try {
    sources = await deps.listSources({
      types: ["screen", "window"],
      thumbnailSize: PREVIEW_THUMBNAIL_SIZE
    });
  } catch {
    return [];
  }

  const screens: CaptureTarget[] = [];
  const windows: CaptureTarget[] = [];

  for (const source of sources) {
    if (source.thumbnail.isEmpty()) {
      continue;
    }

    const kind = detectKind(source.id);
    const label = source.name.trim() || (kind === "screen" ? "Screen" : "Window");
    const png = source.thumbnail.toPNG();
    const thumbnailDataUrl = `data:image/png;base64,${png.toString("base64")}`;

    const target: CaptureTarget = {
      id: source.id,
      label,
      kind,
      thumbnailDataUrl
    };

    if (kind === "screen") {
      screens.push(target);
    } else {
      windows.push(target);
    }
  }

  // Screens preserve system display order, whilst windows are alphabetised for scanning.
  windows.sort((a, b) => a.label.localeCompare(b.label));

  return [...screens, ...windows];
}

export async function captureTarget(
  deps: CaptureDeps,
  targetId: string,
  outputDir: string,
  now: number
): Promise<CaptureOutcome> {
  if (!outputDir || typeof outputDir !== "string") {
    return {
      status: "unavailable",
      reason: "A destination folder must be specified."
    };
  }

  let dirStat;
  try {
    dirStat = await fs.stat(outputDir);
  } catch {
    return {
      status: "unavailable",
      reason: "The destination folder does not exist."
    };
  }

  if (!dirStat.isDirectory()) {
    return {
      status: "unavailable",
      reason: "The destination path is not a folder."
    };
  }

  if (!targetId || typeof targetId !== "string") {
    return {
      status: "unavailable",
      reason: "A window or screen must be selected."
    };
  }

  let sources: Awaited<ReturnType<CaptureDeps["listSources"]>>;
  try {
    sources = await deps.listSources({
      types: ["screen", "window"],
      thumbnailSize: CAPTURE_THUMBNAIL_SIZE
    });
  } catch {
    return {
      status: "unavailable",
      reason: "Screen capture is currently unavailable on this Mac."
    };
  }

  const matched = sources.find((source) => source.id === targetId);
  if (!matched) {
    return {
      status: "unavailable",
      reason: "The selected window or screen is no longer available."
    };
  }

  if (matched.thumbnail.isEmpty()) {
    return {
      status: "unavailable",
      reason: "The selected window or screen has no visible content to capture."
    };
  }

  const pngBuffer = matched.thumbnail.toPNG();
  const bytes = pngBuffer.byteLength;
  const size = matched.thumbnail.getSize();

  if (bytes === 0 || size.width === 0 || size.height === 0) {
    return {
      status: "unavailable",
      reason: "The selected window or screen has no visible content to capture."
    };
  }

  // Refusing captures above the ceiling prevents generating files that cannot be attached.
  if (bytes > MAX_CAPTURE_BYTES) {
    return {
      status: "unavailable",
      reason: "The capture is too large to attach because it exceeds the 16 MB limit."
    };
  }

  const kind = detectKind(matched.id);
  const label = matched.name.trim() || (kind === "screen" ? "Screen" : "Window");
  const slug = sanitiseLabel(label, kind);
  const timestamp = Number.isFinite(now) ? Math.trunc(now) : Date.now();
  const filename = `${slug}-${timestamp}.png`;
  const pngPath = path.join(outputDir, filename);

  try {
    await fs.writeFile(pngPath, pngBuffer);
  } catch {
    return {
      status: "unavailable",
      reason: "The capture could not be saved to disk."
    };
  }

  return {
    status: "captured",
    pngPath,
    bytes,
    width: size.width,
    height: size.height,
    label,
    at: now
  };
}
