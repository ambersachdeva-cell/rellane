/**
 * Spatial infinite canvas data model and SVG export for Rellane project workrooms.
 * Organises cards, notes, code snippets, charts, and sources on a 2D plane with
 * pure immutable updates, viewport management, and standalone vector export.
 */

export type CanvasNodeType = "card" | "note" | "snippet" | "chart" | "source";

export interface CanvasNode {
  readonly id: string;
  readonly type: CanvasNodeType;
  readonly title: string;
  readonly content: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CanvasEdge {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly label?: string;
  readonly style?: "solid" | "dashed" | "arrow";
}

export interface CanvasViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number; // clamped between 0.1 and 3.0
}

export interface InfiniteCanvas {
  readonly id: string;
  readonly title: string;
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  readonly viewport: CanvasViewport;
  readonly selectedNodeIds: readonly string[];
}

export interface CanvasBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3.0;
const DEFAULT_NODE_WIDTH = 200;
const DEFAULT_NODE_HEIGHT = 150;
const DEFAULT_VIEWPORT_PADDING = 40;

export function createCanvas(id: string, title: string): InfiniteCanvas {
  return {
    id,
    title,
    nodes: [],
    edges: [],
    viewport: {
      x: 0,
      y: 0,
      zoom: 1.0,
    },
    selectedNodeIds: [],
  };
}

export function addNode(canvas: InfiniteCanvas, node: CanvasNode): InfiniteCanvas {
  const existingIndex = canvas.nodes.findIndex((n) => n.id === node.id);
  const nextNodes =
    existingIndex >= 0
      ? canvas.nodes.map((n, i) => (i === existingIndex ? node : n))
      : [...canvas.nodes, node];

  return {
    ...canvas,
    nodes: nextNodes,
  };
}

export function updateNode(
  canvas: InfiniteCanvas,
  nodeId: string,
  patch: Partial<Omit<CanvasNode, "id">>,
): InfiniteCanvas {
  const targetIndex = canvas.nodes.findIndex((n) => n.id === nodeId);
  if (targetIndex < 0) {
    return canvas;
  }
  const current = canvas.nodes[targetIndex]!;

  // Under exactOptionalPropertyTypes, optional keys must be omitted rather than assigned undefined
  const resolvedColor = patch.color !== undefined ? patch.color : current.color;
  const resolvedMetadata = patch.metadata !== undefined ? patch.metadata : current.metadata;

  const updatedNode: CanvasNode = {
    id: current.id,
    type: patch.type !== undefined ? patch.type : current.type,
    title: patch.title !== undefined ? patch.title : current.title,
    content: patch.content !== undefined ? patch.content : current.content,
    x: patch.x !== undefined ? patch.x : current.x,
    y: patch.y !== undefined ? patch.y : current.y,
    width: patch.width !== undefined ? patch.width : current.width,
    height: patch.height !== undefined ? patch.height : current.height,
    ...(resolvedColor !== undefined ? { color: resolvedColor } : {}),
    ...(resolvedMetadata !== undefined ? { metadata: resolvedMetadata } : {}),
  };

  const nextNodes = canvas.nodes.map((n, i) => (i === targetIndex ? updatedNode : n));
  return {
    ...canvas,
    nodes: nextNodes,
  };
}

export function removeNode(canvas: InfiniteCanvas, nodeId: string): InfiniteCanvas {
  // Removing a node cascades to delete any connecting edges to eliminate dangling references
  const nodes = canvas.nodes.filter((n) => n.id !== nodeId);
  const edges = canvas.edges.filter((e) => e.sourceId !== nodeId && e.targetId !== nodeId);
  const selectedNodeIds = canvas.selectedNodeIds.filter((id) => id !== nodeId);

  return {
    ...canvas,
    nodes,
    edges,
    selectedNodeIds,
  };
}

export function connectNodes(
  canvas: InfiniteCanvas,
  sourceId: string,
  targetId: string,
  label?: string,
  style?: "solid" | "dashed" | "arrow",
): InfiniteCanvas {
  let counter = 1;
  let candidateId = `edge-${sourceId}-${targetId}`;
  while (canvas.edges.some((e) => e.id === candidateId)) {
    counter += 1;
    candidateId = `edge-${sourceId}-${targetId}-${counter}`;
  }

  const newEdge: CanvasEdge = {
    id: candidateId,
    sourceId,
    targetId,
    ...(label !== undefined ? { label } : {}),
    ...(style !== undefined ? { style } : {}),
  };

  return {
    ...canvas,
    edges: [...canvas.edges, newEdge],
  };
}

