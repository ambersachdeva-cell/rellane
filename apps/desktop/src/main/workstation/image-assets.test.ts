/**
 * Tests for workstation image assets persistence, integrity, and scope isolation.
 *
 * Validates exact byte and metadata roundtrip, duplicate versus different-case separation,
 * PNG/JPEG magic byte validation, dimension and byte cap enforcement, cross-task isolation,
 * corruption detection, cascade erasure, atomic rollback, and SQLite on-disk persistence.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeCase, eraseCase, openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import {
  listImageAssets,
  readImageAsset,
  saveImageAsset
} from "./image-assets.js";

function createTestBook(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

/** Standard 8-byte PNG signature followed by synthetic payload bytes. */
function makeSyntheticPng(extraBytes: readonly number[] = [0, 1, 2, 3]): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extraBytes]);
}

/** Standard JPEG SOI marker [0xFF, 0xD8, 0xFF] followed by synthetic payload bytes. */
function makeSyntheticJpeg(extraBytes: readonly number[] = [0xe0, 0x00, 0x10]): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, ...extraBytes]);
}

let db: DatabaseSync;

beforeEach(() => {
  db = createTestBook();
});

afterEach(() => {
  db.close();
});

describe("workstation image assets", () => {
  it("roundtrips exact original bytes and complete metadata", () => {
    const caseId = openCase(db, {
      title: "Task: Architectural Diagram Review",
      question: "Examine server topology schematic"
    });

    const originalBytes = makeSyntheticPng([10, 20, 30, 40, 50]);
    const fixedAt = 1_700_000_000_000;

    const saved = saveImageAsset(
      db,
      {
        caseId,
        title: "Topology Schematic",
        fileName: "topology-v1.png",
        mime: "image/png",
        width: 1920,
        height: 1080,
        content: originalBytes
      },
      fixedAt
    );

    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(saved.caseId).toBe(caseId);
    expect(saved.title).toBe("Topology Schematic");
    expect(saved.fileName).toBe("topology-v1.png");
    expect(saved.mime).toBe("image/png");
    expect(saved.width).toBe(1920);
    expect(saved.height).toBe(1080);
    expect(saved.byteLength).toBe(originalBytes.byteLength);
    expect(saved.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(saved.createdAt).toBe(fixedAt);

    const readResult = readImageAsset(db, caseId, saved.id);
    expect(readResult.asset).toEqual(saved);
    expect(Array.from(readResult.content)).toEqual(Array.from(originalBytes));

    const listed = listImageAssets(db, caseId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(saved);
    // Ensure list returns metadata only, without raw content blob
    expect("content" in (listed[0] ?? {})).toBe(false);
  });

  it("returns existing asset unchanged for duplicate content within the same case, but allows separate ownership across cases", () => {
    const caseA = openCase(db, { title: "Room Alpha", question: "Alpha work" });
    const caseB = openCase(db, { title: "Room Beta", question: "Beta work" });

    const pngBytes = makeSyntheticPng([99, 100, 101]);

    const initialA = saveImageAsset(
      db,
      {
        caseId: caseA,
        title: "Original Alpha Title",
        fileName: "alpha.png",
        mime: "image/png",
        width: 800,
        height: 600,
        content: pngBytes
      },
      1_000
    );

    // Attempt duplicate write in same case with different title and filename
    const duplicateA = saveImageAsset(
      db,
      {
        caseId: caseA,
        title: "Ignored Secondary Title",
        fileName: "ignored.png",
        mime: "image/png",
        width: 800,
        height: 600,
        content: pngBytes
      },
      2_000
    );

    // Duplicate within same case returns the existing asset unchanged
    expect(duplicateA.id).toBe(initialA.id);
    expect(duplicateA.title).toBe("Original Alpha Title");
    expect(duplicateA.fileName).toBe("alpha.png");
    expect(duplicateA.createdAt).toBe(1_000);
    expect(listImageAssets(db, caseA)).toHaveLength(1);

    // Different case saving identical content creates an independent copy for that case
    const savedB = saveImageAsset(
      db,
      {
        caseId: caseB,
        title: "Beta Title",
        fileName: "beta.png",
        mime: "image/png",
        width: 800,
        height: 600,
        content: pngBytes
      },
      3_000
    );

    expect(savedB.id).not.toBe(initialA.id);
    expect(savedB.caseId).toBe(caseB);
    expect(savedB.sha256).toBe(initialA.sha256);
    expect(savedB.title).toBe("Beta Title");
    expect(listImageAssets(db, caseA)).toHaveLength(1);
    expect(listImageAssets(db, caseB)).toHaveLength(1);
  });

  it("validates PNG and JPEG signatures and rejects mismatched or invalid headers", () => {
    const caseId = openCase(db, { title: "Validation Task", question: "Test signatures" });

    const validPng = makeSyntheticPng();
    const validJpeg = makeSyntheticJpeg();
    const garbageBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    // Valid PNG with PNG mime succeeds
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Valid PNG",
        fileName: "valid.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: validPng
      })
    ).not.toThrow();

    // Valid JPEG with JPEG mime succeeds
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Valid JPEG",
        fileName: "valid.jpg",
        mime: "image/jpeg",
        width: 100,
        height: 100,
        content: validJpeg
      })
    ).not.toThrow();

    // Mismatched: PNG bytes with image/jpeg mime
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Mismatched JPEG",
        fileName: "mismatch.jpg",
        mime: "image/jpeg",
        width: 100,
        height: 100,
        content: validPng
      })
    ).toThrow(/Invalid JPEG signature/iu);

    // Mismatched: JPEG bytes with image/png mime
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Mismatched PNG",
        fileName: "mismatch.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: validJpeg
      })
    ).toThrow(/Invalid PNG signature/iu);

    // Arbitrary bytes fail signature checks
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Corrupt File",
        fileName: "corrupt.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: garbageBytes
      })
    ).toThrow(/Invalid PNG signature/iu);
  });

  it("enforces byte cap, non-emptiness, dimension limits, and total pixel bounds", () => {
    const caseId = openCase(db, { title: "Limits Task", question: "Test boundaries" });
    const png = makeSyntheticPng();

    // Empty content rejected
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Empty",
        fileName: "empty.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: new Uint8Array(0)
      })
    ).toThrow();

    // Exceeding 8 MiB byte cap rejected
    const oversizedBuffer = new Uint8Array(8 * 1024 * 1024 + 1);
    oversizedBuffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Oversized",
        fileName: "oversized.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: oversizedBuffer
      })
    ).toThrow(/8 MiB/iu);

    // Width / height out of 1..4096 range rejected
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Zero Dimension",
        fileName: "zero.png",
        mime: "image/png",
        width: 0,
        height: 100,
        content: png
      })
    ).toThrow();

    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Excessive Width",
        fileName: "large.png",
        mime: "image/png",
        width: 4097,
        height: 100,
        content: png
      })
    ).toThrow();

    // Total pixel cap: 4096 * 4096 = 16,777,216 (> 16 million pixels) is rejected
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Too Many Pixels",
        fileName: "pixels.png",
        mime: "image/png",
        width: 4096,
        height: 4096,
        content: png
      })
    ).toThrow(/16 million pixels/iu);

    // 4000 * 4000 = 16,000,000 pixels is within bounds
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Max Total Pixels",
        fileName: "boundary.png",
        mime: "image/png",
        width: 4000,
        height: 4000,
        content: png
      })
    ).not.toThrow();
  });

  it("enforces plain bounded text and rejects filename paths, control characters, and unknown input keys", () => {
    const caseId = openCase(db, { title: "Sanitization Task", question: "Verify text constraints" });
    const png = makeSyntheticPng();

    // Titles are display text, not paths. A before/after label is legitimate.
    expect(saveImageAsset(db, { caseId, title: "Before/After Comparison", fileName: "valid.png", mime: "image/png", width: 100, height: 100, content: png }).title).toBe("Before/After Comparison");

    // Slashes and backslashes in fileName (path traversal prevention)
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Valid Title",
        fileName: "nested/dir/image.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: png
      })
    ).toThrow(/slashes/iu);

    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Valid Title",
        fileName: "..\\secret.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: png
      })
    ).toThrow(/slashes/iu);

    // Control characters in title and filename
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Newline\nIn Title",
        fileName: "valid.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: png
      })
    ).toThrow(/control characters/iu);

    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Null Byte",
        fileName: "file\0.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: png
      })
    ).toThrow(/control characters/iu);

    // Title length bounds (1..200)
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "   ",
        fileName: "valid.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: png
      })
    ).toThrow();

    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "a".repeat(201),
        fileName: "valid.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: png
      })
    ).toThrow();

    // FileName length bounds (1..255)
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Valid Title",
        fileName: "a".repeat(256),
        mime: "image/png",
        width: 100,
        height: 100,
        content: png
      })
    ).toThrow();

    // Unknown extra keys rejected by strict schema
    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Extra Keys",
        fileName: "test.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: png,
        unrecognizedField: true
      } as unknown as Parameters<typeof saveImageAsset>[1])
    ).toThrow();
  });

  it("refuses new writes on empty, missing, or closed cases", () => {
    const png = makeSyntheticPng();

    // Missing case refused
    expect(() =>
      saveImageAsset(db, {
        caseId: "missing-case-id",
        title: "Orphan Asset",
        fileName: "orphan.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: png
      })
    ).toThrow(/does not exist/iu);

    // Closed case refused
    const caseId = openCase(db, { title: "Closed Task", question: "Done" });
    closeCase(db, caseId, { closedAs: "settled", verdict: "Completed analysis." });

    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Late Asset",
        fileName: "late.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: png
      })
    ).toThrow(/closed/iu);
  });

  it("refuses cross-task reads and non-existent IDs", () => {
    const caseA = openCase(db, { title: "Case A", question: "Question A" });
    const caseB = openCase(db, { title: "Case B", question: "Question B" });

    const assetA = saveImageAsset(db, {
      caseId: caseA,
      title: "Asset A",
      fileName: "a.png",
      mime: "image/png",
      width: 200,
      height: 200,
      content: makeSyntheticPng([1, 2, 3])
    });

    // Reading assetA under caseB must be refused
    expect(() => readImageAsset(db, caseB, assetA.id)).toThrow(/not found for case/iu);

    // Non-existent asset ID refused
    expect(() =>
      readImageAsset(db, caseA, "00000000-0000-0000-0000-000000000000")
    ).toThrow(/not found for case/iu);
  });

  it("detects and refuses corrupted stored content on read", () => {
    const caseId = openCase(db, { title: "Integrity Task", question: "Tamper detection" });
    const asset = saveImageAsset(db, {
      caseId,
      title: "Integrity Test",
      fileName: "test.png",
      mime: "image/png",
      width: 100,
      height: 100,
      content: makeSyntheticPng([1, 1, 1])
    });

    // Directly tamper with the stored content BLOB in SQLite
    const tamperedBytes = makeSyntheticPng([9, 9, 9]);
    db.prepare("UPDATE workstation_image_asset SET content = ? WHERE id = ?").run(
      tamperedBytes,
      asset.id
    );

    // Read recomputes hash and refuses corrupted content
    expect(() => readImageAsset(db, caseId, asset.id)).toThrow(/Corrupted image asset/iu);

    // Directly tamper with byte length
    db.prepare("UPDATE workstation_image_asset SET byte_length = byte_length + 1 WHERE id = ?").run(
      asset.id
    );
    expect(() => readImageAsset(db, caseId, asset.id)).toThrow(/Corrupted image asset/iu);
  });

  it("cascades image asset deletion upon case erasure while preserving other case assets", () => {
    const caseA = openCase(db, { title: "Task to Delete", question: "Erasure test" });
    const caseB = openCase(db, { title: "Task to Keep", question: "Preserve test" });

    const assetA = saveImageAsset(db, {
      caseId: caseA,
      title: "A",
      fileName: "a.png",
      mime: "image/png",
      width: 100,
      height: 100,
      content: makeSyntheticPng([1])
    });

    const assetB = saveImageAsset(db, {
      caseId: caseB,
      title: "B",
      fileName: "b.png",
      mime: "image/png",
      width: 100,
      height: 100,
      content: makeSyntheticPng([2])
    });

    expect(listImageAssets(db, caseA)).toHaveLength(1);
    expect(listImageAssets(db, caseB)).toHaveLength(1);

    // Erase Case A
    const erased = eraseCase(db, caseA);
    expect(erased).toBe(true);

    // Case A's assets are deleted via ON DELETE CASCADE
    expect(listImageAssets(db, caseA)).toHaveLength(0);
    expect(() => readImageAsset(db, caseA, assetA.id)).toThrow();

    // Case B's assets remain intact and readable
    expect(listImageAssets(db, caseB)).toHaveLength(1);
    const readB = readImageAsset(db, caseB, assetB.id);
    expect(readB.asset.id).toBe(assetB.id);
  });

  it("rolls back atomically on failed transactions", () => {
    const caseId = openCase(db, { title: "Rollback Room", question: "Failure test" });
    const png = makeSyntheticPng([5, 5, 5]);

    // Close case to force a failure inside transaction
    closeCase(db, caseId, { closedAs: "settled", verdict: "Finished." });

    expect(() =>
      saveImageAsset(db, {
        caseId,
        title: "Failing Write",
        fileName: "fail.png",
        mime: "image/png",
        width: 100,
        height: 100,
        content: png
      })
    ).toThrow();

    // No rows persisted
    const countRow = db
      .prepare("SELECT COUNT(*) AS n FROM workstation_image_asset WHERE case_id = ?")
      .get(caseId) as Record<string, unknown>;
    expect(Number(countRow["n"])).toBe(0);
  });

  it("persists image assets and exact bytes across real SQLite on-disk database reopen", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rellane-images-test-"));
    const dbPath = join(tempDir, "book.sqlite");

    try {
      const initialDb = new DatabaseSync(dbPath);
      initialDb.exec("PRAGMA foreign_keys = ON");
      for (const migration of MIGRATIONS) {
        initialDb.exec(migration.sql);
      }

      const caseId = openCase(initialDb, {
        title: "Disk Persistence Case",
        question: "Will bytes survive process reboot?"
      });

      const pngBytes = makeSyntheticPng([101, 102, 103, 104]);
      const saved = saveImageAsset(initialDb, {
        caseId,
        title: "Architecture Overview",
        fileName: "overview.png",
        mime: "image/png",
        width: 1280,
        height: 720,
        content: pngBytes
      });

      initialDb.close();

      // Reopen connection from the file on disk
      const reopenedDb = new DatabaseSync(dbPath);
      reopenedDb.exec("PRAGMA foreign_keys = ON");

      const listed = listImageAssets(reopenedDb, caseId);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(saved.id);
      expect(listed[0]?.title).toBe("Architecture Overview");
      expect(listed[0]?.fileName).toBe("overview.png");
      expect(listed[0]?.sha256).toBe(saved.sha256);

      const readBack = readImageAsset(reopenedDb, caseId, saved.id);
      expect(readBack.asset).toEqual(saved);
      expect(Array.from(readBack.content)).toEqual(Array.from(pngBytes));

      reopenedDb.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
