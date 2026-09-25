import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RecoveryQuiescenceCoordinator,
  RecoveryQuiescenceError,
  REQUIRED_HOST_WRITERS
} from "./recovery-quiescence.js";
import { openBook } from "../book/database.js";
import { newRecoverySecret, toPhrase } from "../book/recovery.js";
import { AmbiguousPublicationError } from "../book/bounded-archive.js";
import {
  captureWorkspace,
  importWorkspace,
  reopenRecoveredWorkspace,
  preflightWorkspaceRecovery,
  WorkspaceRecoveryError
} from "./workspace-recovery-coordinator.js";
import {
  createRecoveryManifest,
  validateRecoveryManifest,
  RecoveryManifestError
} from "./workspace-recovery-manifest.js";
import {
  packWorkspaceArchive,
  unpackWorkspaceArchive,
  WorkspaceArchiveError
} from "./workspace-recovery-archive.js";

let baseTempDir: string;
let sourceDir: string;
let destDir: string;
let bookDb: DatabaseSync;
let secret: Buffer;
let phrase: string;
let quiescenceCoordinator: RecoveryQuiescenceCoordinator;

beforeEach(async () => {
  baseTempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "rellane-recovery-test-")));
  sourceDir = path.join(baseTempDir, "source-workspace");
  destDir = path.join(baseTempDir, "dest-archives");

  await mkdir(sourceDir, { recursive: true });
  await mkdir(destDir, { recursive: true });

  const bookFile = path.join(sourceDir, "book.sqlite");
  const opened = await openBook(bookFile);
  bookDb = opened.db;

  secret = newRecoverySecret();
  phrase = toPhrase(secret);

  // Setup trusted coordinator with all required writers registered
  quiescenceCoordinator = new RecoveryQuiescenceCoordinator({
    requiredWriters: REQUIRED_HOST_WRITERS,
    initialRegisteredWriters: [...REQUIRED_HOST_WRITERS],
    coverageDeclaration: "trusted"
  });
});

afterEach(async () => {
  try {
    bookDb.close();
  } catch {
    // Ignore if already closed
  }
  secret.fill(0);
  await rm(baseTempDir, { recursive: true, force: true });
});