export function disconnectNodes(canvas: InfiniteCanvas, edgeId: string): InfiniteCanvas {
  return {
    ...canvas,
    edges: canvas.edges.filter((e) => e.id !== edgeId),
  };
}

export function panViewport(canvas: InfiniteCanvas, dx: number, dy: number): InfiniteCanvas {
  const deltaX = Number.isFinite(dx) ? dx : 0;
  const deltaY = Number.isFinite(dy) ? dy : 0;

  return {
    ...canvas,
    viewport: {
      ...canvas.viewport,
      x: canvas.viewport.x + deltaX,
      y: canvas.viewport.y + deltaY,
    },
  };
}

export function zoomViewport(
  canvas: InfiniteCanvas,
  factor: number,
  center?: { x: number; y: number },
): InfiniteCanvas {
  if (!Number.isFinite(factor) || factor <= 0) {
    return canvas;
  }

  const currentZoom = canvas.viewport.zoom;
  const targetZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom * factor));

  // Zooming around a focal center adjusts camera origin so the cursor point remains stationary
  if (center !== undefined && Number.isFinite(center.x) && Number.isFinite(center.y)) {
    const scale = targetZoom / currentZoom;
    const nextX = center.x - (center.x - canvas.viewport.x) * scale;
    const nextY = center.y - (center.y - canvas.viewport.y) * scale;
    return {
      ...canvas,
      viewport: {
        x: nextX,
        y: nextY,
        zoom: targetZoom,
      },
    };
  }

  return {
    ...canvas,
    viewport: {
      ...canvas.viewport,
      zoom: targetZoom,
    },
  };
}

export function calculateBounds(nodes: readonly CanvasNode[]): CanvasBounds {
  if (nodes.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
    };
  }

  const first = nodes[0]!;
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x + first.width;
  let maxY = first.y + first.height;

  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.x < minX) {
      minX = node.x;
    }
    if (node.y < minY) {
      minY = node.y;
    }
    const right = node.x + node.width;
    const bottom = node.y + node.height;
    if (right > maxX) {
      maxX = right;
    }
    if (bottom > maxY) {
      maxY = bottom;
    }
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

export function fitToScreen(
  canvas: InfiniteCanvas,
  screenWidth: number,
  screenHeight: number,
  padding?: number,
): InfiniteCanvas {
  if (
    !Number.isFinite(screenWidth) ||
    !Number.isFinite(screenHeight) ||
    screenWidth <= 0 ||
    screenHeight <= 0
  ) {
    return canvas;
  }

  if (canvas.nodes.length === 0) {
    return {
      ...canvas,
      viewport: {
        x: 0,
        y: 0,
        zoom: 1.0,
      },
    };
  }

  const pad =
    padding !== undefined && Number.isFinite(padding) && padding >= 0
      ? padding
      : DEFAULT_VIEWPORT_PADDING;

  const availableWidth = Math.max(1, screenWidth - pad * 2);
  const availableHeight = Math.max(1, screenHeight - pad * 2);

  const bounds = calculateBounds(canvas.nodes);
  const boundsWidth = Math.max(1, bounds.width);
  const boundsHeight = Math.max(1, bounds.height);

  const scaleX = availableWidth / boundsWidth;
  const scaleY = availableHeight / boundsHeight;
  const rawZoom = Math.min(scaleX, scaleY);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, rawZoom));

  const boundsCenterX = bounds.minX + bounds.width / 2;
  const boundsCenterY = bounds.minY + bounds.height / 2;

  // Centres the content bounding box in screen coordinates at the determined zoom level
  const viewportX = screenWidth / 2 - boundsCenterX * zoom;
  const viewportY = screenHeight / 2 - boundsCenterY * zoom;

  return {
    ...canvas,
    viewport: {
      x: viewportX,
      y: viewportY,
      zoom,
    },
  };
}

