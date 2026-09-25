/**
 * Durable persistence for owner-authored per-project model preferences.
 * Backed by Book SQLite database.
 *
 * Designed for pure model-choice-advisor ProjectPreferences type.
 * Ensures project isolation, optimistic concurrency revisions, strict validation,
 * and fail-closed handling on invalid or corrupt storage payloads.
 *
 * Schema migration V12 input constant (never executed by this store):
 *
 * ```sql
 * CREATE TABLE workstation_project_model_preference (
 *   project_id   TEXT PRIMARY KEY REFERENCES workstation_project (id) ON DELETE CASCADE,
 *   revision     INTEGER NOT NULL CHECK (revision >= 1),
 *   payload_json TEXT NOT NULL,
 *   updated_at   INTEGER NOT NULL,
 *   deleted_at   INTEGER
 * );
 * ```
 */

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  WORKSTATION_PROVIDER_IDS,
  WorkstationProviderIdSchema,
  type WorkstationProviderId
} from "@cadrane/contracts";
import {
  forgetProjectPreferences,
  MAX_EXCLUSIONS,
  type ModelExclusion,
  type ProjectPreferences
} from "./model-choice-advisor.js";

/** Exact DDL for table creation as schema migration input only. Never executed in regular store. */
export const WORKSTATION_PROJECT_MODEL_PREFERENCE_TABLE_SQL = `
CREATE TABLE workstation_project_model_preference (
  project_id   TEXT PRIMARY KEY REFERENCES workstation_project (id) ON DELETE CASCADE,
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  payload_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
`.trim();

export type SupportedWorkstationProviderId = (typeof WORKSTATION_PROVIDER_IDS)[number];

export { WORKSTATION_PROVIDER_IDS, WorkstationProviderIdSchema };
export type { WorkstationProviderId };

export const MAX_PROJECT_ID_LENGTH = 128;
export const MAX_MODEL_ID_LENGTH = 120;
export const MAX_CAPABILITY_LENGTH = 64;
export const MIN_WEIGHT = 0.0;
export const MAX_WEIGHT = 2.0;
export const MAX_WEIGHT_ENTRIES = 50;
export const MAX_PAYLOAD_JSON_BYTES = 32_768; // 32 KB fail-closed bound
export const MAX_PROJECT_MODEL_PREFERENCE_HISTORY_ROWS = 200;

export const SAFE_MODEL_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export const ProjectIdSchema = z
  .string()
  .min(1, "Project ID cannot be empty")
  .max(MAX_PROJECT_ID_LENGTH, `Project ID exceeds maximum length of ${MAX_PROJECT_ID_LENGTH}`);

export const ModelIdSchema = z
  .string()
  .min(1, "Model ID cannot be empty")
  .max(MAX_MODEL_ID_LENGTH, `Model ID exceeds maximum length of ${MAX_MODEL_ID_LENGTH}`)
  .regex(SAFE_MODEL_ID_REGEX, "Model ID contains invalid characters or pattern")
  .refine(
    (val) => val !== "." && val !== ".." && !val.includes("../") && !val.includes("/.."),
    "Model ID cannot contain path traversal sequences"
  );

export const ModelExclusionSchema = z
  .object({
    providerId: WorkstationProviderIdSchema,
    modelId: ModelIdSchema.optional()
  })
  .strict();

export const WeightSchema = z
  .number()
  .finite("Weight must be a finite number")
  .min(MIN_WEIGHT, `Weight must be at least ${MIN_WEIGHT}`)
  .max(MAX_WEIGHT, `Weight must not exceed ${MAX_WEIGHT}`);

export const ProviderWeightsSchema = z
  .record(z.string(), WeightSchema)
  .superRefine((rec, context) => {
    if (Object.keys(rec).length > MAX_WEIGHT_ENTRIES) {
      context.addIssue({ code: "custom", message: `Too many provider weight entries (maximum allowed is ${MAX_WEIGHT_ENTRIES})` });
    }
    for (const key of Object.keys(rec)) {
      if (!WorkstationProviderIdSchema.safeParse(key).success) {
        context.addIssue({ code: "custom", path: [key], message: `Unknown workstation provider: ${key}` });
      }
    }
  });

