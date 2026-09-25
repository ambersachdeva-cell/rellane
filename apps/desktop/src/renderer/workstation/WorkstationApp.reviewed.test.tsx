import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkstationApp } from "./WorkstationApp.js";

if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
}

describe("WorkstationApp reviewed Agent caller", () => {
  let agentPrepare: ReturnType<typeof vi.fn>;
  let agentStart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    agentPrepare = vi.fn().mockResolvedValue({
      token: "b".repeat(64), expiresAt: Date.now() + 60_000,
      reviews: [{
        caseId: "case-new", providerId: "codex", providerLabel: "Codex", modelId: "gpt-5-codex",
        prompt: "Inspect the source", contextPreview: "EXACT PACKET: Inspect the source",
        sourceIds: [], sourceHash: "hash-of-exact-packet",
        workspace: { id: "private", label: "Private work folder", path: "/synthetic/work" },
        expiresAt: Date.now() + 60_000, resumeSessionId: null, contextSnapshotId: "snapshot-1"
      }]
    });
    agentStart = vi.fn().mockResolvedValue({ runId: "run-agent" });
    Object.assign(window, { cadrane: {
      cases: {
        list: vi.fn().mockResolvedValue({ cases: [{
          id: "case-alpha", title: "Alpha Workspace Case", question: "Inspect the source",
          closedAt: null, lastActivityAt: 1000
        }] }),
        read: vi.fn().mockResolvedValue({
          case: { id: "case-alpha", title: "Alpha Workspace Case", question: "Inspect the source" },
          turns: [], artifacts: []
        }),
        open: vi.fn().mockResolvedValue({
          case: { id: "case-new", title: "Inspect the source", question: "Inspect the source", closedAt: null },
          turns: [], artifacts: []
        })
      },
      runtimes: { discover: vi.fn().mockResolvedValue([]) },
      workstation: {
        continuity: vi.fn().mockResolvedValue({ projects: [], links: [], routines: [] }),
        providers: vi.fn().mockResolvedValue([{
          id: "codex", label: "Codex", family: "codex", state: "detected",
          detail: "Executable found", models: [{ id: "gpt-5-codex", label: "GPT 5 Codex" }]
        }]),
        routines: vi.fn().mockResolvedValue([]), running: vi.fn().mockResolvedValue([]),
        state: vi.fn().mockResolvedValue(null), agentPrepare, agentStart,
        agentsList: vi.fn().mockResolvedValue({ agents: [] }),
        agentPoll: vi.fn().mockResolvedValue({ state: "done", steps: [], answer: "Done" })
      }
    } });
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("shows the exact packet and requires a separate start click", async () => {
    render(<WorkstationApp onTools={() => {}} />);
    await screen.findByRole("button", { name: "Codex" });
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5-codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message your AI" }), {
      target: { value: "Inspect the source" }
    });
    expect(screen.getByRole("textbox", { name: "Message your AI" })).toHaveValue("Inspect the source");
    const stepButton = screen.getByRole("button", { name: "Step through it" });
    await waitFor(() => expect(stepButton).toBeEnabled());
    fireEvent.click(stepButton);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    await waitFor(() => expect(agentPrepare).toHaveBeenCalledWith({
      caseId: "case-new", goal: "Inspect the source", providerId: "codex",
      modelId: "gpt-5-codex", sourceTurnIds: []
    }));
    expect(agentStart).not.toHaveBeenCalled();
    expect(screen.getByText("EXACT PACKET: Inspect the source")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start reviewed Agent" }));
    await waitFor(() => expect(agentStart).toHaveBeenCalledWith({ token: "b".repeat(64) }));
  });

  it("runs a pinned saved agent with a chosen output and exact reviewed start", async () => {
    vi.mocked(window.cadrane.workstation.agentsList).mockResolvedValue({ agents: [{
      id: "my-agent", origin: "user", markdown: "# My agent\n\nFollow the written procedure.",
      updatedAt: 1000, revision: "a".repeat(64)
    }] });
    render(<WorkstationApp onTools={() => {}} />);
    await screen.findByRole("button", { name: "Codex" });
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5-codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message your AI" }), {
      target: { value: "Prepare the client brief" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Your agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open My agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Try it" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Saved agent: my-agent/u }), {
      target: { value: "A complete client brief" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(agentPrepare).toHaveBeenCalledWith({
      caseId: "case-new", goal: "Prepare the client brief", providerId: "codex",
      modelId: "gpt-5-codex", sourceTurnIds: [], savedAgent: {
        id: "my-agent", origin: "user", expectedRevision: "a".repeat(64),
        expectedOutput: "A complete client brief", requestedToolScopes: ["none"]
      }
    }));
    expect(agentStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start reviewed Agent" }));
    await waitFor(() => expect(agentStart).toHaveBeenCalledWith({ token: "b".repeat(64) }));
  });
});