export function serializeCanvas(canvas: InfiniteCanvas): string {
  return JSON.stringify(canvas, null, 2);
}

function isValidNodeType(type: unknown): type is CanvasNodeType {
  return (
    type === "card" ||
    type === "note" ||
    type === "snippet" ||
    type === "chart" ||
    type === "source"
  );
}

function isValidEdgeStyle(style: unknown): style is "solid" | "dashed" | "arrow" {
  return style === "solid" || style === "dashed" || style === "arrow";
}

export function deserializeCanvas(raw: string): InfiniteCanvas {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return createCanvas("canvas-recovered", "Untitled Canvas");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createCanvas("canvas-recovered", "Untitled Canvas");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return createCanvas("canvas-recovered", "Untitled Canvas");
  }

  const record = parsed as Record<string, unknown>;
  const id =
    typeof record["id"] === "string" && record["id"].trim().length > 0
      ? record["id"]
      : "canvas-recovered";
  const title =
    typeof record["title"] === "string" && record["title"].trim().length > 0
      ? record["title"]
      : "Untitled Canvas";

  const rawNodes = Array.isArray(record["nodes"]) ? record["nodes"] : [];
  const nodes: CanvasNode[] = [];
  for (let i = 0; i < rawNodes.length; i++) {
    const rawNode = rawNodes[i];
    if (typeof rawNode !== "object" || rawNode === null || Array.isArray(rawNode)) {
      continue;
    }
    const nr = rawNode as Record<string, unknown>;
    const nodeId =
      typeof nr["id"] === "string" && nr["id"].length > 0 ? nr["id"] : `node-${i + 1}`;
    const nodeType = isValidNodeType(nr["type"]) ? nr["type"] : "note";
    const nodeTitle = typeof nr["title"] === "string" ? nr["title"] : "";
    const nodeContent = typeof nr["content"] === "string" ? nr["content"] : "";
    const x = typeof nr["x"] === "number" && Number.isFinite(nr["x"]) ? nr["x"] : 0;
    const y = typeof nr["y"] === "number" && Number.isFinite(nr["y"]) ? nr["y"] : 0;
    const width =
      typeof nr["width"] === "number" && Number.isFinite(nr["width"]) && nr["width"] > 0
        ? nr["width"]
        : DEFAULT_NODE_WIDTH;
    const height =
      typeof nr["height"] === "number" && Number.isFinite(nr["height"]) && nr["height"] > 0
        ? nr["height"]
        : DEFAULT_NODE_HEIGHT;

    const nodeColor = typeof nr["color"] === "string" ? nr["color"] : undefined;
    const nodeMeta =
      typeof nr["metadata"] === "object" &&
      nr["metadata"] !== null &&
      !Array.isArray(nr["metadata"])
        ? (nr["metadata"] as Record<string, unknown>)
        : undefined;

    const node: CanvasNode = {
      id: nodeId,
      type: nodeType,
      title: nodeTitle,
      content: nodeContent,
      x,
      y,
      width,
      height,
      ...(nodeColor !== undefined ? { color: nodeColor } : {}),
      ...(nodeMeta !== undefined ? { metadata: nodeMeta } : {}),
    };
    nodes.push(node);
  }

  const rawEdges = Array.isArray(record["edges"]) ? record["edges"] : [];
  const edges: CanvasEdge[] = [];
  for (let i = 0; i < rawEdges.length; i++) {
    const rawEdge = rawEdges[i];
    if (typeof rawEdge !== "object" || rawEdge === null || Array.isArray(rawEdge)) {
      continue;
    }
    const er = rawEdge as Record<string, unknown>;
    const edgeId =
      typeof er["id"] === "string" && er["id"].length > 0 ? er["id"] : `edge-${i + 1}`;
    const sourceId = typeof er["sourceId"] === "string" ? er["sourceId"] : "";
    const targetId = typeof er["targetId"] === "string" ? er["targetId"] : "";
    const label = typeof er["label"] === "string" ? er["label"] : undefined;
    const style = isValidEdgeStyle(er["style"]) ? er["style"] : undefined;

    const edge: CanvasEdge = {
      id: edgeId,
      sourceId,
      targetId,
      ...(label !== undefined ? { label } : {}),
      ...(style !== undefined ? { style } : {}),
    };
    edges.push(edge);
  }

  const rawVp =
    typeof record["viewport"] === "object" &&
    record["viewport"] !== null &&
    !Array.isArray(record["viewport"])
      ? (record["viewport"] as Record<string, unknown>)
      : undefined;

  const vpX =
    typeof rawVp?.["x"] === "number" && Number.isFinite(rawVp["x"]) ? rawVp["x"] : 0;
  const vpY =
    typeof rawVp?.["y"] === "number" && Number.isFinite(rawVp["y"]) ? rawVp["y"] : 0;
  const rawZoom =
    typeof rawVp?.["zoom"] === "number" && Number.isFinite(rawVp["zoom"])
      ? rawVp["zoom"]
      : 1.0;
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, rawZoom));

  const viewport: CanvasViewport = {
    x: vpX,
    y: vpY,
    zoom,
  };

  const rawSelected = Array.isArray(record["selectedNodeIds"])
    ? record["selectedNodeIds"]
    : [];
  const selectedNodeIds: string[] = [];
  for (let i = 0; i < rawSelected.length; i++) {
    const sel = rawSelected[i];
    if (typeof sel === "string") {
      selectedNodeIds.push(sel);
    }
  }

  return {
    id,
    title,
    nodes,
    edges,
    viewport,
    selectedNodeIds,
  };
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function calculateNodePerimeterPoint(
  node: CanvasNode,
  targetPoint: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const dx = targetPoint.x - cx;
  const dy = targetPoint.y - cy;

  if (dx === 0 && dy === 0) {
    return { x: cx, y: cy };
  }

  const halfW = node.width / 2;
  const halfH = node.height / 2;

  const scaleX = dx !== 0 ? Math.abs(halfW / dx) : Number.POSITIVE_INFINITY;
  const scaleY = dy !== 0 ? Math.abs(halfH / dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);

  return {
    x: cx + dx * scale,
    y: cy + dy * scale,
  };
}

