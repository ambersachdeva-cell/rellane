/** Spatial canvas view displaying workroom context and outputs as an interactive graph. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseTurnView } from "@cadrane/contracts";
import {
  updateNode,
  panViewport,
  zoomViewport,
  fitToScreen,
  renderCanvasToSvg,
  type InfiniteCanvas
} from "./canvas-model.js";
import {
  createInitialCanvasFromTurns,
  getDefaultStorage,
  loadCanvasDraft,
  reconcileCanvasWithTurns,
  saveCanvasDraft,
  type StorageLike
} from "./canvas-draft-store.js";
import { Icon, Modal } from "./ui.js";

export interface WorkroomCanvasProps {
  readonly caseId: string;
  readonly title: string;
  readonly turns: readonly CaseTurnView[];
  readonly onClose: () => void;
  readonly storage?: StorageLike | null;
}

interface ResolvedInitialState {
  readonly canvas: InfiniteCanvas;
  readonly warning: string | null;
  readonly canPersist: boolean;
}

function resolveInitialState(
  caseId: string,
  title: string,
  turns: readonly CaseTurnView[],
  storage: StorageLike | null
): ResolvedInitialState {
  const result = loadCanvasDraft(caseId, storage);
  if (result.status === "loaded") {
    return {
      canvas: reconcileCanvasWithTurns(result.draft, turns),
      warning: null,
      canPersist: true
    };
  }
  const initial = createInitialCanvasFromTurns(caseId, title, turns);
  if (result.status === "corrupted") {
    return {
      canvas: initial,
      warning:
        "Saved draft for this case is invalid or corrupted. Stored draft has been preserved for recovery without overwriting.",
      canPersist: false
    };
  }
  if (result.status === "version_mismatch") {
    return {
      canvas: initial,
      warning:
        "Saved draft is from an unsupported version. Stored draft has been preserved for recovery without overwriting.",
      canPersist: false
    };
  }
  if (result.status === "storage_unavailable") {
    return {
      canvas: initial,
      warning: result.error,
      canPersist: false
    };
  }
  if (result.status === "read_error") {
    return {
      canvas: initial,
      warning: `${result.error}. In-memory work remains usable.`,
      canPersist: false
    };
  }
  return {
    canvas: initial,
    warning: null,
    canPersist: true
  };
}

interface WorkroomCanvasInnerProps {
  readonly caseId: string;
  readonly title: string;
  readonly turns: readonly CaseTurnView[];
  readonly onClose: () => void;
  readonly storage: StorageLike | null;
}

function WorkroomCanvasInner({
  caseId,
  title,
  turns,
  onClose,
  storage
}: WorkroomCanvasInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [initialResolved] = useState(() => resolveInitialState(caseId, title, turns, storage));
  const [canvas, setCanvas] = useState<InfiniteCanvas>(initialResolved.canvas);
  const [storageWarning, setStorageWarning] = useState<string | null>(initialResolved.warning);

  const userEditCountRef = useRef(0);
  const lastSavedEditCountRef = useRef(0);

  useEffect(() => {
    if (userEditCountRef.current === lastSavedEditCountRef.current) {
      return;
    }
    lastSavedEditCountRef.current = userEditCountRef.current;
    if (!initialResolved.canPersist) {
      return;
    }
    const saveResult = saveCanvasDraft(caseId, canvas, storage);
    if (!saveResult.success) {
      setStorageWarning(saveResult.error);
    } else {
      setStorageWarning((curr) =>
        curr &&
        (curr.startsWith("Storage quota") ||
          curr.startsWith("Storage error") ||
          curr.startsWith("Local draft storage unavailable"))
          ? null
          : curr
      );
    }
  }, [canvas, caseId, storage, initialResolved.canPersist]);

  const prevTurnsRef = useRef(turns);
  useEffect(() => {
    if (prevTurnsRef.current !== turns) {
      prevTurnsRef.current = turns;
      setCanvas((prev) => reconcileCanvasWithTurns(prev, turns));
    }
  }, [turns]);

  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [notice, setNotice] = useState<string>("");

  const mutateCanvas = useCallback((updater: (prev: InfiniteCanvas) => InfiniteCanvas) => {
    userEditCountRef.current += 1;
    setCanvas(updater);
  }, []);

  const handleZoomIn = useCallback(() => {
    mutateCanvas((prev) => zoomViewport(prev, 1.2));
  }, [mutateCanvas]);

  const handleZoomOut = useCallback(() => {
    mutateCanvas((prev) => zoomViewport(prev, 0.8));
  }, [mutateCanvas]);

  const handleFit = useCallback(() => {
    const width = containerRef.current?.clientWidth ?? 900;
    const height = containerRef.current?.clientHeight ?? 600;
    mutateCanvas((prev) => fitToScreen(prev, width, height, 40));
  }, [mutateCanvas]);

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
    if (canvas.selectedNodeIds.length !== 1 || canvas.selectedNodeIds[0] !== nodeId) {
      mutateCanvas((prev) => ({
        ...prev,
        selectedNodeIds: [nodeId]
      }));
    }
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
      if (canvas.selectedNodeIds.length > 0) {
        mutateCanvas((prev) => ({ ...prev, selectedNodeIds: [] }));
      }
    }
  };

  const handleMouseMove = (event: React.MouseEvent) => {
    if (draggingNodeId) {
      const zoom = Math.max(0.1, canvas.viewport.zoom);
      const newX = Math.round((event.clientX - dragOffset.x) / zoom);
      const newY = Math.round((event.clientY - dragOffset.y) / zoom);
      mutateCanvas((prev) => updateNode(prev, draggingNodeId, { x: newX, y: newY }));
    } else if (isPanning) {
      const dx = event.clientX - panStart.x;
      const dy = event.clientY - panStart.y;
      setPanStart({ x: event.clientX, y: event.clientY });
      mutateCanvas((prev) => panViewport(prev, dx, dy));
    }
  };

  const handleMouseUp = () => {
    setDraggingNodeId(null);
    setIsPanning(false);
  };

  const handleWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    mutateCanvas((prev) => zoomViewport(prev, factor));
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

        {storageWarning ? (
          <div
            role="alert"
            data-testid="canvas-storage-warning"
            style={{
              marginTop: "8px",
              padding: "8px 12px",
              borderRadius: "6px",
              backgroundColor: "rgba(239, 68, 68, 0.1)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              color: "#ef4444",
              fontSize: "12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px"
            }}
          >
            <span>{storageWarning}</span>
            <button
              type="button"
              onClick={() => setStorageWarning(null)}
              style={{
                background: "none",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                fontSize: "14px",
                lineHeight: 1
              }}
              aria-label="Dismiss warning"
            >
              ×
            </button>
          </div>
        ) : null}

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
            {canvas.nodes.map((node) => {
              const isSelected = canvas.selectedNodeIds.includes(node.id);
              return (
                <div
                  key={node.id}
                  data-testid={`canvas-node-${node.id}`}
                  data-selected={isSelected ? "true" : "false"}
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
                    boxShadow: isSelected
                      ? "0 0 0 2px var(--ws-blue, #3b82f6), var(--ws-shadow, 0 4px 14px rgba(0,0,0,0.08))"
                      : "var(--ws-shadow, 0 4px 14px rgba(0,0,0,0.08))",
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
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}


export function WorkroomCanvas(props: WorkroomCanvasProps) {
  const effectiveStorage = props.storage !== undefined ? props.storage : getDefaultStorage();
  return <WorkroomCanvasInner key={props.caseId} {...props} storage={effectiveStorage} />;
}