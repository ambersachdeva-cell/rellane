/** Bound chosen images before native decoding, and publish original bytes without replacing existing files. */
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import { MAX_IMAGE_BYTE_LENGTH, MAX_IMAGE_PIXELS, MAX_IMAGE_DIMENSION } from "@cadrane/contracts";
export { MAX_IMAGE_BYTE_LENGTH, MAX_IMAGE_PIXELS, MAX_IMAGE_DIMENSION };

/** Prohibits ASCII control characters (0-31, 127) as well as slashes and backslashes. */
const CONTROL_OR_SLASH_REGEX = /[\u0000-\u001f\u007f/\\]/;

export type WorkstationImageMime = "image/png" | "image/jpeg";

export interface ImageHeaderInfo {
  mime: WorkstationImageMime;
  width: number;
  height: number;
}

export interface ReadChosenImageResult {
  fileName: string;
  content: Buffer;
  mime: WorkstationImageMime;
  width: number;
  height: number;
}

function isPngSignature(content: Uint8Array): boolean {
  if (content.byteLength < 8) return false;
  return (
    content[0]! === 0x89 &&
    content[1]! === 0x50 &&
    content[2]! === 0x4e &&
    content[3]! === 0x47 &&
    content[4]! === 0x0d &&
    content[5]! === 0x0a &&
    content[6]! === 0x1a &&
    content[7]! === 0x0a
  );
}

function isJpegSignature(content: Uint8Array): boolean {
  if (content.byteLength < 2) return false;
  return content[0]! === 0xff && content[1]! === 0xd8;
}

function parsePngHeader(content: Uint8Array): ImageHeaderInfo {
  if (content.byteLength < 33) {
    throw new Error("Truncated PNG: file is too small for signature and IHDR chunk");
  }

  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);

  // First chunk must be IHDR with exact 13-byte data header
  const ihdrLength = view.getUint32(8);
  if (ihdrLength !== 13) {
    throw new Error(`Malformed PNG: IHDR chunk length must be exactly 13 bytes, found ${ihdrLength}`);
  }

  const ihdrType = String.fromCharCode(content[12]!, content[13]!, content[14]!, content[15]!);
  if (ihdrType !== "IHDR") {
    throw new Error(`Malformed PNG: first chunk must be IHDR, found "${ihdrType}"`);
  }

  const width = view.getUint32(16);
  const height = view.getUint32(20);

  if (width < 1 || width > MAX_IMAGE_DIMENSION) {
    throw new Error(`PNG width ${width} is outside permitted range (1..${MAX_IMAGE_DIMENSION})`);
  }
  if (height < 1 || height > MAX_IMAGE_DIMENSION) {
    throw new Error(`PNG height ${height} is outside permitted range (1..${MAX_IMAGE_DIMENSION})`);
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`PNG total pixels (${width * height}) exceed maximum limit of ${MAX_IMAGE_PIXELS}`);
  }

  let offset = 33; // 8 (sig) + 4 (len) + 4 (type) + 13 (data) + 4 (crc)
  let sawIdat = false;
  let sawIend = false;

  while (offset < content.byteLength) {
    if (offset + 8 > content.byteLength) {
      throw new Error("Truncated PNG: insufficient bytes for chunk header");
    }

    const chunkLength = view.getUint32(offset);
    const chunkType = String.fromCharCode(
      content[offset + 4]!,
      content[offset + 5]!,
      content[offset + 6]!,
      content[offset + 7]!
    );

    const totalChunkLength = chunkLength + 12;
    if (chunkLength > 0x7fffffff || offset + totalChunkLength > content.byteLength) {
      throw new Error(`Truncated PNG: chunk "${chunkType}" declared length ${chunkLength} exceeds available bytes`);
    }

    if (chunkType === "IHDR") throw new Error("Malformed PNG: duplicate IHDR dimensions are not permitted.");

    // Reject APNG chunks: animated PNGs not permitted, still images only
    if (chunkType === "acTL" || chunkType === "fcTL" || chunkType === "fdAT") {
      throw new Error(`Unsupported APNG chunk "${chunkType}": animated PNGs are rejected, only still images are permitted`);
    }

    if (chunkType === "IDAT") {
      sawIdat = true;
    }

    if (chunkType === "IEND") {
      if (!sawIdat) {
        throw new Error("Malformed PNG: IEND chunk encountered before any IDAT chunk");
      }
      if (chunkLength !== 0) {
        throw new Error(`Malformed PNG: IEND chunk length must be 0, found ${chunkLength}`);
      }
      sawIend = true;
      offset += totalChunkLength;
      if (offset !== content.byteLength) {
        throw new Error(`Malformed PNG: unexpected ${content.byteLength - offset} trailing byte(s) after final IEND chunk`);
      }
      break;
    }

    offset += totalChunkLength;
  }

  if (!sawIend) {
    throw new Error("Malformed PNG: missing required final IEND chunk");
  }
  if (!sawIdat) {
    throw new Error("Malformed PNG: missing required IDAT chunk");
  }

  return { mime: "image/png", width, height };
}