export function renderCanvasToSvg(
  canvas: InfiniteCanvas,
  options?: { readonly dark?: boolean; readonly padding?: number },
): string {
  const isDark = options?.dark === true;
  const pad =
    options?.padding !== undefined &&
    Number.isFinite(options.padding) &&
    options.padding >= 0
      ? options.padding
      : DEFAULT_VIEWPORT_PADDING;

  const canvasBg = isDark ? "#16161a" : "#f7f7f8";
  const nodeBg = isDark ? "#222228" : "#ffffff";
  const nodeStroke = isDark ? "#363842" : "#e2e4e8";
  const badgeColor = isDark ? "#7a7d88" : "#8c8e98";
  const titleColor = isDark ? "#f0f0f4" : "#1a1a1e";
  const textColor = isDark ? "#9c9ea8" : "#5a5c64";
  const dividerColor = isDark ? "#2c2e36" : "#eceef2";
  const edgeColor = isDark ? "#686b76" : "#8c8e96";
  const labelBg = isDark ? "#1c1c22" : "#ffffff";
  const labelText = isDark ? "#c2c4ce" : "#4a4c54";

  if (canvas.nodes.length === 0) {
    const w = 800;
    const h = 600;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
      `  <rect x="0" y="0" width="${w}" height="${h}" fill="${canvasBg}" />`,
      `  <text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" fill="${badgeColor}">Empty Canvas</text>`,
      `</svg>`,
    ].join("\n");
  }

  const bounds = calculateBounds(canvas.nodes);
  const minX = bounds.minX - pad;
  const minY = bounds.minY - pad;
  const width = Math.max(100, bounds.width + pad * 2);
  const height = Math.max(100, bounds.height + pad * 2);

  const nodeMap = new Map<string, CanvasNode>();
  for (let i = 0; i < canvas.nodes.length; i++) {
    const n = canvas.nodes[i]!;
    nodeMap.set(n.id, n);
  }

  const edgesSvg: string[] = [];
  for (let i = 0; i < canvas.edges.length; i++) {
    const edge = canvas.edges[i]!;
    const sourceNode = nodeMap.get(edge.sourceId);
    const targetNode = nodeMap.get(edge.targetId);

    if (!sourceNode || !targetNode) {
      continue;
    }

    const sourceCenter = {
      x: sourceNode.x + sourceNode.width / 2,
      y: sourceNode.y + sourceNode.height / 2,
    };
    const targetCenter = {
      x: targetNode.x + targetNode.width / 2,
      y: targetNode.y + targetNode.height / 2,
    };

    const start = calculateNodePerimeterPoint(sourceNode, targetCenter);
    const end = calculateNodePerimeterPoint(targetNode, sourceCenter);

    const isDashed = edge.style === "dashed";
    const dashAttr = isDashed ? ' stroke-dasharray="6,4"' : "";
    const hasArrow = edge.style === "arrow" || edge.style === undefined;
    const markerAttr = hasArrow ? ' marker-end="url(#edge-arrow)"' : "";

    const edgePath = `  <path d="M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}" stroke="${edgeColor}" stroke-width="1.5"${dashAttr}${markerAttr} fill="none" />`;
    edgesSvg.push(edgePath);

    if (edge.label !== undefined && edge.label.length > 0) {
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      const labelWidth = Math.max(40, edge.label.length * 7 + 12);
      edgesSvg.push(
        `  <rect x="${(midX - labelWidth / 2).toFixed(1)}" y="${(midY - 9).toFixed(1)}" width="${labelWidth}" height="18" rx="4" fill="${labelBg}" stroke="${edgeColor}" stroke-width="0.5" />`,
      );
      edgesSvg.push(
        `  <text x="${midX.toFixed(1)}" y="${(midY + 4).toFixed(1)}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="10" fill="${labelText}">${escapeXml(edge.label)}</text>`,
      );
    }
  }

  const nodesSvg: string[] = [];
  for (let i = 0; i < canvas.nodes.length; i++) {
    const node = canvas.nodes[i]!;
    const nodeGroup: string[] = [];
    nodeGroup.push(`  <g id="node-${escapeXml(node.id)}">`);
    nodeGroup.push(
      `    <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" fill="${nodeBg}" stroke="${nodeStroke}" stroke-width="1" />`,
    );

    if (node.color !== undefined) {
      nodeGroup.push(
        `    <rect x="${node.x}" y="${node.y}" width="${node.width}" height="4" rx="2" fill="${escapeXml(node.color)}" />`,
      );
    }

    nodeGroup.push(
      `    <text x="${node.x + 14}" y="${node.y + 22}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="10" font-weight="600" letter-spacing="0.05em" fill="${badgeColor}">${escapeXml(node.type.toUpperCase())}</text>`,
    );
    nodeGroup.push(
      `    <text x="${node.x + 14}" y="${node.y + 40}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="13" font-weight="600" fill="${titleColor}">${escapeXml(node.title)}</text>`,
    );
    nodeGroup.push(
      `    <line x1="${node.x + 14}" y1="${node.y + 50}" x2="${node.x + node.width - 14}" y2="${node.y + 50}" stroke="${dividerColor}" stroke-width="1" />`,
    );

    if (node.content.length > 0) {
      const lines = node.content.split("\n");
      const maxLines = Math.max(1, Math.floor((node.height - 65) / 16));
      const visibleLines = lines.slice(0, maxLines);
      nodeGroup.push(
        `    <text x="${node.x + 14}" y="${node.y + 68}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="11" fill="${textColor}">`,
      );
      for (let li = 0; li < visibleLines.length; li++) {
        const lineText = visibleLines[li]!;
        nodeGroup.push(
          `      <tspan x="${node.x + 14}" dy="${li === 0 ? "0" : "16"}">${escapeXml(lineText)}</tspan>`,
        );
      }
      nodeGroup.push(`    </text>`);
    }

    nodeGroup.push(`  </g>`);
    nodesSvg.push(nodeGroup.join("\n"));
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}">`,
    `  <defs>`,
    `    <marker id="edge-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">`,
    `      <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="${edgeColor}" />`,
    `    </marker>`,
    `  </defs>`,
    `  <rect x="${minX.toFixed(1)}" y="${minY.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" fill="${canvasBg}" />`,
    `  <g id="edges">`,
    ...edgesSvg,
    `  </g>`,
    `  <g id="nodes">`,
    ...nodesSvg,
    `  </g>`,
    `</svg>`,
  ].join("\n");
}
