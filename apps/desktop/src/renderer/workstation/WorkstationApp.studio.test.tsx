/** A Studio journey must keep the real case identity and call the existing artifact bridge. */
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CaseRoom, CaseSummary, GovernedProjectMemoryView, WorkstationSnapshot } from "@cadrane/contracts";
import { WorkstationApp } from "./WorkstationApp.js";

const caseSummary: CaseSummary = { id: "11111111-1111-4111-8111-111111111111", title: "Alpha Workspace Case", question: "Investigate telemetry", openedAt: 1000, closedAt: null, closedAs: null, verdict: null, turns: 2, lastActivityAt: 2000 };
const baseRoom: CaseRoom = {
  case: caseSummary,
  turns: [
    { id: "44444444-4444-4444-8444-444444444444", seq: 1, seat: "Source · telemetry.md", kind: "verbatim", body: "Exact source facts", at: 1000, compactedFrom: null },
    { id: "55555555-5555-4555-8555-555555555555", seq: 2, seat: "Workstation · Gemini", kind: "verbatim", body: "# Draft\n\nAn initial answer.", at: 2000, compactedFrom: null }
  ],
  artifacts: [{ id: "66666666-6666-4666-8666-666666666666", revision: 1, sourceTurnId: "55555555-5555-4555-8555-555555555555", body: "# Saved base", createdAt: 2000, acceptedAt: null }],
  exports: []
};
const memory: GovernedProjectMemoryView = {
  projectId: "22222222-2222-4222-8222-222222222222", epoch: 2, items: [{
    id: "99999999-9999-4999-8999-999999999999", projectId: "22222222-2222-4222-8222-222222222222", kind: "exclusion", headRevision: 1, activeRevision: 1, createdAt: 1000,
    active: { revision: 1, state: "approved", text: "Do not include private metrics.", sourceRefs: [], createdBy: "owner", createdAt: 1000, approverId: "owner", approvedAt: "2026-09-24T00:00:00Z", reason: null },
    candidate: null
  }]
};

if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
}

