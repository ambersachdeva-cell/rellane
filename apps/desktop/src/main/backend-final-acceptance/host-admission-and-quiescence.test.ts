import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  admit,
  MAX_CONCURRENT_SESSIONS,
  type RunningSession,
  type StartRequest
} from "../workstation/session-pool.js";

describe("Backend Final Acceptance - Host Admission, Folder Overlap, and Quiescence (G00 / G02 / R06)", () => {
  const dummyOwner1 = { id: "owner-1" };
  const dummyOwner2 = { id: "owner-2" };

  it("blocks concurrent sessions targeting identical workspace folders", () => {
    const wsPath = "/tmp/workspaces/project-alpha";

    const running: RunningSession[] = [
      {
        operationId: "op-1",
        caseId: "case-1",
        providerId: "claude",
        workspacePath: wsPath,
        owner: dummyOwner1,
        startedAt: 1000
      }
    ];

    const request: StartRequest = {
      caseId: "case-2",
      providerId: "codex",
      workspacePath: wsPath,
      owner: dummyOwner2
    };

    const decision = admit(running, request, 2000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("Stop the Claude session in /tmp/workspaces/project-alpha first");
      expect(decision.conflictWith).toBe("op-1");
    }
  });

  it("blocks concurrent sessions targeting overlapping parent/child subdirectories", () => {
    const parentPath = "/tmp/workspaces/monorepo";
    const childPath = "/tmp/workspaces/monorepo/packages/backend";

    // 1. Running in parent, requesting child
    const runningParent: RunningSession[] = [
      {
        operationId: "op-parent",
        caseId: "case-parent",
        providerId: "codex",
        workspacePath: parentPath,
        owner: dummyOwner1,
        startedAt: 1000
      }
    ];

    const reqChild: StartRequest = {
      caseId: "case-child",
      providerId: "claude",
      workspacePath: childPath,
      owner: dummyOwner2
    };

    const decChild = admit(runningParent, reqChild, 2000);
    expect(decChild.allowed).toBe(false);
    if (!decChild.allowed) {
      expect(decChild.reason).toContain("Stop the Codex session");
      expect(decChild.conflictWith).toBe("op-parent");
    }

    // 2. Running in child, requesting parent
    const runningChild: RunningSession[] = [
      {
        operationId: "op-child",
        caseId: "case-child",
        providerId: "claude",
        workspacePath: childPath,
        owner: dummyOwner2,
        startedAt: 1000
      }
    ];

    const reqParent: StartRequest = {
      caseId: "case-parent",
      providerId: "gemini1",
      workspacePath: parentPath,
      owner: dummyOwner1
    };

    const decParent = admit(runningChild, reqParent, 2000);
    expect(decParent.allowed).toBe(false);
    if (!decParent.allowed) {
      expect(decParent.reason).toContain("Stop the Claude session");
      expect(decParent.conflictWith).toBe("op-child");
    }
  });

  it("permits concurrent sessions on distinct sibling folders with distinct providers and cases", () => {
    const siblingA = "/tmp/workspaces/service-a";
    const siblingB = "/tmp/workspaces/service-b";

    const running: RunningSession[] = [
      {
        operationId: "op-a",
        caseId: "case-a",
        providerId: "codex",
        workspacePath: siblingA,
        owner: dummyOwner1,
        startedAt: 1000
      }
    ];

    const request: StartRequest = {
      caseId: "case-b",
      providerId: "claude",
      workspacePath: siblingB,
      owner: dummyOwner2
    };

    const decision = admit(running, request, 2000);
    expect(decision.allowed).toBe(true);
  });

  it("enforces single active run per Case to prevent interleaved transcript races", () => {
    const running: RunningSession[] = [
      {
        operationId: "op-case-1",
        caseId: "case-shared",
        providerId: "claude",
        workspacePath: "/tmp/workspaces/proj-1",
        owner: dummyOwner1,
        startedAt: 1000
      }
    ];

    const request: StartRequest = {
      caseId: "case-shared", // Same case
      providerId: "codex",
      workspacePath: "/tmp/workspaces/proj-2",
      owner: dummyOwner2
    };

    const decision = admit(running, request, 2000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("Stop the running session for this case first");
    }
  });

  it("enforces single active run per Provider to prevent silent account rate limit exhaustion", () => {
    const running: RunningSession[] = [
      {
        operationId: "op-prov-1",
        caseId: "case-1",
        providerId: "codex",
        workspacePath: "/tmp/workspaces/proj-1",
        owner: dummyOwner1,
        startedAt: 1000
      }
    ];

    const request: StartRequest = {
      caseId: "case-2",
      providerId: "codex", // Same provider!
      workspacePath: "/tmp/workspaces/proj-2",
      owner: dummyOwner2
    };

    const decision = admit(running, request, 2000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("Stop the running Codex session first");
    }
  });

  it("caps total concurrent sessions at MAX_CONCURRENT_SESSIONS (4)", () => {
    const running: RunningSession[] = [
      { operationId: "op-1", caseId: "case-1", providerId: "codex", workspacePath: "/tmp/ws/1", owner: {}, startedAt: 1 },
      { operationId: "op-2", caseId: "case-2", providerId: "claude", workspacePath: "/tmp/ws/2", owner: {}, startedAt: 2 },
      { operationId: "op-3", caseId: "case-3", providerId: "gemini1", workspacePath: "/tmp/ws/3", owner: {}, startedAt: 3 },
      { operationId: "op-4", caseId: "case-4", providerId: "gemini2", workspacePath: "/tmp/ws/4", owner: {}, startedAt: 4 }
    ];

    expect(running.length).toBe(MAX_CONCURRENT_SESSIONS);

    const request: StartRequest = {
      caseId: "case-5",
      providerId: "gemini3",
      workspacePath: "/tmp/ws/5",
      owner: {}
    };

    const decision = admit(running, request, 5000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("at most 4 sessions may run at the same time");
    }
  });

  it("models file restore quiescence: active restore lease blocks new session in the same workspace", () => {
    // In WorkstationHost.fileRestore:
    // `this.restoreLeases.set(operationId, { operationId, caseId, workspacePath: canonicalPath, owner, startedAt })`
    // And assertAdmissible includes restore leases mapped with providerId: ""
    const restorePath = "/tmp/workspaces/target-restore";
    const restoreLease: RunningSession = {
      operationId: "restore-op-99",
      caseId: "case-restore",
      providerId: "",
      workspacePath: restorePath,
      owner: dummyOwner1,
      startedAt: 1000
    };

    const running = [restoreLease];

    // Attempt to start a session in the directory currently undergoing restore
    const request: StartRequest = {
      caseId: "case-other",
      providerId: "codex",
      workspacePath: restorePath,
      owner: dummyOwner2
    };

    const decision = admit(running, request, 2000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("Stop the active session in /tmp/workspaces/target-restore first");
      expect(decision.conflictWith).toBe("restore-op-99");
    }
  });
});
