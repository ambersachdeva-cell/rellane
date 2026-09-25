/**
 * Case-scoped recoverable local draft adapter for ArtifactEditor output drafts.
 * Provides schema versioning, strict payload validation, quota failure handling,
 * and safe recovery without overwriting corrupted or future-version stored data.
 */

import type { EditorDraft } from "./ArtifactEditor.js";

export const ARTIFACT_DRAFT_SCHEMA_VERSION = 1;
export const ARTIFACT_DRAFT_KEY_PREFIX = "cadrane:workstation:artifact-draft:";

export function getArtifactDraftKey(caseId: string): string {
  return `${ARTIFACT_DRAFT_KEY_PREFIX}${caseId}`;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface StoredArtifactDraftEnvelope {
  readonly schemaVersion: number;
  readonly caseId: string;
  readonly savedAt: string;
  readonly draft: EditorDraft;
}

export type LoadDraftResult =
  | { readonly status: "not_found" }
  | { readonly status: "loaded"; readonly draft: EditorDraft; readonly savedAt: string }
  | { readonly status: "corrupted"; readonly error: string; readonly raw: string }
  | { readonly status: "version_mismatch"; readonly error: string; readonly storedVersion?: unknown; readonly raw: string }
  | { readonly status: "storage_unavailable"; readonly error: string }
  | { readonly status: "read_error"; readonly error: string };

export type SaveDraftResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: string; readonly quotaExceeded?: boolean };

export type RemoveDraftResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: string };

export function getDefaultStorage(): StorageLike | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    return null;
  }
  return null;
}

function isValidDraft(value: unknown): value is EditorDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.body === "string" &&
    (c.sourceTurnId === null || typeof c.sourceTurnId === "string") &&
    (c.baseVersionId === null || typeof c.baseVersionId === "string")
  );
}

export function parseAndValidateDraft(raw: string, expectedCaseId: string): LoadDraftResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      status: "corrupted",
      error: `Stored draft is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "corrupted", error: "Stored draft root is not an object", raw };
  }
  const r = parsed as Record<string, unknown>;
  if (typeof r.schemaVersion === "number" && r.schemaVersion !== ARTIFACT_DRAFT_SCHEMA_VERSION) {
    return {
      status: "version_mismatch",
      error: `Unsupported schema version: expected ${ARTIFACT_DRAFT_SCHEMA_VERSION}, received ${String(r.schemaVersion)}`,
      storedVersion: r.schemaVersion,
      raw
    };
  }
  if (
    typeof r.schemaVersion !== "number" ||
    typeof r.caseId !== "string" ||
    !r.caseId ||
    typeof r.savedAt !== "string" ||
    !r.savedAt ||
    !isValidDraft(r.draft)
  ) {
    return { status: "corrupted", error: "Invalid artifact draft envelope", raw };
  }
  if (r.caseId !== expectedCaseId) {
    return {
      status: "corrupted",
      error: `Stored draft caseId mismatch: expected "${expectedCaseId}", received "${r.caseId}"`,
      raw
    };
  }
  return {
    status: "loaded",
    draft: {
      body: r.draft.body,
      sourceTurnId: r.draft.sourceTurnId,
      baseVersionId: r.draft.baseVersionId
    },
    savedAt: r.savedAt
  };
}

export function loadArtifactDraft(
  caseId: string,
  storage: StorageLike | null = getDefaultStorage()
): LoadDraftResult {
  if (!storage) return { status: "storage_unavailable", error: "Local draft storage unavailable: changes are kept in memory only." };
  try {
    const raw = storage.getItem(getArtifactDraftKey(caseId));
    if (raw === null || raw.trim().length === 0) return { status: "not_found" };
    return parseAndValidateDraft(raw, caseId);
  } catch (err) {
    return { status: "read_error", error: `Storage read denied: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function saveArtifactDraft(
  caseId: string,
  draft: EditorDraft,
  storage: StorageLike | null = getDefaultStorage()
): SaveDraftResult {
  if (!storage) return { success: false, error: "Local draft storage unavailable: changes are kept in memory only.", quotaExceeded: false };
  try {
    const key = getArtifactDraftKey(caseId);
    const existing = storage.getItem(key);
    if (existing !== null && existing.trim().length > 0) {
      const val = parseAndValidateDraft(existing, caseId);
      if (val.status === "corrupted" || val.status === "version_mismatch") {
        return {
          success: false,
          error: "Cannot overwrite invalid or unsupported stored draft. Persistence is disabled to preserve data for recovery; changes are kept in memory only."
        };
      }
    }
    const envelope: StoredArtifactDraftEnvelope = {
      schemaVersion: ARTIFACT_DRAFT_SCHEMA_VERSION,
      caseId,
      savedAt: new Date().toISOString(),
      draft: { body: draft.body, sourceTurnId: draft.sourceTurnId, baseVersionId: draft.baseVersionId }
    };
    storage.setItem(key, JSON.stringify(envelope));
    return { success: true };
  } catch (err) {
    const isQuota =
      (err instanceof Error &&
        (err.name === "QuotaExceededError" ||
          err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
          err.message.toLowerCase().includes("quota"))) ||
      (typeof DOMException !== "undefined" &&
        err instanceof DOMException &&
        (err.code === 22 || err.name === "QuotaExceededError"));
    return {
      success: false,
      error: isQuota
        ? "Storage quota exceeded. Draft could not be saved to local storage; in-memory changes will be lost if closed."
        : `Storage error: ${err instanceof Error ? err.message : String(err)}`,
      quotaExceeded: Boolean(isQuota)
    };
  }
}

export function removeArtifactDraft(
  caseId: string,
  storage: StorageLike | null = getDefaultStorage()
): RemoveDraftResult {
  if (!storage) return { success: false, error: "Draft storage unavailable" };
  if (!storage.removeItem) return { success: false, error: "Storage does not support item removal" };
  try {
    storage.removeItem(getArtifactDraftKey(caseId));
    return { success: true };
  } catch (err) {
    return { success: false, error: `Storage error removing draft: ${err instanceof Error ? err.message : String(err)}` };
  }
}