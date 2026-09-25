import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  classifyOwnedPath,
  OWNED_DATA_STORES,
  type OwnedDataClass,
  type OwnedDataStoreId
} from "../owned-data-inventory";

export class NativeInventoryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeInventoryParseError";
  }
}

export interface NativeInventoryEntry {
  readonly kind: "file" | "directory";
  readonly rawPathHex: string;
  readonly pathHex: string;
  readonly pathBytes: Uint8Array;
  readonly relativePath: string;
  readonly pathSha256: string;
  readonly depth: number;
  readonly classification: OwnedDataClass;
  readonly storeId: OwnedDataStoreId | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly fileSha256: string | null;
}

export interface NativeInventoryCounts {
  readonly totalEntries: number;
  readonly directoryCount: number;
  readonly fileCount: number;
  readonly totalRegularFileBytes: number;
  readonly totalBytes: number;
  readonly directories: number;
  readonly files: number;
  readonly total: number;
  readonly "portable-data": number;
  readonly "machine-bound": number;
  readonly regenerable: number;
  readonly unknown: number;
  readonly byClass: Readonly<Record<OwnedDataClass, number>>;
}

export interface NativeInventoryObservation {
  readonly entries: readonly NativeInventoryEntry[];
  readonly presentStores: readonly OwnedDataStoreId[];
  readonly absentStores: readonly OwnedDataStoreId[];
  readonly storeIds: readonly OwnedDataStoreId[];
  readonly totalEntries: number;
  readonly directoryCount: number;
  readonly fileCount: number;
  readonly totalRegularFileBytes: number;
  readonly totalBytes: number;
  readonly counts: NativeInventoryCounts;
  readonly blockers: readonly string[];
  readonly rootIdentityAttested: false;
  readonly quiescenceAttested: false;
  readonly bookSnapshotCoherent: false;
  readonly portableKeysVerified: false;
  readonly readyForExport: false;
}

export interface NativeInventoryProcessResult {
  readonly exitCode?: number | null;
  readonly code?: number | null;
  readonly stdout: string;
  readonly stderr?: string;
}

const HEADER = "R24-NOFOLLOW-INVENTORY\t1";
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 32;
const MAX_PATH_BYTES = 2_048;
const MAX_TOTAL_REGULAR_FILE_BYTES = 64 * 1024 * 1024;
// Raw output bound justification and format verification:
// Native helper format: Header (25 B: "R24-NOFOLLOW-INVENTORY\t1\n") + up to MAX_ENTRIES (10,000) rows.
// Max file row: "F\t" (2) + path hex (MAX_PATH_BYTES * 2 = 4096) + "\t" (1) + decimal size (<= 20) + "\t" (1) + sha256 (64) + "\n" (1) = 4185 bytes.
// Worst-case valid output: 25 + 10,000 * 4185 = 41,850,025 bytes (~41.85 MB / 39.91 MiB).
// MAX_RAW_OUTPUT_BYTES is conservatively set to 48 MiB (50,331,648 bytes) to accommodate max valid helper output
// with headroom while refusing excessive raw output prior to line splitting and per-line allocations.
// This bound leaves the existing path, hierarchy, and total file byte checks in place.
export const MAX_RAW_OUTPUT_BYTES = 48 * 1024 * 1024;
const HEX_LOWER = /^[0-9a-f]+$/;
const SHA256_LOWER = /^[0-9a-f]{64}$/;
const DECIMAL_BYTE_COUNT = /^(?:0|[1-9][0-9]*)$/;
const CONTROL_OR_NUL = /[\x00-\x1f\x7f]/;

