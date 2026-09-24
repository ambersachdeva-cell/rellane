/** An export is an explicit handoff of one version. Journal it before writing
 * so an interrupted attempt is visible instead of becoming a false success. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  CaseArtifactExport,
  CaseArtifactExportResult,
  CaseArtifactFormat
} from "@cadrane/contracts";
import { readCase } from "../book/cases.js";
import { artifactVersions } from "./artifacts.js";
import { renderWorkroomDocx } from "./document.js";

const active = new WeakMap<DatabaseSync, Set<string>>();

export function isExporting(db: DatabaseSync, id: string): boolean {
  return active.get(db)?.has(id) ?? false;
}

export function exportReceipts(
  db: DatabaseSync,
  id: string
): readonly CaseArtifactExport[] {
  return db
    .prepare(
      `SELECT e.id, e.version_id AS versionId, v.revision, e.format,
    e.file_name AS fileName, e.sha256, e.bytes, e.state, e.created_at AS createdAt,
    e.completed_at AS completedAt, e.accepted_at AS acceptedAt
    FROM case_artifact_export e JOIN case_artifact_version v ON v.id = e.version_id AND v.case_id = e.case_id
    WHERE e.case_id = ? ORDER BY e.created_at DESC, e.id DESC`
    )
    .all(id)
    .map((row) => ({
      id: String(row["id"]),
      versionId: String(row["versionId"]),
      revision: Number(row["revision"]),
      format: row["format"] as CaseArtifactFormat,
      fileName: String(row["fileName"]),
      sha256: String(row["sha256"]),
      bytes: Number(row["bytes"]),
      state: row["state"] as CaseArtifactExport["state"],
      createdAt: Number(row["createdAt"]),
      completedAt:
        row["completedAt"] === null ? null : Number(row["completedAt"]),
      acceptedAt: row["acceptedAt"] === null ? null : Number(row["acceptedAt"])
    }));
}

export interface ExportDestination {
  readonly defaultName: string;
  readonly format: CaseArtifactFormat;
}

export async function exportArtifactVersion(
  db: DatabaseSync,
  caseId: string,
  versionId: string,
  format: CaseArtifactFormat,
  choose: (destination: ExportDestination) => Promise<string | null>
): Promise<CaseArtifactExportResult> {
  if (isExporting(db, caseId))
    throw new Error(
      "An export is already open for this workroom. Finish or cancel it first."
    );
  const inFlight = active.get(db) ?? new Set<string>();
  active.set(db, inFlight);
  inFlight.add(caseId);
  try {
    if (format !== "docx" && format !== "md")
      throw new Error("Choose Word or Markdown for this export.");
    const room = readCase(db, caseId);
    const version = artifactVersions(db, caseId).find(
      (one) => one.id === versionId
    );
    if (!room || !version)
      throw new Error(
        "That output version is no longer available in this workroom."
      );
    const safeTitle =
      room.title
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .trim()
        .slice(0, 80) || "output";
    const destination = await choose({
      defaultName: `${safeTitle}-v${version.revision}.${format}`,
      format
    });
    if (destination === null)
      return { written: false, fileName: null, receiptRecorded: false };
    if (
      !path.isAbsolute(destination) ||
      path.extname(destination).toLowerCase() !== `.${format}`
    ) {
      throw new Error(`Choose a new file ending in .${format}.`);
    }
    const bytes =
      format === "docx"
        ? await renderWorkroomDocx(room.title, version)
        : Buffer.from(
            `# ${room.title}\n\n${version.body}\n\n---\nVersion ${version.revision} · ${version.acceptedAt === null ? "Draft — not accepted" : "Accepted by owner"}\nWorkroom: ${room.id}\nVersion: ${version.id}\n`,
            "utf8"
          );
    if (bytes.length > 2 * 1024 * 1024)
      throw new Error(
        "This export is too large. Shorten the output before exporting."
      );
    // The dialog and document generation yield. Recheck withdrawal before the
    // durable start and file write, even for callers outside the desktop IPC.
    if (
      !readCase(db, caseId) ||
      !artifactVersions(db, caseId).some((one) => one.id === versionId)
    ) {
      throw new Error(
        "This output was removed while the export was being prepared."
      );
    }
    const id = randomUUID();
    const fileName = path.basename(destination);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    db.prepare(
      `INSERT INTO case_artifact_export
      (id, case_id, version_id, format, file_name, sha256, bytes, state, created_at, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(
      id,
      caseId,
      versionId,
      format,
      fileName,
      sha256,
      bytes.length,
      Date.now(),
      version.acceptedAt
    );
    try {
      const handle = await open(
        destination,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      try {
        db.prepare(
          "UPDATE case_artifact_export SET state = 'failed', completed_at = ? WHERE id = ?"
        ).run(Date.now(), id);
      } catch {
        /* The pending receipt remains an unconfirmed attempt. */
      }
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new Error(
          "A file with that name already exists. Choose a new name; existing files are never replaced."
        );
      }
      throw new Error(
        "The export did not finish. The new file may be incomplete. Check it and choose a new name before trying again."
      );
    }
    let receiptRecorded = false;
    try {
      receiptRecorded =
        db
          .prepare(
            "UPDATE case_artifact_export SET state = 'written', completed_at = ? WHERE id = ?"
          )
          .run(Date.now(), id).changes === 1;
    } catch {
      /* The file is written; reporting failure would invite a duplicate. */
    }
    return { written: true, fileName, receiptRecorded };
  } finally {
    inFlight.delete(caseId);
  }
}
