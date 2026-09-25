/**
 * Whole-data recovery needs to know which app-owned paths exist before any
 * export is designed. This scanner reads names and metadata only: it does not
 * open file contents, unwrap keys, repair stores, or authorize an import.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type OwnedDataClass = "portable-data" | "machine-bound" | "regenerable" | "unknown";
export type OwnedDataEntryKind = "file" | "directory" | "symbolic-link" | "other";

/** Static source map; every store is optional on a legitimately fresh root. */
export const OWNED_DATA_STORES = [
  { id: "book", example: "book.sqlite", source: "main/book/open.ts", class: "portable-data" },
  { id: "backup-key", example: "backup.key", source: "main/book/open.ts", class: "machine-bound" },
  { id: "settings-grants", example: "settings.json", source: "main/foundations/settings.ts", class: "portable-data" },
  { id: "action-ledger", example: "ledger.jsonl", source: "main/security/ledger.ts", class: "machine-bound" },
  { id: "secret-store", example: "secrets.bin", source: "main/security/secrets.ts", class: "machine-bound" },
  { id: "telegram-token", example: "telegram-token.enc", source: "main/dispatch/telegram-token.ts", class: "machine-bound" },
  { id: "whatsapp-config", example: "whatsapp-config.enc", source: "main/dispatch/whatsapp-config.ts", class: "machine-bound" },
  { id: "automation-key", example: "cadrane-secure/automation-workspace-key-v1.json", source: "main/workspace-key-broker.ts", class: "machine-bound" },
  { id: "automation-workspace", example: "automations/workspace-v1.json.encrypted", source: "daemon/automation-runtime.ts", class: "machine-bound" },
  { id: "vault", example: "Vault", source: "main/vault/where.ts", class: "portable-data" },
  { id: "skills", example: "skills", source: "main/ipc.ts", class: "portable-data" },
  { id: "timeline", example: "timeline", source: "main/timeline/manifest-store.ts", class: "portable-data" },
  { id: "preimages", example: "workstation/changes", source: "main/workstation/ipc.ts", class: "portable-data" },
  { id: "agents", example: "workstation/agents", source: "main/workstation/agent-store-ipc.ts", class: "portable-data" },
  { id: "memory", example: "workstation/memory", source: "main/workstation/project-memory-ipc.ts", class: "portable-data" },
  { id: "watches", example: "workstation/watches", source: "main/workstation/watch-store.ts", class: "portable-data" },
  { id: "private-workspaces", example: "workstation/workspaces", source: "main/workstation/ipc.ts", class: "portable-data" },
  { id: "renderer-drafts", example: "Local Storage", source: "renderer/workstation/WorkstationApp.tsx", class: "portable-data" },
  { id: "crash-reports", example: "crashes", source: "main/foundations/crash.ts", class: "portable-data" },
  { id: "speech-output", example: "speech/output.wav", source: "main/workstation/speech.ts", class: "regenerable" },
  { id: "browser-cache", example: "Cache", source: "Electron userData", class: "regenerable" },
  { id: "managed-models", example: "local-intelligence/managed-models", source: "daemon/service.ts", class: "unknown" },
  { id: "browser-credentials", example: "Cookies", source: "Electron userData", class: "machine-bound" }
] as const;

export type OwnedDataStoreId = typeof OWNED_DATA_STORES[number]["id"];

export interface OwnedDataInventoryEntry {
  /** Stable within this inventory; no owner filename is exposed in the report. */
  readonly pathSha256: string;
  readonly depth: number;
  readonly kind: OwnedDataEntryKind;
  readonly classification: OwnedDataClass;
  readonly storeId: OwnedDataStoreId | null;
  readonly bytes: number | null;
}