describe("WorkstationApp Studio path", () => {
  let saveArtifact: ReturnType<typeof vi.fn>;
  let exportArtifact: ReturnType<typeof vi.fn>;
  let assignProject: ReturnType<typeof vi.fn>;
  let stop: ReturnType<typeof vi.fn>;
  let running: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    saveArtifact = vi.fn().mockImplementation(async (input: { body: string }) => ({ ...baseRoom, artifacts: [{ id: "77777777-7777-4777-8777-777777777777", revision: 2, sourceTurnId: "55555555-5555-4555-8555-555555555555", body: input.body, createdAt: 3000, acceptedAt: null }, ...baseRoom.artifacts] }));
    exportArtifact = vi.fn().mockResolvedValue({ written: true, fileName: "alpha.md" });
    assignProject = vi.fn();
    stop = vi.fn().mockResolvedValue(null);
    running = vi.fn().mockResolvedValue([]);
    Object.assign(window, { cadrane: {
      cases: { list: vi.fn().mockResolvedValue({ cases: [caseSummary] }), read: vi.fn().mockResolvedValue(baseRoom), saveArtifact, exportArtifact },
      runtimes: { discover: vi.fn().mockResolvedValue([]) },
      workstation: {
        continuity: vi.fn().mockResolvedValue({ projects: [
          { id: "22222222-2222-4222-8222-222222222222", title: "Alpha Project", brief: "A real shared brief", revision: 2, createdAt: 1000, updatedAt: 2000 },
          { id: "33333333-3333-4333-8333-333333333333", title: "Beta Project", brief: "Separate brief", revision: 1, createdAt: 1000, updatedAt: 2000 }
        ], links: [{ caseId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222" }], routines: [] }),
        providers: vi.fn().mockResolvedValue([]), routines: vi.fn().mockResolvedValue([]), running,
        state: vi.fn().mockResolvedValue(null), stop, assignProject,
        memoryRead: vi.fn().mockResolvedValue({ projectId: "22222222-2222-4222-8222-222222222222", facts: [] }),
        memoryGoverned: vi.fn().mockResolvedValue(memory),
        checkCitations: vi.fn().mockResolvedValue({ status: "uncited", summary: "No numbered references", disclaimer: "Claims are not checked", sources: [], citedIds: [], unknownReferences: [], missingFromSourcesBlock: [], unexpectedInSourcesBlock: [], mismatchedUrls: [], expectedSourcesBlock: "", warnings: [], errors: [], quotes: [], quoteCheckNote: "No quotes" })
      }
    } });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  async function openCase() {
    render(<WorkstationApp onTools={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Alpha Workspace Case" }));
    await screen.findByRole("button", { name: "Studio" });
    await waitFor(() => expect(screen.getByLabelText("Project")).toBeEnabled());
  }

  it("uses one case, selected resources, the existing save, review, history and export path", async () => {
    await openCase();
    fireEvent.click(screen.getByRole("button", { name: "Studio" }));
    expect(await screen.findByText("A real shared brief")).toBeInTheDocument();
    expect(screen.getByText("Do not include private metrics.")).toBeInTheDocument();
    const source = screen.getByRole("checkbox", { name: "telemetry.md" });
    fireEvent.click(source);
    fireEvent.click(screen.getByRole("button", { name: "Design document" }));
    const editor = screen.getByRole("textbox", { name: "Edit output" }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# Exact draft\n\nSource backed. [1]" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(source).toBeChecked();
    expect(screen.getByText("Source backed. [1]")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check citation links" }));
    await waitFor(() => expect(window.cadrane.workstation.checkCitations).toHaveBeenCalledWith({ caseId: "11111111-1111-4111-8111-111111111111", draft: "# Exact draft\n\nSource backed. [1]", sourceTurnIds: ["44444444-4444-4444-8444-444444444444"] }));
    fireEvent.click(screen.getByRole("button", { name: "Deliver" }));
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() => expect(saveArtifact).toHaveBeenCalledWith({ id: "11111111-1111-4111-8111-111111111111", baseVersionId: "66666666-6666-4666-8666-666666666666", sourceTurnId: "55555555-5555-4555-8555-555555555555", body: "# Exact draft\n\nSource backed. [1]" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(exportArtifact).toHaveBeenCalledWith({ id: "11111111-1111-4111-8111-111111111111", versionId: "77777777-7777-4777-8777-777777777777", format: "docx" }));
  });

  it("recovers an exact unfinished draft after a renderer restart", async () => {
    const first = render(<WorkstationApp onTools={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Alpha Workspace Case" }));
    fireEvent.click(await screen.findByRole("button", { name: "Studio" }));
    fireEvent.click(screen.getByRole("button", { name: "Design document" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit output" }), { target: { value: "  exact leading space\n\nunfinished  " } });
    first.unmount();
    render(<WorkstationApp onTools={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Alpha Workspace Case" }));
    fireEvent.click(await screen.findByRole("button", { name: "Studio" }));
    fireEvent.click(screen.getByRole("button", { name: "Design document" }));
    expect(screen.getByRole("textbox", { name: "Edit output" })).toHaveValue("  exact leading space\n\nunfinished  ");
  });

  it("switches project destination without reassigning the open case or dropping its composer draft", async () => {
    await openCase();
    fireEvent.change(screen.getByRole("textbox", { name: "Message your AI" }), { target: { value: "Keep this scoped thought" } });
    await waitFor(() => expect(screen.getByLabelText("Project")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "33333333-3333-4333-8333-333333333333" } });
    await waitFor(() => expect(screen.getByLabelText("Project")).toHaveValue("33333333-3333-4333-8333-333333333333"));
    expect(assignProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Alpha Workspace Case" }));
    expect(await screen.findByRole("textbox", { name: "Message your AI" })).toHaveValue("Keep this scoped thought");
  });

  it("routes overview Stop to the active operation and exact case", async () => {
    const live: WorkstationSnapshot = { operationId: "88888888-8888-4888-8888-888888888888", caseId: "11111111-1111-4111-8111-111111111111", providerId: "gemini1", modelId: "gemini-3.8-flash-high", sessionId: null, status: "needs-approval", startedAt: Date.now() - 1000, updatedAt: Date.now(), text: "", activity: [], permission: null, detail: "Review file read" };
    running.mockResolvedValue([live]);
    render(<WorkstationApp onTools={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop Alpha Workspace Case" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ caseId: "11111111-1111-4111-8111-111111111111", operationId: "88888888-8888-4888-8888-888888888888" }));
  });
});
