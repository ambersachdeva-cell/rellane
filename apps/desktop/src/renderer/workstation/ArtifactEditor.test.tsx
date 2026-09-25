import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ArtifactEditor, type EditorDraft } from "./ArtifactEditor.js";
import type { CaseRoom, WorkstationCitationCheckResult } from "@cadrane/contracts";
import { getArtifactDraftKey } from "./artifact-drafts.js";

describe("ArtifactEditor", () => {
  let mockSaveArtifact: ReturnType<typeof vi.fn>;
  let mockExportArtifact: ReturnType<typeof vi.fn>;
  let mockCheckCitations: ReturnType<typeof vi.fn>;

  const baseRoom: CaseRoom = {
    case: { id: "case-alpha", title: "Investigation", question: "Question", openedAt: 1000, closedAt: null, closedAs: null, verdict: null, turns: 1, lastActivityAt: 1000 },
    turns: [{ id: "source-1", seat: "system", kind: "verbatim", body: "Source facts", seq: 1, at: 1000, compactedFrom: null }],
    artifacts: [{ id: "artifact-v1", revision: 1, body: "Saved base text", createdAt: 1000, acceptedAt: null, sourceTurnId: "source-1" }],
    exports: []
  };

  beforeEach(() => {
    localStorage.clear();
    mockSaveArtifact = vi.fn();
    mockExportArtifact = vi.fn();
    mockCheckCitations = vi.fn();
    Object.assign(window, {
      cadrane: {
        cases: { saveArtifact: mockSaveArtifact, exportArtifact: mockExportArtifact },
        workstation: { checkCitations: mockCheckCitations }
      }
    });
  });

  it("keeps changes typed while Save pending and moves baseVersionId only if previous base matches", async () => {
    let resolveSave!: (value: CaseRoom) => void;
    const pendingPromise = new Promise<CaseRoom>(r => { resolveSave = r; });
    mockSaveArtifact.mockReturnValue(pendingPromise);

    const onSaved = vi.fn();
    const onMessage = vi.fn();
    let draft: EditorDraft = { body: "Initial typed edits", sourceTurnId: "source-1", baseVersionId: "artifact-v1" };
    const setDraft = vi.fn((next: EditorDraft) => { draft = next; });

    const { rerender } = render(
      <ArtifactEditor room={baseRoom} draft={draft} setDraft={setDraft} savedBody="Saved base text" onSaved={onSaved} onClose={() => {}} onMessage={onMessage} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    expect(mockSaveArtifact).toHaveBeenCalledWith({ id: "case-alpha", baseVersionId: "artifact-v1", sourceTurnId: "source-1", body: "Initial typed edits" });

    draft = { ...draft, body: "Edits continued while save in flight" };
    rerender(
      <ArtifactEditor room={baseRoom} draft={draft} setDraft={setDraft} savedBody="Saved base text" onSaved={onSaved} onClose={() => {}} onMessage={onMessage} />
    );

    const updatedRoom: CaseRoom = {
      ...baseRoom,
      artifacts: [{ id: "artifact-v2", revision: 2, body: "Initial typed edits", createdAt: 2000, acceptedAt: null, sourceTurnId: "source-1" }, ...baseRoom.artifacts]
    };
    resolveSave(updatedRoom);

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(setDraft).toHaveBeenCalledWith({
      body: "Edits continued while save in flight",
      sourceTurnId: "source-1",
      baseVersionId: "artifact-v2"
    });
  });

  it("leaves draft intact when Save fails", async () => {
    mockSaveArtifact.mockRejectedValue(new Error("Storage write failed"));
    const onSaved = vi.fn();
    const onMessage = vi.fn();
    const setDraft = vi.fn();
    const draft: EditorDraft = { body: "Unsaved edits", sourceTurnId: null, baseVersionId: "artifact-v1" };

    render(
      <ArtifactEditor room={baseRoom} draft={draft} setDraft={setDraft} savedBody="Saved base text" onSaved={onSaved} onClose={() => {}} onMessage={onMessage} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith("Storage write failed"));
    expect(onSaved).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalledWith(expect.objectContaining({ body: "Saved base text" }));
  });

  it("ignores async save completion if unmounted or switched case", async () => {
    let resolveSave!: (value: CaseRoom) => void;
    const pendingPromise = new Promise<CaseRoom>(r => { resolveSave = r; });
    mockSaveArtifact.mockReturnValue(pendingPromise);
    const onSaved = vi.fn();

    const { unmount } = render(
      <ArtifactEditor room={baseRoom} draft={{ body: "Pending save", sourceTurnId: null, baseVersionId: "artifact-v1" }} setDraft={() => {}} savedBody="Saved base text" onSaved={onSaved} onClose={() => {}} onMessage={() => {}} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    unmount();

    resolveSave({ ...baseRoom, artifacts: [{ id: "artifact-v2", revision: 2, body: "Pending save", createdAt: 2000, acceptedAt: null, sourceTurnId: null }] });
    await new Promise(r => setTimeout(r, 20));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("blocks save with clear warning when corrupted draft is preserved", async () => {
    localStorage.setItem(getArtifactDraftKey("case-alpha"), "{ corrupt json");
    const onMessage = vi.fn();
    render(
      <ArtifactEditor room={baseRoom} draft={{ body: "Attempted overwrite", sourceTurnId: null, baseVersionId: "artifact-v1" }} setDraft={() => {}} savedBody="Saved base text" onSaved={() => {}} onClose={() => {}} onMessage={onMessage} />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/unrecognised or corrupted draft is preserved/i);
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    expect(mockSaveArtifact).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.stringMatching(/cannot save version/i));
  });

  it("ignores async citation completion when unmounted", async () => {
    let resolveCitation!: (res: WorkstationCitationCheckResult) => void;
    mockCheckCitations.mockReturnValue(new Promise<WorkstationCitationCheckResult>(r => { resolveCitation = r; }));
    const onMessage = vi.fn();
    const { unmount } = render(
      <ArtifactEditor room={baseRoom} selectedSourceIds={["source-1"]} draft={{ body: "Body [1]", sourceTurnId: "source-1", baseVersionId: "artifact-v1" }} setDraft={() => {}} savedBody="Saved base text" onSaved={() => {}} onClose={() => {}} onMessage={onMessage} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Check citation links" }));
    unmount();
    resolveCitation({ status: "ok", summary: "OK", disclaimer: "Disc", expectedSourcesBlock: "", quotes: [], sources: [], citedIds: [], unknownReferences: [], missingFromSourcesBlock: [], unexpectedInSourcesBlock: [], mismatchedUrls: [], warnings: [], errors: [], quoteCheckNote: "" });
    await new Promise(r => setTimeout(r, 20));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores async export completion when unmounted", async () => {
    let resolveExport!: (v: { written: boolean }) => void;
    mockExportArtifact.mockReturnValue(new Promise<{ written: boolean }>(r => { resolveExport = r; }));
    const onMessage = vi.fn();
    const { unmount } = render(
      <ArtifactEditor room={baseRoom} draft={{ body: "Saved base text", sourceTurnId: "source-1", baseVersionId: "artifact-v1" }} setDraft={() => {}} savedBody="Saved base text" onSaved={() => {}} onClose={() => {}} onMessage={onMessage} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    unmount();
    resolveExport({ written: true });
    await new Promise(r => setTimeout(r, 20));
    expect(onMessage).not.toHaveBeenCalled();
  });
});
