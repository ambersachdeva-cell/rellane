import { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { MIGRATIONS } from "../book/schema.js";
import { saveWorkstationProject } from "./projects.js";
import { installModelPreferencesIpc } from "./model-preferences-ipc.js";

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } }));

const trusted = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const untrusted = { sender: { id: 2 } } as unknown as IpcMainInvokeEvent;

describe("trusted project model preference IPC", () => {
  let db: DatabaseSync;
  let projectId: string;
  let otherId: string;
  beforeEach(() => {
    handlers.clear();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    projectId = saveWorkstationProject(db, { title: "One", brief: "One brief" }).id;
    otherId = saveWorkstationProject(db, { title: "Two", brief: "Two brief" }).id;
  });
  afterEach(() => db.close());

  it("rejects foreign senders before opening Book or mutating policy", async () => {
    let bookReads = 0;
    installModelPreferencesIpc({
      assertTrusted: (event) => { if (event !== trusted) throw new Error("Untrusted sender"); },
      book: () => { bookReads += 1; return db; }
    });
    for (const [channel, input] of [
      [IPC_CHANNELS.workstationModelPreferencesRead, { projectId }],
      [IPC_CHANNELS.workstationModelPreferencesSave, { projectId, expectedRevision: 0, preferences: {} }],
      [IPC_CHANNELS.workstationModelPreferencesForget, { projectId, expectedRevision: 1 }]
    ] as const) {
      await expect(handlers.get(channel)!(untrusted, input)).rejects.toThrow("Untrusted sender");
    }
    expect(bookReads).toBe(0);
  });

  it("persists exact exclusions with revisions, forgets them, and preserves tombstone revision", async () => {
    installModelPreferencesIpc({ assertTrusted: () => {}, book: () => db });
    const read = handlers.get(IPC_CHANNELS.workstationModelPreferencesRead)!;
    const save = handlers.get(IPC_CHANNELS.workstationModelPreferencesSave)!;
    const forget = handlers.get(IPC_CHANNELS.workstationModelPreferencesForget)!;
    expect(await read(trusted, { projectId })).toBeNull();
    const first = await save(trusted, { projectId, expectedRevision: 0,
      preferences: { projectId, exclusions: [{ providerId: "gemini1" }],
        providerWeights: { claude: 1.5 } }
    }) as { revision: number; preferences: { exclusions: readonly { providerId: string }[] } };
    expect(first.revision).toBe(1);
    expect(first.preferences.exclusions).toEqual([{ providerId: "gemini1" }]);
    await expect(save(trusted, { projectId, expectedRevision: 0, preferences: {} }))
      .rejects.toThrow(/Stale project preference revision/);
    await expect(save(trusted, { projectId, expectedRevision: 1,
      preferences: { projectId: otherId, exclusions: [{ providerId: "claude" }] }
    })).rejects.toThrow(/Cross-project refusal/);
    await expect(save(trusted, { projectId, expectedRevision: 1,
      preferences: { exclusions: [{ providerId: "invented" }] }
    })).rejects.toThrow();
    const forgotten = await forget(trusted, { projectId, expectedRevision: 1 }) as {
      revision: number; deletedAt: number; preferences: { exclusions: readonly unknown[] }
    };
    expect(forgotten.revision).toBe(2);
    expect(forgotten.deletedAt).toBeGreaterThan(0);
    expect(forgotten.preferences.exclusions).toEqual([]);
    expect(await read(trusted, { projectId })).toMatchObject({ revision: 2, deletedAt: forgotten.deletedAt });
    const revived = await save(trusted, { projectId, expectedRevision: 2,
      preferences: { exclusions: [{ providerId: "claude", modelId: "sonnet" }] }
    }) as { revision: number; deletedAt: number | null };
    expect(revived.revision).toBe(3);
    expect(revived.deletedAt).toBeNull();
    expect(await read(trusted, { projectId: otherId })).toBeNull();
    await expect(read(trusted, { projectId, extra: true })).rejects.toThrow();
  });
});
