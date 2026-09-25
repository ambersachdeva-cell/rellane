import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditCopiedRoot, MAX_SNAPSHOT_JSON_BYTES } from "./copied-root-audit.js";
import { readContentBefore, saveBefore } from "./change-store.js";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const OP_ID = "22222222-2222-4222-8222-222222222222";

let baseTempDir: string;
let sourceRoot: string;
let copiedRoot: string;
let sourceDbPath: string;
let copiedDbPath: string;
let sourceStoreRoot: string;
let copiedStoreRoot: string;

function hashOf(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function createBookSchemaTables(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE party (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'customer',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE document (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'other',
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE invoice (
      id TEXT PRIMARY KEY,
      party_id TEXT NOT NULL REFERENCES party (id),
      issued_on INTEGER NOT NULL,
      subtotal_paise INTEGER NOT NULL DEFAULT 0,
      tax_paise INTEGER NOT NULL DEFAULT 0,
      total_paise INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'confirmed',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE invoice_item (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES invoice (id),
      position INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity_milli INTEGER NOT NULL DEFAULT 1000,
      rate_paise INTEGER NOT NULL DEFAULT 0,
      amount_paise INTEGER NOT NULL DEFAULT 0,
      tax_rate_bp INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE payment (
      id TEXT PRIMARY KEY,
      party_id TEXT NOT NULL REFERENCES party (id),
      received_on INTEGER NOT NULL,
      amount_paise INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE payment_allocation (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES payment (id),
      invoice_id TEXT NOT NULL REFERENCES invoice (id),
      amount_paise INTEGER NOT NULL
    );
  `);
  db.close();
}

async function writeValidPreimage(
  storeRoot: string,
  caseId: string,
  opId: string,
  folderOrigin: string,
  files: { relativePath: string; content: string }[]
): Promise<void> {
  const targetDir = path.join(storeRoot, `${caseId}__${opId}`);
  const filesDir = path.join(targetDir, "files");
  await fs.mkdir(filesDir, { recursive: true });

  const entries = files.map((f) => {
    const contentBuffer = Buffer.from(f.content, "utf8");
    return {
      relativePath: f.relativePath,
      hash: hashOf(contentBuffer),
      bytes: contentBuffer.length,
      modifiedAt: 1700000000000
    };
  });

  for (const f of files) {
    const key = hashOf(f.relativePath);
    await fs.writeFile(path.join(filesDir, key), f.content, "utf8");
  }

  const snapshotJson = JSON.stringify({
    takenAt: 1700000000000,
    folder: folderOrigin,
    entries
  });

  await fs.writeFile(path.join(targetDir, "snapshot.json"), snapshotJson, "utf8");
}

async function writeFutureSnapshotCopy(withOversized = false): Promise<void> {
  createBookSchemaTables(sourceDbPath);
  const workspace = path.join(baseTempDir, "fixture-workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "notes.txt"), "restorable notes", "utf8");
  if (withOversized) {
    await fs.writeFile(path.join(workspace, "oversized.txt"), "x".repeat(1_048_577), "utf8");
  }
  expect(await saveBefore(sourceStoreRoot, CASE_ID, OP_ID, workspace)).toBe(true);
  await fs.cp(sourceRoot, copiedRoot, { recursive: true });
}

async function readFutureMetadata(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(copiedStoreRoot,
    `${CASE_ID}__${OP_ID}`, "snapshot.json"), "utf8")) as Record<string, unknown>;
}

async function writeFutureMetadata(metadata: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(copiedStoreRoot,
    `${CASE_ID}__${OP_ID}`, "snapshot.json"), JSON.stringify(metadata), "utf8");
}

async function snapshotDirectoryTree(dir: string): Promise<Map<string, string>> {
  const tree = new Map<string, string>();
  async function traverse(current: string): Promise<void> {
    const items = await fs.readdir(current, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(current, item.name);
      const relative = path.relative(dir, full);
      if (item.isDirectory()) {
        tree.set(relative, "dir");
        await traverse(full);
      } else if (item.isFile()) {
        const data = await fs.readFile(full);
        tree.set(relative, `file:${hashOf(data)}:${data.length}`);
      } else if (item.isSymbolicLink()) {
        tree.set(relative, "symlink");
      }
    }
  }
  await traverse(dir);
  return tree;
}

beforeEach(async () => {
  baseTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "copied-root-audit-test-"));
  sourceRoot = path.join(baseTempDir, "source");
  copiedRoot = path.join(baseTempDir, "copy");

  sourceDbPath = path.join(sourceRoot, "book.sqlite");
  copiedDbPath = path.join(copiedRoot, "book.sqlite");

  sourceStoreRoot = path.join(sourceRoot, "preimages");
  copiedStoreRoot = path.join(copiedRoot, "preimages");

  await fs.mkdir(sourceStoreRoot, { recursive: true });
  await fs.mkdir(copiedRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(baseTempDir, { recursive: true, force: true });
});

describe("copied-root-audit", () => {
  it("verifies the exact kept manifest while preserving hash-only entries and restore semantics", async () => {
    await writeFutureSnapshotCopy(true);
    const metadata = await readFutureMetadata();
    expect(metadata["snapshotFormatVersion"]).toBe(2);
    expect((metadata["entries"] as unknown[]).length).toBe(2);
    expect((metadata["keptFiles"] as { relativePath: string }[]).map(item => item.relativePath))
      .toEqual(["notes.txt"]);
    const db = new DatabaseSync(copiedDbPath);
    try {
      const report = await auditCopiedRoot(db, copiedStoreRoot);
      expect(report.status).toBe("verified-complete");
      expect(report.preimages.totalKeptFilesChecked).toBe(1);
      expect(report.preimageAudits[0]?.totalEntries).toBe(2);
      expect(await readContentBefore(copiedStoreRoot, CASE_ID, OP_ID, "notes.txt")).toBe("restorable notes");
      expect(await readContentBefore(copiedStoreRoot, CASE_ID, OP_ID, "oversized.txt")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("reports missing, extra and mismatched future manifest blobs without modifying the copy", async () => {
    await writeFutureSnapshotCopy();
    const filesDir = path.join(copiedStoreRoot, `${CASE_ID}__${OP_ID}`, "files");
    const blobName = hashOf("notes.txt");
    const blobPath = path.join(filesDir, blobName);
    const db = new DatabaseSync(copiedDbPath);
    try {
      await fs.unlink(blobPath);
      expect((await auditCopiedRoot(db, copiedStoreRoot)).preimageAudits[0]?.status).toBe("missing");

      await fs.writeFile(blobPath, "restorable notes", "utf8");
      const extra = hashOf("extra.txt");
      await fs.writeFile(path.join(filesDir, extra), "extra", "utf8");
      expect((await auditCopiedRoot(db, copiedStoreRoot)).preimageAudits[0]?.status).toBe("damaged");
      await fs.unlink(path.join(filesDir, extra));

      const metadata = await readFutureMetadata();
      const keptFiles = metadata["keptFiles"] as { relativePath: string; blobName: string; hash: string; bytes: number }[];
      await writeFutureMetadata({ ...metadata, keptFiles: [{ ...keptFiles[0]!, hash: "0".repeat(64) }] });
      const mismatched = await auditCopiedRoot(db, copiedStoreRoot);
      expect(mismatched.preimageAudits[0]?.status).toBe("damaged");
      expect(mismatched.preimageAudits[0]?.issues.some(issue => issue.includes("manifest disagrees"))).toBe(true);
      await writeFutureMetadata(metadata);
      await fs.writeFile(blobPath, "restorable note!", "utf8");
      expect((await auditCopiedRoot(db, copiedStoreRoot)).preimageAudits[0]?.status).toBe("damaged");
      await fs.writeFile(blobPath, "restorable notes", "utf8");
      expect(await fs.readFile(blobPath, "utf8")).toBe("restorable notes");
    } finally {
      db.close();
    }
  });

  it("bounds future manifest count and kept blob size before opening content", async () => {
    await writeFutureSnapshotCopy();
    const metadata = await readFutureMetadata();
    const keptFiles = metadata["keptFiles"] as { relativePath: string; blobName: string; hash: string; bytes: number }[];
    const db = new DatabaseSync(copiedDbPath);
    try {
      await writeFutureMetadata({ ...metadata, keptFiles: Array.from({ length: 401 }, () => keptFiles[0]) });
      expect((await auditCopiedRoot(db, copiedStoreRoot)).preimageAudits[0]?.status).toBe("damaged");
      await writeFutureMetadata({ ...metadata, keptFiles: [{ ...keptFiles[0]!, bytes: 1_048_577 }] });
      expect((await auditCopiedRoot(db, copiedStoreRoot)).preimageAudits[0]?.status).toBe("damaged");
      const withoutManifest = { ...metadata };
      delete withoutManifest["keptFiles"];
      await writeFutureMetadata(withoutManifest);
      expect((await auditCopiedRoot(db, copiedStoreRoot)).preimageAudits[0]?.status).toBe("damaged");
      await writeFutureMetadata({ ...metadata, padding: "x".repeat(MAX_SNAPSHOT_JSON_BYTES) });
      expect((await auditCopiedRoot(db, copiedStoreRoot)).preimageAudits[0]?.status).toBe("damaged");
    } finally {
      db.close();
    }
  });
  it("does not call an empty copied preimage store complete", async () => {
    createBookSchemaTables(copiedDbPath);
    await fs.mkdir(copiedStoreRoot, { recursive: true });
    const db = new DatabaseSync(copiedDbPath);
    try {
      const report = await auditCopiedRoot(db, copiedStoreRoot);
      expect(report.status).toBe("unavailable");
      expect(report.preimages.totalTargets).toBe(0);
    } finally {
      db.close();
    }
  });

  it("does not certify a snapshot whose kept file has vanished", async () => {
    createBookSchemaTables(sourceDbPath);
    await writeValidPreimage(sourceStoreRoot, CASE_ID, OP_ID, "/origin", [
      { relativePath: "notes.txt", content: "kept content" }
    ]);
    await fs.cp(sourceRoot, copiedRoot, { recursive: true });
    const filesDir = path.join(copiedStoreRoot, `${CASE_ID}__${OP_ID}`, "files");
    await fs.unlink(path.join(filesDir, hashOf("notes.txt")));
    const db = new DatabaseSync(copiedDbPath);
    try {
      const report = await auditCopiedRoot(db, copiedStoreRoot);
      expect(report.status).toBe("unavailable");
      expect(report.preimages.verifiedCompleteCount).toBe(0);
      expect(report.preimages.totalKeptFilesChecked).toBe(0);
    } finally {
      db.close();
    }
  });

  it("verifies a valid copied database and preimages complete without changes", async () => {
    createBookSchemaTables(sourceDbPath);
    await writeValidPreimage(
      sourceStoreRoot,
      CASE_ID,
      OP_ID,
      "/mock/workspace/source",
      [
        { relativePath: "notes.txt", content: "initial project notes" },
        { relativePath: "nested/data.csv", content: "id,val\n1,100\n" }
      ]
    );

    await fs.cp(sourceRoot, copiedRoot, { recursive: true });

    const sourceBefore = await snapshotDirectoryTree(sourceRoot);
    const copiedBefore = await snapshotDirectoryTree(copiedRoot);

    const db = new DatabaseSync(copiedDbPath);
    try {
      const report = await auditCopiedRoot(db, copiedStoreRoot);

      expect(report.status).toBe("verified-complete");
      expect(report.database.status).toBe("verified-complete");
      expect(report.database.integrityCheckOk).toBe(true);
      expect(report.database.foreignKeyCheckOk).toBe(true);
      expect(report.database.schemaStatus).toBe("verified-complete");
      expect(report.database.tableCount).toBe(6);

      expect(report.preimages.totalTargets).toBe(1);
      expect(report.preimages.verifiedCompleteCount).toBe(1);
      expect(report.preimages.unverifiedClaimCount).toBe(0);
      expect(report.preimages.damagedCount).toBe(0);
      expect(report.preimages.activeClaimCount).toBe(0);
      expect(report.preimages.stagingCount).toBe(0);
      expect(report.preimages.totalKeptFilesChecked).toBe(2);
      expect(report.preimages.totalKeptBytesChecked).toBeGreaterThan(0);

      expect(report.preimageAudits).toHaveLength(1);
      expect(report.preimageAudits[0]!.caseId).toBe(CASE_ID);
      expect(report.preimageAudits[0]!.operationId).toBe(OP_ID);
      expect(report.preimageAudits[0]!.status).toBe("verified-complete");
      expect(report.preimageAudits[0]!.keptFilesVerified).toBe(2);
      expect(report.preimageAudits[0]!.totalEntries).toBe(2);
    } finally {
      db.close();
    }

    const sourceAfter = await snapshotDirectoryTree(sourceRoot);
    const copiedAfter = await snapshotDirectoryTree(copiedRoot);

    expect(sourceAfter).toEqual(sourceBefore);
    expect(copiedAfter).toEqual(copiedBefore);
  });

  it("refuses symlinks and marks audit damaged without following link outside workspace", async () => {
    createBookSchemaTables(sourceDbPath);
    await writeValidPreimage(
      sourceStoreRoot,
      CASE_ID,
      OP_ID,
      "/mock/workspace/source",
      [{ relativePath: "notes.txt", content: "authentic notes" }]
    );

    await fs.cp(sourceRoot, copiedRoot, { recursive: true });

    const outsideSecret = path.join(baseTempDir, "secret.txt");
    await fs.writeFile(outsideSecret, "confidential outside data", "utf8");

    const targetFilesDir = path.join(copiedStoreRoot, `${CASE_ID}__${OP_ID}`, "files");
    const pathHash = hashOf("notes.txt");
    const blobFile = path.join(targetFilesDir, pathHash);
    await fs.unlink(blobFile);
    await fs.symlink(outsideSecret, blobFile);

    const db = new DatabaseSync(copiedDbPath);
    try {
      const report = await auditCopiedRoot(db, copiedStoreRoot);

      expect(report.status).toBe("damaged");
      expect(report.preimages.damagedCount).toBe(1);
      expect(report.preimages.verifiedCompleteCount).toBe(0);
      expect(report.issues.some((issue) => issue.toLowerCase().includes("symbolic link"))).toBe(
        true
      );
    } finally {
      db.close();
    }
  });

  it("traps swapped symlink race so outside sentinel is never returned or read", async () => {
    createBookSchemaTables(sourceDbPath);
    await writeValidPreimage(
      sourceStoreRoot,
      CASE_ID,
      OP_ID,
      "/mock/workspace/source",
      [{ relativePath: "notes.txt", content: "authentic notes" }]
    );

    await fs.cp(sourceRoot, copiedRoot, { recursive: true });

    const outsideSentinelPath = path.join(baseTempDir, "sentinel-secret.txt");
    const sentinelContent = "PRIVATE_CONFIDENTIAL_SENTINEL_NEVER_READ";
    await fs.writeFile(outsideSentinelPath, sentinelContent, "utf8");

    const targetFilesDir = path.join(copiedStoreRoot, `${CASE_ID}__${OP_ID}`, "files");
    const pathHash = hashOf("notes.txt");
    const blobPath = path.join(targetFilesDir, pathHash);

    let swapped = false;
    let sentinelOpened = false;

    const originalOpen = fs.open;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof originalOpen>) => {
      const targetPath = String(args[0]);
      if (targetPath.includes("sentinel-secret")) {
        sentinelOpened = true;
      }
      return originalOpen(...args);
    });

    try {
      const db = new DatabaseSync(copiedDbPath);
      try {
        const report = await auditCopiedRoot({
          db,
          changeStoreRoot: copiedStoreRoot,
          onBeforeFileOpen: async (filePath) => {
            if (filePath === blobPath && !swapped) {
              await fs.unlink(blobPath);
              await fs.symlink(outsideSentinelPath, blobPath);
              swapped = true;
            }
          }
        });

        expect(swapped).toBe(true);
        expect(sentinelOpened).toBe(false);
        expect(report.status).toBe("damaged");
        expect(report.preimages.damagedCount).toBe(1);
        expect(report.preimages.verifiedCompleteCount).toBe(0);

        const serialized = JSON.stringify(report);
        expect(serialized).not.toContain(sentinelContent);
        expect(serialized).not.toContain("sentinel-secret");
      } finally {
        db.close();
      }
    } finally {
      openSpy.mockRestore();
    }
  });

  it("reports damaged when a kept blob hash or byte length does not match snapshot metadata", async () => {
    createBookSchemaTables(sourceDbPath);
    await writeValidPreimage(
      sourceStoreRoot,
      CASE_ID,
      OP_ID,
      "/mock/workspace/source",
      [{ relativePath: "notes.txt", content: "pristine content" }]
    );

    await fs.cp(sourceRoot, copiedRoot, { recursive: true });

    const targetFilesDir = path.join(copiedStoreRoot, `${CASE_ID}__${OP_ID}`, "files");
    const blobPath = path.join(targetFilesDir, hashOf("notes.txt"));
    await fs.writeFile(blobPath, "tampered corrupted content", "utf8");

    const db = new DatabaseSync(copiedDbPath);
    try {
      const report = await auditCopiedRoot(db, copiedStoreRoot);

      expect(report.status).toBe("damaged");
      expect(report.preimages.damagedCount).toBe(1);
      expect(report.preimages.verifiedCompleteCount).toBe(0);
      expect(
        report.preimageAudits.some((a) => a.issues.some((i) => i.toLowerCase().includes("disagrees")))
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("reports lingering claim and incomplete staging as uncertain without treating untouched or deleting", async () => {
    createBookSchemaTables(sourceDbPath);
    await writeValidPreimage(
      sourceStoreRoot,
      CASE_ID,
      OP_ID,
      "/mock/workspace/source",
      [{ relativePath: "notes.txt", content: "data" }]
    );

    await fs.cp(sourceRoot, copiedRoot, { recursive: true });

    const lingeringCase = "33333333-3333-4333-8333-333333333333";
    const lingeringOp = "44444444-4444-4444-8444-444444444444";
    const claimFile = path.join(copiedStoreRoot, `.claim_${lingeringCase}__${lingeringOp}`);
    await fs.writeFile(claimFile, "crashed-claim-pid", "utf8");

    const stagingCase = "55555555-5555-4555-8555-555555555555";
    const stagingOp = "66666666-6666-4666-8666-666666666666";
    const stagingDir = path.join(
      copiedStoreRoot,
      `.staging_${stagingCase}__${stagingOp}_abcdef1234567890`
    );
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(path.join(stagingDir, "partial.tmp"), "incomplete bytes", "utf8");

    const copiedBefore = await snapshotDirectoryTree(copiedRoot);

    const db = new DatabaseSync(copiedDbPath);
    try {
      const report = await auditCopiedRoot({ db, changeStoreRoot: copiedStoreRoot });

      expect(report.status).toBe("unverified-claim");
      expect(report.preimages.unverifiedClaimCount).toBe(2);
      expect(report.preimages.activeClaimCount).toBe(1);
      expect(report.preimages.stagingCount).toBe(1);

      const claimAudit = report.preimageAudits.find(
        (a) => a.caseId === lingeringCase && a.operationId === lingeringOp
      );
      expect(claimAudit).toBeDefined();
      expect(claimAudit?.status).toBe("unverified-claim");
      expect(claimAudit?.hasClaim).toBe(true);
      expect(
        claimAudit?.issues.some((i) => i.toLowerCase().includes("prior write state is unknown"))
      ).toBe(true);

      const stagingAudit = report.preimageAudits.find(
        (a) => a.caseId === stagingCase && a.operationId === stagingOp
      );
      expect(stagingAudit).toBeDefined();
      expect(stagingAudit?.status).toBe("unverified-claim");
      expect(stagingAudit?.hasStaging).toBe(true);
    } finally {
      db.close();
    }

    const copiedAfter = await snapshotDirectoryTree(copiedRoot);
    expect(copiedAfter).toEqual(copiedBefore);
    await expect(fs.access(claimFile)).resolves.toBeUndefined();
    await expect(fs.access(stagingDir)).resolves.toBeUndefined();
  });

  it("ignores snapshot.json.folder origin folder path and evaluates copied preimages autonomously", async () => {
    createBookSchemaTables(sourceDbPath);
    const nonExistentOrigin = "/completely/fictitious/and/nonexistent/origin/path/12345";
    await writeValidPreimage(
      sourceStoreRoot,
      CASE_ID,
      OP_ID,
      nonExistentOrigin,
      [{ relativePath: "independent.txt", content: "portable content" }]
    );

    await fs.cp(sourceRoot, copiedRoot, { recursive: true });

    const db = new DatabaseSync(copiedDbPath);
    try {
      const report = await auditCopiedRoot(db, copiedStoreRoot);

      expect(report.status).toBe("verified-complete");
      expect(report.preimages.verifiedCompleteCount).toBe(1);
      expect(report.preimages.damagedCount).toBe(0);
      expect(report.preimages.totalKeptFilesChecked).toBe(1);
    } finally {
      db.close();
    }
  });

  it("honestly skips content checking for unkept large files without flagging false corruption", async () => {
    createBookSchemaTables(sourceDbPath);
    const targetDir = path.join(sourceStoreRoot, `${CASE_ID}__${OP_ID}`);
    const filesDir = path.join(targetDir, "files");
    await fs.mkdir(filesDir, { recursive: true });

    const smallText = "small kept text";
    const largeDummyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const smallPathHash = hashOf("small.txt");
    await fs.writeFile(path.join(filesDir, smallPathHash), smallText, "utf8");

    const snapshotJson = JSON.stringify({
      takenAt: 1700000000000,
      folder: "/mock/folder",
      entries: [
        {
          relativePath: "small.txt",
          hash: hashOf(smallText),
          bytes: Buffer.byteLength(smallText, "utf8"),
          modifiedAt: 1700000000000
        },
        {
          relativePath: "oversized.bin",
          hash: largeDummyHash,
          bytes: 2_000_000,
          modifiedAt: 1700000000000
        }
      ]
    });
    await fs.writeFile(path.join(targetDir, "snapshot.json"), snapshotJson, "utf8");

    await fs.cp(sourceRoot, copiedRoot, { recursive: true });

    const db = new DatabaseSync(copiedDbPath);
    try {
      const report = await auditCopiedRoot(db, copiedStoreRoot);

      expect(report.status).toBe("unavailable");
      expect(report.preimages.unavailableCount).toBe(1);
      expect(report.preimages.damagedCount).toBe(0);
      expect(report.preimages.totalKeptFilesChecked).toBe(1);
    } finally {
      db.close();
    }
  });

  it("reports unavailable when Book schema tables are not present without inventing schema version", async () => {
    const db = new DatabaseSync(copiedDbPath);
    db.exec(`
      CREATE TABLE unrelated_notes (id INTEGER PRIMARY KEY, note TEXT);
      PRAGMA user_version = 0;
    `);

    try {
      const report = await auditCopiedRoot(db, copiedStoreRoot);

      expect(report.database.schemaStatus).toBe("unavailable");
      expect(report.database.status).toBe("unavailable");
      expect(report.database.integrityCheckOk).toBe(true);
      expect(report.database.foreignKeyCheckOk).toBe(true);
      expect(report.status).toBe("unavailable");
    } finally {
      db.close();
    }
  });

  it("reports damaged when SQLite integrity check fails", async () => {
    createBookSchemaTables(copiedDbPath);
    const handle = await fs.open(copiedDbPath, "r+");
    try {
      const corruptedHeader = Buffer.alloc(100, 0xff);
      await handle.write(corruptedHeader, 0, 100, 24);
    } finally {
      await handle.close();
    }

    const db = new DatabaseSync(copiedDbPath);
    try {
      const report = await auditCopiedRoot(db, copiedStoreRoot);
      expect(report.database.integrityCheckOk).toBe(false);
      expect(report.database.status).toBe("damaged");
      expect(report.status).toBe("damaged");
    } finally {
      db.close();
    }
  });
});
