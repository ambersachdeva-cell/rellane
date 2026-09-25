import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inventoryOwnedDataRoot, OWNED_DATA_STORES } from "./owned-data-inventory.js";

let base: string;
let root: string;

function digest(relativePath: string): string {
  return createHash("sha256").update(relativePath).digest("hex");
}

async function file(relativePath: string, text = "synthetic bytes"): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, text);
}

function entryFor(report: Awaited<ReturnType<typeof inventoryOwnedDataRoot>>, relativePath: string) {
  return report.entries.find(entry => entry.pathSha256 === digest(relativePath));
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rellane-owned-inventory-")));
  root = path.join(base, "copy");
  await fs.mkdir(root);
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("owned data inventory", () => {
  it("classifies source-grounded stores without opening file contents or exposing names", async () => {
    await file("book.sqlite", "not actually SQLite");
    await file("book.sqlite-wal");
    await file("book.sqlite-shm");
    await file("backup.key", "encrypted backup key");
    await file("settings.json", "host grants and settings");
    await file("ledger.jsonl", "encrypted ledger");
    await file("secrets.bin", "Keychain ciphertext");
    await file("telegram-token.enc", "token ciphertext");
    await file("whatsapp-config.enc", "config ciphertext");
    await file("cadrane-secure/automation-workspace-key-v1.json", "wrapped key");
    await file("automations/workspace-v1.json.encrypted", "workspace ciphertext");
    await file("Vault/Cases/example.md");
    await file("skills/example/skill.json");
    await file(`timeline/${"a".repeat(32)}/1700000000000.mfst.gz`);
    await file("workstation/changes/case__operation/snapshot.json");
    await file("workstation/agents/planner.md");
    await file("workstation/memory/project-1.json");
    await file("workstation/watches/watches.json");
    await file(`workstation/watches/seen/${"b".repeat(64)}.txt`);
    await file("workstation/workspaces/case-1/result.txt");
    await file("Local Storage/leveldb/000001.log", "unsaved draft bytes");
    await file("crashes/crash-2026-09-24.txt");
    await file("speech/output.wav");
    await file("Cache/cache-data");
    await fs.chmod(path.join(root, "secrets.bin"), 0o000);

    const report = await inventoryOwnedDataRoot(root);
    expect(report.status).toBe("classified");
    expect(report.contentVerified).toBe(false);
    expect(report.directoryTraversalVerified).toBe(false);
    expect(report.readyForExport).toBe(false);
    expect(entryFor(report, "book.sqlite-wal")).toMatchObject({ classification: "portable-data", storeId: "book" });
    expect(entryFor(report, "book.sqlite-shm")).toMatchObject({ classification: "regenerable", storeId: "book" });
    expect(entryFor(report, "backup.key")).toMatchObject({ classification: "machine-bound", storeId: "backup-key" });
    expect(entryFor(report, "secrets.bin")).toMatchObject({ classification: "machine-bound", storeId: "secret-store" });
    expect(entryFor(report, "Local Storage/leveldb/000001.log")).toMatchObject({ classification: "portable-data", storeId: "renderer-drafts" });
    expect(entryFor(report, "workstation/changes/case__operation/snapshot.json")).toMatchObject({ classification: "portable-data", storeId: "preimages" });
    expect(entryFor(report, "speech/output.wav")).toMatchObject({ classification: "regenerable", storeId: "speech-output" });
    expect(entryFor(report, "Cache/cache-data")).toMatchObject({ classification: "regenerable", storeId: "browser-cache" });
    expect(report.presentStores).toContain("automation-workspace");
    expect(report.presentStores).toContain("vault");
    expect(report.presentStores).toContain("skills");
    expect(report.presentStores).toContain("timeline");
    expect(report.absentStores).toContain("managed-models");
    expect(JSON.stringify(report)).not.toContain("Keychain ciphertext");
    expect(JSON.stringify(report)).not.toContain("Vault/Cases/example.md");
    expect(await fs.readFile(path.join(root, "book.sqlite"), "utf8")).toBe("not actually SQLite");
  });

  it("treats absent optional stores and an empty root as ordinary absence", async () => {
    const report = await inventoryOwnedDataRoot(root);
    expect(report.status).toBe("classified");
    expect(report.entries).toEqual([]);
    expect(report.presentStores).toEqual([]);
    expect(report.absentStores).toEqual(OWNED_DATA_STORES.map(store => store.id));
    expect(report.counts.unknown).toBe(0);
    expect(report.readyForExport).toBe(false);
  });

  it("keeps unknown files and unsupported nested workstation stores as blockers", async () => {
    await file(".DS_Store", "Finder metadata");
    await file("workstation/future-store/state.json", "future user data");
    const report = await inventoryOwnedDataRoot(root);
    expect(report.status).toBe("unknown");
    expect(report.counts.unknown).toBeGreaterThanOrEqual(3);
    expect(entryFor(report, ".DS_Store")).toMatchObject({ classification: "unknown", storeId: null });
    expect(entryFor(report, "workstation/future-store/state.json")).toMatchObject({ classification: "unknown", storeId: null });
    expect(report.readyForExport).toBe(false);
    expect(await fs.readFile(path.join(root, ".DS_Store"), "utf8")).toBe("Finder metadata");
  });

  it("flags hidden foreign entries and malformed preimage files while preserving them", async () => {
    await file("Vault/.DS_Store", "finder");
    await file("skills/example/.hidden", "unknown");
    await file("workstation/changes/case__operation/.staging", "staging");
    await file("workstation/changes/case__operation/payload.bin", "foreign");
    const report = await inventoryOwnedDataRoot(root);
    expect(report.status).toBe("unknown");
    for (const name of [
      "Vault/.DS_Store", "skills/example/.hidden",
      "workstation/changes/case__operation/.staging",
      "workstation/changes/case__operation/payload.bin"
    ]) expect(entryFor(report, name)).toMatchObject({ classification: "unknown", storeId: null });
    expect(report.counts.unknown).toBeGreaterThanOrEqual(4);
    expect(report.readyForExport).toBe(false);
    expect(await fs.readFile(path.join(root, "Vault", ".DS_Store"), "utf8")).toBe("finder");
  });

  it("treats hard-linked store files as unknown", async () => {
    const outside = path.join(base, "outside.txt");
    await fs.writeFile(outside, "shared bytes");
    await fs.link(outside, path.join(root, "settings.json"));
    const report = await inventoryOwnedDataRoot(root);
    expect(report.status).toBe("unknown");
    expect(entryFor(report, "settings.json")).toMatchObject({ classification: "unknown", storeId: null });
    expect(report.presentStores).not.toContain("settings-grants");
    expect(await fs.readFile(outside, "utf8")).toBe("shared bytes");
  });

  it("reports managed models as known ownership with unresolved portability", async () => {
    await file("local-intelligence/managed-models/models/model.gguf", "model fixture");
    const report = await inventoryOwnedDataRoot(root);
    expect(report.status).toBe("unknown");
    expect(report.presentStores).toContain("managed-models");
    expect(entryFor(report, "local-intelligence/managed-models/models/model.gguf")).toMatchObject({
      classification: "unknown", storeId: "managed-models"
    });
  });

  it("does not follow a symlink to another directory or treat it as owned data", async () => {
    const outside = path.join(base, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "outside sentinel");
    await fs.symlink(outside, path.join(root, "Vault"));
    const report = await inventoryOwnedDataRoot(root);
    expect(report.status).toBe("unknown");
    expect(entryFor(report, "Vault")).toMatchObject({ kind: "symbolic-link", classification: "unknown" });
    expect(report.entries).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("secret.txt");
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside sentinel");
  });

  it("accepts a system-style ancestor alias but rejects a symlinked data-root leaf", async () => {
    await file("settings.json");
    const alias = path.join(base, "alias");
    await fs.symlink(base, alias);
    expect((await inventoryOwnedDataRoot(path.join(alias, "copy"))).status).toBe("classified");
    const leaf = path.join(base, "linked-copy");
    await fs.symlink(root, leaf);
    expect((await inventoryOwnedDataRoot(leaf)).status).toBe("unavailable");
  });

  it("does not call a missing root corruption and never creates it", async () => {
    const absent = path.join(base, "absent-copy");
    const report = await inventoryOwnedDataRoot(absent);
    expect(report.status).toBe("unavailable");
    expect(report.contentVerified).toBe(false);
    await expect(fs.lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
