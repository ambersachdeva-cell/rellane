import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkstationApp } from "./WorkstationApp.js";
import type {
  GovernedProjectMemoryCommand,
  GovernedProjectMemoryView
} from "@cadrane/contracts";

if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

describe("WorkstationApp memory governance integration", () => {
  let mockMemoryGoverned: ReturnType<typeof vi.fn>;
  let mockMemoryRead: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    mockMemoryGoverned = vi.fn().mockImplementation(async (cmd: GovernedProjectMemoryCommand): Promise<GovernedProjectMemoryView> => {
      return {
        projectId: cmd.projectId,
        epoch: 1,
        items: []
      };
    });
    mockMemoryRead = vi.fn().mockResolvedValue({ projectId: "proj-alpha", facts: [] });

    Object.assign(window, { cadrane: {
      cases: {
        list: vi.fn().mockResolvedValue({
          cases: [
            {
              id: "case-alpha",
              title: "Alpha Workspace Case",
              question: "Investigate telemetry",
              closedAt: null,
              lastActivityAt: 1000
            }
          ]
        }),
        read: vi.fn().mockResolvedValue({
          case: { id: "case-alpha", title: "Alpha Workspace Case", question: "Investigate telemetry" },
          turns: [],
          artifacts: []
        }),
        open: vi.fn().mockResolvedValue({
          case: { id: "case-new", title: "New Case", question: "" },
          turns: [],
          artifacts: []
        })
      },
      runtimes: {
        discover: vi.fn().mockResolvedValue([])
      },
      workstation: {
        continuity: vi.fn().mockResolvedValue({
          projects: [
            {
              id: "proj-alpha",
              title: "Alpha Project",
              brief: "Shared brief for alpha",
              revision: 1,
              createdAt: 1000,
              updatedAt: 1000
            },
            {
              id: "proj-beta",
              title: "Beta Project",
              brief: "Shared brief for beta",
              revision: 1,
              createdAt: 1000,
              updatedAt: 1000
            }
          ],
          links: [{ caseId: "case-alpha", projectId: "proj-alpha" }],
          routines: []
        }),
        providers: vi.fn().mockResolvedValue([]),
        routines: vi.fn().mockResolvedValue([]),
        running: vi.fn().mockResolvedValue([]),
        state: vi.fn().mockResolvedValue(null),
        memoryRead: mockMemoryRead,
        memoryGoverned: mockMemoryGoverned,
        memorySet: vi.fn().mockResolvedValue({ projectId: "proj-alpha", facts: [] }),
        memoryForget: vi.fn().mockResolvedValue({ projectId: "proj-alpha", facts: [] })
      }
    } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("retains unsaved multiline proposal draft across modal close and reopen cycles", async () => {
    render(<WorkstationApp onTools={() => {}} />);

    const openWorkBtn = await screen.findByRole("button", { name: "Alpha Workspace Case" });
    fireEvent.click(openWorkBtn);

    const whatItKnowsBtn = await screen.findByRole("button", { name: /What it knows/i });
    fireEvent.click(whatItKnowsBtn);

    const textarea = (await screen.findByLabelText(/Propose memory text/i)) as HTMLTextAreaElement;
    const multilineDraft = "Constraint 1: TLS 1.3 required\nConstraint 2: No plain text transmission\nConstraint 3: Token TTL <= 15m";
    fireEvent.change(textarea, { target: { value: multilineDraft } });
    expect(textarea.value).toBe(multilineDraft);

    const closeBtn = screen.getByRole("button", { name: /Close dialog/i });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByLabelText(/Propose memory text/i)).toBeNull();
    });

    const reopenBtn = screen.getByRole("button", { name: /What it knows/i });
    fireEvent.click(reopenBtn);

    const restoredTextarea = (await screen.findByLabelText(/Propose memory text/i)) as HTMLTextAreaElement;
    expect(restoredTextarea.value).toBe(multilineDraft);
  });

  it("retains draft and surfaces bridge failure when propose mutation fails", async () => {
    mockMemoryGoverned.mockRejectedValue(new Error("CAS version conflict: head revision changed to 3"));

    render(<WorkstationApp onTools={() => {}} />);

    const openWorkBtn = await screen.findByRole("button", { name: "Alpha Workspace Case" });
    fireEvent.click(openWorkBtn);

    const whatItKnowsBtn = await screen.findByRole("button", { name: /What it knows/i });
    fireEvent.click(whatItKnowsBtn);

    const textarea = (await screen.findByLabelText(/Propose memory text/i)) as HTMLTextAreaElement;
    const proposalText = "Mandate strict envelope encryption for all snapshots";
    fireEvent.change(textarea, { target: { value: proposalText } });

    const saveBtn = screen.getByRole("button", { name: /Save proposal/i });
    fireEvent.click(saveBtn);

    const alertMsg = await screen.findByText(/CAS version conflict: head revision changed to 3/i);
    expect(alertMsg).toHaveTextContent("CAS version conflict: head revision changed to 3");

    expect(textarea.value).toBe(proposalText);
  });

  it("sends id and expectedRevision when proposing a revision to an existing item", async () => {
    mockMemoryGoverned.mockImplementation(async (cmd: GovernedProjectMemoryCommand): Promise<GovernedProjectMemoryView> => {
      return {
        projectId: cmd.projectId,
        epoch: 1,
        items: [
          {
            id: "mem-item-99",
            projectId: cmd.projectId,
            kind: "decision",
            headRevision: 4,
            activeRevision: 4,
            active: {
              revision: 4,
              state: "approved",
              text: "Primary database is PostgreSQL 14",
              sourceRefs: [],
              createdBy: "lead",
              createdAt: 1000,
              approverId: "architect",
              approvedAt: "2026-09-24T00:00:00Z",
              reason: null
            },
            candidate: null,
            createdAt: 1000
          }
        ]
      };
    });

    render(<WorkstationApp onTools={() => {}} />);

    const openWorkBtn = await screen.findByRole("button", { name: "Alpha Workspace Case" });
    fireEvent.click(openWorkBtn);

    const whatItKnowsBtn = await screen.findByRole("button", { name: /What it knows/i });
    fireEvent.click(whatItKnowsBtn);

    const reviseBtn = await screen.findByRole("button", { name: /Propose revision for "Primary database is PostgreSQL 14"/i });
    fireEvent.click(reviseBtn);

    const textarea = (await screen.findByLabelText(/Propose memory text/i)) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Primary database is PostgreSQL 14");

    fireEvent.change(textarea, { target: { value: "Primary database is PostgreSQL 16" } });
    const saveRevBtn = screen.getByRole("button", { name: /Save revision proposal/i });
    fireEvent.click(saveRevBtn);

    await waitFor(() => {
      expect(mockMemoryGoverned).toHaveBeenCalledWith(expect.objectContaining({
        action: "propose",
        projectId: "proj-alpha",
        id: "mem-item-99",
        expectedRevision: 4,
        kind: "decision",
        text: "Primary database is PostgreSQL 16"
      }));
    });
  });
});