export interface OwnedDataInventoryReport {
  readonly status: "classified" | "unknown" | "unavailable";
  readonly entries: readonly OwnedDataInventoryEntry[];
  readonly presentStores: readonly OwnedDataStoreId[];
  /** Absence is ordinary for optional stores; this is not a corruption verdict. */
  readonly absentStores: readonly OwnedDataStoreId[];
  readonly counts: Readonly<Record<OwnedDataClass, number>>;
  readonly externalBoundaries: readonly string[];
  readonly contentVerified: false;
  /** Path-based directory traversal is advisory and cannot certify a mutable root. */
  readonly directoryTraversalVerified: false;
  readonly readyForExport: false;
  readonly issues: readonly string[];
}

const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 48;
const MAX_RELATIVE_CHARS = 2_048;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const AGENT_MD = /^[A-Za-z0-9_-]{1,80}\.md$/;
const MEMORY_JSON = /^[A-Za-z0-9-]{1,64}\.json$/;
const CAPTURE = /^\d+\.mfst\.gz$/;
const CRASH = /^crash-[A-Za-z0-9-]+\.txt$/;
const CHANGE_RUN = /^[A-Za-z0-9_-]{1,80}__[A-Za-z0-9_-]{1,80}$/;
const EXTERNAL_BOUNDARIES = [
  "Granted folders outside the app data root require separate inventory and host re-granting.",
  "Backup archives outside the app data root are not included.",
  "Keychain and provider-native sessions are not represented by copied file bytes.",
  "Book WAL sidecars require a coherent export receipt; the shared-memory index is regenerable.",
  "Saved artifacts and source records live in Book; workspace files and Vault files are separate; Electron Local Storage can hold unsaved drafts and other origin state."
] as const;

export type OwnedPathDecision = {
  readonly classification: OwnedDataClass;
  readonly storeId: OwnedDataStoreId | null;
};

type Decision = OwnedPathDecision;
const UNKNOWN: Decision = { classification: "unknown", storeId: null };

function decision(classification: OwnedDataClass, storeId: OwnedDataStoreId | null): Decision {
  return { classification, storeId };
}

export function classifyOwnedPath(
  parts: readonly string[],
  kind: OwnedDataEntryKind
): OwnedPathDecision {
  return classify(parts, kind);
}