function parseJpegHeader(content: Uint8Array): ImageHeaderInfo {
  if (content.byteLength < 4) {
    throw new Error("Truncated JPEG: file is too small");
  }

  let offset = 2; // Past SOI (0xFF, 0xD8)
  let width = 0;
  let height = 0;
  let sawSof = false;
  let sawSos = false;
  let sawEoi = false;

  while (offset < content.byteLength) {
    if (content[offset]! !== 0xff) {
      throw new Error(`Malformed JPEG: expected marker prefix 0xFF at offset ${offset}, found 0x${content[offset]!.toString(16).padStart(2, "0")}`);
    }

    while (offset < content.byteLength && content[offset]! === 0xff) {
      offset++;
    }

    if (offset >= content.byteLength) {
      throw new Error("Truncated JPEG: unexpected EOF after 0xFF marker prefix");
    }

    const marker = content[offset++]!;

    // EOI (0xD9) - End of Image
    if (marker === 0xd9) {
      if (offset !== content.byteLength) throw new Error("Malformed JPEG: trailing bytes after EOI are not permitted.");
      sawEoi = true;
      break;
    }

    // Standalone markers without payload/length: RST0..RST7 (0xD0..0xD7), TEM (0x01)
    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }
    if (marker === 0x01) {
      continue;
    }
    if (marker === 0x00) {
      throw new Error("Malformed JPEG: unexpected 0xFF00 byte sequence outside entropy data");
    }
    if (marker === 0xd8) {
      throw new Error("Malformed JPEG: unexpected duplicate SOI marker");
    }

    // Markers with length: read 2-byte big-endian length
    if (offset + 2 > content.byteLength) {
      throw new Error(`Truncated JPEG: unexpected EOF reading length for marker 0x${marker.toString(16).toUpperCase().padStart(2, "0")}`);
    }

    const segmentLength = (content[offset]! << 8) | content[offset + 1]!;
    if (segmentLength < 2) {
      throw new Error(`Malformed JPEG: invalid segment length ${segmentLength} for marker 0x${marker.toString(16).toUpperCase().padStart(2, "0")}`);
    }

    if (offset + segmentLength > content.byteLength) {
      throw new Error(`Truncated JPEG: segment 0x${marker.toString(16).toUpperCase().padStart(2, "0")} requires ${segmentLength} bytes, but only ${content.byteLength - offset} available`);
    }

    // Reject DNL (0xDC - Define Number of Lines): dynamic height definitions prohibited
    if (marker === 0xdc) {
      throw new Error("Unsupported JPEG feature: DNL (Define Number of Lines) marker 0xFFDC is not permitted");
    }

    // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2)
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (sawSof) {
        throw new Error("Malformed JPEG: duplicate SOF marker encountered; only one SOF frame is permitted");
      }
      if (segmentLength < 8) {
        throw new Error(`Malformed JPEG: SOF segment length ${segmentLength} is too short`);
      }

      const sofHeight = (content[offset + 3]! << 8) | content[offset + 4]!;
      const sofWidth = (content[offset + 5]! << 8) | content[offset + 6]!;

      if (sofWidth === 0 || sofHeight === 0) {
        throw new Error(`Malformed JPEG: image dimension cannot be zero (${sofWidth}x${sofHeight})`);
      }
      if (sofWidth > MAX_IMAGE_DIMENSION || sofHeight > MAX_IMAGE_DIMENSION) {
        throw new Error(`JPEG dimensions ${sofWidth}x${sofHeight} exceed maximum allowed dimension of ${MAX_IMAGE_DIMENSION}`);
      }
      if (sofWidth * sofHeight > MAX_IMAGE_PIXELS) {
        throw new Error(`JPEG total pixels (${sofWidth * sofHeight}) exceed maximum limit of ${MAX_IMAGE_PIXELS}`);
      }

      width = sofWidth;
      height = sofHeight;
      sawSof = true;
      offset += segmentLength;
      continue;
    }

    // Reject other SOF modes (lossless, differential, arithmetic)
    const isOtherSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isOtherSof) {
      throw new Error(`Unsupported JPEG mode: SOF marker 0x${marker.toString(16).toUpperCase().padStart(2, "0")} is not supported; only baseline (SOF0), extended sequential (SOF1), and progressive (SOF2) are permitted`);
    }

    // SOS (0xDA - Start of Scan)
    if (marker === 0xda) {
      if (!sawSof) {
        throw new Error("Malformed JPEG: SOS marker encountered before SOF frame header");
      }
      sawSos = true;
      offset += segmentLength;

      // Entropy scan parsing: handle 0xFF00 byte stuffing, restart markers, and progressive multiple SOS scans
      while (offset < content.byteLength) {
        if (content[offset]! === 0xff) {
          while (offset < content.byteLength && content[offset]! === 0xff) {
            offset++;
          }
          if (offset >= content.byteLength) {
            throw new Error("Truncated JPEG: unexpected EOF in scan entropy data following 0xFF");
          }
          const b = content[offset]!;
          if (b === 0x00) {
            // Byte stuffing: literal 0xFF in entropy stream
            offset++;
          } else if (b >= 0xd0 && b <= 0xd7) {
            // Restart marker RST0..RST7
            offset++;
          } else {
            // Next marker reached: back up so outer loop reads the 0xFF before marker byte
            offset--;
            break;
          }
        } else {
          offset++;
        }
      }
      continue;
    }

    // Advance past any other segment with length (APPn, DQT, DHT, DRI, COM, etc.)
    offset += segmentLength;
  }

  if (!sawSof) {
    throw new Error("Malformed JPEG: missing required SOF (Start of Frame) marker");
  }
  if (!sawSos) {
    throw new Error("Malformed JPEG: missing required SOS (Start of Scan) marker");
  }
  if (!sawEoi) {
    throw new Error("Malformed JPEG: missing required EOI (End of Image) marker or truncated file");
  }

  return { mime: "image/jpeg", width, height };
}

