/**
 * Case-scoped recoverable local draft adapter for WorkroomCanvas view state.
 * Provides schema versioning, strict payload validation, quota failure handling,
 * and non-destructive reconciliation with incoming source turns.
 */

import { z } from "zod";
import type { CaseTurnView } from "@cadrane/contracts";
import {
  createCanvas,
  addNode,
  connectNodes,
  type CanvasNode,
  type CanvasNodeType,
  type InfiniteCanvas
} from "./canvas-model.js";

export const CANVAS_DRAFT_SCHEMA_VERSION = 1;
export const CANVAS_DRAFT_KEY_PREFIX = "cadrane:workroom:canvas-draft:";

export function getCanvasDraftKey(caseId: string): string {
  return `${CANVAS_DRAFT_KEY_PREFIX}${caseId}`;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface StoredCanvasDraftEnvelope {
  readonly schemaVersion: number;
  readonly caseId: string;
  readonly savedAt: string;
  readonly canvas: InfiniteCanvas;
}

export type LoadDraftResult =
  | { readonly status: "not_found" }
  | { readonly status: "loaded"; readonly draft: InfiniteCanvas; readonly savedAt: string }
  | { readonly status: "corrupted"; readonly error: string; readonly raw: string }
  | {
      readonly status: "version_mismatch";
      readonly error: string;
      readonly storedVersion?: unknown;
      readonly raw: string;
    }
  | { readonly status: "storage_unavailable"; readonly error: string }
  | { readonly status: "read_error"; readonly error: string };

export type RemoveDraftResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: string };

export type SaveDraftResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: string; readonly quotaExceeded?: boolean };

export function getDefaultStorage(): StorageLike | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

const canvasNodeTypeSchema = z.enum(["card", "note", "snippet", "chart", "source"]);
const canvasEdgeStyleSchema = z.enum(["solid", "dashed", "arrow"]);

const canvasNodeSchema = z.object({
  id: z.string().min(1),
  type: canvasNodeTypeSchema,
  title: z.string(),
  content: z.string(),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  color: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const canvasEdgeSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  label: z.string().optional(),
  style: canvasEdgeStyleSchema.optional()
});

const canvasViewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().min(0.1).max(3.0)
});

const infiniteCanvasSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    nodes: z.array(canvasNodeSchema),
    edges: z.array(canvasEdgeSchema),
    viewport: canvasViewportSchema,
    selectedNodeIds: z.array(z.string())
  })
  .superRefine((c, ctx) => {
    const nodeIds = new Set<string>();
    for (const n of c.nodes) {
      if (nodeIds.has(n.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate node ID: ${n.id}` });
      }
      nodeIds.add(n.id);
    }
    for (const e of c.edges) {
      if (!nodeIds.has(e.sourceId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Edge ${e.id} missing sourceId: ${e.sourceId}` });
      }
      if (!nodeIds.has(e.targetId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Edge ${e.id} missing targetId: ${e.targetId}` });
      }
    }
    for (const s of c.selectedNodeIds) {
      if (!nodeIds.has(s)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Selected node not found: ${s}` });
      }
    }
  });

const storedEnvelopeSchema = z
  .object({
    schemaVersion: z.number().int(),
    caseId: z.string().min(1),
    savedAt: z.string().min(1),
    canvas: infiniteCanvasSchema
  })
  .superRefine((env, ctx) => {
    if (env.canvas.id !== env.caseId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "canvas.id must match envelope caseId" });
    }
  });

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
    return {
      status: "corrupted",
      error: "Stored draft root is not an object",
      raw
    };
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record["schemaVersion"] === "number" && record["schemaVersion"] !== CANVAS_DRAFT_SCHEMA_VERSION) {
    return {
      status: "version_mismatch",
      error: `Unsupported schema version: expected ${CANVAS_DRAFT_SCHEMA_VERSION}, received ${String(record["schemaVersion"])}`,
      storedVersion: record["schemaVersion"],
      raw
    };
  }

  const parseResult = storedEnvelopeSchema.safeParse(parsed);
  if (!parseResult.success) {
    return {
      status: "corrupted",
      error: parseResult.error.issues.map((i) => i.message).join("; "),
      raw
    };
  }

  if (parseResult.data.caseId !== expectedCaseId) {
    return {
      status: "corrupted",
      error: `Stored draft caseId mismatch: expected "${expectedCaseId}", received "${parseResult.data.caseId}"`,
      raw
    };
  }

  return {
    status: "loaded",
    draft: parseResult.data.canvas as InfiniteCanvas,
    savedAt: parseResult.data.savedAt
  };
}