function classify(parts: readonly string[], kind: OwnedDataEntryKind): Decision {
  if (kind === "symbolic-link" || kind === "other") return UNKNOWN;
  if (parts.some(part => part.startsWith("."))) return UNKNOWN;
  const [top, second, third, fourth] = parts;
  if (!top) return UNKNOWN;

  const rootFiles: Partial<Record<string, Decision>> = {
    "book.sqlite": decision("portable-data", "book"),
    "book.sqlite-wal": decision("portable-data", "book"),
    "book.sqlite-shm": decision("regenerable", "book"),
    "backup.key": decision("machine-bound", "backup-key"),
    "settings.json": decision("portable-data", "settings-grants"),
    "ledger.jsonl": decision("machine-bound", "action-ledger"),
    "secrets.bin": decision("machine-bound", "secret-store"),
    "telegram-token.enc": decision("machine-bound", "telegram-token"),
    "whatsapp-config.enc": decision("machine-bound", "whatsapp-config"),
    "Cookies": decision("machine-bound", "browser-credentials"),
    "Local State": decision("machine-bound", "browser-credentials")
  };
  if (parts.length === 1 && kind === "file") return rootFiles[top] ?? UNKNOWN;

  if (top === "Vault" || top === "skills" || top === "Local Storage") {
    if (parts.length === 1 && kind !== "directory") return UNKNOWN;
    const storeId = top === "Vault" ? "vault" : top === "skills" ? "skills" : "renderer-drafts";
    return decision("portable-data", storeId);
  }
  if (["Cache", "Code Cache", "GPUCache", "DawnCache", "ShaderCache"].includes(top)) {
    if (parts.length === 1 && kind !== "directory") return UNKNOWN;
    return decision("regenerable", "browser-cache");
  }
  if (top === "cadrane-secure") {
    if (parts.length === 1 && kind === "directory") return decision("machine-bound", null);
    return parts.length === 2 && second === "automation-workspace-key-v1.json" && kind === "file"
      ? decision("machine-bound", "automation-key") : UNKNOWN;
  }
  if (top === "automations") {
    if (parts.length === 1 && kind === "directory") return decision("machine-bound", null);
    if (parts.length === 2 && kind === "file" && second === "workspace-v1.json.encrypted")
      return decision("machine-bound", "automation-workspace");
    if (parts.length === 2 && kind === "file" && second === "workspace-v1.json")
      return decision("portable-data", "automation-workspace");
    return UNKNOWN;
  }
  if (top === "timeline") {
    if (parts.length === 1 && kind === "directory") return decision("portable-data", "timeline");
    if (!second || !HEX32.test(second)) return UNKNOWN;
    if (parts.length === 2 && kind === "directory") return decision("portable-data", "timeline");
    if (parts.length === 3 && kind === "file" && third === "index.json")
      return decision("regenerable", "timeline");
    if (parts.length === 3 && kind === "file" && third && CAPTURE.test(third))
      return decision("portable-data", "timeline");
    return UNKNOWN;
  }
  if (top === "workstation") {
    if (parts.length === 1 && kind === "directory") return decision("portable-data", null);
    if (!second) return UNKNOWN;
    if (second === "changes") {
      if (parts.length === 2 && kind === "directory") return decision("portable-data", "preimages");
      if (!third || !CHANGE_RUN.test(third)) return UNKNOWN;
      if (parts.length === 3 && kind === "directory") return decision("portable-data", "preimages");
      if (parts.length === 4 && kind === "file" && fourth === "snapshot.json")
        return decision("portable-data", "preimages");
      if (parts.length === 4 && kind === "directory" && fourth === "files")
        return decision("portable-data", "preimages");
      if (parts.length === 5 && kind === "file" && fourth === "files" && parts[4] && HEX64.test(parts[4]))
        return decision("portable-data", "preimages");
      return UNKNOWN;
    }
    if (second === "workspaces" && (parts.length > 2 || kind === "directory"))
      return decision("portable-data", "private-workspaces");
    if (second === "agents") {
      if (parts.length === 2 && kind === "directory") return decision("portable-data", "agents");
      return parts.length === 3 && kind === "file" && third && AGENT_MD.test(third)
        ? decision("portable-data", "agents") : UNKNOWN;
    }
    if (second === "memory") {
      if (parts.length === 2 && kind === "directory") return decision("portable-data", "memory");
      return parts.length === 3 && kind === "file" && third && MEMORY_JSON.test(third)
        ? decision("portable-data", "memory") : UNKNOWN;
    }
    if (second === "watches") {
      if (parts.length === 2 && kind === "directory") return decision("portable-data", "watches");
      if (parts.length === 3 && kind === "file" && third === "watches.json")
        return decision("portable-data", "watches");
      if (parts.length === 3 && kind === "directory" && third === "seen")
        return decision("portable-data", "watches");
      if (parts.length === 4 && kind === "file" && third === "seen" &&
          fourth && HEX64.test(fourth.slice(0, -4)) && fourth.endsWith(".txt"))
        return decision("portable-data", "watches");
      return UNKNOWN;
    }
    return UNKNOWN;
  }
  if (top === "crashes") {
    if (parts.length === 1 && kind === "directory") return decision("portable-data", "crash-reports");
    return parts.length === 2 && kind === "file" && second && CRASH.test(second)
      ? decision("portable-data", "crash-reports") : UNKNOWN;
  }
  if (top === "speech") {
    if (parts.length === 1 && kind === "directory") return decision("regenerable", "speech-output");
    return parts.length === 2 && kind === "file" &&
      (second === "output.wav" || Boolean(second?.startsWith("speech-input-") && second.endsWith(".txt")))
      ? decision("regenerable", "speech-output") : UNKNOWN;
  }
  if (top === "local-intelligence" &&
      ((parts.length === 1 && kind === "directory") || second === "managed-models"))
    return decision("unknown", "managed-models");
  return UNKNOWN;
}

