/** Exercise preflight and atomic filesystem behavior; native decoder acceptance is checked separately. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  inspectImageHeader,
  readChosenImage,
  exportOriginalImage,
  MAX_IMAGE_BYTE_LENGTH,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS
} from "./image-files.js";

// Note: Tests evaluate bounded binary preflight header parsing only, not full image decoding.

function createPngFixture(options: {
  width?: number;
  height?: number;
  ihdrLength?: number;
  includeIdat?: boolean;
  includeIend?: boolean;
  extraChunks?: Array<{ type: string; data: Uint8Array }>;
  trailingBytes?: Uint8Array;
} = {}): Buffer {
  const width = options.width ?? 64;
  const height = options.height ?? 64;
  const ihdrLength = options.ihdrLength ?? 13;
  const includeIdat = options.includeIdat ?? true;
  const includeIend = options.includeIend ?? true;

  const parts: Buffer[] = [];
  // PNG Signature
  parts.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  // IHDR
  const ihdrPayload = Buffer.alloc(ihdrLength);
  if (ihdrLength >= 8) {
    ihdrPayload.writeUInt32BE(width, 0);
    ihdrPayload.writeUInt32BE(height, 4);
    if (ihdrLength >= 13) {
      ihdrPayload[8] = 8;  // bit depth
      ihdrPayload[9] = 2;  // color type (RGB)
      ihdrPayload[10] = 0; // compression method
      ihdrPayload[11] = 0; // filter method
      ihdrPayload[12] = 0; // interlace method
    }
  }
  const ihdrChunk = Buffer.alloc(12 + ihdrLength);
  ihdrChunk.writeUInt32BE(ihdrLength, 0);
  ihdrChunk.write("IHDR", 4, 4, "ascii");
  ihdrPayload.copy(ihdrChunk, 8);
  ihdrChunk.writeUInt32BE(0, 8 + ihdrLength); // CRC
  parts.push(ihdrChunk);

  // Extra chunks (e.g. APNG)
  if (options.extraChunks) {
    for (const ec of options.extraChunks) {
      const c = Buffer.alloc(12 + ec.data.byteLength);
      c.writeUInt32BE(ec.data.byteLength, 0);
      c.write(ec.type, 4, 4, "ascii");
      Buffer.from(ec.data).copy(c, 8);
      c.writeUInt32BE(0, 8 + ec.data.byteLength);
      parts.push(c);
    }
  }

  // IDAT
  if (includeIdat) {
    const idatChunk = Buffer.alloc(12 + 4);
    idatChunk.writeUInt32BE(4, 0);
    idatChunk.write("IDAT", 4, 4, "ascii");
    idatChunk.writeUInt32BE(0x12345678, 8);
    idatChunk.writeUInt32BE(0, 12);
    parts.push(idatChunk);
  }

  // IEND
  if (includeIend) {
    const iendChunk = Buffer.alloc(12);
    iendChunk.writeUInt32BE(0, 0);
    iendChunk.write("IEND", 4, 4, "ascii");
    iendChunk.writeUInt32BE(0, 8);
    parts.push(iendChunk);
  }

  if (options.trailingBytes) {
    parts.push(Buffer.from(options.trailingBytes));
  }

  return Buffer.concat(parts);
}

function createJpegFixture(options: {
  width?: number;
  height?: number;
  sofMarker?: number;
  duplicateSof?: boolean;
  otherSofMarker?: number;
  includeDnl?: boolean;
  includeSos?: boolean;
  includeEoi?: boolean;
  entropyBytes?: Uint8Array;
  multipleScans?: boolean;
  truncateAfterSof?: boolean;
} = {}): Buffer {
  const width = options.width ?? 64;
  const height = options.height ?? 64;
  const sofMarker = options.sofMarker ?? 0xc0;
  const includeSos = options.includeSos ?? true;
  const includeEoi = options.includeEoi ?? true;

  const parts: Buffer[] = [];
  // SOI
  parts.push(Buffer.from([0xff, 0xd8]));

  // APP0
  parts.push(Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00
  ]));

  function buildSof(marker: number, w: number, h: number): Buffer {
    const b = Buffer.alloc(13);
    b[0] = 0xff;
    b[1] = marker;
    b.writeUInt16BE(11, 2); // segment length = 11
    b[4] = 8; // precision
    b.writeUInt16BE(h, 5);
    b.writeUInt16BE(w, 7);
    b[9] = 1; // 1 component
    b[10] = 1; b[11] = 0x11; b[12] = 0;
    return b;
  }

  parts.push(buildSof(sofMarker, width, height));

  if (options.truncateAfterSof) {
    return Buffer.concat(parts);
  }

  if (options.duplicateSof) {
    parts.push(buildSof(sofMarker, width, height));
  }

  if (options.otherSofMarker !== undefined) {
    parts.push(buildSof(options.otherSofMarker, width, height));
  }

  if (options.includeDnl) {
    parts.push(Buffer.from([0xff, 0xdc, 0x00, 0x04, 0x00, 0x64]));
  }

  if (includeSos) {
    const sos = Buffer.from([
      0xff, 0xda, 0x00, 0x08,
      0x01, 0x01, 0x00,
      0x00, 0x3f, 0x00
    ]);
    parts.push(sos);

    if (options.entropyBytes) {
      parts.push(Buffer.from(options.entropyBytes));
    } else {
      // Contains literal 0xFF (FF 00) and restart marker RST0 (FF D0)
      parts.push(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]));
    }

    if (options.multipleScans) {
      parts.push(sos);
      parts.push(Buffer.from([0x9a, 0xbc, 0xff, 0x00, 0xde]));
    }
  }

  if (includeEoi) {
    parts.push(Buffer.from([0xff, 0xd9]));
  }

  return Buffer.concat(parts);
}

it("refuses a second PNG dimension header before the native decoder sees it", () => {
  const dimensions = Buffer.alloc(13); dimensions.writeUInt32BE(8000, 0); dimensions.writeUInt32BE(8000, 4);
  expect(() => inspectImageHeader(createPngFixture({ extraChunks: [{ type: "IHDR", data: dimensions }] }))).toThrow("duplicate IHDR");
});
it("refuses a second image appended after JPEG EOI", () => {
  const image = createJpegFixture();
  expect(() => inspectImageHeader(Buffer.concat([image, image]))).toThrow("trailing bytes");
});

describe("image-files unit and behavior tests", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "image-files-test-"));
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("inspectImageHeader: PNG preflight parsing", () => {
    it("parses valid PNG dimensions within limits", () => {
      const fixture = createPngFixture({ width: 320, height: 240 });
      const result = inspectImageHeader(fixture);
      expect(result).toEqual({ mime: "image/png", width: 320, height: 240 });
    });

    it("rejects empty and oversize buffer", () => {
      expect(() => inspectImageHeader(new Uint8Array(0))).toThrow(/empty/i);
      expect(() => inspectImageHeader(new Uint8Array(MAX_IMAGE_BYTE_LENGTH + 1))).toThrow(/exceeds/i);
    });

    it("rejects truncated PNG signature and truncated chunks", () => {
      expect(() => inspectImageHeader(Buffer.from([0x89, 0x50, 0x4e]))).toThrow();
      const fixture = createPngFixture({ width: 100, height: 100 });
      expect(() => inspectImageHeader(fixture.subarray(0, 20))).toThrow(/Truncated PNG/);
    });

    it("rejects non-13-byte IHDR chunks", () => {
      const fixture = createPngFixture({ ihdrLength: 10 });
      expect(() => inspectImageHeader(fixture)).toThrow(/IHDR chunk length must be exactly 13 bytes/);
    });

    it("rejects PNG width or height exceeding 4096 or zero dimension", () => {
      const oversizeW = createPngFixture({ width: 4097, height: 100 });
      expect(() => inspectImageHeader(oversizeW)).toThrow(/outside permitted range/);

      const oversizeH = createPngFixture({ width: 100, height: 4097 });
      expect(() => inspectImageHeader(oversizeH)).toThrow(/outside permitted range/);

      const zeroDim = createPngFixture({ width: 0, height: 100 });
      expect(() => inspectImageHeader(zeroDim)).toThrow(/outside permitted range/);
    });

    it("rejects PNG total pixel counts exceeding 16 million", () => {
      const oversizePixels = createPngFixture({ width: 4000, height: 4001 });
      expect(() => inspectImageHeader(oversizePixels)).toThrow(/exceed maximum limit of 16000000/);
    });

    it("rejects APNG chunks acTL, fcTL, fdAT for still-image compliance", () => {
      const apngAcTL = createPngFixture({ extraChunks: [{ type: "acTL", data: new Uint8Array(8) }] });
      expect(() => inspectImageHeader(apngAcTL)).toThrow(/APNG chunk "acTL"/);

      const apngFcTL = createPngFixture({ extraChunks: [{ type: "fcTL", data: new Uint8Array(26) }] });
      expect(() => inspectImageHeader(apngFcTL)).toThrow(/APNG chunk "fcTL"/);

      const apngFdAT = createPngFixture({ extraChunks: [{ type: "fdAT", data: new Uint8Array(8) }] });
      expect(() => inspectImageHeader(apngFdAT)).toThrow(/APNG chunk "fdAT"/);
    });

    it("requires IDAT and final IEND chunk without trailing garbage", () => {
      const missingIdat = createPngFixture({ includeIdat: false });
      expect(() => inspectImageHeader(missingIdat)).toThrow(/IDAT chunk/);

      const missingIend = createPngFixture({ includeIend: false });
      expect(() => inspectImageHeader(missingIend)).toThrow(/missing required final IEND chunk/);

      const trailingGarbage = createPngFixture({ trailingBytes: Buffer.from([0x01, 0x02, 0x03]) });
      expect(() => inspectImageHeader(trailingGarbage)).toThrow(/trailing byte/);
    });
  });

  describe("inspectImageHeader: JPEG preflight parsing", () => {
    it("parses baseline SOF0 and progressive SOF2 JPEG dimensions", () => {
      const baseline = createJpegFixture({ width: 800, height: 600, sofMarker: 0xc0 });
      expect(inspectImageHeader(baseline)).toEqual({ mime: "image/jpeg", width: 800, height: 600 });

      const progressive = createJpegFixture({ width: 1024, height: 768, sofMarker: 0xc2, multipleScans: true });
      expect(inspectImageHeader(progressive)).toEqual({ mime: "image/jpeg", width: 1024, height: 768 });
    });

    it("does not return early at first SOF without inspecting full stream to EOI", () => {
      const truncatedAfterSof = createJpegFixture({ truncateAfterSof: true });
      expect(() => inspectImageHeader(truncatedAfterSof)).toThrow(/missing required SOS|unexpected EOF/);
    });

    it("rejects duplicate SOF markers", () => {
      const duplicateSof = createJpegFixture({ duplicateSof: true });
      expect(() => inspectImageHeader(duplicateSof)).toThrow(/duplicate SOF marker/);
    });

    it("rejects unsupported SOF modes (e.g. lossless SOF3)", () => {
      const unsupportedSof = createJpegFixture({ otherSofMarker: 0xc3 });
      expect(() => inspectImageHeader(unsupportedSof)).toThrow(/SOF marker 0xC3 is not supported/);
    });

    it("rejects DNL marker (0xFFDC)", () => {
      const withDnl = createJpegFixture({ includeDnl: true });
      expect(() => inspectImageHeader(withDnl)).toThrow(/DNL .* is not permitted/);
    });

    it("rejects zero dimensions, oversize dimensions, and oversize pixels", () => {
      const zeroDim = createJpegFixture({ width: 0, height: 100 });
      expect(() => inspectImageHeader(zeroDim)).toThrow(/cannot be zero/);

      const oversizeDim = createJpegFixture({ width: 4097, height: 100 });
      expect(() => inspectImageHeader(oversizeDim)).toThrow(/exceed maximum allowed dimension/);

      const oversizePixels = createJpegFixture({ width: 4000, height: 4001 });
      expect(() => inspectImageHeader(oversizePixels)).toThrow(/exceed maximum limit/);
    });

    it("handles entropy FF00 and restart bytes RST0..RST7 in scan data", () => {
      const entropy = Buffer.from([0xaa, 0xff, 0x00, 0xbb, 0xff, 0xd0, 0xcc, 0xff, 0xd7, 0xdd]);
      const jpeg = createJpegFixture({ entropyBytes: entropy });
      expect(inspectImageHeader(jpeg)).toEqual({ mime: "image/jpeg", width: 64, height: 64 });
    });

    it("requires SOS and EOI", () => {
      const missingSos = createJpegFixture({ includeSos: false });
      expect(() => inspectImageHeader(missingSos)).toThrow(/missing required SOS/);

      const missingEoi = createJpegFixture({ includeEoi: false });
      expect(() => inspectImageHeader(missingEoi)).toThrow(/missing required EOI/);
    });
  });

  describe("readChosenImage", () => {
    it("reads exact original bytes of regular file and returns basename and header metadata", async () => {
      const originalContent = createPngFixture({ width: 120, height: 80 });
      const targetFile = path.join(tempDir, "sample.png");
      await fs.promises.writeFile(targetFile, originalContent);

      const result = await readChosenImage(targetFile);
      expect(result.fileName).toBe("sample.png");
      expect(result.mime).toBe("image/png");
      expect(result.width).toBe(120);
      expect(result.height).toBe(80);
      expect(result.content.equals(originalContent)).toBe(true);
    });

    it("refuses symlinks via O_NOFOLLOW", async () => {
      const realFile = path.join(tempDir, "real.png");
      const symlinkFile = path.join(tempDir, "symlink.png");
      await fs.promises.writeFile(realFile, createPngFixture({ width: 50, height: 50 }));
      await fs.promises.symlink(realFile, symlinkFile);

      await expect(readChosenImage(symlinkFile)).rejects.toThrow();
    });

    it("refuses URLs and invalid filenames with control characters or slashes", async () => {
      await expect(readChosenImage("file:///tmp/image.png")).rejects.toThrow(/absolute local file path/);
      await expect(readChosenImage(path.join(tempDir, "bad\nname.png"))).rejects.toThrow(/control characters/);
    });

    it("refuses files with mismatched or unsupported extensions", async () => {
      const pngData = createPngFixture({ width: 50, height: 50 });
      const mismatchedExt = path.join(tempDir, "image.jpg");
      await fs.promises.writeFile(mismatchedExt, pngData);
      await expect(readChosenImage(mismatchedExt)).rejects.toThrow(/does not match/);

      const unsupportedExt = path.join(tempDir, "image.gif");
      await fs.promises.writeFile(unsupportedExt, pngData);
      await expect(readChosenImage(unsupportedExt)).rejects.toThrow(/Unsupported file extension/);
    });

    it("refuses empty files and files exceeding 8 MiB prior to full allocation", async () => {
      const emptyFile = path.join(tempDir, "empty.png");
      await fs.promises.writeFile(emptyFile, Buffer.alloc(0));
      await expect(readChosenImage(emptyFile)).rejects.toThrow(/empty/);

      const hugeFile = path.join(tempDir, "huge.png");
      const handle = await fs.promises.open(hugeFile, "w");
      await handle.truncate(MAX_IMAGE_BYTE_LENGTH + 10);
      await handle.close();

      await expect(readChosenImage(hugeFile)).rejects.toThrow(/exceeds maximum allowed size/);
    });
  });

  describe("exportOriginalImage", () => {
    it("writes exact original bytes without modifying them", async () => {
      const targetFile = path.join(tempDir, "exported.png");
      const originalBytes = createPngFixture({ width: 150, height: 150 });

      let asserted = false;
      await exportOriginalImage(targetFile, originalBytes, () => {
        asserted = true;
      });

      expect(asserted).toBe(true);
      const exportedBytes = await fs.promises.readFile(targetFile);
      expect(exportedBytes.equals(originalBytes)).toBe(true);
    });

    it("never replaces an existing file or symlink (preserves destination, refuses overwrite)", async () => {
      const targetFile = path.join(tempDir, "existing.png");
      const initialBytes = Buffer.from("INITIAL_IMMUTABLE_FILE");
      await fs.promises.writeFile(targetFile, initialBytes);

      const newBytes = createPngFixture({ width: 100, height: 100 });
      await expect(exportOriginalImage(targetFile, newBytes, () => {})).rejects.toThrow(/EEXIST/);

      const existingContent = await fs.promises.readFile(targetFile);
      expect(existingContent.equals(initialBytes)).toBe(true);
    });

    it("never replaces an existing symlink (preserves symlink)", async () => {
      const realFile = path.join(tempDir, "real-target.png");
      const symlinkFile = path.join(tempDir, "export-link.png");
      const originalContent = Buffer.from("TARGET_CONTENT");
      await fs.promises.writeFile(realFile, originalContent);
      await fs.promises.symlink(realFile, symlinkFile);

      const newBytes = createPngFixture({ width: 100, height: 100 });
      await expect(exportOriginalImage(symlinkFile, newBytes, () => {})).rejects.toThrow(/EEXIST/);

      const targetContent = await fs.promises.readFile(realFile);
      expect(targetContent.equals(originalContent)).toBe(true);
    });

    it("leaves no final file and cleans up temporary file if assertCurrent throws", async () => {
      const targetFile = path.join(tempDir, "should-not-exist.png");
      const originalBytes = createPngFixture({ width: 100, height: 100 });

      await expect(
        exportOriginalImage(targetFile, originalBytes, () => {
          throw new Error("Stale snapshot assertion failed");
        })
      ).rejects.toThrow("Stale snapshot assertion failed");

      await expect(fs.promises.stat(targetFile)).rejects.toThrow();
      const remainingFiles = await fs.promises.readdir(tempDir);
      expect(remainingFiles).toEqual([]);
    });

    it("refuses empty or oversize content", async () => {
      const targetFile = path.join(tempDir, "invalid.png");
      await expect(exportOriginalImage(targetFile, new Uint8Array(0), () => {})).rejects.toThrow(/empty/);
      await expect(exportOriginalImage(targetFile, new Uint8Array(MAX_IMAGE_BYTE_LENGTH + 1), () => {})).rejects.toThrow(/exceeds/);
    });
  });
});
