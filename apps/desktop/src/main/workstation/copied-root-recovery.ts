/**
 * A copied root cannot be certified by walking mutable path names. This
 * preflight validates an external inventory claim and destination boundary,
 * but deliberately does not enumerate or open source contents.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CopiedRootAuditReport } from "./copied-root-audit.js";

/** Provisional test taxonomy, not the complete installed app-owned store catalog. */
export const COPIED_ROOT_STORES = [
  "book", "preimages", "artifacts", "sources", "workstation-state", "drafts", "settings"
] as const;
export type CopiedRootStore = typeof COPIED_ROOT_STORES[number];

export interface RecoveryInventoryEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly bytes?: number;
  readonly sha256?: string;
}

export interface RecoveryInventoryStore {
  readonly id: CopiedRootStore;
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface RecoveryInventory {
  readonly formatVersion: 1;
  readonly sourceIdentity: string;
  readonly stores: readonly RecoveryInventoryStore[];
  readonly entries: readonly RecoveryInventoryEntry[];
}

export interface CopiedRootRecoveryPreflightOptions {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  /** Exact UTF-8 inventory bytes pinned independently of the copied root. */
  readonly inventoryJson: string;
  readonly expectedInventorySha256: string;
  readonly expectedSourceIdentity: string;
  /** Test seam: a source directory can change after its initial metadata check. */
  readonly onAfterRootCheck?: (() => Promise<void> | void) | undefined;
}

export interface CopiedRootRecoveryPreflight {
  /** The external claim has a matching digest, identity, schema, and ownership partition. */
  readonly inventoryClaimValid: boolean;
  /** No mutable copied-root directory is enumerated, so source bytes are not verified. */
  readonly inventoryVerified: false;
  readonly directoryTraversalVerified: false;
  /** Empty until a safe snapshot can prove source bytes and contents. */
  readonly coveredStores: readonly CopiedRootStore[];
  /** Stores named by the external claim, not verified as present on disk. */
  readonly declaredStores: readonly CopiedRootStore[];
  readonly missingStores: readonly CopiedRootStore[];
  readonly catalogComplete: false;
  readonly bookAndPreimages: CopiedRootAuditReport | null;
  readonly destinationAbsent: boolean;
  readonly restoreAvailable: false;
  readonly issues: readonly string[];
  readonly nextDependency: string;
}

const HASH = /^[0-9a-f]{64}$/;
const MAX_INVENTORY_BYTES = 2 * 1024 * 1024;
const MAX_INVENTORY_ENTRIES = 20_000;
const NEXT_DEPENDENCY = "Obtain a trusted immutable, quiescent source snapshot or a descriptor-pinned directory reader, with a WAL-aware Book export receipt and complete app-owned store map; then test no-overwrite staged import, rollback, and reopen.";

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function safeRelative(value: string): boolean {
  if (!value || value.includes("\0") || value.includes("\\") || path.isAbsolute(value)) return false;
  return value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validInventory(value: unknown): value is RecoveryInventory {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.formatVersion !== 1 || typeof obj.sourceIdentity !== "string" ||
      obj.sourceIdentity.length < 1 || obj.sourceIdentity.length > 200 ||
      !Array.isArray(obj.stores) || !Array.isArray(obj.entries) ||
      obj.entries.length > MAX_INVENTORY_ENTRIES) return false;
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const raw of obj.stores) {
    if (typeof raw !== "object" || raw === null) return false;
    const store = raw as Record<string, unknown>;
    if (typeof store.id !== "string" || !COPIED_ROOT_STORES.includes(store.id as CopiedRootStore) ||
        typeof store.path !== "string" || !safeRelative(store.path) ||
        (store.kind !== "file" && store.kind !== "directory") ||
        ids.has(store.id) || paths.has(store.path)) return false;
    ids.add(store.id);
    paths.add(store.path);
  }
  const entryPaths = new Set<string>();
  for (const raw of obj.entries) {
    if (typeof raw !== "object" || raw === null) return false;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.path !== "string" || !safeRelative(entry.path) ||
        (entry.kind !== "file" && entry.kind !== "directory") || entryPaths.has(entry.path)) return false;
    if (entry.kind === "file" &&
        (!Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0 ||
         typeof entry.sha256 !== "string" || !HASH.test(entry.sha256))) return false;
    if (entry.kind === "directory" && (entry.bytes !== undefined || entry.sha256 !== undefined)) return false;
    entryPaths.add(entry.path);
  }
  return (obj.stores as RecoveryInventoryStore[]).every(store =>
    (obj.entries as RecoveryInventoryEntry[]).some(entry =>
      entry.path === store.path && entry.kind === store.kind));
}

