import { describe, it, expect } from "vitest";
import type { CaseTurnView } from "@cadrane/contracts";
import { createCanvas, addNode, type InfiniteCanvas } from "./canvas-model.js";
import {
  CANVAS_DRAFT_SCHEMA_VERSION,
  getCanvasDraftKey,
  loadCanvasDraft,
  parseAndValidateDraft,
  saveCanvasDraft,
  removeCanvasDraft,
  reconcileCanvasWithTurns,
  createInitialCanvasFromTurns,
  type StorageLike
} from "./canvas-draft-store.js";

function createMemoryStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    }
  };
}

describe("canvas-draft-store adapter", () => {
  it("saves and loads valid canvas drafts", () => {
    const storage = createMemoryStorage();
    let canvas = createCanvas("case-alpha", "Alpha Case");
    canvas = addNode(canvas, {
      id: "node-1",
      type: "card",
      title: "Card 1",
      content: "Content 1",
      x: 100,
      y: 120,
      width: 260,
      height: 160,
      metadata: { sourceRevision: 3, tags: ["reviewed"], nested: { editable: true } }
    });

    const saveRes = saveCanvasDraft("case-alpha", canvas, storage);
    expect(saveRes.success).toBe(true);

    const loaded = loadCanvasDraft("case-alpha", storage);
    expect(loaded.status).toBe("loaded");
    if (loaded.status === "loaded") {
      expect(loaded.draft.nodes.length).toBe(1);
      expect(loaded.draft.nodes[0]!.title).toBe("Card 1");
      expect(loaded.draft.nodes[0]!.x).toBe(100);
      expect(loaded.draft.nodes[0]!.metadata).toEqual(canvas.nodes[0]!.metadata);
    }
  });

  it("detects syntax corruption without deleting or throwing", () => {
    const malformed = "{ not valid json ";
    const storage = createMemoryStorage({
      [getCanvasDraftKey("case-beta")]: malformed
    });

    const result = loadCanvasDraft("case-beta", storage);
    expect(result.status).toBe("corrupted");
    if (result.status === "corrupted") {
      expect(result.raw).toBe(malformed);
    }
    // Ensures corrupt entry was not overwritten or removed
    expect(storage.getItem(getCanvasDraftKey("case-beta"))).toBe(malformed);
  });

  it("detects version mismatch and preserves stored payload for recovery", () => {
    const futureDraft = JSON.stringify({
      schemaVersion: 99,
      caseId: "case-future",
      savedAt: new Date().toISOString(),
      canvas: createCanvas("case-future", "Future")
    });
    const storage = createMemoryStorage({
      [getCanvasDraftKey("case-future")]: futureDraft
    });

    const result = loadCanvasDraft("case-future", storage);
    expect(result.status).toBe("version_mismatch");
    if (result.status === "version_mismatch") {
      expect(result.storedVersion).toBe(99);
      expect(result.raw).toBe(futureDraft);
    }
    expect(storage.getItem(getCanvasDraftKey("case-future"))).toBe(futureDraft);
  });

  it("detects invalid node geometry and corrupt envelope fields", () => {
    const badNodePayload = JSON.stringify({
      schemaVersion: CANVAS_DRAFT_SCHEMA_VERSION,
      caseId: "case-bad",
      savedAt: new Date().toISOString(),
      canvas: {
        id: "case-bad",
        title: "Bad",
        nodes: [{ id: "n1", type: "invalid_type", title: "T", content: "C", x: "bad", y: 0, width: 0, height: -1 }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        selectedNodeIds: []
      }
    });

    const result = parseAndValidateDraft(badNodePayload, "case-bad");
    expect(result.status).toBe("corrupted");
  });

  it("handles quota failure gracefully and returns honest warning", () => {
    const quotaErr = new Error("QuotaExceededError");
    quotaErr.name = "QuotaExceededError";
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw quotaErr;
      }
    };

    const canvas = createCanvas("case-quota", "Quota Case");
    const res = saveCanvasDraft("case-quota", canvas, storage);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.quotaExceeded).toBe(true);
      expect(res.error).toMatch(/quota/i);
    }
  });

  it("reconciles new source turns without shifting existing user layout", () => {
    let draft = createCanvas("case-reconcile", "Title");
    draft = addNode(draft, {
      id: "turn-t1",
      type: "card",
      title: "User Moved Card",
      content: "Custom edited note",
      x: 500,
      y: 400,
      width: 260,
      height: 160
    });

    const turns: CaseTurnView[] = [
      { id: "t1", seq: 1, seat: "owner", kind: "request", body: "Turn 1 text", createdAt: "2026-09-24T00:00:00Z" } as unknown as CaseTurnView,
      { id: "t2", seq: 2, seat: "Workstation · Assistant", kind: "response", body: "Turn 2 text", createdAt: "2026-09-24T00:01:00Z" } as unknown as CaseTurnView
    ];

    const reconciled = reconcileCanvasWithTurns(draft, turns);
    expect(reconciled.nodes.length).toBe(2);

    // Existing user-modified node position and content preserved
    const node1 = reconciled.nodes.find((n) => n.id === "turn-t1");
    expect(node1?.x).toBe(500);
    expect(node1?.y).toBe(400);
    expect(node1?.content).toBe("Custom edited note");

    // New turn appended below
    const node2 = reconciled.nodes.find((n) => n.id === "turn-t2");
    expect(node2).toBeDefined();
    expect(node2!.y).toBeGreaterThanOrEqual(560); // 400 + 160
  });

  it("detects topology errors including duplicates, missing targets, and invalid zoom", () => {
    const base = {
      schemaVersion: CANVAS_DRAFT_SCHEMA_VERSION,
      caseId: "case-top",
      savedAt: new Date().toISOString(),
      canvas: {
        id: "case-top",
        title: "Top",
        nodes: [{ id: "n1", type: "card", title: "N1", content: "C", x: 0, y: 0, width: 100, height: 100 }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        selectedNodeIds: []
      }
    };

    const dupNodes = JSON.parse(JSON.stringify(base));
    dupNodes.canvas.nodes.push({ id: "n1", type: "card", title: "Dup", content: "C", x: 10, y: 10, width: 100, height: 100 });
    expect(parseAndValidateDraft(JSON.stringify(dupNodes), "case-top").status).toBe("corrupted");

    const badEdge = JSON.parse(JSON.stringify(base));
    badEdge.canvas.edges.push({ id: "e1", sourceId: "n1", targetId: "missing" });
    expect(parseAndValidateDraft(JSON.stringify(badEdge), "case-top").status).toBe("corrupted");

    const badSel = JSON.parse(JSON.stringify(base));
    badSel.canvas.selectedNodeIds = ["ghost"];
    expect(parseAndValidateDraft(JSON.stringify(badSel), "case-top").status).toBe("corrupted");

    const badId = JSON.parse(JSON.stringify(base));
    badId.canvas.id = "different-case";
    expect(parseAndValidateDraft(JSON.stringify(badId), "case-top").status).toBe("corrupted");

    const badZoom = JSON.parse(JSON.stringify(base));
    badZoom.canvas.viewport.zoom = 10;
    expect(parseAndValidateDraft(JSON.stringify(badZoom), "case-top").status).toBe("corrupted");
  });

  it("refuses to overwrite existing corrupted draft in storage", () => {
    const corruptPayload = "{ invalid json ";
    const storage = createMemoryStorage({
      [getCanvasDraftKey("case-protect")]: corruptPayload
    });

    const newCanvas = createCanvas("case-protect", "Attempted Overwrite");
    const saveRes = saveCanvasDraft("case-protect", newCanvas, storage);

    expect(saveRes.success).toBe(false);
    if (saveRes.success) throw new Error("Corrupt stored draft was overwritten.");
    expect(saveRes.error).toMatch(/cannot overwrite/i);
    expect(storage.getItem(getCanvasDraftKey("case-protect"))).toBe(corruptPayload);
  });

  it("truthfully reports storage_unavailable and read_error without masquerading", () => {
    const unavail = loadCanvasDraft("case-none", null);
    expect(unavail.status).toBe("storage_unavailable");

    const throwStorage: StorageLike = {
      getItem: () => {
        throw new Error("PermissionDenied");
      },
      setItem: () => {}
    };
    const readErr = loadCanvasDraft("case-denied", throwStorage);
    expect(readErr.status).toBe("read_error");

    expect(removeCanvasDraft("case-del", null).success).toBe(false);
    const mem = createMemoryStorage({ [getCanvasDraftKey("case-del")]: "data" });
    expect(removeCanvasDraft("case-del", mem).success).toBe(true);
    expect(mem.getItem(getCanvasDraftKey("case-del"))).toBeNull();
  });
});