export const ModelWeightsSchema = z
  .record(ModelIdSchema, WeightSchema)
  .refine(
    (rec) => Object.keys(rec).length <= MAX_WEIGHT_ENTRIES,
    `Too many model weight entries (maximum allowed is ${MAX_WEIGHT_ENTRIES})`
  );

export const ProviderModelWeightsSchema = z
  .record(z.string(), ModelWeightsSchema)
  .superRefine((rec, context) => {
    if (Object.values(rec).reduce((count, weights) => count + Object.keys(weights).length, 0) > MAX_WEIGHT_ENTRIES) {
      context.addIssue({ code: "custom", message: `Too many provider-model weight entries (maximum allowed is ${MAX_WEIGHT_ENTRIES})` });
    }
    for (const providerId of Object.keys(rec)) {
      if (!WorkstationProviderIdSchema.safeParse(providerId).success) {
        context.addIssue({ code: "custom", path: [providerId], message: `Unknown workstation provider: ${providerId}` });
      }
    }
  });

export const CapabilityKeySchema = z
  .string()
  .min(1, "Capability key cannot be empty")
  .max(MAX_CAPABILITY_LENGTH, `Capability key exceeds maximum length of ${MAX_CAPABILITY_LENGTH}`)
  .regex(/^[a-zA-Z0-9_:-]+$/, "Capability key contains invalid characters");

/** Capability weights are preserved as valid bounded data (0..2), currently unused by advisor for scoring. */
export const CapabilityWeightsSchema = z
  .record(CapabilityKeySchema, WeightSchema)
  .refine(
    (rec) => Object.keys(rec).length <= MAX_WEIGHT_ENTRIES,
    `Too many capability weight entries (maximum allowed is ${MAX_WEIGHT_ENTRIES})`
  );

export const ProjectPreferencesSchema = z
  .object({
    projectId: ProjectIdSchema.nullable().optional(),
    exclusions: z
      .array(ModelExclusionSchema)
      .max(MAX_EXCLUSIONS, `Exclusions exceed maximum of ${MAX_EXCLUSIONS}`)
      .optional(),
    providerWeights: ProviderWeightsSchema.optional(),
    modelWeights: ModelWeightsSchema.optional(),
    providerModelWeights: ProviderModelWeightsSchema.optional(),
    capabilityWeights: CapabilityWeightsSchema.optional()
  })
  .strict();

export interface StoredProjectModelPreferences {
  readonly projectId: string;
  readonly revision: number;
  readonly preferences: ProjectPreferences;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}

export interface SaveProjectModelPreferencesInput {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly preferences: ProjectPreferences;
}

export interface ForgetProjectModelPreferencesInput {
  readonly projectId: string;
  readonly expectedRevision: number;
}

export interface GetProjectModelPreferencesOptions {
  readonly includeDeleted?: boolean;
}

export interface ProjectModelPreferenceHistoryEntry {
  readonly projectId: string;
  readonly revision: number;
  readonly changeKind: "legacy_baseline" | "owner_save" | "owner_forget" | "adaptive_accept";
  readonly preferences: ProjectPreferences;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
  readonly proposalId: string | null;
}

function parseSafeInteger(value: unknown, fieldName: string): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Corrupt database row: ${fieldName} is out of safe integer range.`);
    }
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Corrupt database row: ${fieldName} must be a safe integer.`);
  }
  return value;
}

/**
 * Validates and serializes ProjectPreferences to bounded JSON.
 * Fails closed without silent truncation or trim.
 */
export function serializeProjectPreferences(preferences: ProjectPreferences): string {
  const parsed = ProjectPreferencesSchema.parse(preferences);
  const json = JSON.stringify(parsed);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > MAX_PAYLOAD_JSON_BYTES) {
    throw new Error(
      `Project preferences payload size (${byteLength} bytes) exceeds maximum limit of ${MAX_PAYLOAD_JSON_BYTES} bytes.`
    );
  }
  return json;
}

/**
 * Parses and validates raw stored JSON into ProjectPreferences.
 * Fails closed on malformed syntax or schema violations.
 */
