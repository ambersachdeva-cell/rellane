import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryPanel, type Learned } from "./MemoryPanel.js";
import type { GovernedProjectMemoryView } from "@cadrane/contracts";

if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

const sampleFacts: readonly Learned[] = [
  {
    id: "fact-1",
    kind: "business",
    text: "Legacy customer acquisition pattern",
    source: "session-1",
    count: 2,
    pinned: false,
    hidden: false,
    lastSeen: Date.now()
  }
];

describe("MemoryPanel canonical governed memory user path", () => {
  it("guides user to choose/create project when no project is selected", () => {
    const onSelectProject = vi.fn();
    render(
      <MemoryPanel
        facts={sampleFacts}
        stale={[]}
        projectTitle="Personal workspace"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId={null}
        governedView={null}
        onSelectProject={onSelectProject}
      />
    );

    expect(
      screen.getByText(/Approved memory and project governance require an explicit project/i)
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Propose memory text/i)).toBeNull();
    expect(screen.getByText("Legacy customer acquisition pattern")).toBeInTheDocument();

    const chooseBtn = screen.getByRole("button", { name: /Choose project/i });
    fireEvent.click(chooseBtn);
    expect(onSelectProject).toHaveBeenCalledTimes(1);
  });

  it("executes propose -> pending -> approve authoritative lifecycle without optimistic assumptions", async () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    const onReview = vi.fn().mockResolvedValue(undefined);

    const initialView: GovernedProjectMemoryView = {
      projectId: "proj-alpha",
      epoch: 1,
      items: []
    };

    const { rerender } = render(
      <MemoryPanel
        facts={[]}
        stale={[]}
        projectTitle="Alpha Project"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId="proj-alpha"
        governedView={initialView}
        onPropose={onPropose}
        onReview={onReview}
      />
    );

    const input = screen.getByLabelText(/Propose memory text/i);
    fireEvent.change(input, { target: { value: "Must enforce TLS 1.3 only" } });
    const kindSelect = screen.getByLabelText(/Kind:/i);
    fireEvent.change(kindSelect, { target: { value: "instruction" } });

    const saveBtn = screen.getByRole("button", { name: /Save proposal/i });
    fireEvent.click(saveBtn);

    expect(onPropose).toHaveBeenCalledWith({
      kind: "instruction",
      text: "Must enforce TLS 1.3 only"
    });

    // Candidate is NOT optimistically approved
    expect(screen.queryByText(/Approved \(v/i)).toBeNull();

    // Server returns post-transaction authoritative view with candidate pending
    const pendingView: GovernedProjectMemoryView = {
      projectId: "proj-alpha",
      epoch: 2,
      items: [
        {
          id: "mem-item-1",
          projectId: "proj-alpha",
          kind: "instruction",
          headRevision: 1,
          activeRevision: null,
          active: null,
          candidate: {
            revision: 1,
            state: "proposed",
            text: "Must enforce TLS 1.3 only",
            sourceRefs: [],
            createdBy: "actor-owner",
            createdAt: 1000,
            approverId: null,
            approvedAt: null,
            reason: null
          },
          createdAt: 1000
        }
      ]
    };

    rerender(
      <MemoryPanel
        facts={[]}
        stale={[]}
        projectTitle="Alpha Project"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId="proj-alpha"
        governedView={pendingView}
        onPropose={onPropose}
        onReview={onReview}
      />
    );

    expect(screen.getByText("Proposed candidate (v1)")).toBeInTheDocument();
    expect(screen.getByText("Must enforce TLS 1.3 only", { selector: "p" })).toBeInTheDocument();

    // Click Approve on displayed candidate
    const approveBtn = screen.getByRole("button", { name: /Approve candidate/i });
    await waitFor(() => expect(approveBtn).not.toBeDisabled());
    fireEvent.click(approveBtn);
    expect(onReview).toHaveBeenCalledWith("mem-item-1", 1, "approve");

    // Server returns approved authoritative view
    const approvedView: GovernedProjectMemoryView = {
      projectId: "proj-alpha",
      epoch: 3,
      items: [
        {
          id: "mem-item-1",
          projectId: "proj-alpha",
          kind: "instruction",
          headRevision: 2,
          activeRevision: 2,
          active: {
            revision: 2,
            state: "approved",
            text: "Must enforce TLS 1.3 only",
            sourceRefs: [],
            createdBy: "actor-owner",
            createdAt: 1000,
            approverId: "actor-owner",
            approvedAt: "2026-09-24T00:00:00.000Z",
            reason: null
          },
          candidate: null,
          createdAt: 1000
        }
      ]
    };

    rerender(
      <MemoryPanel
        facts={[]}
        stale={[]}
        projectTitle="Alpha Project"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId="proj-alpha"
        governedView={approvedView}
        onPropose={onPropose}
        onReview={onReview}
      />
    );

    expect(screen.getByText(/Approved \(v2\)/i)).toBeInTheDocument();
    expect(screen.queryByText("Proposed candidate (v1)")).toBeNull();
  });

  it("retains prior approved active revision next to proposed candidate and allows rejection", () => {
    const onReview = vi.fn().mockResolvedValue(undefined);
    const candidateAndActiveView: GovernedProjectMemoryView = {
      projectId: "proj-alpha",
      epoch: 4,
      items: [
        {
          id: "mem-item-2",
          projectId: "proj-alpha",
          kind: "decision",
          headRevision: 3,
          activeRevision: 2,
          active: {
            revision: 2,
            state: "approved",
            text: "Active established architecture decision",
            sourceRefs: [],
            createdBy: "author-1",
            createdAt: 1000,
            approverId: "reviewer-1",
            approvedAt: "2026-09-24T00:00:00Z",
            reason: null
          },
          candidate: {
            revision: 3,
            state: "proposed",
            text: "Proposed new candidate decision replacing prior",
            sourceRefs: [],
            createdBy: "author-2",
            createdAt: 2000,
            approverId: null,
            approvedAt: null,
            reason: null
          },
          createdAt: 1000
        }
      ]
    };

    render(
      <MemoryPanel
        facts={[]}
        stale={[]}
        projectTitle="Alpha Project"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId="proj-alpha"
        governedView={candidateAndActiveView}
        onReview={onReview}
      />
    );

    expect(screen.getByText("Active established architecture decision")).toBeInTheDocument();
    expect(screen.getByText("Proposed new candidate decision replacing prior")).toBeInTheDocument();
    expect(screen.getByText(/Prior approved active/i)).toBeInTheDocument();
    expect(screen.getByText(/Awaiting review \(prior approved v2 remains active\)/i)).toBeInTheDocument();

    const rejectBtn = screen.getByRole("button", { name: /Reject candidate/i });
    fireEvent.click(rejectBtn);
    expect(onReview).toHaveBeenCalledWith("mem-item-2", 3, "reject");
  });

  it("isolates drafts per project, suppresses late/stale reads, and retains unsaved draft on failed save", async () => {
    const failingPropose = vi.fn().mockRejectedValue(new Error("Simulated network collision"));

    const viewA: GovernedProjectMemoryView = {
      projectId: "proj-a",
      epoch: 1,
      items: [
        {
          id: "item-a",
          projectId: "proj-a",
          kind: "instruction",
          headRevision: 1,
          activeRevision: 1,
          active: {
            revision: 1,
            state: "approved",
            text: "Sensitive Project A Rule",
            sourceRefs: [],
            createdBy: "a",
            createdAt: 1,
            approverId: "a",
            approvedAt: "2026-09-24T00:00:00Z",
            reason: null
          },
          candidate: null,
          createdAt: 1
        }
      ]
    };

    const { rerender } = render(
      <MemoryPanel
        facts={[]}
        stale={[]}
        projectTitle="Project A"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId="proj-a"
        governedView={viewA}
        onPropose={failingPropose}
      />
    );

    expect(screen.getByText("Sensitive Project A Rule")).toBeInTheDocument();
    const inputA = screen.getByLabelText(/Propose memory text/i);
    fireEvent.change(inputA, { target: { value: "Draft for project A" } });

    // Switch to Project B, while late view from Project A is passed in
    rerender(
      <MemoryPanel
        facts={[]}
        stale={[]}
        projectTitle="Project B"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId="proj-b"
        governedView={viewA}
        onPropose={failingPropose}
      />
    );

    // Stale Project A content is suppressed
    expect(screen.queryByText("Sensitive Project A Rule")).toBeNull();
    // Project B proposal textarea does not leak Project A's draft
    const inputB = screen.getByLabelText(/Propose memory text/i) as HTMLTextAreaElement;
    expect(inputB.value).toBe("");

    // Switch back to Project A
    rerender(
      <MemoryPanel
        facts={[]}
        stale={[]}
        projectTitle="Project A"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId="proj-a"
        governedView={viewA}
        onPropose={failingPropose}
      />
    );

    const restoredInputA = screen.getByLabelText(/Propose memory text/i) as HTMLTextAreaElement;
    expect(restoredInputA.value).toBe("Draft for project A");

    // Attempt to save and fail
    const saveBtn = screen.getByRole("button", { name: /Save proposal/i });
    fireEvent.click(saveBtn);

    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Simulated network collision");
    // Draft is retained on failure
    expect(restoredInputA.value).toBe("Draft for project A");
  });

  it("distinguishes findings from instructions and makes exclusions visible", () => {
    const mixedView: GovernedProjectMemoryView = {
      projectId: "proj-x",
      epoch: 1,
      items: [
        {
          id: "item-find",
          projectId: "proj-x",
          kind: "finding",
          headRevision: 1,
          activeRevision: 1,
          active: {
            revision: 1,
            state: "approved",
            text: "Finding: latency spiked under heavy concurrency",
            sourceRefs: [],
            createdBy: "analyst",
            createdAt: 100,
            approverId: "reviewer",
            approvedAt: "2026-09-24T00:00:00Z",
            reason: null
          },
          candidate: null,
          createdAt: 100
        },
        {
          id: "item-find-unapproved",
          projectId: "proj-x",
          kind: "finding",
          headRevision: 1,
          activeRevision: null,
          active: null,
          candidate: {
            revision: 1,
            state: "proposed",
            text: "Unreviewed finding candidate",
            sourceRefs: [],
            createdBy: "analyst",
            createdAt: 150,
            approverId: null,
            approvedAt: null,
            reason: null
          },
          createdAt: 150
        },
        {
          id: "item-excl",
          projectId: "proj-x",
          kind: "exclusion",
          headRevision: 1,
          activeRevision: 1,
          active: {
            revision: 1,
            state: "approved",
            text: "Never ingest binary binaries directly",
            sourceRefs: [],
            createdBy: "security",
            createdAt: 200,
            approverId: "sec-lead",
            approvedAt: "2026-09-24T00:00:00Z",
            reason: null
          },
          candidate: null,
          createdAt: 200
        }
      ]
    };

    render(
      <MemoryPanel
        facts={[]}
        stale={[]}
        projectTitle="Project X"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId="proj-x"
        governedView={mixedView}
      />
    );

    expect(screen.getAllByText("Observed Finding")).toHaveLength(2);
    expect(screen.getByText(/Accepted finding \(v1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/\(Finding - not an approved decision or instruction\)/i)).toBeInTheDocument();
    expect(screen.getByText("Exclusion", { selector: "span" })).toBeInTheDocument();
  });

  it("uses truthful memory record deletion wording and does not claim provider unsend", () => {
    const onForgetGoverned = vi.fn().mockResolvedValue(undefined);
    const view: GovernedProjectMemoryView = {
      projectId: "proj-z",
      epoch: 1,
      items: [
        {
          id: "mem-z",
          projectId: "proj-z",
          kind: "instruction",
          headRevision: 1,
          activeRevision: 1,
          active: {
            revision: 1,
            state: "approved",
            text: "Instruction to forget",
            sourceRefs: [],
            createdBy: "actor",
            createdAt: 1,
            approverId: "actor",
            approvedAt: "2026-09-24T00:00:00Z",
            reason: null
          },
          candidate: null,
          createdAt: 1
        }
      ]
    };

    render(
      <MemoryPanel
        facts={[]}
        stale={[]}
        projectTitle="Project Z"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId="proj-z"
        governedView={view}
        onForgetGoverned={onForgetGoverned}
      />
    );

    const deleteBtn = screen.getByRole("button", { name: /Delete entire memory record "Instruction to forget"/i });
    expect(deleteBtn).toHaveAttribute(
      "title",
      "Delete this entire memory record, including approved and pending revisions. This removes the record from project governance and does not erase or unsend original provider messages."
    );

    fireEvent.click(deleteBtn);
    expect(onForgetGoverned).toHaveBeenCalledWith("mem-z", 1);
  });

  it("supports proposing revisions to existing items with CAS expectedRevision and preserves active record", () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    const view: GovernedProjectMemoryView = {
      projectId: "proj-rev",
      epoch: 1,
      items: [
        {
          id: "mem-rev-1",
          projectId: "proj-rev",
          kind: "decision",
          headRevision: 2,
          activeRevision: 2,
          active: {
            revision: 2,
            state: "approved",
            text: "Database engine must be PostgreSQL 15+",
            sourceRefs: [],
            createdBy: "architect",
            createdAt: 100,
            approverId: "lead",
            approvedAt: "2026-09-24T00:00:00Z",
            reason: null
          },
          candidate: null,
          createdAt: 100
        }
      ]
    };

    render(
      <MemoryPanel
        facts={[]}
        stale={[]}
        projectTitle="Revision Test"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId="proj-rev"
        governedView={view}
        onPropose={onPropose}
      />
    );

    const reviseBtn = screen.getByRole("button", { name: /Propose revision for "Database engine must be PostgreSQL 15\+"/i });
    fireEvent.click(reviseBtn);

    expect(screen.getByText(/Propose revision to memory entry/i)).toBeInTheDocument();
    const textarea = screen.getByLabelText(/Propose memory text/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Database engine must be PostgreSQL 15+");

    fireEvent.change(textarea, { target: { value: "Database engine must be PostgreSQL 16+ with vector extensions" } });
    const saveRevBtn = screen.getByRole("button", { name: /Save revision proposal/i });
    fireEvent.click(saveRevBtn);

    expect(onPropose).toHaveBeenCalledWith({
      kind: "decision",
      text: "Database engine must be PostgreSQL 16+ with vector extensions",
      id: "mem-rev-1",
      expectedRevision: 2
    });
  });

  it("disables governed actions when canonical backend is unavailable while keeping legacy observations accessible", () => {
    render(
      <MemoryPanel
        facts={sampleFacts}
        stale={[]}
        projectTitle="Unavailable Test"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId="proj-err"
        governedView={null}
        governedError="Canonical project memory is unavailable."
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Canonical project memory is unavailable.");
    const textarea = screen.getByLabelText(/Propose memory text/i);
    expect(textarea).toBeDisabled();
    const saveBtn = screen.getByRole("button", { name: /Save proposal/i });
    expect(saveBtn).toBeDisabled();

    expect(screen.getByText("Legacy customer acquisition pattern")).toBeInTheDocument();
    const keepBtn = screen.getByRole("button", { name: /Keep "Legacy customer acquisition pattern"/i });
    expect(keepBtn).not.toBeDisabled();
  });

  it("passes optional reason to review and forget actions when provided", () => {
    const onReview = vi.fn().mockResolvedValue(undefined);
    const onForgetGoverned = vi.fn().mockResolvedValue(undefined);

    const view: GovernedProjectMemoryView = {
      projectId: "proj-reason",
      epoch: 1,
      items: [
        {
          id: "mem-r1",
          projectId: "proj-reason",
          kind: "instruction",
          headRevision: 1,
          activeRevision: null,
          active: null,
          candidate: {
            revision: 1,
            state: "proposed",
            text: "Candidate instruction",
            sourceRefs: [],
            createdBy: "author",
            createdAt: 10,
            approverId: null,
            approvedAt: null,
            reason: null
          },
          createdAt: 10
        }
      ]
    };

    render(
      <MemoryPanel
        facts={[]}
        stale={[]}
        projectTitle="Reason Test"
        now={Date.now()}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
        projectId="proj-reason"
        governedView={view}
        onReview={onReview}
        onForgetGoverned={onForgetGoverned}
      />
    );

    const reasonInput = screen.getByPlaceholderText(/Optional reason/i);
    fireEvent.change(reasonInput, { target: { value: "Approved after security team audit" } });

    const approveBtn = screen.getByRole("button", { name: /Approve candidate/i });
    fireEvent.click(approveBtn);

    expect(onReview).toHaveBeenCalledWith("mem-r1", 1, "approve", "Approved after security team audit");
  });
});