function freshReport(status: OwnedDataInventoryReport["status"], issues: readonly string[]): OwnedDataInventoryReport {
  return {
    status,
    entries: [],
    presentStores: [],
    absentStores: OWNED_DATA_STORES.map(store => store.id),
    counts: { "portable-data": 0, "machine-bound": 0, regenerable: 0, unknown: 0 },
    externalBoundaries: EXTERNAL_BOUNDARIES,
    contentVerified: false,
    directoryTraversalVerified: false,
    readyForExport: false,
    issues
  };
}

function safeName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." &&
    !name.includes("/") && !name.includes("\0");
}

/** Read only directory entries and lstat metadata from an offline copied root. */
export async function inventoryOwnedDataRoot(rootPath: string): Promise<OwnedDataInventoryReport> {
  const spelledRoot = path.resolve(rootPath);
  let root: string;
  try {
    const stat = await fs.lstat(spelledRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return freshReport("unavailable", ["Copied data root is not a regular directory."]);
    root = await fs.realpath(spelledRoot);
  } catch {
    return freshReport("unavailable", ["Copied data root is missing or inaccessible."]);
  }

  const entries: OwnedDataInventoryEntry[] = [];
  const present = new Set<OwnedDataStoreId>();
  const counts: Record<OwnedDataClass, number> = {
    "portable-data": 0, "machine-bound": 0, regenerable: 0, unknown: 0
  };
  const pending = [""];
  try {
    while (pending.length > 0) {
      const relativeDirectory = pending.pop()!;
      const dirPath = path.join(root, relativeDirectory);
      const before = await fs.lstat(dirPath, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink() || await fs.realpath(dirPath) !== dirPath)
        throw new Error("copied directory changed");
      const handle = await fs.opendir(dirPath);
      for await (const dirent of handle) {
        if (entries.length >= MAX_ENTRIES) throw new Error("entry limit");
        const relativePath = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
        const depth = relativePath.split("/").length;
        if (!safeName(dirent.name) || depth > MAX_DEPTH || relativePath.length > MAX_RELATIVE_CHARS)
          throw new Error("unsafe or unbounded entry name");
        const stat = await fs.lstat(path.join(root, relativePath));
        const kind: OwnedDataEntryKind = stat.isSymbolicLink() ? "symbolic-link" :
          stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
        const hardLinked = kind === "file" && stat.nlink > 1;
        const { classification, storeId } = hardLinked
          ? UNKNOWN : classify(relativePath.split("/"), kind);
        entries.push({
          pathSha256: createHash("sha256").update(relativePath).digest("hex"),
          depth,
          kind,
          classification,
          storeId,
          bytes: kind === "file" ? stat.size : null
        });
        counts[classification] += 1;
        if (storeId !== null) present.add(storeId);
        if (kind === "directory") pending.push(relativePath);
      }
      const after = await fs.lstat(dirPath, { bigint: true });
      if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev ||
          before.ino !== after.ino || before.mtimeNs !== after.mtimeNs ||
          await fs.realpath(dirPath) !== dirPath) throw new Error("copied directory changed");
    }
    if (await fs.realpath(spelledRoot) !== root)
      throw new Error("copied root alias changed");
  } catch {
    return freshReport("unavailable", ["Copied data root changed, exceeded bounds, or could not be fully listed."]);
  }

  entries.sort((a, b) => a.pathSha256.localeCompare(b.pathSha256));
  const presentStores = OWNED_DATA_STORES.map(store => store.id).filter(id => present.has(id));
  const absentStores = OWNED_DATA_STORES.map(store => store.id).filter(id => !present.has(id));
  const issues: string[] = [];
  if (counts.unknown > 0) issues.push("Unknown, hidden, or hard-linked entries require explicit owner review before any export plan.");
  issues.push("Path-based directory traversal and metadata cannot prove source containment under concurrent mutation, file contents, SQLite/WAL consistency, key portability, or source quiescence.");
  return {
    status: counts.unknown > 0 ? "unknown" : "classified",
    entries,
    presentStores,
    absentStores,
    counts,
    externalBoundaries: EXTERNAL_BOUNDARIES,
    contentVerified: false,
    directoryTraversalVerified: false,
    readyForExport: false,
    issues
  };
}