export function deserializeProjectPreferences(json: string): ProjectPreferences {
  if (typeof json !== "string" || json.length === 0) {
    throw new Error("Stored preferences payload JSON must be a non-empty string.");
  }
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > MAX_PAYLOAD_JSON_BYTES) {
    throw new Error(
      `Stored preferences payload size (${byteLength} bytes) exceeds maximum limit of ${MAX_PAYLOAD_JSON_BYTES} bytes.`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Corrupt project preferences JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const parsed = ProjectPreferencesSchema.parse(raw);
  return {
    ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
    ...(parsed.exclusions !== undefined ? {
      exclusions: parsed.exclusions.map((exclusion) => ({
        providerId: exclusion.providerId,
        ...(exclusion.modelId !== undefined ? { modelId: exclusion.modelId } : {})
      }))
    } : {}),
    ...(parsed.providerWeights !== undefined ? { providerWeights: parsed.providerWeights } : {}),
    ...(parsed.modelWeights !== undefined ? { modelWeights: parsed.modelWeights } : {}),
    ...(parsed.providerModelWeights !== undefined ? { providerModelWeights: parsed.providerModelWeights } : {}),
    ...(parsed.capabilityWeights !== undefined ? { capabilityWeights: parsed.capabilityWeights } : {})
  };
}

/**
 * Reads stored model preferences for a project.
 * Returns null if no record exists or if the preference is forgotten/tombstoned
 * (unless options.includeDeleted is true).
 * Fails closed if the database row contains corrupt, non-safe-integer, or malformed data.
 */
export function getProjectModelPreferences(
  db: DatabaseSync,
  projectId: string,
  options: GetProjectModelPreferencesOptions = {}
): StoredProjectModelPreferences | null {
  const validProjectId = ProjectIdSchema.parse(projectId);

  const row = db
    .prepare(
      `SELECT project_id, revision, payload_json, updated_at, deleted_at
       FROM workstation_project_model_preference
       WHERE project_id = ?`
    )
    .get(validProjectId) as
    | {
        project_id: unknown;
        revision: unknown;
        payload_json: unknown;
        updated_at: unknown;
        deleted_at: unknown;
      }
    | undefined;

  if (!row) {
    return null;
  }

  if (typeof row.project_id !== "string") {
    throw new Error("Corrupt database row: project_id must be a string.");
  }
  const storedProjectId = ProjectIdSchema.parse(row.project_id);
  if (storedProjectId !== validProjectId) {
    throw new Error("Corrupt database row: project_id mismatch.");
  }

  const revision = parseSafeInteger(row.revision, "revision");
  if (revision < 1) {
    throw new Error("Corrupt database row: revision must be >= 1.");
  }

  const updatedAt = parseSafeInteger(row.updated_at, "updated_at");
  if (updatedAt <= 0) {
    throw new Error("Corrupt database row: updated_at must be positive.");
  }

  let deletedAt: number | null = null;
  if (row.deleted_at !== null && row.deleted_at !== undefined) {
    deletedAt = parseSafeInteger(row.deleted_at, "deleted_at");
    if (deletedAt <= 0) {
      throw new Error("Corrupt database row: deleted_at must be positive.");
    }
  }

  if (deletedAt !== null && !options.includeDeleted) {
    return null;
  }

  if (typeof row.payload_json !== "string") {
    throw new Error("Corrupt database row: payload_json must be a string.");
  }

  const preferences = deserializeProjectPreferences(row.payload_json);

  if (
    preferences.projectId !== null &&
    preferences.projectId !== undefined &&
    preferences.projectId !== validProjectId
  ) {
    throw new Error(
      `Corrupt database row: payload projectId '${preferences.projectId}' does not match row project_id '${validProjectId}'.`
    );
  }

  return {
    projectId: validProjectId,
    revision,
    preferences,
    updatedAt,
    deletedAt
  };
}

type RawPreferenceRevision = {
  readonly revision: unknown;
  readonly payload_json: unknown;
  readonly updated_at: unknown;
  readonly deleted_at: unknown;
};

function rawCurrentPreference(db: DatabaseSync, projectId: string): RawPreferenceRevision | undefined {
  return db.prepare(
    `SELECT revision, payload_json, updated_at, deleted_at
     FROM workstation_project_model_preference WHERE project_id = ?`
  ).get(projectId) as RawPreferenceRevision | undefined;
}

export function appendPreferenceHistory(
  db: DatabaseSync,
  projectId: string,
  revision: number,
  changeKind: ProjectModelPreferenceHistoryEntry["changeKind"],
  payloadJson: string,
  updatedAt: number,
  deletedAt: number | null,
  proposalId: string | null = null
): void {
  db.prepare(
    `INSERT INTO workstation_project_model_preference_revision
     (project_id, revision, change_kind, payload_json, updated_at, deleted_at, proposal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(projectId, revision, changeKind, payloadJson, updatedAt, deletedAt, proposalId);
}

/** Capture the currently readable V12 row before its first post-V15 edit. Older overwritten revisions stay unknown. */
export function establishPreferenceHistoryHead(db: DatabaseSync, projectId: string, currentRevision: number | null): void {
  const head = db.prepare(
    `SELECT revision, payload_json, updated_at, deleted_at
     FROM workstation_project_model_preference_revision
     WHERE project_id = ? ORDER BY revision DESC LIMIT 1`
  ).get(projectId) as RawPreferenceRevision | undefined;
  const current = rawCurrentPreference(db, projectId);
  if (currentRevision === null) {
    if (head || current) throw new Error("Project preference history/current row mismatch.");
    return;
  }
  if (!current || parseSafeInteger(current.revision, "revision") !== currentRevision ||
      typeof current.payload_json !== "string") {
    throw new Error("Project preference history/current row mismatch.");
  }
  if (!head) {
    appendPreferenceHistory(
      db, projectId, currentRevision, "legacy_baseline", current.payload_json,
      parseSafeInteger(current.updated_at, "updated_at"),
      current.deleted_at === null ? null : parseSafeInteger(current.deleted_at, "deleted_at")
    );
    return;
  }
  if (parseSafeInteger(head.revision, "history revision") !== currentRevision ||
      head.payload_json !== current.payload_json ||
      head.updated_at !== current.updated_at ||
      head.deleted_at !== current.deleted_at) {
    throw new Error("Project preference history/current row mismatch.");
  }
}

/** Bounded read of preserved versions since the last explicit forget. A forget erases old payloads. */
export function listProjectModelPreferenceHistory(
  db: DatabaseSync,
  projectId: string
): readonly ProjectModelPreferenceHistoryEntry[] {
  const validProjectId = ProjectIdSchema.parse(projectId);
  const rows = db.prepare(
    `SELECT project_id, revision, change_kind, payload_json, updated_at, deleted_at, proposal_id
     FROM workstation_project_model_preference_revision
     WHERE project_id = ? ORDER BY revision ASC LIMIT ?`
  ).all(validProjectId, MAX_PROJECT_MODEL_PREFERENCE_HISTORY_ROWS + 1) as readonly Record<string, unknown>[];
  if (rows.length > MAX_PROJECT_MODEL_PREFERENCE_HISTORY_ROWS) {
    throw new Error("Project model preference history exceeds bounded read limit.");
  }
  const history = rows.map((row): ProjectModelPreferenceHistoryEntry => {
    const revision = parseSafeInteger(row["revision"], "history revision");
    const updatedAt = parseSafeInteger(row["updated_at"], "history updated_at");
    const deletedAt = row["deleted_at"] === null ? null : parseSafeInteger(row["deleted_at"], "history deleted_at");
    const changeKind = row["change_kind"];
    if (row["project_id"] !== validProjectId || revision < 1 || updatedAt <= 0 ||
        (deletedAt !== null && deletedAt <= 0) ||
        (changeKind !== "legacy_baseline" && changeKind !== "owner_save" &&
         changeKind !== "owner_forget" && changeKind !== "adaptive_accept") ||
        typeof row["payload_json"] !== "string" ||
        (row["proposal_id"] !== null && typeof row["proposal_id"] !== "string")) {
      throw new Error("Corrupt project model preference history row.");
    }
    const preferences = deserializeProjectPreferences(row["payload_json"]);
    if (preferences.projectId !== null && preferences.projectId !== undefined &&
        preferences.projectId !== validProjectId) {
      throw new Error("Cross-project project model preference history payload.");
    }
    if ((changeKind === "owner_forget" && deletedAt === null) ||
        ((changeKind === "owner_save" || changeKind === "adaptive_accept") && deletedAt !== null)) {
      throw new Error("Corrupt project model preference history state.");
    }
    return {
      projectId: validProjectId, revision, changeKind,
      preferences,
      updatedAt, deletedAt, proposalId: row["proposal_id"]
    };
  });
  for (let index = 1; index < history.length; index += 1) {
    if (history[index]!.revision !== history[index - 1]!.revision + 1) {
      throw new Error("Project model preference history has a revision gap.");
    }
  }
  const current = getProjectModelPreferences(db, validProjectId, { includeDeleted: true });
  if (history.length > 0 && history[history.length - 1]!.revision !== current?.revision) {
    throw new Error("Project preference history/current row mismatch.");
  }
  return history;
}

/**
 * Saves owner-authored project model preferences with optimistic concurrency control.
 * Ensures target project exists and enforces strict project isolation.
 *
 * For a fresh preference record, expectedRevision must be 0 (writes revision 1).
 * For existing preference records, expectedRevision must match current revision.
 */
export function saveProjectModelPreferences(
  db: DatabaseSync,
  input: SaveProjectModelPreferencesInput,
  at: number = Date.now()
): StoredProjectModelPreferences {
  if (!input || typeof input !== "object") {
    throw new Error("Input must be an object.");
  }
  const validProjectId = ProjectIdSchema.parse(input.projectId);

  if (
    typeof input.expectedRevision !== "number" ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw new Error("expectedRevision must be a non-negative safe integer.");
  }

  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) {
    throw new Error("at timestamp must be a positive safe integer.");
  }

  if (!input.preferences || typeof input.preferences !== "object") {
    throw new Error("preferences must be an object.");
  }

  // Cross-project refusal
  if (
    input.preferences.projectId !== undefined &&
    input.preferences.projectId !== null &&
    input.preferences.projectId !== validProjectId
  ) {
    throw new Error(
      `Cross-project refusal: preferences.projectId '${input.preferences.projectId}' does not match target projectId '${validProjectId}'.`
    );
  }

  // Normalize preference envelope with authoritative projectId
  const normalizedPreferences: ProjectPreferences = {
    ...input.preferences,
    projectId: validProjectId
  };

  const payloadJson = serializeProjectPreferences(normalizedPreferences);

  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("BEGIN IMMEDIATE;");
  try {
    const projectRow = db
      .prepare("SELECT id FROM workstation_project WHERE id = ?")
      .get(validProjectId) as { id: string } | undefined;

    if (!projectRow) {
      throw new Error(
        `Cannot save project model preferences: project '${validProjectId}' does not exist.`
      );
    }

    // Do not overwrite a corrupt prior record, including a tombstone. The
    // owner needs a recoverable error instead of losing the original bytes.
    const existingRow = getProjectModelPreferences(db, validProjectId, { includeDeleted: true });
    establishPreferenceHistoryHead(db, validProjectId, existingRow?.revision ?? null);

    let nextRevision: number;

    if (existingRow !== null) {
      const currentRevision = existingRow.revision;
      if (currentRevision !== input.expectedRevision) {
        throw new Error(
          `Stale project preference revision: expected revision ${input.expectedRevision}, but current revision is ${currentRevision}.`
        );
      }
      nextRevision = currentRevision + 1;
      if (!Number.isSafeInteger(nextRevision)) {
        throw new Error("Revision overflow: next revision exceeds safe integer range.");
      }

      db.prepare(
        `UPDATE workstation_project_model_preference
         SET revision = ?, payload_json = ?, updated_at = ?, deleted_at = NULL
         WHERE project_id = ?`
      ).run(nextRevision, payloadJson, at, validProjectId);
    } else {
      if (input.expectedRevision !== 0) {
        throw new Error(
          `Stale project preference revision: expected revision ${input.expectedRevision}, but no preferences recorded yet (expected 0).`
        );
      }
      nextRevision = 1;

      db.prepare(
        `INSERT INTO workstation_project_model_preference
         (project_id, revision, payload_json, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, NULL)`
      ).run(validProjectId, nextRevision, payloadJson, at);
    }

    appendPreferenceHistory(db, validProjectId, nextRevision, "owner_save", payloadJson, at, null);

    db.exec("COMMIT;");

    return {
      projectId: validProjectId,
      revision: nextRevision,
      preferences: deserializeProjectPreferences(payloadJson),
      updatedAt: at,
      deletedAt: null
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Ignore rollback failure if transaction is inactive
    }
    throw error;
  }
}

/**
 * Tombstones and forgets project model preferences with optimistic concurrency control.
 * Bumps revision and replaces the active row's payload with empty preferences.
 * includeDeleted readers cannot restore the old value from this table; SQLite
 * WAL files and backups may still retain earlier bytes until their own lifecycle ends.
 */
export function forgetProjectModelPreferences(
  db: DatabaseSync,
  input: ForgetProjectModelPreferencesInput,
  at: number = Date.now()
): StoredProjectModelPreferences {
  if (!input || typeof input !== "object") {
    throw new Error("Input must be an object.");
  }
  const validProjectId = ProjectIdSchema.parse(input.projectId);

  if (
    typeof input.expectedRevision !== "number" ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw new Error("expectedRevision must be a safe integer >= 1.");
  }

  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) {
    throw new Error("at timestamp must be a positive safe integer.");
  }

  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("BEGIN IMMEDIATE;");
  try {
    const projectRow = db
      .prepare("SELECT id FROM workstation_project WHERE id = ?")
      .get(validProjectId) as { id: string } | undefined;

    if (!projectRow) {
      throw new Error(
        `Cannot forget project model preferences: project '${validProjectId}' does not exist.`
      );
    }

    const existingRow = db
      .prepare(
        `SELECT revision, payload_json, updated_at, deleted_at
         FROM workstation_project_model_preference
         WHERE project_id = ?`
      )
      .get(validProjectId) as
      | {
          revision: unknown;
          payload_json: unknown;
          updated_at: unknown;
          deleted_at: unknown;
        }
      | undefined;

    if (existingRow === undefined) {
      throw new Error(
        `Cannot forget project model preferences: project '${validProjectId}' has no recorded preferences.`
      );
    }

    if (existingRow.deleted_at !== null && existingRow.deleted_at !== undefined) {
      throw new Error(
        `Cannot forget project model preferences: preferences for project '${validProjectId}' are already forgotten.`
      );
    }

    const currentRevision = parseSafeInteger(existingRow.revision, "revision");
    if (currentRevision !== input.expectedRevision) {
      throw new Error(
        `Stale project preference revision: expected revision ${input.expectedRevision}, but current revision is ${currentRevision}.`
      );
    }

    const nextRevision = currentRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new Error("Revision overflow: next revision exceeds safe integer range.");
    }

    // Replace the live preference value with an empty project-scoped value.
    const emptyPreferences = forgetProjectPreferences(validProjectId);
    const emptyPayloadJson = serializeProjectPreferences(emptyPreferences);

    db.prepare(
      `UPDATE workstation_project_model_preference
       SET revision = ?, payload_json = ?, updated_at = ?, deleted_at = ?
       WHERE project_id = ?`
    ).run(nextRevision, emptyPayloadJson, at, at, validProjectId);

    // Explicit forgetting erases policy and proposal content, including
    // historical copies. The tombstone retains only an empty policy and CAS revision.
    db.prepare("DELETE FROM workstation_project_model_adaptation_proposal WHERE project_id = ?")
      .run(validProjectId);
    db.prepare("DELETE FROM workstation_project_model_preference_revision WHERE project_id = ?")
      .run(validProjectId);
    appendPreferenceHistory(db, validProjectId, nextRevision, "owner_forget", emptyPayloadJson, at, at);

    db.exec("COMMIT;");

    return {
      projectId: validProjectId,
      revision: nextRevision,
      preferences: emptyPreferences,
      updatedAt: at,
      deletedAt: at
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Ignore rollback failure if transaction is inactive
    }
    throw error;
  }
}
