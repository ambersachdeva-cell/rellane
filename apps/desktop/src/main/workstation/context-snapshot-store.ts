/** Durable exact reviewed packets. A dispatch attempt does not prove provider delivery. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface ContextSnapshotRef { readonly id: string; readonly revision: number }
export interface ContextSnapshotManifest {
  readonly preview: string;
  readonly sourceIds: readonly string[];
  readonly omitted: readonly string[];
  readonly constraints: readonly ContextSnapshotRef[];
}
export interface ContextSnapshot {
  readonly id: string;
  readonly caseId: string;
  readonly projectId: string | null;
  readonly memoryEpoch: number;
  readonly providerId: string;
  /** Selected/requested model, never an inferred provider report. */
  readonly modelId: string | null;
  readonly packetHash: string;
  readonly packet: string | null;
  readonly manifest: ContextSnapshotManifest | null;
  readonly createdAt: number;
  readonly dispatchAttemptedAt: number | null;
  readonly redactedAt: number | null;
}
export interface RestoredContextSnapshot extends ContextSnapshot {
  readonly packet: string;
  readonly manifest: ContextSnapshotManifest;
}
export type SaveContextSnapshot = Omit<ContextSnapshot, "packetHash" | "createdAt" | "dispatchAttemptedAt" | "redactedAt"> & {
  readonly packet: string;
  readonly manifest: ContextSnapshotManifest;
};
export interface RestoreContextSnapshotQuery {
  readonly id: string;
  readonly caseId: string;
  readonly projectId: string | null;
  readonly providerId: string;
  readonly modelId?: string | null;
}

function hash(packet: string): string {
  return createHash("sha256").update(packet, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const prop = (value as Record<string, unknown>)[key];
    if (prop !== null && typeof prop === "object" && !Object.isFrozen(prop)) {
      deepFreeze(prop);
    }
  }
  return value;
}

function assertScope(db: DatabaseSync, caseId: string, projectId: string | null, memoryEpoch: number): void {
  const room = db.prepare("SELECT closed_at AS closedAt FROM work_case WHERE id = ?")
    .get(caseId) as { closedAt: number | null } | undefined;
  if (!room || room.closedAt !== null) throw new Error("The reviewed case is unavailable.");
  const linked = db.prepare("SELECT project_id AS projectId FROM workstation_project_link WHERE case_id = ?")
    .get(caseId) as { projectId: string } | undefined;
  if ((linked?.projectId ?? null) !== projectId) throw new Error("The case changed projects. Review again.");
  if (projectId === null) {
    if (memoryEpoch !== 0) throw new Error("An unassigned case cannot have project memory.");
    return;
  }
  const project = db.prepare("SELECT memory_epoch AS epoch FROM workstation_project WHERE id = ?")
    .get(projectId) as { epoch: number } | undefined;
  if (!project || project.epoch !== memoryEpoch) throw new Error("Project memory changed. Review again.");
}

function validateManifest(value: unknown, projectId: string | null): ContextSnapshotManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed context snapshot manifest.");
  }
  const manifest = value as Record<string, unknown>;
  if (typeof manifest["preview"] !== "string" ||
      !Array.isArray(manifest["sourceIds"]) ||
      !Array.isArray(manifest["omitted"]) ||
      !Array.isArray(manifest["constraints"]) ||
      !manifest["omitted"].every((item: unknown) => typeof item === "string")) {
    throw new Error("Malformed context snapshot manifest.");
  }
  const sourceIds = manifest["sourceIds"] as unknown[];
  const seenSourceIds = new Set<string>();
  for (const sourceId of sourceIds) {
    if (typeof sourceId !== "string" || sourceId.length === 0 || seenSourceIds.has(sourceId)) {
      throw new Error("Context snapshot manifest contains invalid or duplicate source IDs.");
    }
    seenSourceIds.add(sourceId);
  }
  const constraints = manifest["constraints"] as unknown[];
  if (constraints.length > 100) throw new Error("Too many reviewed constraints.");
  if (projectId === null && constraints.length > 0) {
    throw new Error("An unassigned case cannot carry project constraints.");
  }
  const seenConstraintIds = new Set<string>();
  for (const value of constraints) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Malformed context snapshot constraint reference.");
    }
    const ref = value as Record<string, unknown>;
    if (typeof ref["id"] !== "string" || ref["id"].length === 0 ||
        typeof ref["revision"] !== "number" || !Number.isInteger(ref["revision"]) ||
        ref["revision"] < 1) {
      throw new Error("Malformed context snapshot constraint reference.");
    }
    if (seenConstraintIds.has(ref["id"])) {
      throw new Error("Context snapshot manifest contains duplicate constraint IDs.");
    }
    seenConstraintIds.add(ref["id"]);
  }
  return value as ContextSnapshotManifest;
}

