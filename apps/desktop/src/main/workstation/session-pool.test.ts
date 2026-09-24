import { describe, expect, it } from "vitest";
import {
  admit,
  MAX_CONCURRENT_SESSIONS,
  sessionsFor,
  type RunningSession,
  type StartRequest,
} from "./session-pool.js";

describe("session-pool admit policy", () => {
  it("allows a request when the pool is empty", () => {
    const request: StartRequest = {
      caseId: "case-1",
      providerId: "codex",
      workspacePath: "/workspaces/project-a",
      owner: {},
    };
    const decision = admit([], request, 1000);
    expect(decision).toEqual({ allowed: true });
  });

  it("refuses when a running session has the same workspace folder", () => {
    const running: RunningSession = {
      operationId: "op-1",
      caseId: "case-1",
      providerId: "codex",
      workspacePath: "/workspaces/project-a",
      owner: {},
      startedAt: 1000,
    };
    const request: StartRequest = {
      caseId: "case-2",
      providerId: "claude",
      workspacePath: "/workspaces/project-a",
      owner: {},
    };
    const decision = admit([running], request, 2000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.conflictWith).toBe("op-1");
      expect(decision.reason).toContain("/workspaces/project-a");
      expect(decision.reason).not.toContain("\n");
      expect(decision.reason).not.toMatch(/error/i);
    }
  });

  it("refuses when a running session has the same case id", () => {
    const running: RunningSession = {
      operationId: "op-1",
      caseId: "case-1",
      providerId: "codex",
      workspacePath: "/workspaces/project-a",
      owner: {},
      startedAt: 1000,
    };
    const request: StartRequest = {
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/workspaces/project-b",
      owner: {},
    };
    const decision = admit([running], request, 2000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.conflictWith).toBeNull();
      expect(decision.reason).not.toContain("\n");
      expect(decision.reason).not.toMatch(/error/i);
    }
  });

  it("refuses when a running session has the same provider id", () => {
    const running: RunningSession = {
      operationId: "op-1",
      caseId: "case-1",
      providerId: "codex",
      workspacePath: "/workspaces/project-a",
      owner: {},
      startedAt: 1000,
    };
    const request: StartRequest = {
      caseId: "case-2",
      providerId: "codex",
      workspacePath: "/workspaces/project-b",
      owner: {},
    };
    const decision = admit([running], request, 2000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.conflictWith).toBeNull();
      expect(decision.reason).not.toContain("\n");
      expect(decision.reason).not.toMatch(/error/i);
    }
  });

  it("allows when case, provider, and workspace folder are all disjoint", () => {
    const running: RunningSession = {
      operationId: "op-1",
      caseId: "case-1",
      providerId: "codex",
      workspacePath: "/workspaces/project-a",
      owner: {},
      startedAt: 1000,
    };
    const request: StartRequest = {
      caseId: "case-2",
      providerId: "claude",
      workspacePath: "/workspaces/project-b",
      owner: {},
    };
    const decision = admit([running], request, 2000);
    expect(decision).toEqual({ allowed: true });
  });

  it("refuses at concurrency limit and allows at limit minus one", () => {
    const makeSession = (index: number): RunningSession => ({
      operationId: `op-${index}`,
      caseId: `case-${index}`,
      providerId: `provider-${index}`,
      workspacePath: `/workspaces/project-${index}`,
      owner: {},
      startedAt: 1000 + index,
    });

    const belowLimit = Array.from({ length: MAX_CONCURRENT_SESSIONS - 1 }, (_, i) => makeSession(i));
    const candidate: StartRequest = {
      caseId: "case-candidate",
      providerId: "provider-candidate",
      workspacePath: "/workspaces/project-candidate",
      owner: {},
    };

    const allowedDecision = admit(belowLimit, candidate, 5000);
    expect(allowedDecision).toEqual({ allowed: true });

    const atLimit = Array.from({ length: MAX_CONCURRENT_SESSIONS }, (_, i) => makeSession(i));
    const refusedDecision = admit(atLimit, candidate, 5000);
    expect(refusedDecision.allowed).toBe(false);
    if (!refusedDecision.allowed) {
      expect(refusedDecision.reason).toContain(String(MAX_CONCURRENT_SESSIONS));
      expect(refusedDecision.conflictWith).toBeNull();
      expect(refusedDecision.reason).not.toContain("\n");
      expect(refusedDecision.reason).not.toMatch(/error/i);
    }
  });

  it("refuses when caseId, providerId, or workspacePath is empty", () => {
    const baseRequest: StartRequest = {
      caseId: "case-1",
      providerId: "codex",
      workspacePath: "/workspaces/project-a",
      owner: {},
    };

    const emptyFolder = admit([], { ...baseRequest, workspacePath: "" }, 1000);
    expect(emptyFolder.allowed).toBe(false);
    if (!emptyFolder.allowed) {
      expect(emptyFolder.conflictWith).toBeNull();
      expect(emptyFolder.reason).not.toMatch(/error/i);
    }

    const emptyCase = admit([], { ...baseRequest, caseId: "" }, 1000);
    expect(emptyCase.allowed).toBe(false);
    if (!emptyCase.allowed) {
      expect(emptyCase.conflictWith).toBeNull();
      expect(emptyCase.reason).not.toMatch(/error/i);
    }

    const emptyProvider = admit([], { ...baseRequest, providerId: "" }, 1000);
    expect(emptyProvider.allowed).toBe(false);
    if (!emptyProvider.allowed) {
      expect(emptyProvider.conflictWith).toBeNull();
      expect(emptyProvider.reason).not.toMatch(/error/i);
    }
  });

  it("prioritises folder conflict over provider conflict deterministically", () => {
    const folderHolder: RunningSession = {
      operationId: "op-folder",
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/workspaces/shared",
      owner: {},
      startedAt: 1000,
    };
    const providerHolder: RunningSession = {
      operationId: "op-provider",
      caseId: "case-2",
      providerId: "codex",
      workspacePath: "/workspaces/other",
      owner: {},
      startedAt: 1001,
    };

    const request: StartRequest = {
      caseId: "case-3",
      providerId: "codex",
      workspacePath: "/workspaces/shared",
      owner: {},
    };

    const decision = admit([folderHolder, providerHolder], request, 2000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.conflictWith).toBe("op-folder");
      expect(decision.reason).toContain("/workspaces/shared");
    }
  });

  it("sessionsFor filters by case and sorts by startedAt with operationId tie breaking", () => {
    const s1: RunningSession = {
      operationId: "op-2",
      caseId: "case-target",
      providerId: "codex",
      workspacePath: "/workspaces/a",
      owner: {},
      startedAt: 200,
    };
    const s2: RunningSession = {
      operationId: "op-1",
      caseId: "case-target",
      providerId: "claude",
      workspacePath: "/workspaces/b",
      owner: {},
      startedAt: 100,
    };
    const s3: RunningSession = {
      operationId: "op-tie-b",
      caseId: "case-target",
      providerId: "gemini",
      workspacePath: "/workspaces/c",
      owner: {},
      startedAt: 150,
    };
    const s4: RunningSession = {
      operationId: "op-tie-a",
      caseId: "case-target",
      providerId: "local",
      workspacePath: "/workspaces/d",
      owner: {},
      startedAt: 150,
    };
    const unrelated: RunningSession = {
      operationId: "op-unrelated",
      caseId: "case-other",
      providerId: "codex",
      workspacePath: "/workspaces/e",
      owner: {},
      startedAt: 50,
    };

    const ordered = sessionsFor([s1, s2, s3, s4, unrelated], "case-target");
    expect(ordered.map((s) => s.operationId)).toEqual([
      "op-1",
      "op-tie-a",
      "op-tie-b",
      "op-2",
    ]);

    const empty = sessionsFor([s1, s2], "case-unknown");
    expect(empty).toEqual([]);
  });
});