export function loadCanvasDraft(
  caseId: string,
  storage: StorageLike | null = getDefaultStorage()
): LoadDraftResult {
  if (!storage) {
    return {
      status: "storage_unavailable",
      error: "Local draft storage unavailable: changes are kept in memory only."
    };
  }
  try {
    const raw = storage.getItem(getCanvasDraftKey(caseId));
    if (raw === null || raw.trim().length === 0) {
      return { status: "not_found" };
    }
    return parseAndValidateDraft(raw, caseId);
  } catch (err) {
    return {
      status: "read_error",
      error: `Storage read denied or failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export function saveCanvasDraft(
  caseId: string,
  canvas: InfiniteCanvas,
  storage: StorageLike | null = getDefaultStorage()
): SaveDraftResult {
  if (!storage) {
    return {
      success: false,
      error: "Local draft storage unavailable: changes are kept in memory only.",
      quotaExceeded: false
    };
  }
  try {
    const key = getCanvasDraftKey(caseId);
    const existingRaw = storage.getItem(key);
    if (existingRaw !== null && existingRaw.trim().length > 0) {
      const validation = parseAndValidateDraft(existingRaw, caseId);
      if (validation.status === "corrupted" || validation.status === "version_mismatch") {
        return {
          success: false,
          error: "Cannot overwrite invalid or unsupported stored draft. Persistence is disabled to preserve data for recovery; changes are kept in memory only."
        };
      }
    }

    const envelope: StoredCanvasDraftEnvelope = {
      schemaVersion: CANVAS_DRAFT_SCHEMA_VERSION,
      caseId,
      savedAt: new Date().toISOString(),
      canvas
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

    const message = isQuota
      ? "Storage quota exceeded. Draft could not be saved to local storage; in-memory changes will be lost if closed."
      : `Storage error: ${err instanceof Error ? err.message : String(err)}`;

    return {
      success: false,
      error: message,
      quotaExceeded: Boolean(isQuota)
    };
  }
}

export function removeCanvasDraft(
  caseId: string,
  storage: StorageLike | null = getDefaultStorage()
): RemoveDraftResult {
  if (!storage) {
    return { success: false, error: "Draft storage unavailable" };
  }
  if (!storage.removeItem) {
    return { success: false, error: "Storage does not support item removal" };
  }
  try {
    storage.removeItem(getCanvasDraftKey(caseId));
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `Storage error removing draft: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export function createInitialCanvasFromTurns(
  caseId: string,
  title: string,
  turns: readonly CaseTurnView[]
): InfiniteCanvas {
  let initial = createCanvas(caseId, title);
  let xOffset = 60;
  let yOffset = 80;
  let previousNodeId: string | null = null;

  for (const turn of turns) {
    if (!turn.body.trim()) continue;
    const isOwner = turn.seat === "owner";
    const isSource = turn.kind === "verbatim";
    const nodeType: CanvasNodeType = isSource ? "source" : isOwner ? "card" : "snippet";
    const nodeTitle = isSource
      ? "Source Context"
      : isOwner
      ? `Request #${turn.seq}`
      : `${turn.seat.replace(/^Workstation · /u, "")} #${turn.seq}`;

    const nodeId = `turn-${turn.id}`;
    const node: CanvasNode = {
      id: nodeId,
      type: nodeType,
      title: nodeTitle,
      content: turn.body.length > 280 ? `${turn.body.slice(0, 277)}…` : turn.body,
      x: xOffset,
      y: yOffset,
      width: 260,
      height: 160,
      color: isOwner ? "#3b82f6" : isSource ? "#10b981" : "#8b5cf6"
    };

    initial = addNode(initial, node);
    if (previousNodeId) {
      initial = connectNodes(initial, previousNodeId, nodeId, undefined, "arrow");
    }
    previousNodeId = nodeId;

    xOffset += 320;
    if (xOffset > 1000) {
      xOffset = 60;
      yOffset += 220;
    }
  }

  return initial;
}

export function reconcileCanvasWithTurns(
  draft: InfiniteCanvas,
  turns: readonly CaseTurnView[]
): InfiniteCanvas {
  const existingNodeIds = new Set(draft.nodes.map((n) => n.id));
  const newTurns = turns.filter(
    (t) => t.body.trim().length > 0 && !existingNodeIds.has(`turn-${t.id}`)
  );

  if (newTurns.length === 0) {
    return draft;
  }

  let maxY = 80;
  for (const node of draft.nodes) {
    const bottom = node.y + node.height;
    if (bottom > maxY) maxY = bottom;
  }

  let xOffset = 60;
  let yOffset = maxY + 60;
  let result = draft;
  let previousNodeId: string | null =
    draft.nodes.length > 0 ? draft.nodes[draft.nodes.length - 1]!.id : null;

  for (const turn of newTurns) {
    const isOwner = turn.seat === "owner";
    const isSource = turn.kind === "verbatim";
    const nodeType: CanvasNodeType = isSource ? "source" : isOwner ? "card" : "snippet";
    const nodeTitle = isSource
      ? "Source Context"
      : isOwner
      ? `Request #${turn.seq}`
      : `${turn.seat.replace(/^Workstation · /u, "")} #${turn.seq}`;

    const nodeId = `turn-${turn.id}`;
    const node: CanvasNode = {
      id: nodeId,
      type: nodeType,
      title: nodeTitle,
      content: turn.body.length > 280 ? `${turn.body.slice(0, 277)}…` : turn.body,
      x: xOffset,
      y: yOffset,
      width: 260,
      height: 160,
      color: isOwner ? "#3b82f6" : isSource ? "#10b981" : "#8b5cf6"
    };

    result = addNode(result, node);
    if (previousNodeId) {
      result = connectNodes(result, previousNodeId, nodeId, undefined, "arrow");
    }
    previousNodeId = nodeId;

    xOffset += 320;
    if (xOffset > 1000) {
      xOffset = 60;
      yOffset += 220;
    }
  }

  return result;
}