describe("Whole-Workspace Recovery Backend (G02)", () => {
  it("happy path: captures committed WAL state and auxiliary stores under lease, publishes no-clobber, imports into fresh root, and reopens with zero model replay", async () => {
    // 1. Populate SQLite Book with data including uncheckpointed WAL frames
    bookDb.exec("PRAGMA wal_autocheckpoint = 0");
    bookDb
      .prepare("INSERT INTO party (id, name, created_at, updated_at) VALUES (?,?,?,?)")
      .run("p1", "Synthetic Party Corp", Date.now(), Date.now());
    bookDb
      .prepare("INSERT INTO invoice (id, party_id, issued_on, total_paise, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("inv-1", "p1", Date.now(), 50000, "confirmed", Date.now(), Date.now());

    // Insert canonical work_case and case_turn rows (from V4 migration)
    const nowTs = Date.now();
    bookDb
      .prepare("INSERT INTO work_case (id, title, question, opened_at) VALUES (?,?,?,?)")
      .run("c1", "Case 1", "What happened during the run?", nowTs);
    bookDb
      .prepare("INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at) VALUES (?,?,?,?,?,?,?)")
      .run("t1", "c1", 1, "owner", "verbatim", "Synthetic instruction", nowTs);
    bookDb
      .prepare("INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at) VALUES (?,?,?,?,?,?,?)")
      .run("r1", "c1", 2, "workstation-session", "receipt", JSON.stringify({ event: "interrupted", snapshot: { status: "interrupted" }, details: "Crash occurred mid-stream" }), nowTs + 1);

    // 2. Populate auxiliary portable stores
    await writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark", telemetry: false }), "utf8");

    const memoryDir = path.join(sourceDir, "workstation", "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, "project-1.json"), JSON.stringify({ decisions: ["approved-1"] }), "utf8");

    const agentsDir = path.join(sourceDir, "workstation", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(path.join(agentsDir, "writer-agent.md"), "# Writer Agent\nSystem prompt", "utf8");

    const changesDir = path.join(sourceDir, "workstation", "changes", "c1__op1");
    await mkdir(changesDir, { recursive: true });
    await writeFile(path.join(changesDir, "snapshot.json"), JSON.stringify({ entries: [], takenAt: Date.now(), folder: "/tmp" }), "utf8");

    // Machine-bound store that should be excluded
    await writeFile(path.join(sourceDir, "secrets.bin"), "local-keychain-ciphertext", "utf8");

    // 3. Capture under product-wide quiescence lease
    const workspaceKeyMaterial = new Uint8Array(32).fill(77);
    const captureReceipt = await captureWorkspace({
      quiescenceCoordinator,
      sourceRoot: sourceDir,
      destinationDirectory: destDir,
      destinationArchiveName: "backup.cadrane-recovery",
      recoverySecret: secret,
      sourceIdentity: "synthetic-workspace-alpha",
      db: bookDb,
      workspaceKey: {
        reference: { spaceId: "11111111-1111-4111-8111-111111111111", keyId: "22222222-2222-4222-8222-222222222222" },
        keyMaterial: workspaceKeyMaterial,
        recoveryPhrase: phrase
      },
      allowSyntheticPrerequisite: true
    });

    expect(captureReceipt.archiveBytes).toBeGreaterThan(0);
    expect(captureReceipt.capturedStores).toContain("book");
    expect(captureReceipt.capturedStores).toContain("settings-grants");
    expect(captureReceipt.capturedStores).toContain("memory");
    expect(captureReceipt.capturedStores).toContain("agents");
    expect(captureReceipt.capturedStores).toContain("preimages");
    expect(captureReceipt.excludedStores.some(s => s.includes("secrets.bin"))).toBe(true);
    expect(captureReceipt.manifest.keyEnvelope).not.toBeNull();
    expect(captureReceipt.manifest.readiness.status).toBe("blocked");
    expect(captureReceipt.manifest.readiness.readyForRecovery).toBe(false);
    expect(captureReceipt.manifest.readiness.readyForExport).toBe(false);
    expect(captureReceipt.manifest.readiness.blockedReasons.length).toBeGreaterThan(0);

    // Verify published archive exists
    const archivePath = captureReceipt.destinationPath;
    const archiveStat = await lstat(archivePath);
    expect(archiveStat.isFile()).toBe(true);

    // 4. Safe isolated staged import into a new destination root
    const importedRoot = path.join(baseTempDir, "restored-workspace");
    const importReceipt = await importWorkspace({
      archivePath,
      destinationRoot: importedRoot,
      recoverySecret: secret,
      recoveryPhrase: phrase,
      allowSyntheticPrerequisite: true
    });

    expect(importReceipt.destinationRoot).toBe(importedRoot);
    expect(importReceipt.importedStores).toContain("book");
    expect(importReceipt.importedStores).toContain("settings-grants");
    expect(importReceipt.importedStores).toContain("memory");
    expect(importReceipt.importedStores).toContain("agents");
    expect(importReceipt.importedStores).toContain("preimages");

    // 5. Reopen recovered workspace and prove identities, schema, and zero model replay
    const report = await reopenRecoveredWorkspace(importedRoot);
    expect(report.reopened).toBe(true);
    expect(report.appIdentity).toBe("Cadrane");
    expect(report.partiesCount).toBe(1);
    expect(report.invoicesCount).toBe(1);
    expect(report.casesCount).toBe(1);
    expect(report.turnsCount).toBe(2);
    expect(report.sessionReceiptsCount).toBe(1);
    expect(report.interruptedRunsCount).toBe(1);
    expect(report.modelEffectsReplayed).toBe(false);

    // Verify content of restored auxiliary files
    const restoredSettings = JSON.parse(await readFile(path.join(importedRoot, "settings.json"), "utf8"));
    expect(restoredSettings.theme).toBe("dark");

    const restoredMemory = JSON.parse(await readFile(path.join(importedRoot, "workstation", "memory", "project-1.json"), "utf8"));
    expect(restoredMemory.decisions).toEqual(["approved-1"]);

    // Verify machine-bound store was NOT imported
    let secretsExist = true;
    try {
      await lstat(path.join(importedRoot, "secrets.bin"));
    } catch {
      secretsExist = false;
    }
    expect(secretsExist).toBe(false);
  });

  it("refuses capture if coordinator coverage is incomplete or untrusted", async () => {
    const untrustedCoordinator = new RecoveryQuiescenceCoordinator({
      requiredWriters: REQUIRED_HOST_WRITERS,
      initialRegisteredWriters: [...REQUIRED_HOST_WRITERS],
      coverageDeclaration: "untrusted"
    });

    await expect(
      captureWorkspace({
        quiescenceCoordinator: untrustedCoordinator,
        sourceRoot: sourceDir,
        destinationDirectory: destDir,
        destinationArchiveName: "untrusted.archive",
        recoverySecret: secret,
        sourceIdentity: "test-identity",
        db: bookDb,
        allowSyntheticPrerequisite: true
      })
    ).rejects.toThrow(RecoveryQuiescenceError);
  });

  it("refuses capture when a writer is currently active without killing the active writer", async () => {
    // Acquire a writer permit
    const permit = quiescenceCoordinator.acquireWriterPermit("book");
    expect(permit.released).toBe(false);
    expect(quiescenceCoordinator.activeWriteCount).toBe(1);

    await expect(
      captureWorkspace({
        quiescenceCoordinator,
        sourceRoot: sourceDir,
        destinationDirectory: destDir,
        destinationArchiveName: "active-race.archive",
        recoverySecret: secret,
        sourceIdentity: "test-identity",
        db: bookDb,
        allowSyntheticPrerequisite: true
      })
    ).rejects.toThrow(RecoveryQuiescenceError);

    // Active writer is still running and not stopped/killed
    expect(permit.released).toBe(false);
    expect(quiescenceCoordinator.activeWriteCount).toBe(1);

    // Once permit is released, capture succeeds
    permit.release();
    expect(quiescenceCoordinator.activeWriteCount).toBe(0);

    const receipt = await captureWorkspace({
      quiescenceCoordinator,
      sourceRoot: sourceDir,
      destinationDirectory: destDir,
      destinationArchiveName: "active-race.archive",
      recoverySecret: secret,
      sourceIdentity: "test-identity",
      db: bookDb,
      allowSyntheticPrerequisite: true
    });
    expect(receipt.archiveBytes).toBeGreaterThan(0);
  });

  it("blocks new writer admissions while recovery freeze lease is active", async () => {
    let capturedDuringFreeze = false;
    await captureWorkspace({
      quiescenceCoordinator,
      sourceRoot: sourceDir,
      destinationDirectory: destDir,
      destinationArchiveName: "frozen-block.archive",
      recoverySecret: secret,
      sourceIdentity: "test-identity",
      db: bookDb,
      allowSyntheticPrerequisite: true,
      onAfterFreeze: () => {
        capturedDuringFreeze = true;
        expect(quiescenceCoordinator.isFrozen).toBe(true);

        // Attempting to admit writer while frozen is rejected
        const res = quiescenceCoordinator.tryAcquireWriterPermit("workstation-case");
        expect(res.granted).toBe(false);
        if (!res.granted) {
          expect(res.code).toBe("FREEZE_IN_PROGRESS");
        }
      }
    });

    expect(capturedDuringFreeze).toBe(true);
    expect(quiescenceCoordinator.isFrozen).toBe(false);

    // Unfrozen coordinator permits admission again
    const permit = quiescenceCoordinator.acquireWriterPermit("workstation-case");
    expect(permit.released).toBe(false);
    permit.release();
  });

  it("cleans temporary staging if capture fails mid-flight and leaves destination clean", async () => {
    const errorSimulated = new Error("simulated failure after snapshot");
    await expect(
      captureWorkspace({
        quiescenceCoordinator,
        sourceRoot: sourceDir,
        destinationDirectory: destDir,
        destinationArchiveName: "aborted.archive",
        recoverySecret: secret,
        sourceIdentity: "test-identity",
        db: bookDb,
        allowSyntheticPrerequisite: true,
        onAfterFreeze: () => {
          throw errorSimulated;
        }
      })
    ).rejects.toThrow(errorSimulated);

    // Destination archive does NOT exist
    const destFiles = await readdir(destDir);
    expect(destFiles).toEqual([]);

    // Coordinator lease was released
    expect(quiescenceCoordinator.isFrozen).toBe(false);
  });

  it("refuses publication if destination archive already exists (no-clobber)", async () => {
    const archiveName = "collision.archive";
    const existingFile = path.join(destDir, archiveName);
    await writeFile(existingFile, "pre-existing data", "utf8");

    await expect(
      captureWorkspace({
        quiescenceCoordinator,
        sourceRoot: sourceDir,
        destinationDirectory: destDir,
        destinationArchiveName: archiveName,
        recoverySecret: secret,
        sourceIdentity: "test-identity",
        db: bookDb,
        allowSyntheticPrerequisite: true
      })
    ).rejects.toThrow("already exists; refusing to overwrite.");

    expect(await readFile(existingFile, "utf8")).toBe("pre-existing data");
  });

  it("refuses publication if destination is a symbolic link", async () => {
    const outside = path.join(baseTempDir, "outside.txt");
    await writeFile(outside, "outside file", "utf8");

    const archiveName = "symlink-collision.archive";
    const symlinkPath = path.join(destDir, archiveName);
    await symlink(outside, symlinkPath);

    await expect(
      captureWorkspace({
        quiescenceCoordinator,
        sourceRoot: sourceDir,
        destinationDirectory: destDir,
        destinationArchiveName: archiveName,
        recoverySecret: secret,
        sourceIdentity: "test-identity",
        db: bookDb,
        allowSyntheticPrerequisite: true
      })
    ).rejects.toThrow("already exists; refusing to overwrite.");

    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside file");
  });

  it("handles ambiguous publication on directory sync failure without clobbering", async () => {
    const syncError = new Error("injected directory sync failure");
    let caughtError: unknown;

    try {
      await captureWorkspace({
        quiescenceCoordinator,
        sourceRoot: sourceDir,
        destinationDirectory: destDir,
        destinationArchiveName: "ambiguous.archive",
        recoverySecret: secret,
        sourceIdentity: "test-identity",
        db: bookDb,
        allowSyntheticPrerequisite: true,
        syncDirectory: async () => {
          throw syncError;
        }
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(AmbiguousPublicationError);
    const ambiguous = caughtError as AmbiguousPublicationError;
    expect(ambiguous.destination).toBe(path.join(destDir, "ambiguous.archive"));

    // File was published by hard link before sync failed
    const publishedStat = await lstat(path.join(destDir, "ambiguous.archive"));
    expect(publishedStat.isFile()).toBe(true);
  });

  it("authenticates before decompression: rejects corrupted archive or wrong recovery secret", async () => {
    const captureReceipt = await captureWorkspace({
      quiescenceCoordinator,
      sourceRoot: sourceDir,
      destinationDirectory: destDir,
      destinationArchiveName: "valid.archive",
      recoverySecret: secret,
      sourceIdentity: "test-identity",
      db: bookDb,
      allowSyntheticPrerequisite: true
    });

    const archiveData = await readFile(captureReceipt.destinationPath);

    // 1. Wrong secret fails authentication loudly before decompression
    const wrongSecret = Buffer.from(secret);
    const byte0 = wrongSecret[0];
    if (byte0 !== undefined) {
      wrongSecret[0] = byte0 ^ 1;
    }
    expect(() => unpackWorkspaceArchive(archiveData, wrongSecret)).toThrow(WorkspaceArchiveError);
    expect(() => unpackWorkspaceArchive(archiveData, wrongSecret)).toThrow(/Archive authentication failed/);

    // 2. Corrupted ciphertext fails tag verification
    const corruptedCiphertext = Buffer.from(archiveData);
    const idxCipher = corruptedCiphertext.length - 25;
    const byteCipher = corruptedCiphertext[idxCipher];
    if (byteCipher !== undefined) {
      corruptedCiphertext[idxCipher] = byteCipher ^ 0xff;
    }
    expect(() => unpackWorkspaceArchive(corruptedCiphertext, secret)).toThrow(WorkspaceArchiveError);

    // 3. Corrupted auth tag fails verification
    const corruptedTag = Buffer.from(archiveData);
    const idxTag = corruptedTag.length - 5;
    const byteTag = corruptedTag[idxTag];
    if (byteTag !== undefined) {
      corruptedTag[idxTag] = byteTag ^ 0xaa;
    }
    expect(() => unpackWorkspaceArchive(corruptedTag, secret)).toThrow(WorkspaceArchiveError);

    // 4. Altered header AAD fails tag verification
    const text = archiveData.toString("utf8");
    const newline = archiveData.indexOf(0x0a);
    const headerObj = JSON.parse(archiveData.subarray(0, newline).toString("utf8"));
    headerObj.bookSchema = 999;
    const alteredHeaderLine = `${JSON.stringify(headerObj)}\n`;
    const alteredArchive = Buffer.concat([
      Buffer.from(alteredHeaderLine, "utf8"),
      archiveData.subarray(newline + 1)
    ]);
    expect(() => unpackWorkspaceArchive(alteredArchive, secret)).toThrow(WorkspaceArchiveError);
  });

  it("refuses import if destination root already exists and preserves prior contents", async () => {
    const captureReceipt = await captureWorkspace({
      quiescenceCoordinator,
      sourceRoot: sourceDir,
      destinationDirectory: destDir,
      destinationArchiveName: "to-import.archive",
      recoverySecret: secret,
      sourceIdentity: "test-identity",
      db: bookDb,
      allowSyntheticPrerequisite: true
    });

    const occupiedRoot = path.join(baseTempDir, "occupied-root");
    await mkdir(occupiedRoot);
    await writeFile(path.join(occupiedRoot, "vital-doc.txt"), "precious owner document", "utf8");

    await expect(
      importWorkspace({
        archivePath: captureReceipt.destinationPath,
        destinationRoot: occupiedRoot,
        recoverySecret: secret,
        allowSyntheticPrerequisite: true
      })
    ).rejects.toThrow("already exists; refusing to overwrite.");

    // Existing root is untouched
    expect(await readFile(path.join(occupiedRoot, "vital-doc.txt"), "utf8")).toBe("precious owner document");
  });

  it("refuses directory traversal attempts and cleans only its staging directory on failure", async () => {
    // Manually assemble a malicious manifest with directory traversal
    expect(() =>
      createRecoveryManifest({
        sourceIdentity: "evil-actor",
        bookSchema: 1,
        files: [
          {
            relativePath: "../outside.txt",
            storeId: "settings-grants",
            kind: "file",
            bytes: 10,
            sha256: createHash("sha256").update("1234567890").digest("hex")
          }
        ]
      })
    ).toThrow(RecoveryManifestError);

    // Also test absolute path rejection
    expect(() =>
      createRecoveryManifest({
        sourceIdentity: "evil-actor",
        bookSchema: 1,
        files: [
          {
            relativePath: "/etc/passwd",
            storeId: "settings-grants",
            kind: "file",
            bytes: 10,
            sha256: createHash("sha256").update("1234567890").digest("hex")
          }
        ]
      })
    ).toThrow(RecoveryManifestError);
  });

  it("refuses nested source and destination directories", async () => {
    const nestedDest = path.join(sourceDir, "nested-backup");
    await mkdir(nestedDest);

    await expect(
      captureWorkspace({
        quiescenceCoordinator,
        sourceRoot: sourceDir,
        destinationDirectory: nestedDest,
        destinationArchiveName: "nested.archive",
        recoverySecret: secret,
        sourceIdentity: "test-identity",
        db: bookDb,
        allowSyntheticPrerequisite: true
      })
    ).rejects.toThrow("Source root and destination directory cannot be nested.");
  });

  it("refuses future book schema version early during import", async () => {
    const filesMap = new Map<string, Buffer>();
    const dummyBook = Buffer.from("dummy-sqlite");
    filesMap.set("book.sqlite", dummyBook);

    const manifest = createRecoveryManifest({
      sourceIdentity: "future-app",
      bookSchema: 9999, // Future schema version
      files: [
        {
          relativePath: "book.sqlite",
          storeId: "book",
          kind: "file",
          bytes: dummyBook.byteLength,
          sha256: createHash("sha256").update(dummyBook).digest("hex")
        }
      ]
    });

    const destArchive = path.join(destDir, "future.archive");
    await packWorkspaceArchive({
      manifest,
      files: filesMap,
      secret,
      destination: destArchive
    });

    const targetImportRoot = path.join(baseTempDir, "future-import");
    await expect(
      importWorkspace({
        archivePath: destArchive,
        destinationRoot: targetImportRoot,
        recoverySecret: secret,
        allowSyntheticPrerequisite: true
      })
    ).rejects.toThrow(/newer than maximum supported/);

    // Staging was cleaned and target root was not created
    let exists = true;
    try {
      await lstat(targetImportRoot);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("adversarial reopen: rejects workspace if model effects or turns were replayed after interrupted run", async () => {
    // 1. Capture workspace with an interrupted run in canonical work_case / case_turn
    const nowTs = Date.now();
    bookDb
      .prepare("INSERT INTO work_case (id, title, question, opened_at) VALUES (?,?,?,?)")
      .run("c_adv", "Adversarial Case", "Adversarial question", nowTs);
    bookDb
      .prepare("INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at) VALUES (?,?,?,?,?,?,?)")
      .run("t_adv1", "c_adv", 1, "owner", "verbatim", "Adversarial prompt", nowTs);
    bookDb
      .prepare("INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at) VALUES (?,?,?,?,?,?,?)")
      .run("r_adv", "c_adv", 2, "workstation-session", "receipt", JSON.stringify({ event: "interrupted", snapshot: { status: "interrupted" }, details: "Worker crashed" }), nowTs + 1);

    const captureReceipt = await captureWorkspace({
      quiescenceCoordinator,
      sourceRoot: sourceDir,
      destinationDirectory: destDir,
      destinationArchiveName: "adv-reopen.archive",
      recoverySecret: secret,
      sourceIdentity: "adv-identity",
      db: bookDb,
      allowSyntheticPrerequisite: true
    });

    const importedRoot = path.join(baseTempDir, "adv-restored-workspace");
    await importWorkspace({
      archivePath: captureReceipt.destinationPath,
      destinationRoot: importedRoot,
      recoverySecret: secret,
      allowSyntheticPrerequisite: true
    });

    // Valid reopen succeeds: no replay has occurred
    const cleanReport = await reopenRecoveredWorkspace(importedRoot);
    expect(cleanReport.reopened).toBe(true);
    expect(cleanReport.interruptedRunsCount).toBe(1);
    expect(cleanReport.modelEffectsReplayed).toBe(false);

    // Adversarially inject a replayed assistant turn into the restored database
    const restoredBookDb = new DatabaseSync(path.join(importedRoot, "book.sqlite"));
    try {
      restoredBookDb
        .prepare("INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at) VALUES (?,?,?,?,?,?,?)")
        .run("t_adv2", "c_adv", 3, "assistant", "finding", "Illegal replayed model generation", nowTs + 2);
    } finally {
      restoredBookDb.close();
    }

    // Reopen MUST detect the replayed model effect and throw
    await expect(reopenRecoveredWorkspace(importedRoot)).rejects.toThrow(
      "Model effects were illegally replayed following workspace recovery reopen."
    );
  });

  it("explicitly disables unsafe whole-root capture entrypoint unless synthetic prerequisite is specified", async () => {
    await expect(
      captureWorkspace({
        quiescenceCoordinator,
        sourceRoot: sourceDir,
        destinationDirectory: destDir,
        destinationArchiveName: "unsafe.archive",
        recoverySecret: secret,
        sourceIdentity: "test-identity",
        db: bookDb
        // allowSyntheticPrerequisite omitted / undefined
      })
    ).rejects.toThrow("Whole-workspace recovery capture is disabled");
  });

  it("explicitly disables unsafe whole-root import entrypoint unless synthetic prerequisite is specified", async () => {
    await expect(
      importWorkspace({
        archivePath: path.join(destDir, "some.archive"),
        destinationRoot: path.join(baseTempDir, "some-root"),
        recoverySecret: secret
        // allowSyntheticPrerequisite omitted / undefined
      })
    ).rejects.toThrow("Whole-workspace recovery import is disabled");
  });

  it("provides sound recovery preflight reporting fail-closed blocked status and sound prerequisites", () => {
    const preflight = preflightWorkspaceRecovery(quiescenceCoordinator);
    expect(preflight.readyForRecovery).toBe(false);
    expect(preflight.readyForExport).toBe(false);
    expect(preflight.status).toBe("blocked");
    expect(preflight.quiescenceCoverageComplete).toBe(true);
    expect(preflight.quiescenceCoverageTrusted).toBe(true);
    expect(preflight.nativeDescriptorBoundaryEstablished).toBe(false);
    expect(preflight.hostWriterIntegrationEstablished).toBe(false);
    expect(preflight.soundPrerequisites.length).toBeGreaterThanOrEqual(4);
    expect(preflight.blockedReasons.length).toBeGreaterThanOrEqual(4);
  });

  it("detects concurrent directory swap against pinned source descriptor during freeze", async () => {
    const swappedAway = path.join(baseTempDir, "source-workspace-swapped");
    await expect(
      captureWorkspace({
        quiescenceCoordinator,
        sourceRoot: sourceDir,
        destinationDirectory: destDir,
        destinationArchiveName: "swap-detected.archive",
        recoverySecret: secret,
        sourceIdentity: "swap-identity",
        db: bookDb,
        allowSyntheticPrerequisite: true,
        onAfterFreeze: async () => {
          const { rename } = await import("node:fs/promises");
          await rename(sourceDir, swappedAway);
          await mkdir(sourceDir, { recursive: true });
        }
      })
    ).rejects.toThrow(/Concurrent swap detected on directory/);
  });

  it("verifies captured auxiliary portable store against valid descriptor-pinned native inventory", async () => {
    const { parseNativeInventoryManifest } = await import("./r24-native-inventory/manifest-parser.js");
    const { createHash } = await import("node:crypto");

    const agentsDir = path.join(sourceDir, "workstation", "agents");
    await mkdir(agentsDir, { recursive: true });
    const briefContent = "# Writer Agent\nSystem prompt";
    await writeFile(path.join(agentsDir, "writer-agent.md"), briefContent, "utf8");
    const briefBuf = Buffer.from(briefContent, "utf8");
    const briefSha256 = createHash("sha256").update(briefBuf).digest("hex");

    const manifestStr =
      [
        "R24-NOFOLLOW-INVENTORY\t1",
        `D\t${Buffer.from("workstation", "utf8").toString("hex")}`,
        `D\t${Buffer.from("workstation/agents", "utf8").toString("hex")}`,
        `F\t${Buffer.from("workstation/agents/writer-agent.md", "utf8").toString("hex")}\t${briefBuf.byteLength}\t${briefSha256}`
      ].join("\n") + "\n";

    const observation = parseNativeInventoryManifest(manifestStr, 0);

    const archive = await captureWorkspace({
      quiescenceCoordinator,
      sourceRoot: sourceDir,
      destinationDirectory: destDir,
      destinationArchiveName: "native-verified.archive",
      recoverySecret: secret,
      sourceIdentity: "native-verified-identity",
      db: bookDb,
      allowSyntheticPrerequisite: true,
      nativeInventoryObservation: observation
    });

    expect(archive).toBeDefined();
    expect(archive.capturedStores).toContain("agents");
  });

  it("rejects capture when native inventory observation reports mismatched SHA-256 for auxiliary portable store", async () => {
    const { parseNativeInventoryManifest } = await import("./r24-native-inventory/manifest-parser.js");

    const agentsDir = path.join(sourceDir, "workstation", "agents");
    await mkdir(agentsDir, { recursive: true });
    const briefContent = "# Writer Agent\nSystem prompt";
    await writeFile(path.join(agentsDir, "writer-agent.md"), briefContent, "utf8");
    const briefBuf = Buffer.from(briefContent, "utf8");
    const mismatchedSha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const manifestStr =
      [
        "R24-NOFOLLOW-INVENTORY\t1",
        `D\t${Buffer.from("workstation", "utf8").toString("hex")}`,
        `D\t${Buffer.from("workstation/agents", "utf8").toString("hex")}`,
        `F\t${Buffer.from("workstation/agents/writer-agent.md", "utf8").toString("hex")}\t${briefBuf.byteLength}\t${mismatchedSha256}`
      ].join("\n") + "\n";

    const observation = parseNativeInventoryManifest(manifestStr, 0);

    await expect(
      captureWorkspace({
        quiescenceCoordinator,
        sourceRoot: sourceDir,
        destinationDirectory: destDir,
        destinationArchiveName: "sha-mismatch.archive",
        recoverySecret: secret,
        sourceIdentity: "tampered-identity",
        db: bookDb,
        allowSyntheticPrerequisite: true,
        nativeInventoryObservation: observation
      })
    ).rejects.toThrow(WorkspaceRecoveryError);
  });
});
