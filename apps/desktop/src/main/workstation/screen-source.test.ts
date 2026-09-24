import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureTarget,
  listCaptureTargets,
  MAX_CAPTURE_BYTES,
  type CaptureDeps
} from "./screen-source.js";

function createMockThumbnail(options?: {
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly empty?: boolean;
}) {
  const width = options?.width ?? 800;
  const height = options?.height ?? 600;
  const empty = options?.empty ?? false;
  const byteCount = options?.bytes ?? 128;
  const buffer = Buffer.alloc(byteCount, 0x42);

  return {
    toPNG: () => buffer,
    getSize: () => ({ width, height }),
    isEmpty: () => empty
  };
}

describe("screen-source", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "screen-source-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("skips sources whose thumbnails are empty", async () => {
    const deps: CaptureDeps = {
      listSources: async () => [
        {
          id: "window:1",
          name: "Safari",
          thumbnail: createMockThumbnail({ empty: true })
        },
        {
          id: "window:2",
          name: "Terminal",
          thumbnail: createMockThumbnail({ empty: false })
        }
      ]
    };

    const targets = await listCaptureTargets(deps);
    expect(targets).toHaveLength(1);
    if (targets.length > 0) {
      expect(targets[0]!.id).toBe("window:2");
      expect(targets[0]!.label).toBe("Terminal");
    }
  });

  it("refuses an unknown target id", async () => {
    const deps: CaptureDeps = {
      listSources: async () => [
        {
          id: "window:1",
          name: "Safari",
          thumbnail: createMockThumbnail()
        }
      ]
    };

    const outcome = await captureTarget(deps, "window:unknown", tempDir, 1_700_000_000_000);
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.reason).toBe("The selected window or screen is no longer available.");
    }
  });

  it("refuses an outputDir that does not exist or is not a directory", async () => {
    const deps: CaptureDeps = {
      listSources: async () => [
        {
          id: "window:1",
          name: "Safari",
          thumbnail: createMockThumbnail()
        }
      ]
    };

    const nonExistent = path.join(tempDir, "missing-folder");
    const outcomeMissing = await captureTarget(deps, "window:1", nonExistent, 1_700_000_000_000);
    expect(outcomeMissing.status).toBe("unavailable");

    const regularFile = path.join(tempDir, "regular-file.txt");
    await fs.writeFile(regularFile, "content");
    const outcomeFile = await captureTarget(deps, "window:1", regularFile, 1_700_000_000_000);
    expect(outcomeFile.status).toBe("unavailable");
    if (outcomeFile.status === "unavailable") {
      expect(outcomeFile.reason).toBe("The destination path is not a folder.");
    }
  });

  it("refuses captures exceeding MAX_CAPTURE_BYTES", async () => {
    const deps: CaptureDeps = {
      listSources: async () => [
        {
          id: "window:1",
          name: "Heavy Window",
          thumbnail: createMockThumbnail({ bytes: MAX_CAPTURE_BYTES + 1024 })
        }
      ]
    };

    const outcome = await captureTarget(deps, "window:1", tempDir, 1_700_000_000_000);
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.reason).toContain("16 MB");
    }

    const writtenFiles = await fs.readdir(tempDir);
    expect(writtenFiles).toHaveLength(0);
  });

  it("sanitises the written filename to safe characters", async () => {
    const deps: CaptureDeps = {
      listSources: async () => [
        {
          id: "window:1",
          name: "../../../Invoice #42: Acme / Co. *2024*?",
          thumbnail: createMockThumbnail()
        }
      ]
    };

    const now = 1_700_000_123_456;
    const outcome = await captureTarget(deps, "window:1", tempDir, now);
    expect(outcome.status).toBe("captured");
    if (outcome.status === "captured") {
      expect(outcome.label).toBe("../../../Invoice #42: Acme / Co. *2024*?");
      expect(path.dirname(outcome.pngPath)).toBe(tempDir);
      const basename = path.basename(outcome.pngPath);
      expect(basename).toBe(`Invoice-42-Acme-Co-2024-${now}.png`);
      const fileStat = await fs.stat(outcome.pngPath);
      expect(fileStat.isFile()).toBe(true);
    }
  });

  it("records the pixel size from the image rather than the requested thumbnail size", async () => {
    let requestedWidth = 0;
    const deps: CaptureDeps = {
      listSources: async (options) => {
        requestedWidth = options.thumbnailSize.width;
        return [
          {
            id: "window:1",
            name: "Dashboard",
            thumbnail: createMockThumbnail({ width: 2560, height: 1600 })
          }
        ];
      }
    };

    const outcome = await captureTarget(deps, "window:1", tempDir, 1_700_000_000_000);
    expect(requestedWidth).toBeGreaterThanOrEqual(1920);
    expect(outcome.status).toBe("captured");
    if (outcome.status === "captured") {
      expect(outcome.width).toBe(2560);
      expect(outcome.height).toBe(1600);
    }
  });

  it("orders screens first in capture order, then windows alphabetically by name", async () => {
    const deps: CaptureDeps = {
      listSources: async () => [
        {
          id: "window:2",
          name: "Zulip",
          thumbnail: createMockThumbnail()
        },
        {
          id: "screen:1",
          name: "Built-in Display",
          thumbnail: createMockThumbnail()
        },
        {
          id: "window:1",
          name: "Apple Mail",
          thumbnail: createMockThumbnail()
        },
        {
          id: "screen:2",
          name: "External 4K Display",
          thumbnail: createMockThumbnail()
        }
      ]
    };

    const targets = await listCaptureTargets(deps);
    expect(targets.map((t) => t.label)).toEqual([
      "Built-in Display",
      "External 4K Display",
      "Apple Mail",
      "Zulip"
    ]);
    expect(targets.map((t) => t.kind)).toEqual([
      "screen",
      "screen",
      "window",
      "window"
    ]);
  });

  it("captures target successfully writing png and returning metadata", async () => {
    const mockPngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const deps: CaptureDeps = {
      listSources: async () => [
        {
          id: "screen:0",
          name: "Main Monitor",
          thumbnail: {
            toPNG: () => mockPngBuffer,
            getSize: () => ({ width: 1920, height: 1080 }),
            isEmpty: () => false
          }
        }
      ]
    };

    const now = 1_720_000_000_000;
    const outcome = await captureTarget(deps, "screen:0", tempDir, now);
    expect(outcome.status).toBe("captured");
    if (outcome.status === "captured") {
      expect(outcome.bytes).toBe(mockPngBuffer.byteLength);
      expect(outcome.width).toBe(1920);
      expect(outcome.height).toBe(1080);
      expect(outcome.label).toBe("Main Monitor");
      expect(outcome.at).toBe(now);

      const writtenBytes = await fs.readFile(outcome.pngPath);
      expect(writtenBytes).toEqual(mockPngBuffer);
    }
  });
});
