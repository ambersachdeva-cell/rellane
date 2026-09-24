import { describe, expect, it } from "vitest";
import {
  addNode,
  calculateBounds,
  connectNodes,
  createCanvas,
  deserializeCanvas,
  disconnectNodes,
  fitToScreen,
  panViewport,
  removeNode,
  renderCanvasToSvg,
  serializeCanvas,
  updateNode,
  zoomViewport,
} from "./canvas-model.js";
import type { CanvasNode, InfiniteCanvas } from "./canvas-model.js";

describe("canvas-model", () => {
  it("creates a canvas with neutral default viewport and collections", () => {
    const canvas = createCanvas("canvas-1", "Strategy Workroom");

    expect(canvas.id).toBe("canvas-1");
    expect(canvas.title).toBe("Strategy Workroom");
    expect(canvas.nodes).toEqual([]);
    expect(canvas.edges).toEqual([]);
    expect(canvas.selectedNodeIds).toEqual([]);
    expect(canvas.viewport.zoom).toBe(1.0);
  });

  it("adds, updates, and removes nodes immutably", () => {
    const initial = createCanvas("c1", "Project Map");
    const card: CanvasNode = {
      id: "node-1",
      type: "card",
      title: "Architecture",
      content: "Core process pipeline",
      x: 100,
      y: 150,
      width: 240,
      height: 160,
      color: "#4a5568",
    };

    const withCard = addNode(initial, card);
    expect(withCard.nodes).toHaveLength(1);
    if (withCard.nodes.length > 0) {
      expect(withCard.nodes[0]!.title).toBe("Architecture");
    }

    const patched = updateNode(withCard, "node-1", {
      title: "Refactored Architecture",
      x: 120,
    });
    if (patched.nodes.length > 0) {
      const updated = patched.nodes[0]!;
      expect(updated.title).toBe("Refactored Architecture");
      expect(updated.x).toBe(120);
      expect(updated.y).toBe(150);
      expect(updated.color).toBe("#4a5568");
    }

    const removed = removeNode(patched, "node-1");
    expect(removed.nodes).toHaveLength(0);
  });

  it("prunes dangling edges when a connected node is removed", () => {
    const initial = createCanvas("c2", "Dependencies");
    const n1: CanvasNode = {
      id: "src",
      type: "source",
      title: "Input Feed",
      content: "raw data",
      x: 0,
      y: 0,
      width: 180,
      height: 120,
    };
    const n2: CanvasNode = {
      id: "dst",
      type: "snippet",
      title: "Transformer",
      content: "parse()",
      x: 300,
      y: 0,
      width: 180,
      height: 120,
    };

    const populated = addNode(addNode(initial, n1), n2);
    const connected = connectNodes(populated, "src", "dst", "feeds into", "arrow");
    expect(connected.edges).toHaveLength(1);

    const pruned = removeNode(connected, "src");
    expect(pruned.nodes).toHaveLength(1);
    expect(pruned.edges).toHaveLength(0);
  });

  it("connects nodes with directed arrows and disconnects by edge id", () => {
    const canvas = createCanvas("c3", "Workflow");
    const connected = connectNodes(canvas, "step-1", "step-2", "next", "arrow");

    expect(connected.edges).toHaveLength(1);
    if (connected.edges.length > 0) {
      const edge = connected.edges[0]!;
      expect(edge.sourceId).toBe("step-1");
      expect(edge.targetId).toBe("step-2");
      expect(edge.style).toBe("arrow");
      expect(edge.label).toBe("next");

      const disconnected = disconnectNodes(connected, edge.id);
      expect(disconnected.edges).toHaveLength(0);
    }
  });

  it("clamps zoom between 0.1 and 3.0 and pans viewport", () => {
    const canvas = createCanvas("c4", "Camera Test");

    const panned = panViewport(canvas, 50, -30);
    expect(panned.viewport.x).toBe(50);
    expect(panned.viewport.y).toBe(-30);

    const zoomedIn = zoomViewport(canvas, 10);
    expect(zoomedIn.viewport.zoom).toBe(3.0);

    const zoomedOut = zoomViewport(canvas, 0.01);
    expect(zoomedOut.viewport.zoom).toBe(0.1);

    const focalZoom = zoomViewport(canvas, 2.0, { x: 200, y: 150 });
    expect(focalZoom.viewport.zoom).toBe(2.0);
    expect(focalZoom.viewport.x).toBe(-200);
    expect(focalZoom.viewport.y).toBe(-150);
  });

  it("calculates bounds correctly for empty and distributed nodes", () => {
    const emptyBounds = calculateBounds([]);
    expect(emptyBounds).toEqual({
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
    });

    const nodes: readonly CanvasNode[] = [
      {
        id: "n1",
        type: "note",
        title: "A",
        content: "",
        x: -50,
        y: 100,
        width: 150,
        height: 80,
      },
      {
        id: "n2",
        type: "chart",
        title: "B",
        content: "",
        x: 200,
        y: -40,
        width: 100,
        height: 200,
      },
    ];

    const bounds = calculateBounds(nodes);
    expect(bounds.minX).toBe(-50);
    expect(bounds.minY).toBe(-40);
    expect(bounds.maxX).toBe(300);
    expect(bounds.maxY).toBe(180);
    expect(bounds.width).toBe(350);
    expect(bounds.height).toBe(220);
  });

  it("fits distributed nodes to screen bounds with padding", () => {
    const canvas = createCanvas("c5", "Fitter");
    const populated = addNode(
      canvas,
      {
        id: "single",
        type: "card",
        title: "Overview",
        content: "Body",
        x: 0,
        y: 0,
        width: 400,
        height: 200,
      },
    );

    const fitted = fitToScreen(populated, 1000, 600, 50);
    expect(fitted.viewport.zoom).toBeGreaterThanOrEqual(0.1);
    expect(fitted.viewport.zoom).toBeLessThanOrEqual(3.0);
    expect(Number.isFinite(fitted.viewport.x)).toBe(true);
    expect(Number.isFinite(fitted.viewport.y)).toBe(true);
  });

  it("roundtrips serialization safely and validates corrupted inputs", () => {
    const canvas: InfiniteCanvas = {
      id: "canvas-persist",
      title: "Persisted Session",
      nodes: [
        {
          id: "node-1",
          type: "note",
          title: "Meeting Note",
          content: "Review budget",
          x: 10,
          y: 20,
          width: 180,
          height: 90,
        },
      ],
      edges: [
        {
          id: "edge-1",
          sourceId: "node-1",
          targetId: "node-2",
          style: "arrow",
        },
      ],
      viewport: {
        x: 15,
        y: 25,
        zoom: 1.5,
      },
      selectedNodeIds: ["node-1"],
    };

    const raw = serializeCanvas(canvas);
    const recovered = deserializeCanvas(raw);
    expect(recovered).toEqual(canvas);

    const fallbackEmpty = deserializeCanvas("");
    expect(fallbackEmpty.title).toBe("Untitled Canvas");

    const fallbackCorrupt = deserializeCanvas("{ malformed json");
    expect(fallbackCorrupt.nodes).toEqual([]);
  });

  it("renders valid standalone SVG XML with nodes, edges, and arrows", () => {
    const canvas = createCanvas("c6", "Export Workroom");
    const n1: CanvasNode = {
      id: "n1",
      type: "card",
      title: "Client Spec",
      content: "High priority deliverable",
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      color: "#2563eb",
    };
    const n2: CanvasNode = {
      id: "n2",
      type: "source",
      title: "Data Sheet",
      content: "Specs table",
      x: 350,
      y: 0,
      width: 200,
      height: 120,
    };

    const populated = addNode(addNode(canvas, n1), n2);
    const linked = connectNodes(populated, "n1", "n2", "references", "arrow");

    const svg = renderCanvasToSvg(linked, { dark: true, padding: 30 });

    expect(svg).toContain("<svg xmlns=\"http://www.w3.org/2000/svg\"");
    expect(svg).toContain("<rect");
    expect(svg).toContain("<text");
    expect(svg).toContain("<path");
    expect(svg).toContain("Client Spec");
    expect(svg).toContain("Data Sheet");
    expect(svg).toContain("references");
    expect(svg).toContain("marker id=\"edge-arrow\"");
    expect(svg).toContain("</svg>");
  });
});
