import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CaseTurnView } from "@cadrane/contracts";
import { WorkroomCanvas } from "./WorkroomCanvas.js";
import {
  getCanvasDraftKey,
  type StorageLike,
  CANVAS_DRAFT_SCHEMA_VERSION
} from "./canvas-draft-store.js";

if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

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

const sampleTurns: readonly CaseTurnView[] = [
  {
    id: "turn-1",
    seq: 1,
    seat: "owner",
    kind: "request",
    body: "First turn request text",
    createdAt: "2026-09-24T00:00:00Z"
  } as unknown as CaseTurnView,
  {
    id: "turn-2",
    seq: 2,
    seat: "Workstation · Engineer",
    kind: "response",
    body: "Second turn response text",
    createdAt: "2026-09-24T00:01:00Z"
  } as unknown as CaseTurnView
];

describe("WorkroomCanvas local draft integration", () => {
  it("does not persist a stub to storage on untouched open", () => {
    const storage = createMemoryStorage();
    const { unmount } = render(
      <WorkroomCanvas
        caseId="case-untouched"
        title="Untouched Case"
        turns={sampleTurns}
        onClose={() => {}}
        storage={storage}
      />
    );

    expect(storage.getItem(getCanvasDraftKey("case-untouched"))).toBeNull();
    unmount();
    expect(storage.getItem(getCanvasDraftKey("case-untouched"))).toBeNull();
  });

  it("retains edited viewport, selection, and nodes across unmount and remount", () => {
    const storage = createMemoryStorage();
    const { unmount } = render(
      <WorkroomCanvas
        caseId="case-persisted"
        title="Persisted Case"
        turns={sampleTurns}
        onClose={() => {}}
        storage={storage}
      />
    );

    // Zoom in (100% -> 120%)
    const zoomInBtn = screen.getByRole("button", { name: /zoom in/i });
    fireEvent.click(zoomInBtn);

    // Click on node 1 to select it
    const node1 = screen.getByTestId("canvas-node-turn-turn-1");
    fireEvent.mouseDown(node1);

    expect(storage.getItem(getCanvasDraftKey("case-persisted"))).not.toBeNull();
    unmount();

    // Reopen same case
    render(
      <WorkroomCanvas
        caseId="case-persisted"
        title="Persisted Case"
        turns={sampleTurns}
        onClose={() => {}}
        storage={storage}
      />
    );

    expect(screen.getByText(/Zoom 120%/)).toBeInTheDocument();
    const remountedNode1 = screen.getByTestId("canvas-node-turn-turn-1");
    expect(remountedNode1).toHaveAttribute("data-selected", "true");
  });

  it("isolates drafts between distinct case IDs", () => {
    const storage = createMemoryStorage();
    const turnsA: CaseTurnView[] = [
      { id: "a1", seq: 1, seat: "owner", kind: "request", body: "Case A Body", createdAt: "2026-09-24T00:00:00Z" } as unknown as CaseTurnView
    ];
    const turnsB: CaseTurnView[] = [
      { id: "b1", seq: 1, seat: "owner", kind: "request", body: "Case B Body", createdAt: "2026-09-24T00:00:00Z" } as unknown as CaseTurnView
    ];

    // Open and edit Case A
    const { unmount: unmountA } = render(
      <WorkroomCanvas
        caseId="case-aaa"
        title="Case A"
        turns={turnsA}
        onClose={() => {}}
        storage={storage}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(screen.getByText(/Zoom 120%/)).toBeInTheDocument();
    unmountA();

    // Open Case B untouched
    const { unmount: unmountB } = render(
      <WorkroomCanvas
        caseId="case-bbb"
        title="Case B"
        turns={turnsB}
        onClose={() => {}}
        storage={storage}
      />
    );
    expect(screen.getByText(/Zoom 100%/)).toBeInTheDocument();
    expect(storage.getItem(getCanvasDraftKey("case-bbb"))).toBeNull();
    unmountB();

    expect(storage.getItem(getCanvasDraftKey("case-aaa"))).not.toBeNull();
  });

  it("avoids stale writes when switching caseId prop without unmount", () => {
    const storage = createMemoryStorage();
    const turns1: CaseTurnView[] = [
      { id: "x1", seq: 1, seat: "owner", kind: "request", body: "Body X1", createdAt: "2026-09-24T00:00:00Z" } as unknown as CaseTurnView
    ];
    const turns2: CaseTurnView[] = [
      { id: "y1", seq: 1, seat: "owner", kind: "request", body: "Body Y1", createdAt: "2026-09-24T00:00:00Z" } as unknown as CaseTurnView
    ];

    const { rerender } = render(
      <WorkroomCanvas
        caseId="case-1"
        title="Case 1"
        turns={turns1}
        onClose={() => {}}
        storage={storage}
      />
    );

    // User zooms in Case 1
    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(storage.getItem(getCanvasDraftKey("case-1"))).not.toBeNull();
    expect(storage.getItem(getCanvasDraftKey("case-2"))).toBeNull();

    // Case prop switches to case-2
    rerender(
      <WorkroomCanvas
        caseId="case-2"
        title="Case 2"
        turns={turns2}
        onClose={() => {}}
        storage={storage}
      />
    );

    // Stale Case 1 canvas must NOT have been saved under case-2
    expect(storage.getItem(getCanvasDraftKey("case-2"))).toBeNull();
    expect(screen.getByText("Body Y1")).toBeInTheDocument();
  });

  it("preserves corrupt stored state for recovery and displays an honest alert banner", () => {
    const corruptedData = "{ unparseable json ";
    const storage = createMemoryStorage({
      [getCanvasDraftKey("case-corrupt")]: corruptedData
    });

    render(
      <WorkroomCanvas
        caseId="case-corrupt"
        title="Corrupted Case"
        turns={sampleTurns}
        onClose={() => {}}
        storage={storage}
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/corrupted|invalid/i);
    // Stored corrupted data is not overwritten
    expect(storage.getItem(getCanvasDraftKey("case-corrupt"))).toBe(corruptedData);
  });

  it("displays an honest recoverability warning on storage quota failure and keeps in-memory work", () => {
    const quotaErr = new Error("The quota has been exceeded.");
    quotaErr.name = "QuotaExceededError";
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw quotaErr;
      }
    };

    render(
      <WorkroomCanvas
        caseId="case-quota"
        title="Quota Case"
        turns={sampleTurns}
        onClose={() => {}}
        storage={storage}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));

    // In-memory zoom state is preserved
    expect(screen.getByText(/Zoom 120%/)).toBeInTheDocument();

    // Warning banner is visible
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/quota exceeded/i);
  });

  it("preserves corrupt stored draft on edit and keeps warning visible with in-memory updates", () => {
    const corruptedData = "{ unparseable corrupt payload ";
    const storage = createMemoryStorage({
      [getCanvasDraftKey("case-corrupt-edit")]: corruptedData
    });

    render(
      <WorkroomCanvas
        caseId="case-corrupt-edit"
        title="Corrupt Edit Case"
        turns={sampleTurns}
        onClose={() => {}}
        storage={storage}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/corrupted|invalid/i);
    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));

    expect(screen.getByText(/Zoom 120%/)).toBeInTheDocument();
    expect(storage.getItem(getCanvasDraftKey("case-corrupt-edit"))).toBe(corruptedData);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("safely handles StrictMode and case switching without stale overwrites or saving untouched opens", () => {
    const storage = createMemoryStorage();
    const { rerender } = render(
      <React.StrictMode>
        <WorkroomCanvas
          caseId="case-strict-1"
          title="Strict 1"
          turns={sampleTurns}
          onClose={() => {}}
          storage={storage}
        />
      </React.StrictMode>
    );

    expect(storage.getItem(getCanvasDraftKey("case-strict-1"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(storage.getItem(getCanvasDraftKey("case-strict-1"))).not.toBeNull();

    rerender(
      <React.StrictMode>
        <WorkroomCanvas
          caseId="case-strict-2"
          title="Strict 2"
          turns={sampleTurns}
          onClose={() => {}}
          storage={storage}
        />
      </React.StrictMode>
    );

    expect(screen.getByText(/Zoom 100%/)).toBeInTheDocument();
    expect(storage.getItem(getCanvasDraftKey("case-strict-2"))).toBeNull();
    expect(storage.getItem(getCanvasDraftKey("case-strict-1"))).not.toBeNull();
  });
});
