import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { COPIED_ROOT_STORES, preflightCopiedRootRecovery } from "./copied-root-recovery.js";
import type { RecoveryInventory, RecoveryInventoryEntry, RecoveryInventoryStore } from "./copied-root-recovery.js";

let temporary: string;
let source: string;
let destination: string;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inventory(entries: RecoveryInventoryEntry[], stores: RecoveryInventoryStore[] = [
  { id: "book", path: "book.sqlite", kind: "file" },
  { id: "preimages", path: "preimages", kind: "directory" }
]) {
  const manifest: RecoveryInventory = {
    formatVersion: 1, sourceIdentity: "synthetic-owner-copy", stores, entries
  };
  const inventoryJson = JSON.stringify(manifest);
  return {
    sourceRoot: source, destinationRoot: destination, inventoryJson,
    expectedInventorySha256: sha256(inventoryJson),
    expectedSourceIdentity: "synthetic-owner-copy"
  };
}

function baseEntries(): RecoveryInventoryEntry[] {
  return [
    { path: "book.sqlite", kind: "file", bytes: 4, sha256: sha256("book") },
    { path: "preimages", kind: "directory" }
  ];
}

beforeEach(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rellane-recovery-")));
  source = path.join(temporary, "copied-source");
  destination = path.join(temporary, "new-install");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "book.sqlite"), "book");
  await fs.mkdir(path.join(source, "preimages"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

describe("copied root recovery preflight", () => {
  it("validates the external claim but never certifies mutable source bytes or Book semantics", async () => {
    const options = inventory(baseEntries());
    const result = await preflightCopiedRootRecovery(options);
    expect(result.inventoryClaimValid).toBe(true);
    expect(result.inventoryVerified).toBe(false);
    expect(result.directoryTraversalVerified).toBe(false);
    expect(result.coveredStores).toEqual([]);
    expect(result.declaredStores).toEqual(["book", "preimages"]);
    expect(result.missingStores).toEqual(COPIED_ROOT_STORES.slice(2));
    expect(result.bookAndPreimages).toBeNull();
    expect(result.catalogComplete).toBe(false);
    expect(result.destinationAbsent).toBe(true);
    expect(result.restoreAvailable).toBe(false);
    expect(await fs.readFile(path.join(source, "book.sqlite"), "utf8")).toBe("book");
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts an ancestor alias for boundary checks without claiming source verification", async () => {
    const alias = path.join(temporary, "alias");
    await fs.symlink(temporary, alias);
    const result = await preflightCopiedRootRecovery({
      ...inventory(baseEntries()),
      sourceRoot: path.join(alias, "copied-source"),
      destinationRoot: path.join(alias, "new-install")
    });
    expect(result.destinationAbsent).toBe(true);
    expect(result.inventoryVerified).toBe(false);
    expect(result.restoreAvailable).toBe(false);
  });

  it("refuses a symlinked source root leaf", async () => {
    const link = path.join(temporary, "link");
    await fs.symlink(source, link);
    const result = await preflightCopiedRootRecovery({ ...inventory(baseEntries()), sourceRoot: link });
    expect(result.issues).toContain("Copied source root is absent, linked, or inaccessible.");
    expect(result.destinationAbsent).toBe(false);
  });

  it("routes inventoried WAL sidecars to an explicit refusal and withholds Book completeness", async () => {
    const entries = [
      ...baseEntries(),
      { path: "book.sqlite-wal", kind: "file" as const, bytes: 3, sha256: sha256("wal") },
      { path: "book.sqlite-shm", kind: "file" as const, bytes: 3, sha256: sha256("shm") }
    ];
    const result = await preflightCopiedRootRecovery(inventory(entries));
    expect(result.inventoryClaimValid).toBe(true);
    expect(result.issues).toContain("SQLite sidecars require a trusted WAL-aware export receipt before recovery review.");
    expect(result.bookAndPreimages).toBeNull();
    expect(result.inventoryVerified).toBe(false);
  });

  it("also withholds completeness when WAL sidecars are absent", async () => {
    const result = await preflightCopiedRootRecovery(inventory(baseEntries()));
    expect(result.issues).toContain("Book checkpoint state and WAL quiescence are unproven even when no sidecars are listed.");
    expect(result.bookAndPreimages).toBeNull();
  });

  it("rejects a manipulated pin and mismatched owner identity", async () => {
    const options = inventory(baseEntries());
    const changed = await preflightCopiedRootRecovery({
      ...options, inventoryJson: options.inventoryJson.replace("synthetic-owner-copy", "other-owner")
    });
    expect(changed.inventoryClaimValid).toBe(false);
    expect(changed.declaredStores).toEqual([]);
    const wrongIdentity = await preflightCopiedRootRecovery({
      ...options, expectedSourceIdentity: "another-owner"
    });
    expect(wrongIdentity.inventoryClaimValid).toBe(false);
  });

  it("flags unknown and hidden manifest entries without silently dropping them", async () => {
    const result = await preflightCopiedRootRecovery(inventory([
      ...baseEntries(),
      { path: ".DS_Store", kind: "file", bytes: 1, sha256: sha256("x") }
    ]));
    expect(result.inventoryClaimValid).toBe(false);
    expect(result.issues).toContain("Inventory has unclassified or overlapping claimed entries.");
    expect(result.issues).toContain("Inventory claims hidden or unknown entries; owner review is required.");
    expect(result.restoreAvailable).toBe(false);
  });

  it("detects a destination collision and preserves its bytes", async () => {
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, "existing.txt"), "unchanged");
    const result = await preflightCopiedRootRecovery(inventory(baseEntries()));
    expect(result.destinationAbsent).toBe(false);
    expect(result.restoreAvailable).toBe(false);
    expect(await fs.readFile(path.join(destination, "existing.txt"), "utf8")).toBe("unchanged");
  });

  it("cannot enumerate an outside directory after a nested source directory is swapped", async () => {
    const nested = path.join(source, "preimages", "nested");
    await fs.mkdir(nested);
    const outside = path.join(temporary, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "outside sentinel");
    const options = inventory([...baseEntries(), { path: "preimages/nested", kind: "directory" }]);
    const readdir = vi.spyOn(fs, "readdir");
    const readFile = vi.spyOn(fs, "readFile");
    const result = await preflightCopiedRootRecovery({
      ...options,
      onAfterRootCheck: async () => {
        await fs.rmdir(nested);
        await fs.symlink(outside, nested);
      }
    });
    expect(result.directoryTraversalVerified).toBe(false);
    expect(result.inventoryVerified).toBe(false);
    expect(result.restoreAvailable).toBe(false);
    expect(readdir).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside sentinel");
  });
});
