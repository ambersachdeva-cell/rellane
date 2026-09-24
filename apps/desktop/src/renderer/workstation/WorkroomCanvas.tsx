/** Spatial canvas view displaying workroom context and outputs as an interactive graph. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CaseTurnView } from "@cadrane/contracts";
import {
  createCanvas,
  addNode,
  updateNode,
  removeNode,
  connectNodes,
  panViewport,
  zoomViewport,
  fitToScreen,
  renderCanvasToSvg,
  type CanvasNode,
  type CanvasNodeType,
  type InfiniteCanvas
} from "./canvas-model.js";
import { Icon, IconButton, Modal } from "./ui.js";

export interface WorkroomCanvasProps {
  readonly caseId: string;
  readonly title: string;
  readonly turns: readonly CaseTurnView[];
  readonly onClose: () => void;
}

export function WorkroomCanvas({ caseId, title, turns, onClose }: WorkroomCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState<InfiniteCanvas>(() => {
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
  });

  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [notice, setNotice] = useState<string>("");

  const handleZoomIn = useCallback(() => {
    setCanvas((prev) => zoomViewport(prev, 1.2));
  }, []);

  const handleZoomOut = useCallback(() => {
    setCanvas((prev) => zoomViewport(prev, 0.8));
  }, []);

  const handleFit = useCallback(() => {
    const width = containerRef.current?.clientWidth ?? 900;
    const height = containerRef.current?.clientHeight ?? 600;
    setCanvas((prev) => fitToScreen(prev, width, height, 40));
  }, []);

  const handleExportSvg = useCallback(() => {
    const svg = renderCanvasToSvg(canvas, { dark: true, padding: 50 });
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-canvas.svg`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice("Canvas exported to SVG file.");
    setTimeout(() => setNotice(""), 3000);
  }, [canvas, title]);

  const handleMouseDownNode = (nodeId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const node = canvas.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    setDraggingNodeId(nodeId);
    setDragOffset({
      x: event.clientX - node.x * canvas.viewport.zoom,
      y: event.clientY - node.y * canvas.viewport.zoom
    });
  };

  const handleMouseDownCanvas = (event: React.MouseEvent) => {
    if (event.target === containerRef.current || (event.target as HTMLElement).tagName === "svg") {
      setIsPanning(true);
      setPanStart({ x: event.clientX, y: event.clientY });
    }
  };

  const handleMouseMove = (event: React.MouseEvent) => {
    if (draggingNodeId) {
      const zoom = Math.max(0.1, canvas.viewport.zoom);
      const newX = Math.round((event.clientX - dragOffset.x) / zoom);
      const newY = Math.round((event.clientY - dragOffset.y) / zoom);
      setCanvas((prev) => updateNode(prev, draggingNodeId, { x: newX, y: newY }));
    } else if (isPanning) {
      const dx = event.clientX - panStart.x;
      const dy = event.clientY - panStart.y;
      setPanStart({ x: event.clientX, y: event.clientY });
      setCanvas((prev) => panViewport(prev, dx, dy));
    }
  };

  const handleMouseUp = () => {
    setDraggingNodeId(null);
    setIsPanning(false);
  };

  const handleWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    setCanvas((prev) => zoomViewport(prev, factor));
  };

  return (
    <Modal title={`Workroom Canvas · ${title}`} eyebrow="Spatial Workspace" wide onClose={onClose}>
      <div className="ws-canvas-container" style={{ position: "relative", height: "68vh", display: "flex", flexDirection: "column" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: "12px", borderBottom: "1px solid var(--ws-line)" }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <span style={{ fontSize: "13px", color: "var(--ws-muted)" }}>
              {canvas.nodes.length} cards · Zoom {Math.round(canvas.viewport.zoom * 100)}%
            </span>
            {notice ? <span style={{ fontSize: "12px", color: "var(--ws-blue)", marginLeft: "12px" }}>{notice}</span> : null}
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="ws-button ws-button--small" type="button" onClick={handleZoomIn} aria-label="Zoom in">
              <Icon name="plus" size={14} /> In
            </button>
            <button className="ws-button ws-button--small" type="button" onClick={handleZoomOut} aria-label="Zoom out">
              <Icon name="minus" size={14} /> Out
            </button>
            <button className="ws-button ws-button--small" type="button" onClick={handleFit} aria-label="Fit to screen">
              <Icon name="panel" size={14} /> Fit
            </button>
            <button className="ws-button ws-button--primary ws-button--small" type="button" onClick={handleExportSvg}>
              <Icon name="export" size={14} /> Export SVG
            </button>
          </div>
        </header>

        <div
          ref={containerRef}
          onMouseDown={handleMouseDownCanvas}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          style={{
            flex: 1,
            position: "relative",
            overflow: "hidden",
            backgroundColor: "var(--ws-ground)",
            backgroundImage: "radial-gradient(circle, var(--ws-soft) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
            borderRadius: "6px",
            marginTop: "12px",
            cursor: draggingNodeId ? "grabbing" : isPanning ? "grabbing" : "grab"
          }}
        >
          <div
            style={{
              position: "absolute",
              transform: `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.zoom})`,
              transformOrigin: "0 0"
            }}
          >
            {/* SVG Connecting Edges */}
            <svg
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: 3000,
                height: 3000,
                pointerEvents: "none"
              }}
            >
              <defs>
                <marker id="canvas-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--ws-muted)" />
                </marker>
              </defs>
              {canvas.edges.map((edge) => {
                const src = canvas.nodes.find((n) => n.id === edge.sourceId);
                const tgt = canvas.nodes.find((n) => n.id === edge.targetId);
                if (!src || !tgt) return null;
                const x1 = src.x + src.width;
                const y1 = src.y + src.height / 2;
                const x2 = tgt.x;
                const y2 = tgt.y + tgt.height / 2;
                const dx = Math.abs(x2 - x1) / 2;
                return (
                  <path
                    key={edge.id}
                    d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="var(--ws-soft)"
                    strokeWidth="1.5"
                    markerEnd="url(#canvas-arrow)"
                  />
                );
              })}
            </svg>

            {/* Nodes */}
            {canvas.nodes.map((node) => (
              <div
                key={node.id}
                onMouseDown={(e) => handleMouseDownNode(node.id, e)}
                style={{
                  position: "absolute",
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  width: `${node.width}px`,
                  minHeight: `${node.height}px`,
                  backgroundColor: "var(--ws-paper)",
                  border: `1px solid ${node.color ?? "var(--ws-line)"}`,
                  borderRadius: "8px",
                  padding: "12px",
                  boxShadow: "var(--ws-shadow, 0 4px 14px rgba(0,0,0,0.08))",
                  color: "var(--ws-ink)",
                  userSelect: "none",
                  cursor: "grab"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                  <strong style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.04em", color: node.color ?? "var(--ws-blue)" }}>
                    {node.title}
                  </strong>
                  <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "4px", backgroundColor: "var(--ws-ground)", color: "var(--ws-muted)", border: "1px solid var(--ws-line)" }}>
                    {node.type}
                  </span>
                </div>
                <p style={{ fontSize: "12px", lineHeight: "1.45", color: "var(--ws-ink)", margin: 0, wordBreak: "break-word" }}>
                  {node.content}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