export function inspectImageHeader(content: Uint8Array): ImageHeaderInfo {
  if (!content || content.byteLength === 0) {
    throw new Error("Image content is empty");
  }
  if (content.byteLength > MAX_IMAGE_BYTE_LENGTH) {
    throw new Error(`Image content exceeds maximum allowed size of ${MAX_IMAGE_BYTE_LENGTH} bytes (8 MiB)`);
  }

  if (isPngSignature(content)) {
    return parsePngHeader(content);
  }

  if (isJpegSignature(content)) {
    return parseJpegHeader(content);
  }

  throw new Error("Unsupported or unrecognized image format: expected PNG or JPEG signature");
}

export async function readChosenImage(filePath: string): Promise<ReadChosenImageResult> {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("Choose an absolute local file path");
  }

  // URLs are strictly prohibited
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath)) {
    throw new Error("URLs are not supported; local filesystem path required");
  }

  const fileName = path.basename(filePath);

  if (fileName.length === 0 || fileName.length > 255) {
    throw new Error("Filename must be between 1 and 255 characters");
  }
  if (CONTROL_OR_SLASH_REGEX.test(fileName)) {
    throw new Error("Filename must not contain slashes, backslashes, or control characters");
  }

  const extMatch = fileName.match(/\.([a-zA-Z0-9]+)$/);
  if (!extMatch) {
    throw new Error(`Filename "${fileName}" missing required extension (.png, .jpg, or .jpeg)`);
  }
  const ext = extMatch[1]!.toLowerCase();
  if (ext !== "png" && ext !== "jpg" && ext !== "jpeg") {
    throw new Error(`Unsupported file extension ".${ext}". Only .png, .jpg, and .jpeg are allowed.`);
  }

  let handle: fs.promises.FileHandle | null = null;
  try {
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    handle = await fs.promises.open(filePath, flags);

    const beforeStat = await handle.stat();
    if (!beforeStat.isFile()) {
      throw new Error("Target is not a regular file");
    }

    if (beforeStat.size <= 0) {
      throw new Error("Image file is empty");
    }
    if (beforeStat.size > MAX_IMAGE_BYTE_LENGTH) {
      throw new Error(`Image file exceeds maximum allowed size of ${MAX_IMAGE_BYTE_LENGTH} bytes (8 MiB)`);
    }

    // Bounded allocation: at most prior size + 1 bytes (never allocate > 8 MiB + 1)
    const allocSize = beforeStat.size + 1;
    const buffer = Buffer.alloc(allocSize);
    let bytesRead = 0;
    while (bytesRead < allocSize) {
      const part = await handle.read(buffer, bytesRead, allocSize - bytesRead, bytesRead);
      if (part.bytesRead === 0) break;
      bytesRead += part.bytesRead;
    }

    if (bytesRead !== beforeStat.size) {
      throw new Error(`File size changed during read: expected ${beforeStat.size} bytes, read ${bytesRead} bytes`);
    }

    const afterStat = await handle.stat();
    if (
      afterStat.size !== beforeStat.size ||
      afterStat.mtimeMs !== beforeStat.mtimeMs ||
      afterStat.ctimeMs !== beforeStat.ctimeMs ||
      afterStat.dev !== beforeStat.dev ||
      afterStat.ino !== beforeStat.ino
    ) {
      throw new Error("File metadata changed concurrently during read");
    }

    const content = buffer.subarray(0, bytesRead);

    // Preflight inspect header after reading
    const header = inspectImageHeader(content);

    if (header.mime === "image/png" && ext !== "png") {
      throw new Error(`Filename extension ".${ext}" does not match detected MIME type "${header.mime}"`);
    }
    if (header.mime === "image/jpeg" && ext !== "jpg" && ext !== "jpeg") {
      throw new Error(`Filename extension ".${ext}" does not match detected MIME type "${header.mime}"`);
    }

    return {
      fileName,
      content,
      mime: header.mime,
      width: header.width,
      height: header.height
    };
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

export async function exportOriginalImage(
  filePath: string,
  content: Uint8Array,
  assertCurrent: () => void
): Promise<void> {
  if (!content || content.byteLength === 0) {
    throw new Error("Export content is empty");
  }
  if (content.byteLength > MAX_IMAGE_BYTE_LENGTH) {
    throw new Error(`Export content exceeds maximum allowed size of ${MAX_IMAGE_BYTE_LENGTH} bytes (8 MiB)`);
  }
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("Choose an absolute local file path");
  }

  const dir = path.dirname(filePath);
  const tempName = `.tmp_export_${randomBytes(16).toString("hex")}`;
  const tempPath = path.join(dir, tempName);

  let tempCreated = false;
  let handle: fs.promises.FileHandle | null = null;

  try {
    handle = await fs.promises.open(
      tempPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600
    );
    tempCreated = true;

    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;

    // Pre-publish assertion: must not link if state is stale
    assertCurrent();

    // Atomic hard link to destination: fails with EEXIST if target already exists or is a symlink
    await fs.promises.link(tempPath, filePath);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore close failure during cleanup
      }
    }
    if (tempCreated) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // ignore unlink failure
      }
    }
  }
}
