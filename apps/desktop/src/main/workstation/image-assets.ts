/** An imported image belongs to one task. Keep original bytes, deduplicate locally, and refuse corrupt reads. */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { WorkstationImageAssetSaveInputSchema, WorkstationImageIdSchema, WorkstationCaseIdSchema,
  WorkstationImageAssetSchema, type WorkstationImageAsset, type WorkstationImageMime } from "@cadrane/contracts";




/**
 * Checks standard PNG magic bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].
 */
function isValidPngSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

/**
 * Checks standard JPEG SOI marker: [0xFF, 0xD8, 0xFF].
 */
function isValidJpegSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 3) return false;
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Storage sanity check for image signatures.
 * Note: The Electron importer must fully validate and decode images prior to storage.
 */
function validateImageSignature(mime: WorkstationImageMime, bytes: Uint8Array): void {
  if (mime === "image/png") {
    if (!isValidPngSignature(bytes)) {
      throw new Error("Invalid PNG signature: buffer does not begin with PNG magic bytes.");
    }
  } else if (mime === "image/jpeg") {
    if (!isValidJpegSignature(bytes)) {
      throw new Error("Invalid JPEG signature: buffer does not begin with JPEG magic bytes.");
    }
  } else {
    throw new Error(`Unsupported image MIME type: ${mime}`);
  }
}

function computeSha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function toWorkstationImageAsset(row: Record<string, unknown>): WorkstationImageAsset {
  return WorkstationImageAssetSchema.parse({
    id: String(row["id"]),
    caseId: String(row["caseId"]),
    title: String(row["title"]),
    fileName: String(row["fileName"]),
    mime: String(row["mime"]) as WorkstationImageMime,
    width: Number(row["width"]),
    height: Number(row["height"]),
    byteLength: Number(row["byteLength"]),
    sha256: String(row["sha256"]),
    createdAt: Number(row["createdAt"])
  });
}

/**
 * Saves an image asset explicitly imported by the owner.
 *
 * Enforces:
 * - Strict input validation (bounds, dimensions, mime, non-empty content <= 8 MiB)
 * - Storage sanity checks for PNG/JPEG signatures
 * - Verification that the target task (case) exists and is not closed
 * - Atomic duplicate detection: if the same case already has this exact content (by SHA-256),
 *   the existing asset is returned unchanged without storing a duplicate BLOB.
 */
export function saveImageAsset(
  db: DatabaseSync,
  input: {
    caseId: string;
    title: string;
    fileName: string;
    mime: "image/png" | "image/jpeg";
    width: number;
    height: number;
    content: Uint8Array;
  },
  at?: number
): WorkstationImageAsset {
  const parsed = WorkstationImageAssetSaveInputSchema.parse(input);
  validateImageSignature(parsed.mime, parsed.content);

  const createdAt = at !== undefined ? at : Date.now();
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error("Invalid timestamp: 'at' must be a finite non-negative number.");
  }

  const sha256 = computeSha256(parsed.content);

  db.exec("BEGIN IMMEDIATE");
  try {
    const caseRow = db
      .prepare("SELECT closed_at AS closedAt FROM work_case WHERE id = ?")
      .get(parsed.caseId) as Record<string, unknown> | undefined;

    if (caseRow === undefined) {
      throw new Error(`Case does not exist: ${parsed.caseId}`);
    }
    if (caseRow["closedAt"] !== null) {
      throw new Error(`That case is closed. A closed case does not accept new image assets.`);
    }

    const existing = db
      .prepare(`
        SELECT id, case_id AS caseId, title, file_name AS fileName, mime,
               width, height, byte_length AS byteLength, sha256, created_at AS createdAt
        FROM workstation_image_asset
        WHERE case_id = ? AND sha256 = ?
      `)
      .get(parsed.caseId, sha256) as Record<string, unknown> | undefined;

    if (existing !== undefined) {
      db.exec("COMMIT");
      return toWorkstationImageAsset(existing);
    }

    const count = db.prepare("SELECT COUNT(*) AS n FROM workstation_image_asset WHERE case_id = ?").get(parsed.caseId);
    if (Number(count?.["n"]) >= 64) throw new Error("This work has 64 images. Start another task to add more; existing images are preserved.");
    const id = randomUUID();
    db.prepare(`
      INSERT INTO workstation_image_asset (
        id, case_id, title, file_name, mime, width, height, byte_length, sha256, content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      parsed.caseId,
      parsed.title,
      parsed.fileName,
      parsed.mime,
      parsed.width,
      parsed.height,
      parsed.content.byteLength,
      sha256,
      parsed.content,
      createdAt
    );

    db.exec("COMMIT");

    return {
      id,
      caseId: parsed.caseId,
      title: parsed.title,
      fileName: parsed.fileName,
      mime: parsed.mime,
      width: parsed.width,
      height: parsed.height,
      byteLength: parsed.content.byteLength,
      sha256,
      createdAt
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Transaction already rolled back or connection in error
    }
    throw error;
  }
}

/**
 * Lists metadata for all image assets in a case.
 * Metadata only — never returns original BLOB contents.
 */
export function listImageAssets(
  db: DatabaseSync,
  caseId: string
): readonly WorkstationImageAsset[] {
  const validatedCaseId = WorkstationCaseIdSchema.parse(caseId);
  const rows = db
    .prepare(`
      SELECT id, case_id AS caseId, title, file_name AS fileName, mime,
             width, height, byte_length AS byteLength, sha256, created_at AS createdAt
      FROM workstation_image_asset
      WHERE case_id = ?
      ORDER BY created_at ASC, id ASC
    `)
    .all(validatedCaseId) as readonly Record<string, unknown>[];

  return rows.map(toWorkstationImageAsset);
}

/**
 * Reads an image asset scoped strictly by caseId and id.
 * Refuses foreign-task IDs and missing records.
 * Recomputes hash and byte length on read to detect and refuse corrupted content.
 */
export function readImageAsset(
  db: DatabaseSync,
  caseId: string,
  id: string
): { asset: WorkstationImageAsset; content: Uint8Array } {
  const validatedCaseId = WorkstationCaseIdSchema.parse(caseId);
  const validatedId = WorkstationImageIdSchema.parse(id);

  const row = db
    .prepare(`
      SELECT id, case_id AS caseId, title, file_name AS fileName, mime,
             width, height, byte_length AS byteLength, sha256, content, created_at AS createdAt
      FROM workstation_image_asset
      WHERE id = ? AND case_id = ?
    `)
    .get(validatedId, validatedCaseId) as Record<string, unknown> | undefined;

  if (row === undefined) {
    throw new Error(
      `Image asset '${validatedId}' not found for case '${validatedCaseId}'.`
    );
  }

  const rawContent = row["content"];
  if (!(rawContent instanceof Uint8Array)) throw new Error("Corrupted image asset: original bytes are missing.");
  const content = rawContent;

  const asset = toWorkstationImageAsset(row);

  if (content.byteLength !== asset.byteLength) {
    throw new Error(
      `Corrupted image asset: stored byte length (${content.byteLength}) does not match recorded length (${asset.byteLength}).`
    );
  }

  const digest = computeSha256(content);
  if (digest !== asset.sha256) {
    throw new Error(
      `Corrupted image asset: stored SHA-256 digest (${digest}) does not match recorded digest (${asset.sha256}).`
    );
  }

  return { asset, content };
}