function claimIssues(inventory: RecoveryInventory): string[] {
  const issues: string[] = [];
  const book = inventory.stores.find(store => store.id === "book" && store.kind === "file");
  let unclassified = false;
  for (const entry of inventory.entries) {
    // Sidecars belong to Book for ownership accounting, then require explicit refusal.
    const matching = inventory.stores.filter(store => entry.path === store.path ||
      (store.id === "book" && store.kind === "file" &&
       (entry.path === `${store.path}-wal` || entry.path === `${store.path}-shm`)) ||
      (store.kind === "directory" && entry.path.startsWith(`${store.path}/`)));
    if (matching.length !== 1) unclassified = true;
    if (entry.path.split("/").some(part => part.startsWith(".")))
      issues.push("Inventory claims hidden or unknown entries; owner review is required.");
  }
  if (unclassified) issues.push("Inventory has unclassified or overlapping claimed entries.");
  if (book && inventory.entries.some(entry =>
    entry.path === `${book.path}-wal` || entry.path === `${book.path}-shm`))
    issues.push("SQLite sidecars require a trusted WAL-aware export receipt before recovery review.");
  if (book)
    issues.push("Book checkpoint state and WAL quiescence are unproven even when no sidecars are listed.");
  return [...new Set(issues)];
}

async function absentDestination(destination: string): Promise<boolean> {
  try {
    await fs.lstat(destination);
    return false;
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error &&
        (error as { code?: unknown }).code === "ENOENT")) return false;
  }
  try {
    const stat = await fs.lstat(path.dirname(destination));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function preflightCopiedRootRecovery(options: CopiedRootRecoveryPreflightOptions): Promise<CopiedRootRecoveryPreflight> {
  const issues: string[] = [];
  const sourceInput = path.resolve(options.sourceRoot);
  const destinationInput = path.resolve(options.destinationRoot);
  let source: string | null = null;
  let destination: string | null = null;
  try {
    const stat = await fs.lstat(sourceInput);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe source root");
    source = await fs.realpath(sourceInput);
  } catch {
    issues.push("Copied source root is absent, linked, or inaccessible.");
  }
  try {
    const parent = await fs.realpath(path.dirname(destinationInput));
    destination = path.join(parent, path.basename(destinationInput));
  } catch {
    issues.push("Destination parent cannot be resolved.");
  }
  try {
    await options.onAfterRootCheck?.();
  } catch {
    issues.push("Copied source root changed during preflight.");
    source = null;
  }
  if (source !== null) {
    try {
      const stat = await fs.lstat(sourceInput);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(sourceInput) !== source)
        throw new Error("source root changed");
    } catch {
      source = null;
      issues.push("Copied source root changed during preflight.");
    }
  }
  const destinationAbsent = source !== null && destination !== null &&
    !inside(source, destination) && !inside(destination, source) &&
    await absentDestination(destination);
  if (!destinationAbsent)
    issues.push("Destination is occupied, nested with source, or cannot be safely checked.");

  let inventory: RecoveryInventory | null = null;
  const bytes = Buffer.byteLength(options.inventoryJson, "utf8");
  if (bytes === 0 || bytes > MAX_INVENTORY_BYTES || !HASH.test(options.expectedInventorySha256) ||
      sha256(options.inventoryJson) !== options.expectedInventorySha256) {
    issues.push("Externally pinned inventory is absent, oversized, or does not match its digest.");
  } else {
    try {
      const parsed: unknown = JSON.parse(options.inventoryJson);
      if (validInventory(parsed) && parsed.sourceIdentity === options.expectedSourceIdentity)
        inventory = parsed;
      else issues.push("Inventory schema or expected source identity does not match.");
    } catch {
      issues.push("Inventory JSON is malformed.");
    }
  }
  if (inventory !== null) issues.push(...claimIssues(inventory));
  const declaredStores = inventory === null ? [] :
    COPIED_ROOT_STORES.filter(id => inventory.stores.some(store => store.id === id));
  const missingStores = COPIED_ROOT_STORES.filter(id => !declaredStores.includes(id));
  if (missingStores.length > 0)
    issues.push("One or more provisional stores is absent from the external inventory claim.");
  issues.push("Copied-root directory traversal cannot be pinned by this Node reader; source bytes and semantic completeness are unverified.");
  issues.push("The store taxonomy is provisional; external key references, native sessions, and source quiescence remain unverified.");
  return {
    inventoryClaimValid: inventory !== null && claimIssues(inventory).every(issue =>
      !issue.includes("unclassified") && !issue.includes("hidden")),
    inventoryVerified: false,
    directoryTraversalVerified: false,
    coveredStores: [],
    declaredStores,
    missingStores,
    catalogComplete: false,
    bookAndPreimages: null,
    destinationAbsent,
    restoreAvailable: false,
    issues,
    nextDependency: NEXT_DEPENDENCY
  };
}
