import { describe, it, expect, beforeEach } from "vitest";
import {
  ARTIFACT_DRAFT_SCHEMA_VERSION,
  getArtifactDraftKey,
  loadArtifactDraft,
  saveArtifactDraft,
  removeArtifactDraft,
  type StorageLike
} from "./artifact-drafts.js";
import type { EditorDraft } from "./ArtifactEditor.js";

class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe("artifact-drafts storage helper", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("recovers an exact stored draft with body, sourceTurnId, and baseVersionId", () => {
    const draft: EditorDraft = {
      body: "# Title\nDetailed content for investigation.",
      sourceTurnId: "turn-source-42",
      baseVersionId: "artifact-v1"
    };
    const saveResult = saveArtifactDraft("case-100", draft, storage);
    expect(saveResult.success).toBe(true);

    const loadResult = loadArtifactDraft("case-100", storage);
    expect(loadResult.status).toBe("loaded");
    if (loadResult.status === "loaded") {
      expect(loadResult.draft).toEqual(draft);
      expect(typeof loadResult.savedAt).toBe("string");
    }
  });

  it("returns not_found when no draft exists for the case", () => {
    const result = loadArtifactDraft("case-none", storage);
    expect(result.status).toBe("not_found");
  });

  it("preserves corrupted JSON and blocks save without overwriting raw data", () => {
    const key = getArtifactDraftKey("case-corrupt");
    const corruptedRaw = "{ corrupted: json without closing brace";
    storage.setItem(key, corruptedRaw);

    const loadResult = loadArtifactDraft("case-corrupt", storage);
    expect(loadResult.status).toBe("corrupted");

    const newDraft: EditorDraft = {
      body: "Attempted overwrite text",
      sourceTurnId: null,
      baseVersionId: null
    };

    const saveResult = saveArtifactDraft("case-corrupt", newDraft, storage);
    expect(saveResult.success).toBe(false);
    if (!saveResult.success) {
      expect(saveResult.error).toMatch(/cannot overwrite invalid or unsupported stored draft/i);
    }
    expect(storage.getItem(key)).toBe(corruptedRaw);
  });

  it("preserves future version raw and blocks save without overwriting", () => {
    const key = getArtifactDraftKey("case-future");
    const raw = JSON.stringify({
      schemaVersion: 99,
      caseId: "case-future",
      savedAt: "2026-09-24T00:00:00Z",
      draft: { body: "Future format", sourceTurnId: null, baseVersionId: null }
    });
    storage.setItem(key, raw);

    const loadResult = loadArtifactDraft("case-future", storage);
    expect(loadResult.status).toBe("version_mismatch");

    const saveResult = saveArtifactDraft("case-future", { body: "New", sourceTurnId: null, baseVersionId: null }, storage);
    expect(saveResult.success).toBe(false);
    expect(storage.getItem(key)).toBe(raw);
  });

  it("handles write failure when storage quota exceeded", () => {
    const quotaStorage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      }
    };
    const saveResult = saveArtifactDraft("case-q", { body: "Heavy text", sourceTurnId: null, baseVersionId: null }, quotaStorage);
    expect(saveResult.success).toBe(false);
    if (!saveResult.success) {
      expect(saveResult.quotaExceeded).toBe(true);
      expect(saveResult.error).toMatch(/storage quota exceeded/i);
    }
  });

  it("explicit discard only clears the targeted case draft", () => {
    saveArtifactDraft("case-1", { body: "Draft 1", sourceTurnId: null, baseVersionId: "v1" }, storage);
    saveArtifactDraft("case-2", { body: "Draft 2", sourceTurnId: null, baseVersionId: "v2" }, storage);

    expect(removeArtifactDraft("case-1", storage).success).toBe(true);
    expect(loadArtifactDraft("case-1", storage).status).toBe("not_found");
    expect(loadArtifactDraft("case-2", storage).status).toBe("loaded");
  });

  it("preserves stale saved baseVersionId without implicit rebase", () => {
    const draft: EditorDraft = { body: "Draft text", sourceTurnId: null, baseVersionId: "v1" };
    saveArtifactDraft("case-stale", draft, storage);

    const loaded = loadArtifactDraft("case-stale", storage);
    expect(loaded.status).toBe("loaded");
    if (loaded.status === "loaded") {
      expect(loaded.draft.baseVersionId).toBe("v1");
    }
  });
});