function verifyContextSnapshot(
  db: DatabaseSync,
  id: string,
  caseId: string,
  projectId: string | null,
  expectedProviderId?: string,
  expectedModelId?: string | null
): RestoredContextSnapshot {
  const row = db.prepare(`SELECT id, case_id AS caseId, project_id AS projectId,
    memory_epoch AS memoryEpoch, provider_id AS providerId, model_id AS modelId,
    packet_hash AS packetHash, packet, manifest_json AS manifestJson, created_at AS createdAt,
    dispatch_attempted_at AS dispatchAttemptedAt, redacted_at AS redactedAt
    FROM workstation_context_snapshot WHERE id = ?`).get(id) as (
      Omit<ContextSnapshot, "manifest"> & { manifestJson: string | null }
    ) | undefined;
  if (!row) throw new Error("Reviewed context is unavailable.");
  if (row.caseId !== caseId || row.projectId !== projectId) throw new Error("Context snapshot scope mismatch.");
  if (row.redactedAt !== null || row.packet === null || row.manifestJson === null) {
    throw new Error("Reviewed context is unavailable.");
  }
  if (typeof row.packet !== "string" || row.packet.length === 0) {
    throw new Error("Reviewed context is unavailable.");
  }
  if (expectedProviderId !== undefined && row.providerId !== expectedProviderId) {
    throw new Error("Context snapshot provider mismatch.");
  }
  if (expectedModelId !== undefined && row.modelId !== expectedModelId) {
    throw new Error("Context snapshot model mismatch.");
  }
  if (hash(row.packet) !== row.packetHash) {
    throw new Error("Context snapshot packet hash mismatch.");
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(row.manifestJson) as unknown;
  } catch {
    throw new Error("Malformed context snapshot manifest.");
  }
  const manifest = validateManifest(rawManifest, projectId);

  assertScope(db, caseId, projectId, row.memoryEpoch);

  if (projectId !== null && manifest.constraints.length > 0) {
    const approved = db.prepare(`SELECT 1 FROM workstation_project_memory_entry e
      JOIN workstation_project_memory_revision r ON r.entry_id = e.id AND r.revision = e.active_revision
      WHERE e.project_id = ? AND e.id = ? AND r.revision = ? AND r.state = 'approved'
        AND e.kind IN ('instruction', 'decision', 'exclusion')`);
    for (const ref of manifest.constraints) {
      if (!approved.get(projectId, ref.id, ref.revision)) {
        throw new Error("The reviewed constraint is not an active approval for this project.");
      }
    }
  }

  const storedConstraints = db.prepare(
    "SELECT memory_id AS id, revision FROM workstation_context_snapshot_constraint WHERE snapshot_id = ?"
  ).all(id) as unknown as readonly { id: string; revision: number }[];

  if (storedConstraints.length !== manifest.constraints.length) {
    throw new Error("Stored context snapshot constraint links disagree with manifest.");
  }
  const storedMap = new Map<string, number>();
  for (const sc of storedConstraints) {
    storedMap.set(sc.id, sc.revision);
  }
  for (const ref of manifest.constraints) {
    const storedRev = storedMap.get(ref.id);
    if (storedRev === undefined || storedRev !== ref.revision) {
      throw new Error("Stored context snapshot constraint links disagree with manifest.");
    }
  }

  return deepFreeze({
    id: row.id,
    caseId: row.caseId,
    projectId: row.projectId,
    memoryEpoch: row.memoryEpoch,
    providerId: row.providerId,
    modelId: row.modelId,
    packetHash: row.packetHash,
    packet: row.packet,
    manifest,
    createdAt: row.createdAt,
    dispatchAttemptedAt: row.dispatchAttemptedAt,
    redactedAt: row.redactedAt
  });
}