export function parseNativeInventoryManifest(
  input: NativeInventoryProcessResult | string,
  explicitExitCode?: number | null
): NativeInventoryObservation {
  let exitCode: number | null;
  let stdout: string;

  if (typeof input === "string") {
    stdout = input;
    exitCode = explicitExitCode !== undefined ? explicitExitCode : null;
  } else {
    stdout = input.stdout;
    if (explicitExitCode !== undefined) {
      exitCode = explicitExitCode;
    } else if (input.exitCode !== undefined) {
      exitCode = input.exitCode;
    } else if (input.code !== undefined) {
      exitCode = input.code;
    } else {
      exitCode = null;
    }
  }

  if (exitCode !== 0) {
    throw new NativeInventoryParseError(
      `Native inventory process failed with exit code ${exitCode ?? "null"}`
    );
  }

  if (stdout.length === 0) {
    throw new NativeInventoryParseError("Empty native inventory output");
  }

  if (stdout.length > MAX_RAW_OUTPUT_BYTES || Buffer.byteLength(stdout, "utf8") > MAX_RAW_OUTPUT_BYTES) {
    throw new NativeInventoryParseError(
      `Raw output size exceeds limit of ${MAX_RAW_OUTPUT_BYTES} bytes`
    );
  }

  if (stdout.includes("\r")) {
    throw new NativeInventoryParseError("CR characters are forbidden in native inventory output");
  }

  if (!stdout.endsWith("\n")) {
    throw new NativeInventoryParseError("Manifest output must terminate with a newline");
  }

  if (stdout.endsWith("\n\n")) {
    throw new NativeInventoryParseError("Trailing empty line detected in manifest output");
  }

  const lines = stdout.slice(0, -1).split("\n");
  if (lines.length === 0 || lines[0] !== HEADER) {
    throw new NativeInventoryParseError("Manifest header is missing or invalid");
  }

  const entries: NativeInventoryEntry[] = [];
  const seenPaths = new Map<string, "file" | "directory">();
  let prevPathBytes: Buffer | null = null;
  let prevRelativePath: string | null = null;
  let totalRegularFileBytes = 0;
  let dirCount = 0;
  let fileCount = 0;

  const classCounts: Record<OwnedDataClass, number> = {
    "portable-data": 0,
    "machine-bound": 0,
    regenerable: 0,
    unknown: 0
  };

  const textDecoder = new TextDecoder("utf-8", { fatal: true });

  for (let i = 1; i < lines.length; i++) {
    if (entries.length >= MAX_ENTRIES) {
      throw new NativeInventoryParseError(
        `Entry count exceeds limit of ${MAX_ENTRIES}`
      );
    }

    const line = lines[i]!;
    if (line.length === 0) {
      throw new NativeInventoryParseError(`Empty line at line index ${i}`);
    }
    if (line.endsWith(" ") || line.endsWith("\t")) {
      throw new NativeInventoryParseError(`Trailing whitespace at line index ${i}`);
    }

    const cols = line.split("\t");
    const kindChar = cols[0];

    let kind: "directory" | "file";
    if (kindChar === "D") {
      if (cols.length !== 2) {
        throw new NativeInventoryParseError(
          `Directory row must have exactly 2 columns, got ${cols.length} at line ${i + 1}`
        );
      }
      kind = "directory";
    } else if (kindChar === "F") {
      if (cols.length !== 4) {
        throw new NativeInventoryParseError(
          `File row must have exactly 4 columns, got ${cols.length} at line ${i + 1}`
        );
      }
      kind = "file";
    } else {
      throw new NativeInventoryParseError(
        `Unknown row kind "${kindChar}" at line ${i + 1}`
      );
    }

    const hexPath = cols[1]!;
    if (hexPath.length === 0 || hexPath.length % 2 !== 0 || !HEX_LOWER.test(hexPath)) {
      throw new NativeInventoryParseError(
        `Malformed hex path at line ${i + 1}: "${hexPath}"`
      );
    }

    const pathBytes = Buffer.from(hexPath, "hex");
    if (pathBytes.length === 0) {
      throw new NativeInventoryParseError(`Path bytes cannot be empty at line ${i + 1}`);
    }
    if (pathBytes.length > MAX_PATH_BYTES) {
      throw new NativeInventoryParseError(
        `Path byte length ${pathBytes.length} exceeds ${MAX_PATH_BYTES} bytes limit at line ${i + 1}`
      );
    }

    let relativePath: string;
    try {
      relativePath = textDecoder.decode(pathBytes);
    } catch {
      throw new NativeInventoryParseError(
        `Invalid UTF-8 sequence in path bytes at line ${i + 1}`
      );
    }

    if (CONTROL_OR_NUL.test(relativePath)) {
      throw new NativeInventoryParseError(
        `Path contains control characters or NUL at line ${i + 1}`
      );
    }

    if (relativePath.includes("\\")) {
      throw new NativeInventoryParseError(
        `Path contains backslash separator at line ${i + 1}`
      );
    }

    if (relativePath.startsWith("/")) {
      throw new NativeInventoryParseError(
        `Path is absolute at line ${i + 1}`
      );
    }

    const parts = relativePath.split("/");
    if (parts.length > MAX_DEPTH) {
      throw new NativeInventoryParseError(
        `Path depth ${parts.length} exceeds limit of ${MAX_DEPTH} at line ${i + 1}`
      );
    }

    for (const part of parts) {
      if (part.length === 0) {
        throw new NativeInventoryParseError(
          `Path contains empty segment or duplicate slash at line ${i + 1}`
        );
      }
      if (part === "." || part === "..") {
        throw new NativeInventoryParseError(
          `Path contains dot or traversal segment "${part}" at line ${i + 1}`
        );
      }
    }

    if (prevPathBytes !== null) {
      const cmp = Buffer.compare(prevPathBytes, pathBytes);
      if (cmp === 0) {
        throw new NativeInventoryParseError(
          `Duplicate path detected: "${relativePath}" at line ${i + 1}`
        );
      }
      if (cmp > 0) {
        throw new NativeInventoryParseError(
          `Unsorted rows: "${prevRelativePath}" sorted after "${relativePath}" at line ${i + 1}`
        );
      }
    }
    prevPathBytes = pathBytes;
    prevRelativePath = relativePath;

    if (parts.length > 1) {
      for (let k = 1; k < parts.length; k++) {
        const parent = parts.slice(0, k).join("/");
        const parentKind = seenPaths.get(parent);
        if (!parentKind) {
          throw new NativeInventoryParseError(
            `Missing parent directory "${parent}" for path "${relativePath}" at line ${i + 1}`
          );
        }
        if (parentKind !== "directory") {
          throw new NativeInventoryParseError(
            `Conflicting path: ancestor "${parent}" is a file, not a directory`
          );
        }
      }
    }

    let fileBytes: number | null = null;
    let fileSha256: string | null = null;

    if (kind === "file") {
      const rawBytes = cols[2]!;
      if (!DECIMAL_BYTE_COUNT.test(rawBytes)) {
        throw new NativeInventoryParseError(
          `Invalid decimal byte count "${rawBytes}" at line ${i + 1}`
        );
      }
      const parsedBytes = Number(rawBytes);
      if (!Number.isSafeInteger(parsedBytes) || parsedBytes < 0) {
        throw new NativeInventoryParseError(
          `Unsafe integer byte count "${rawBytes}" at line ${i + 1}`
        );
      }
      totalRegularFileBytes += parsedBytes;
      if (totalRegularFileBytes > MAX_TOTAL_REGULAR_FILE_BYTES) {
        throw new NativeInventoryParseError(
          `Total regular-file bytes ${totalRegularFileBytes} exceeds 64 MiB limit`
        );
      }
      fileBytes = parsedBytes;

      const sha = cols[3]!;
      if (!SHA256_LOWER.test(sha)) {
        throw new NativeInventoryParseError(
          `Invalid lowercase sha256 "${sha}" at line ${i + 1}`
        );
      }
      fileSha256 = sha;
      fileCount++;
    } else {
      dirCount++;
    }

    seenPaths.set(relativePath, kind);

    const { classification, storeId } = classifyOwnedPath(parts, kind);
    classCounts[classification]++;

    const pathSha256 = createHash("sha256").update(pathBytes).digest("hex");

    entries.push({
      kind,
      rawPathHex: hexPath,
      pathHex: hexPath,
      pathBytes: new Uint8Array(pathBytes),
      relativePath,
      pathSha256,
      depth: parts.length,
      classification,
      storeId,
      bytes: fileBytes,
      sha256: fileSha256,
      fileSha256
    });
  }

  const presentStoresSet = new Set<OwnedDataStoreId>();
  for (const entry of entries) {
    if (entry.storeId !== null) {
      presentStoresSet.add(entry.storeId);
    }
  }

  const presentStores = OWNED_DATA_STORES.map(s => s.id).filter(id => presentStoresSet.has(id));
  const absentStores = OWNED_DATA_STORES.map(s => s.id).filter(id => !presentStoresSet.has(id));

  const blockers: string[] = [];

  blockers.push("Root identity is not attested; caller must verify descriptor containment boundary.");
  blockers.push("Quiescence is not attested; single-pass observation cannot prove absence of concurrent mutation.");
  blockers.push("Portable keys are unverified; machine-bound key stores cannot be decrypted portably.");
  blockers.push("Parser output is an observation only and does not authorize or stage export.");

  const hasBookSqlite = entries.some(e => e.relativePath === "book.sqlite");
  const hasBookWal = entries.some(e => e.relativePath === "book.sqlite-wal");
  if (hasBookSqlite || hasBookWal) {
    blockers.push(
      "Book SQLite store and WAL sidecar observed without coherent export receipt or VACUUM INTO; logical snapshot coherence is unverified."
    );
  }

  const machineBoundEntries = entries.filter(e => e.classification === "machine-bound");
  if (machineBoundEntries.length > 0) {
    blockers.push(
      `Machine-bound entries present (${machineBoundEntries.length}): ${machineBoundEntries.map(e => e.relativePath).join(", ")}`
    );
  }

  const unknownEntries = entries.filter(e => e.classification === "unknown");
  if (unknownEntries.length > 0) {
    blockers.push(
      `Unknown entries present (${unknownEntries.length}) require owner review: ${unknownEntries.map(e => e.relativePath).join(", ")}`
    );
  }

  const counts: NativeInventoryCounts = {
    totalEntries: entries.length,
    directoryCount: dirCount,
    fileCount,
    totalRegularFileBytes,
    totalBytes: totalRegularFileBytes,
    directories: dirCount,
    files: fileCount,
    total: entries.length,
    "portable-data": classCounts["portable-data"],
    "machine-bound": classCounts["machine-bound"],
    regenerable: classCounts.regenerable,
    unknown: classCounts.unknown,
    byClass: { ...classCounts }
  };

  return {
    entries,
    presentStores,
    absentStores,
    storeIds: presentStores,
    totalEntries: entries.length,
    directoryCount: dirCount,
    fileCount,
    totalRegularFileBytes,
    totalBytes: totalRegularFileBytes,
    counts,
    blockers,
    rootIdentityAttested: false,
    quiescenceAttested: false,
    bookSnapshotCoherent: false,
    portableKeysVerified: false,
    readyForExport: false
  };
}
