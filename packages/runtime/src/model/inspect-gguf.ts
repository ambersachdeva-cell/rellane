import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import {
  GgufInspectionSchema,
  type GgufInspection
} from "@cadrane/contracts";
import { RuntimeBoundaryError } from "../errors.js";

export const GGUF_HEADER_BYTES = 24;
export const MAX_GGUF_MODEL_BYTES = 64n * 1024n * 1024n * 1024n;
const MAX_TENSORS = 100_000_000n;
const MAX_METADATA_ITEMS = 10_000_000n;

export interface ParsedGgufV3Header {
  readonly version: 3;
  readonly tensorCount: bigint;
  readonly metadataCount: bigint;
}

export interface InspectedGguf {
  inspection: GgufInspection;
  trustedPath: string;
}

export async function inspectGguf(
  selectedPath: string,
  signal?: AbortSignal
): Promise<InspectedGguf> {
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await open(selectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size < BigInt(GGUF_HEADER_BYTES) ||
      before.size > MAX_GGUF_MODEL_BYTES
    ) {
      throw unsupported("The selected item is not a supported regular GGUF file.");
    }

    const header = Buffer.alloc(GGUF_HEADER_BYTES);
    const readResult = await handle.read(header, 0, GGUF_HEADER_BYTES, 0);
    if (readResult.bytesRead !== GGUF_HEADER_BYTES) {
      throw unsupported("The selected file does not contain a complete GGUF header.");
    }
    const parsedHeader = parseBoundedGgufV3Header(header, before.size);

    const hash = createHash("sha256");
    signal?.throwIfAborted();
    const stream = handle.createReadStream({
      autoClose: false,
      start: 0,
      signal
    });
    for await (const chunk of stream) {
      hash.update(chunk);
    }

    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new RuntimeBoundaryError({
        code: "FILE_UNSUPPORTED",
        message: "The model file changed during inspection. Try again after the copy finishes.",
        retryable: true
      });
    }

    return {
      trustedPath: selectedPath,
      inspection: GgufInspectionSchema.parse({
        importId: randomUUID(),
        displayName: basename(selectedPath),
        sizeBytes: Number(before.size),
        sha256: hash.digest("hex"),
        version: parsedHeader.version,
        tensorCount: parsedHeader.tensorCount.toString(),
        metadataCount: parsedHeader.metadataCount.toString(),
        status: "header-verified",
        warning: "Header and digest verified. Full model compatibility is tested only by a supported local runtime."
      })
    };
  } catch (error) {
    if (error instanceof RuntimeBoundaryError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new RuntimeBoundaryError({
        code: "CANCELLED",
        message: "The GGUF inspection was cancelled.",
        retryable: true
      }, { cause: error });
    }
    throw new RuntimeBoundaryError({
      code: "FILE_UNSUPPORTED",
      message: "The model could not be opened safely. Select a local, readable GGUF file.",
      retryable: true
    }, { cause: error });
  } finally {
    await handle?.close();
  }
}

export function parseBoundedGgufV3Header(
  header: Uint8Array,
  totalBytes: bigint
): ParsedGgufV3Header {
  if (
    totalBytes < BigInt(GGUF_HEADER_BYTES) ||
    totalBytes > MAX_GGUF_MODEL_BYTES ||
    header.byteLength !== GGUF_HEADER_BYTES
  ) {
    throw unsupported("The selected item is not a supported regular GGUF file.");
  }
  const buffer = Buffer.from(header.buffer, header.byteOffset, header.byteLength);
  if (buffer.subarray(0, 4).toString("ascii") !== "GGUF") {
    throw unsupported("The selected file does not contain a GGUF header.");
  }
  const version = buffer.readUInt32LE(4);
  if (version !== 3) {
    throw unsupported(`This slice supports GGUF v3; the file reports v${version}.`);
  }
  const tensorCount = buffer.readBigUInt64LE(8);
  const metadataCount = buffer.readBigUInt64LE(16);
  if (
    tensorCount === 0n ||
    tensorCount > MAX_TENSORS ||
    metadataCount === 0n ||
    metadataCount > MAX_METADATA_ITEMS
  ) {
    throw unsupported("The GGUF header contains implausible tensor or metadata counts.");
  }
  return {
    version: 3,
    tensorCount,
    metadataCount
  };
}

function unsupported(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "FILE_UNSUPPORTED",
    message,
    retryable: false
  });
}