/** Caller supplies the compiler's exact packet and manifest; no packet parsing or reconstruction. */
export function saveContextSnapshot(db: DatabaseSync, input: SaveContextSnapshot, at = Date.now()): ContextSnapshot {
  if (!input.id || !input.caseId || !input.providerId || !input.packet) throw new Error("Incomplete context snapshot.");
  if (input.packet.length > 1_000_000) throw new Error("Reviewed context exceeds the snapshot limit.");
  validateManifest(input.manifest, input.projectId);
  assertScope(db, input.caseId, input.projectId, input.memoryEpoch);
  const packetHash = hash(input.packet);
  const existing = readContextSnapshot(db, input.id, input.caseId, input.projectId);
  if (existing) {
    if (existing.packet !== input.packet || existing.packetHash !== packetHash ||
        JSON.stringify(existing.manifest) !== JSON.stringify(input.manifest) ||
        existing.memoryEpoch !== input.memoryEpoch || existing.providerId !== input.providerId ||
        existing.modelId !== input.modelId) throw new Error("Context snapshot ID already belongs to another review.");
    return existing;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    assertScope(db, input.caseId, input.projectId, input.memoryEpoch);
    const seen = new Set<string>();
    const approved = db.prepare(`SELECT 1 FROM workstation_project_memory_entry e
      JOIN workstation_project_memory_revision r ON r.entry_id = e.id AND r.revision = e.active_revision
      WHERE e.project_id = ? AND e.id = ? AND r.revision = ? AND r.state = 'approved'
        AND e.kind IN ('instruction', 'decision', 'exclusion')`);
    for (const ref of input.manifest.constraints) {
      if (!ref.id || !Number.isInteger(ref.revision) || ref.revision < 1 || seen.has(ref.id) ||
          !approved.get(input.projectId, ref.id, ref.revision))
        throw new Error("The reviewed constraint is not an active approval for this project.");
      seen.add(ref.id);
    }
    db.prepare(`INSERT INTO workstation_context_snapshot
      (id, case_id, project_id, memory_epoch, provider_id, model_id, packet_hash, packet, manifest_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.caseId, input.projectId, input.memoryEpoch, input.providerId, input.modelId,
        packetHash, input.packet, JSON.stringify(input.manifest), at);
    const put = db.prepare(`INSERT INTO workstation_context_snapshot_constraint
      (snapshot_id, memory_id, revision) VALUES (?, ?, ?)`);
    for (const ref of input.manifest.constraints) put.run(input.id, ref.id, ref.revision);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const saved = readContextSnapshot(db, input.id, input.caseId, input.projectId);
  if (!saved) throw new Error("Reviewed context could not be read after saving.");
  return saved;
}

export function readContextSnapshot(
  db: DatabaseSync, id: string, caseId: string, projectId: string | null
): ContextSnapshot | null {
  const row = db.prepare(`SELECT id, case_id AS caseId, project_id AS projectId,
    memory_epoch AS memoryEpoch, provider_id AS providerId, model_id AS modelId,
    packet_hash AS packetHash, packet, manifest_json AS manifestJson, created_at AS createdAt,
    dispatch_attempted_at AS dispatchAttemptedAt, redacted_at AS redactedAt
    FROM workstation_context_snapshot WHERE id = ?`).get(id) as (
      Omit<ContextSnapshot, "manifest"> & { manifestJson: string | null }
    ) | undefined;
  if (!row) return null;
  if (row.caseId !== caseId || row.projectId !== projectId) throw new Error("Context snapshot scope mismatch.");
  return {
    id: row.id, caseId: row.caseId, projectId: row.projectId, memoryEpoch: row.memoryEpoch,
    providerId: row.providerId, modelId: row.modelId, packetHash: row.packetHash,
    packet: row.packet, manifest: row.manifestJson === null ? null : JSON.parse(row.manifestJson) as ContextSnapshotManifest,
    createdAt: row.createdAt, dispatchAttemptedAt: row.dispatchAttemptedAt, redactedAt: row.redactedAt
  };
}

export function restoreContextSnapshot(
  db: DatabaseSync,
  query: RestoreContextSnapshotQuery
): RestoredContextSnapshot;
export function restoreContextSnapshot(
  db: DatabaseSync,
  id: string,
  caseId: string,
  projectId: string | null,
  providerId: string,
  modelId?: string | null
): RestoredContextSnapshot;
export function restoreContextSnapshot(
  db: DatabaseSync,
  idOrQuery: string | RestoreContextSnapshotQuery,
  caseId?: string,
  projectId?: string | null,
  providerId?: string,
  modelId?: string | null
): RestoredContextSnapshot {
  let id: string;
  let cId: string;
  let pId: string | null;
  let provId: string;
  let mId: string | null | undefined;

  if (typeof idOrQuery === "object" && idOrQuery !== null) {
    id = idOrQuery.id;
    cId = idOrQuery.caseId;
    pId = idOrQuery.projectId;
    provId = idOrQuery.providerId;
    mId = idOrQuery.modelId;
  } else {
    id = idOrQuery;
    cId = caseId!;
    pId = projectId ?? null;
    provId = providerId!;
    mId = modelId;
  }

  if (!id || typeof id !== "string") throw new Error("A snapshot ID is required.");
  if (!cId || typeof cId !== "string") throw new Error("A case ID is required.");
  if (!provId || typeof provId !== "string") throw new Error("A provider ID is required.");

  return verifyContextSnapshot(db, id, cId, pId, provId, mId);
}

/** Marks a local invocation attempt; the adapter has not confirmed receipt. */
export function markContextDispatchAttempt(
  db: DatabaseSync,
  id: string,
  caseId: string,
  projectId: string | null,
  at = Date.now(),
  providerId?: string,
  modelId?: string | null
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    verifyContextSnapshot(db, id, caseId, projectId, providerId, modelId);
    db.prepare("UPDATE workstation_context_snapshot SET dispatch_attempted_at = COALESCE(dispatch_attempted_at, ?) WHERE id = ?")
      .run(at, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Runs inside forgetProjectMemory's transaction; never starts a nested transaction. */
export function redactContextSnapshotsForMemory(db: DatabaseSync, projectId: string, memoryId: string, at = Date.now()): number {
  const result = db.prepare(`UPDATE workstation_context_snapshot
    SET packet = NULL, manifest_json = NULL, redacted_at = COALESCE(redacted_at, ?)
    WHERE project_id = ? AND id IN (
      SELECT snapshot_id FROM workstation_context_snapshot_constraint WHERE memory_id = ?
    )`).run(at, projectId, memoryId);
  return Number(result.changes);
}
