import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  WORKSTATION_PROJECT_MODEL_PREFERENCE_TABLE_SQL,
  WORKSTATION_PROVIDER_IDS,
  MIN_WEIGHT,
  MAX_WEIGHT,
  MAX_MODEL_ID_LENGTH,
  getProjectModelPreferences,
  listProjectModelPreferenceHistory,
  saveProjectModelPreferences,
  forgetProjectModelPreferences
} from "./model-project-preferences-store.js";
import { MIGRATIONS } from "../book/schema.js";
import {
  MAX_EXCLUSIONS,
  type ModelExclusion,
  type ProjectPreferences
} from "./model-choice-advisor.js";

function createBookDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");

  // Recreate minimal Book project schema prerequisite
  db.exec(`
    CREATE TABLE workstation_project (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE workstation_project_revision (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES workstation_project (id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // Additive V12 preference table initialized from published SQL migration constant
  db.exec(WORKSTATION_PROJECT_MODEL_PREFERENCE_TABLE_SQL);
  db.exec(MIGRATIONS.find((migration) => migration.version === 15)!.sql);

  return db;
}

function insertProjectFixture(
  db: DatabaseSync,
  projectId: string,
  title: string = "Test Project",
  at: number = 1000
): void {
  db.prepare("INSERT INTO workstation_project (id, created_at) VALUES (?, ?)").run(
    projectId,
    at
  );
  db.prepare(
    "INSERT INTO workstation_project_revision (id, project_id, revision, title, brief, created_at) VALUES (?, ?, 1, ?, ?, ?)"
  ).run(`rev-${projectId}-1`, projectId, title, "Brief", at);
}

describe("model-project-preferences-store", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createBookDatabase();
    insertProjectFixture(db, "proj-alpha", "Alpha Project");
    insertProjectFixture(db, "proj-beta", "Beta Project");
  });

  it("adds V15 history tables without rewriting an existing V12 owner row", () => {
    const old = new DatabaseSync(":memory:");
    try {
      old.exec("PRAGMA foreign_keys = ON");
      old.exec("CREATE TABLE workstation_project (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
      old.prepare("INSERT INTO workstation_project (id, created_at) VALUES (?, ?)")
        .run("legacy-project", 1000);
      old.exec(WORKSTATION_PROJECT_MODEL_PREFERENCE_TABLE_SQL);
      const payload = '{"projectId":"legacy-project","modelWeights":{"keep":1.7}}';
      old.prepare(
        `INSERT INTO workstation_project_model_preference
         (project_id, revision, payload_json, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL)`
      ).run("legacy-project", 5, payload, 5000);
      old.exec(MIGRATIONS.find((migration) => migration.version === 15)!.sql);
      expect(old.prepare(
        "SELECT revision, payload_json FROM workstation_project_model_preference WHERE project_id = ?"
      ).get("legacy-project")).toEqual({ revision: 5, payload_json: payload });
      expect(old.prepare(
        "SELECT COUNT(*) AS count FROM workstation_project_model_preference_revision"
      ).get()).toEqual({ count: 0 });
    } finally {
      old.close();
    }
  });

  it("verifies provider IDs match contracts exactly without invented providers", () => {
    expect(WORKSTATION_PROVIDER_IDS).toEqual([
      "codex",
      "claude",
      "gemini1",
      "gemini2",
      "gemini3"
    ]);
  });

  it("saves and retrieves model preferences preserving exclusions exactly", () => {
    const exclusions: readonly ModelExclusion[] = [
      { providerId: "claude", modelId: "claude-3-5-sonnet-20241022" },
      { providerId: "codex" }, // Provider-wide exclusion without modelId
      { providerId: "gemini1", modelId: "gemini-1.5-pro" },
      { providerId: "gemini2", modelId: "gemini-2.0-flash" },
      { providerId: "gemini3", modelId: "gemini-3.0-pro" }
    ];

    const preferences: ProjectPreferences = {
      projectId: "proj-alpha",
      exclusions,
      providerWeights: {
        claude: 1.5,
        codex: 0.5
      },
      modelWeights: {
        "claude-3-5-sonnet-20241022": 2.0
      },
      providerModelWeights: {
        codex: { "claude-3-5-sonnet-20241022": 1.1 }
      },
      capabilityWeights: {
        coding: 1.2
      }
    };

    const saved = saveProjectModelPreferences(
      db,
      {
        projectId: "proj-alpha",
        expectedRevision: 0,
        preferences
      },
      2000
    );

    expect(saved.revision).toBe(1);
    expect(saved.projectId).toBe("proj-alpha");
    expect(saved.deletedAt).toBeNull();
    expect(saved.updatedAt).toBe(2000);
    expect(saved.preferences.exclusions).toEqual(exclusions);
    expect(saved.preferences.providerWeights).toEqual({
      claude: 1.5,
      codex: 0.5
    });
    expect(saved.preferences.capabilityWeights).toEqual({
      coding: 1.2
    });
    expect(saved.preferences.providerModelWeights).toEqual({
      codex: { "claude-3-5-sonnet-20241022": 1.1 }
    });

    const loaded = getProjectModelPreferences(db, "proj-alpha");
    expect(loaded).not.toBeNull();
    expect(loaded?.revision).toBe(1);
    expect(loaded?.preferences.exclusions).toEqual(exclusions);
    expect(loaded?.preferences.exclusions?.[1]?.modelId).toBeUndefined();
    expect(loaded?.preferences.providerWeights).toEqual({
      claude: 1.5,
      codex: 0.5
    });
    expect(loaded?.preferences.capabilityWeights).toEqual({
      coding: 1.2
    });
    expect(loaded?.preferences.providerModelWeights).toEqual({
      codex: { "claude-3-5-sonnet-20241022": 1.1 }
    });
  });

  it("demonstrates optimistic concurrency control and rejects stale revisions", () => {
    const pref1: ProjectPreferences = {
      exclusions: [{ providerId: "claude" }]
    };

    // Stale initial expectedRevision when 0 is expected
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 1,
        preferences: pref1
      })
    ).toThrow(/Stale project preference revision.*expected revision 1.*expected 0/);

    // Initial creation succeeds at revision 1
    const saved1 = saveProjectModelPreferences(db, {
      projectId: "proj-alpha",
      expectedRevision: 0,
      preferences: pref1
    });
    expect(saved1.revision).toBe(1);

    // Update with stale expectedRevision 0 fails
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 0,
        preferences: { exclusions: [{ providerId: "codex" }] }
      })
    ).toThrow(/Stale project preference revision.*expected revision 0, but current revision is 1/);

    // Update with matching expectedRevision 1 succeeds and produces revision 2
    const saved2 = saveProjectModelPreferences(db, {
      projectId: "proj-alpha",
      expectedRevision: 1,
      preferences: { exclusions: [{ providerId: "codex" }] }
    });
    expect(saved2.revision).toBe(2);
    expect(saved2.preferences.exclusions).toEqual([{ providerId: "codex" }]);

    // Stale revision rejection on forget
    expect(() =>
      forgetProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 1
      })
    ).toThrow(/Stale project preference revision.*expected revision 1, but current revision is 2/);
  });

  it("preserves each new policy version and captures only the known legacy head before an edit", () => {
    db.prepare(
      `INSERT INTO workstation_project_model_preference
       (project_id, revision, payload_json, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL)`
    ).run("proj-alpha", 7, '{"projectId":"proj-alpha","modelWeights":{"legacy":1.5}}', 7000);

    const saved = saveProjectModelPreferences(db, {
      projectId: "proj-alpha", expectedRevision: 7,
      preferences: { modelWeights: { current: 1.8 } }
    }, 8000);
    expect(saved.revision).toBe(8);
    const history = listProjectModelPreferenceHistory(db, "proj-alpha");
    expect(history.map((entry) => [entry.revision, entry.changeKind]))
      .toEqual([[7, "legacy_baseline"], [8, "owner_save"]]);
    expect(history[0]?.preferences.modelWeights).toEqual({ legacy: 1.5 });
    expect(history[1]?.preferences.modelWeights).toEqual({ current: 1.8 });
    expect((db.prepare(
      `SELECT payload_json FROM workstation_project_model_preference_revision
       WHERE project_id = ? AND revision = 7`
    ).get("proj-alpha") as { payload_json: string }).payload_json)
      .toBe('{"projectId":"proj-alpha","modelWeights":{"legacy":1.5}}');

    expect(() => saveProjectModelPreferences(db, {
      projectId: "proj-alpha", expectedRevision: 7, preferences: {}
    }, 9000)).toThrow(/Stale project preference revision/);
    expect(listProjectModelPreferenceHistory(db, "proj-alpha")).toHaveLength(2);
    expect(listProjectModelPreferenceHistory(db, "proj-beta")).toEqual([]);
  });

  it("preserves a legacy V12 tombstone as an empty baseline when the owner later saves", () => {
    db.prepare(
      `INSERT INTO workstation_project_model_preference
       (project_id, revision, payload_json, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)`
    ).run("proj-alpha", 9,
      '{"projectId":"proj-alpha","exclusions":[],"modelWeights":{}}', 9000, 9000);
    saveProjectModelPreferences(db, {
      projectId: "proj-alpha", expectedRevision: 9,
      preferences: { providerWeights: { codex: 1.1 } }
    }, 10000);
    const history = listProjectModelPreferenceHistory(db, "proj-alpha");
    expect(history.map((entry) => [entry.revision, entry.changeKind, entry.deletedAt]))
      .toEqual([[9, "legacy_baseline", 9000], [10, "owner_save", null]]);
  });

  it("erases previous policy and proposal content on explicit forget, retaining only an empty revision tombstone", () => {
    saveProjectModelPreferences(db, {
      projectId: "proj-alpha", expectedRevision: 0,
      preferences: { modelWeights: { "secret-model": 1.8 } }
    }, 2000);
    saveProjectModelPreferences(db, {
      projectId: "proj-alpha", expectedRevision: 1,
      preferences: { modelWeights: { "secret-model": 1.6 } }
    }, 3000);
    db.prepare(
      `INSERT INTO workstation_project_model_adaptation_proposal
       (id, project_id, base_revision, base_deleted_at, catalog_sha256, catalog_json,
        evidence_sha256, evidence_refs_json, evidence_operations, delta_json,
        reasons_json, unknowns_json, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("proposal-one", "proj-alpha", 2, "a".repeat(64), "[]", "b".repeat(64),
      '[{"caseTurnId":"secret-receipt"}]', 1, '{"modelId":"secret-model"}',
      '["secret reason"]', "[]", 3500);
    expect(() => db.prepare(
      "UPDATE workstation_project_model_adaptation_proposal SET delta_json = ? WHERE id = ?"
    ).run("{}", "proposal-one")).toThrow(/immutable/);

    forgetProjectModelPreferences(db, { projectId: "proj-alpha", expectedRevision: 2 }, 4000);
    const history = listProjectModelPreferenceHistory(db, "proj-alpha");
    expect(history.map((entry) => [entry.revision, entry.changeKind]))
      .toEqual([[3, "owner_forget"]]);
    expect(history[0]?.preferences.modelWeights).toEqual({});
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM workstation_project_model_adaptation_proposal WHERE project_id = ?"
    ).get("proj-alpha")).toEqual({ count: 0 });
    const rawHistory = JSON.stringify(db.prepare(
      "SELECT * FROM workstation_project_model_preference_revision WHERE project_id = ?"
    ).all("proj-alpha"));
    expect(rawHistory).not.toContain("secret-model");
    expect(rawHistory).not.toContain("secret-receipt");

    saveProjectModelPreferences(db, {
      projectId: "proj-alpha", expectedRevision: 3,
      preferences: { modelWeights: { new: 1.2 } }
    }, 5000);
    expect(listProjectModelPreferenceHistory(db, "proj-alpha").map((entry) => entry.revision))
      .toEqual([3, 4]);
  });

  it("fails closed if a history head was changed independently of the V12 policy row", () => {
    saveProjectModelPreferences(db, {
      projectId: "proj-alpha", expectedRevision: 0,
      preferences: { modelWeights: { first: 1.1 } }
    }, 2000);
    db.prepare(
      `UPDATE workstation_project_model_preference
       SET payload_json = ? WHERE project_id = ? AND revision = 1`
    ).run('{"projectId":"proj-alpha","modelWeights":{"wrong":1.1}}', "proj-alpha");
    expect(() => saveProjectModelPreferences(db, {
      projectId: "proj-alpha", expectedRevision: 1,
      preferences: { modelWeights: { second: 1.2 } }
    }, 3000)).toThrow(/history\/current row mismatch/);
    expect(getProjectModelPreferences(db, "proj-alpha")?.revision).toBe(1);
    expect(() => db.prepare(
      `UPDATE workstation_project_model_preference_revision SET payload_json = ?
       WHERE project_id = ? AND revision = 1`
    ).run("{}", "proj-alpha")).toThrow(/immutable/);
  });

  it("supports forget/tombstone, erases sensitive prior payload JSON, and prevents resurrecting data", () => {
    saveProjectModelPreferences(
      db,
      {
        projectId: "proj-alpha",
        expectedRevision: 0,
        preferences: {
          exclusions: [{ providerId: "claude", modelId: "secret-model" }],
          providerWeights: { claude: 1.8 },
          modelWeights: { "secret-model": 2.0 },
          providerModelWeights: { claude: { "secret-model": 1.1 } },
          capabilityWeights: { proprietary: 1.5 }
        }
      },
      3000
    );

    const forgotten = forgetProjectModelPreferences(
      db,
      {
        projectId: "proj-alpha",
        expectedRevision: 1
      },
      4000
    );

    expect(forgotten.revision).toBe(2);
    expect(forgotten.deletedAt).toBe(4000);
    expect(forgotten.preferences.exclusions).toEqual([]);
    expect(forgotten.preferences.providerWeights).toEqual({});
    expect(forgotten.preferences.modelWeights).toEqual({});
    expect(forgotten.preferences.providerModelWeights).toEqual({});
    expect(forgotten.preferences.capabilityWeights).toEqual({});

    // Standard read returns null for forgotten preference
    expect(getProjectModelPreferences(db, "proj-alpha")).toBeNull();

    // Read with includeDeleted returns tombstone record with erased empty preferences
    const tombstone = getProjectModelPreferences(db, "proj-alpha", { includeDeleted: true });
    expect(tombstone).not.toBeNull();
    expect(tombstone?.revision).toBe(2);
    expect(tombstone?.deletedAt).toBe(4000);
    expect(tombstone?.preferences.exclusions).toEqual([]);
    expect(tombstone?.preferences.providerWeights).toEqual({});
    expect(tombstone?.preferences.modelWeights).toEqual({});
    expect(tombstone?.preferences.providerModelWeights).toEqual({});
    expect(tombstone?.preferences.capabilityWeights).toEqual({});

    // Inspect database row directly to guarantee prior sensitive payload JSON is wiped
    const rawRow = db
      .prepare("SELECT payload_json FROM workstation_project_model_preference WHERE project_id = ?")
      .get("proj-alpha") as { payload_json: string };

    expect(rawRow.payload_json).not.toContain("secret-model");
    expect(rawRow.payload_json).not.toContain("proprietary");

    // Attempting to forget already forgotten preference throws
    expect(() =>
      forgetProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 2
      })
    ).toThrow(/already forgotten/);

    // Reviving/saving with expectedRevision: 2 un-tombstones to revision 3
    const revived = saveProjectModelPreferences(
      db,
      {
        projectId: "proj-alpha",
        expectedRevision: 2,
        preferences: { exclusions: [{ providerId: "gemini1" }] }
      },
      5000
    );
    expect(revived.revision).toBe(3);
    expect(revived.deletedAt).toBeNull();
    expect(getProjectModelPreferences(db, "proj-alpha")?.preferences.exclusions).toEqual([
      { providerId: "gemini1" }
    ]);
  });

  it("enforces cross-project refusal and maintains project isolation", () => {
    // 1. Refuse saving when payload envelope specifies a different projectId
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 0,
        preferences: {
          projectId: "proj-beta",
          exclusions: [{ providerId: "claude" }]
        }
      })
    ).toThrow(/Cross-project refusal/);

    // 2. Refuse saving for a non-existent project
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "non-existent-project",
        expectedRevision: 0,
        preferences: { exclusions: [{ providerId: "claude" }] }
      })
    ).toThrow(/project 'non-existent-project' does not exist/);

    // 3. Refuse forget for a non-existent project
    expect(() =>
      forgetProjectModelPreferences(db, {
        projectId: "non-existent-project",
        expectedRevision: 1
      })
    ).toThrow(/project 'non-existent-project' does not exist/);

    // 4. Isolation between projects
    saveProjectModelPreferences(db, {
      projectId: "proj-alpha",
      expectedRevision: 0,
      preferences: { exclusions: [{ providerId: "claude" }] }
    });
    saveProjectModelPreferences(db, {
      projectId: "proj-beta",
      expectedRevision: 0,
      preferences: { exclusions: [{ providerId: "codex" }] }
    });

    expect(getProjectModelPreferences(db, "proj-alpha")?.preferences.exclusions).toEqual([
      { providerId: "claude" }
    ]);
    expect(getProjectModelPreferences(db, "proj-beta")?.preferences.exclusions).toEqual([
      { providerId: "codex" }
    ]);

    // Forgetting Alpha does not impact Beta
    forgetProjectModelPreferences(db, {
      projectId: "proj-alpha",
      expectedRevision: 1
    });

    expect(getProjectModelPreferences(db, "proj-alpha")).toBeNull();
    expect(getProjectModelPreferences(db, "proj-beta")).not.toBeNull();
  });

  it("rejects invented provider identifiers across exclusions and weights", () => {
    for (const invented of ["anthropic", "openai", "google", "ollama"]) {
      expect(() =>
        saveProjectModelPreferences(db, {
          projectId: "proj-alpha",
          expectedRevision: 0,
          preferences: {
            // @ts-expect-error test runtime rejection of invented provider
            exclusions: [{ providerId: invented }]
          }
        })
      ).toThrow();

      expect(() =>
        saveProjectModelPreferences(db, {
          projectId: "proj-alpha",
          expectedRevision: 0,
          preferences: {
            providerWeights: { [invented]: 1.0 }
          }
        })
      ).toThrow();
    }
  });

  it("strictly enforces finite bounded weights in 0..2 inclusive range", () => {
    // Weight boundary 0 is accepted
    const zeroWeight = saveProjectModelPreferences(db, {
      projectId: "proj-alpha",
      expectedRevision: 0,
      preferences: {
        providerWeights: { codex: MIN_WEIGHT }
      }
    });
    expect(zeroWeight.preferences.providerWeights?.codex).toBe(0);

    // Weight boundary 2 is accepted
    const maxWeight = saveProjectModelPreferences(db, {
      projectId: "proj-alpha",
      expectedRevision: 1,
      preferences: {
        providerWeights: { codex: MAX_WEIGHT }
      }
    });
    expect(maxWeight.preferences.providerWeights?.codex).toBe(2);

    // Negative weight (< 0) is rejected
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 2,
        preferences: {
          providerWeights: { codex: -0.1 }
        }
      })
    ).toThrow();

    // Weight > 2 is rejected
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 2,
        preferences: {
          providerWeights: { codex: 2.1 }
        }
      })
    ).toThrow();

    // Large weight (> 2, e.g. 1000) is rejected
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 2,
        preferences: {
          providerWeights: { codex: 1000 }
        }
      })
    ).toThrow();

    // Non-finite weight (NaN)
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 2,
        preferences: {
          providerWeights: { codex: Number.NaN }
        }
      })
    ).toThrow();

    // Non-finite weight (Infinity)
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 2,
        preferences: {
          providerWeights: { codex: Number.POSITIVE_INFINITY }
        }
      })
    ).toThrow();

    // Capability weight out of 0..2 range is rejected
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 2,
        preferences: {
          capabilityWeights: { coding: -0.5 }
        }
      })
    ).toThrow();

    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 2,
        preferences: {
          capabilityWeights: { coding: 2.5 }
        }
      })
    ).toThrow();
  });

  it("strictly enforces safe integers for revisions and timestamps", () => {
    // Non-integer expectedRevision on save
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 1.5,
        preferences: { exclusions: [{ providerId: "codex" }] }
      })
    ).toThrow(/non-negative safe integer/);

    // Negative expectedRevision on save
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: -1,
        preferences: { exclusions: [{ providerId: "codex" }] }
      })
    ).toThrow(/non-negative safe integer/);

    // Non-safe-integer timestamp
    expect(() =>
      saveProjectModelPreferences(
        db,
        {
          projectId: "proj-alpha",
          expectedRevision: 0,
          preferences: { exclusions: [{ providerId: "codex" }] }
        },
        123.456
      )
    ).toThrow(/positive safe integer/);

    // Negative timestamp
    expect(() =>
      saveProjectModelPreferences(
        db,
        {
          projectId: "proj-alpha",
          expectedRevision: 0,
          preferences: { exclusions: [{ providerId: "codex" }] }
        },
        -1000
      )
    ).toThrow(/positive safe integer/);
  });

  it("fails closed on corrupt DB row (corrupt JSON, invalid schema, or invalid integers)", () => {
    // 1. Direct corrupt JSON syntax injection
    db.prepare(
      `INSERT INTO workstation_project_model_preference
       (project_id, revision, payload_json, updated_at, deleted_at)
       VALUES (?, 1, ?, 1000, NULL)`
    ).run("proj-alpha", "{ corrupt: json syntax --");

    expect(() => getProjectModelPreferences(db, "proj-alpha")).toThrow(
      /Corrupt project preferences JSON/
    );

    // 2. Direct schema violation injection (invalid provider ID)
    db.prepare(
      `UPDATE workstation_project_model_preference
       SET payload_json = ?
       WHERE project_id = ?`
    ).run(
      JSON.stringify({ exclusions: [{ providerId: "unsupported-provider" }] }),
      "proj-alpha"
    );

    expect(() => getProjectModelPreferences(db, "proj-alpha")).toThrow();

    // The table constraint rejects revision 0. A non-integer revision still
    // passes SQLite's >= 1 check and must be rejected by the reader.
    db.prepare(
      `UPDATE workstation_project_model_preference
       SET revision = 1.5
       WHERE project_id = ?`
    ).run("proj-alpha");

    expect(() => getProjectModelPreferences(db, "proj-alpha")).toThrow(
      /must be a safe integer/
    );

    // Corrupt updated_at in row (non-positive)
    db.prepare(
      `UPDATE workstation_project_model_preference
       SET revision = 1, updated_at = 0
       WHERE project_id = ?`
    ).run("proj-alpha");

    expect(() => getProjectModelPreferences(db, "proj-alpha")).toThrow(
      /updated_at must be positive/
    );

    // 6. Corrupt deleted_at in row (negative timestamp)
    db.prepare(
      `UPDATE workstation_project_model_preference
       SET updated_at = 1000, deleted_at = -50
       WHERE project_id = ?`
    ).run("proj-alpha");

    expect(() =>
      getProjectModelPreferences(db, "proj-alpha", { includeDeleted: true })
    ).toThrow(/deleted_at must be positive/);
  });

  it("fails closed on oversized inputs without silent truncation", () => {
    // Oversized exclusion array fails closed
    const oversizedExclusions: ModelExclusion[] = Array.from(
      { length: MAX_EXCLUSIONS + 1 },
      () => ({ providerId: "claude" as const })
    );

    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 0,
        preferences: { exclusions: oversizedExclusions }
      })
    ).toThrow(/Exclusions exceed maximum/);

    // Oversized modelId fails closed
    const invalidModelId = "m".repeat(MAX_MODEL_ID_LENGTH + 1);
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 0,
        preferences: {
          exclusions: [{ providerId: "claude", modelId: invalidModelId }]
        }
      })
    ).toThrow(/Model ID exceeds maximum length/);

    // Path traversal modelId fails closed
    expect(() =>
      saveProjectModelPreferences(db, {
        projectId: "proj-alpha",
        expectedRevision: 0,
        preferences: {
          exclusions: [{ providerId: "claude", modelId: "../malicious/path" }]
        }
      })
    ).toThrow(/Model ID cannot contain path traversal/);
  });

  it("cascades deletion when workstation_project is deleted", () => {
    saveProjectModelPreferences(db, {
      projectId: "proj-alpha",
      expectedRevision: 0,
      preferences: { exclusions: [{ providerId: "claude" }] }
    });

    expect(getProjectModelPreferences(db, "proj-alpha")).not.toBeNull();

    db.prepare("DELETE FROM workstation_project WHERE id = ?").run("proj-alpha");

    expect(getProjectModelPreferences(db, "proj-alpha")).toBeNull();
  });
});
