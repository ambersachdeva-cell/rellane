import { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import type { WorkstationProvider } from "@cadrane/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { installModelAdviceIpc } from "./model-advice-ipc.js";
import { forgetProjectModelPreferences, saveProjectModelPreferences } from "./model-project-preferences-store.js";
import { saveWorkstationProject } from "./projects.js";
import { saveSessionReceipt } from "./store.js";

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } }));

const trusted = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const untrusted = { sender: { id: 2 } } as unknown as IpcMainInvokeEvent;
const providers: readonly WorkstationProvider[] = [
  { id: "codex", label: "Codex", family: "codex", state: "detected", detail: "CLI found",
    models: [], canResume: true, canApproveTools: true },
  { id: "claude", label: "Claude", family: "claude", state: "detected", detail: "CLI found",
    models: [{ id: "sonnet", label: "Sonnet" }], canResume: true, canApproveTools: true },
  { id: "gemini1", label: "Gemini 1", family: "gemini", state: "detected", detail: "CLI found",
    models: [{ id: "gemini-3.8-flash-high", label: "Flash High" }], canResume: true, canApproveTools: false },
  { id: "gemini2", label: "Gemini 2", family: "gemini", state: "unavailable", detail: "CLI absent",
    models: [{ id: "gemini-3.8-flash-high", label: "Flash High" }], canResume: true, canApproveTools: false }
];

describe("read-only Solo model advice IPC", () => {
  let db: DatabaseSync;
  let projectId: string;
  let otherId: string;
  const providerReader = vi.fn(async () => providers);
  beforeEach(() => {
    handlers.clear(); providerReader.mockClear();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    projectId = saveWorkstationProject(db, { title: "One", brief: "One brief" }).id;
    otherId = saveWorkstationProject(db, { title: "Two", brief: "Two brief" }).id;
  });
  afterEach(() => db.close());

  function install() {
    installModelAdviceIpc({
      assertTrusted: (event) => { if (event !== trusted) throw new Error("Untrusted sender"); },
      book: () => db, providers: providerReader
    });
    return handlers.get(IPC_CHANNELS.workstationSoloModelAdvice)!;
  }

  it("rejects untrusted and unknown-project calls without reading the provider catalog", async () => {
    const advice = install();
    await expect(advice(untrusted, { projectId })).rejects.toThrow("Untrusted sender");
    await expect(advice(trusted, { projectId: "missing-project" })).rejects.toThrow(/does not exist/);
    await expect(advice(trusted, { projectId, extra: true })).rejects.toThrow();
    expect(providerReader).not.toHaveBeenCalled();
  });

  it("preserves a Solo pin as blocked or unavailable and hard-filters unselected advice", async () => {
    saveProjectModelPreferences(db, { projectId, expectedRevision: 0,
      preferences: { exclusions: [{ providerId: "gemini1" }] }
    });
    const advice = install();
    const blocked = await advice(trusted, { projectId,
      explicitChoice: { providerId: "gemini1", modelId: "gemini-3.8-flash-high" }
    }) as { advice: { isPinned: boolean; pinStatus: string; selected: unknown; rankedCandidates: readonly unknown[] } };
    expect(blocked.advice).toMatchObject({ isPinned: true, pinStatus: "blocked", selected: null,
      rankedCandidates: [] });
    const absentCodex = await advice(trusted, { projectId,
      explicitChoice: { providerId: "codex", modelId: "gpt-6-sol" }
    }) as { advice: { pinStatus: string; selected: unknown } };
    expect(absentCodex.advice).toMatchObject({ pinStatus: "unavailable", selected: null });
    const unavailableProfile = await advice(trusted, { projectId,
      explicitChoice: { providerId: "gemini2", modelId: "gemini-3.8-flash-high" }
    }) as { advice: { pinStatus: string; selected: unknown } };
    expect(unavailableProfile.advice).toMatchObject({ pinStatus: "unavailable", selected: null });
    const unselected = await advice(trusted, { projectId }) as {
      advice: { rankedCandidates: readonly { candidate: { providerId: string; capabilities: readonly string[] } }[];
        reasons: readonly string[] };
      readiness: string; providerCatalog: readonly { providerId: string; modelIds: readonly string[] }[]
    };
    expect(unselected.advice.rankedCandidates.map((one) => one.candidate.providerId)).toEqual(["claude"]);
    expect(unselected.advice.rankedCandidates[0]?.candidate.capabilities).toEqual([]);
    expect(unselected.advice.reasons[0]).toContain("no declared model capabilities");
    expect(unselected.readiness).toBe("unverified");
    expect(unselected.providerCatalog.find((one) => one.providerId === "codex")?.modelIds).toEqual([]);
    const otherProject = await advice(trusted, { projectId: otherId }) as {
      advice: { rankedCandidates: readonly { candidate: { providerId: string } }[] }
    };
    expect(otherProject.advice.rankedCandidates.map((one) => one.candidate.providerId))
      .toContain("gemini1");
    forgetProjectModelPreferences(db, { projectId, expectedRevision: 1 });
    const afterForget = await advice(trusted, { projectId }) as {
      preferencesRevision: number | null;
      advice: { rankedCandidates: readonly { candidate: { providerId: string } }[] }
    };
    expect(afterForget.preferencesRevision).toBe(2);
    expect(afterForget.advice.rankedCandidates.map((one) => one.candidate.providerId))
      .toContain("gemini1");
  });

  it("uses only the requested project's measured receipts and never starts a model", async () => {
    const caseOne = openCase(db, { title: "Case one", question: "One" });
    const caseTwo = openCase(db, { title: "Case two", question: "Two" });
    for (const [caseId, scopedProjectId, operationId] of [
      [caseOne, projectId, "op-one"], [caseTwo, otherId, "op-two"]
    ] as const) {
      saveSessionReceipt(db, caseId, { version: 1, event: "finish", projectId: scopedProjectId,
        workspacePath: "/private/work", snapshot: {
          operationId, caseId, providerId: "claude", modelId: "sonnet", sessionId: "native",
          status: "completed", startedAt: 1000, updatedAt: 2000, text: "PRIVATE ANSWER",
          activity: [], permission: null, detail: "PRIVATE DETAIL"
        }
      });
    }
    const advice = install();
    const view = await advice(trusted, { projectId,
      explicitChoice: { providerId: "claude", modelId: "sonnet" }
    }) as { evidenceOperations: number; advice: { pinStatus: string; selected: {
      reliabilitySignal: { totalAttemptedCount: number; status: string }; candidate: { modelId: string }
    } | null } };
    expect(view.evidenceOperations).toBe(1);
    expect(view.advice.pinStatus).toBe("active");
    expect(view.advice.selected?.candidate.modelId).toBe("sonnet");
    expect(view.advice.selected?.reliabilitySignal.totalAttemptedCount).toBe(1);
    expect(view.advice.selected?.reliabilitySignal.status).toBe("insufficient_sample");
    expect(JSON.stringify(view)).not.toContain("PRIVATE");
    expect(providerReader).toHaveBeenCalledTimes(1);
  });

  it("returns scoped read-only Team packages and leaves unknown model capabilities for owner review", async () => {
    const caseOne = openCase(db, { title: "Team one", question: "One" });
    const caseTwo = openCase(db, { title: "Team two", question: "Two" });
    for (const [caseId, scopedProjectId, operationId] of [
      [caseOne, projectId, "one"], [caseTwo, otherId, "two"]
    ] as const) {
      saveSessionReceipt(db, caseId, { version: 1, event: "finish", projectId: scopedProjectId,
        workspacePath: "/private/work", snapshot: { operationId, caseId,
          providerId: "claude", modelId: "sonnet", sessionId: "native", status: "completed",
          startedAt: 1000, updatedAt: 2000, text: "PRIVATE ANSWER", activity: [],
          permission: null, detail: "PRIVATE DETAIL" }
      });
    }
    const beforeTurns = db.prepare("SELECT COUNT(*) AS count FROM case_turn").get() as { count: number };
    install();
    const teamAdvice = handlers.get(IPC_CHANNELS.workstationTeamModelAdvice)!;
    await expect(teamAdvice(untrusted, { projectId, overallPrompt: "Draft a plan" }))
      .rejects.toThrow("Untrusted sender");
    await expect(teamAdvice(trusted, { projectId: "missing-project", overallPrompt: "Draft a plan" }))
      .rejects.toThrow(/does not exist/);
    await expect(teamAdvice(trusted, { projectId, overallPrompt: "x".repeat(2001) }))
      .rejects.toThrow();

    const view = await teamAdvice(trusted, { projectId, overallPrompt: "Draft a plan" }) as {
      evidenceOperations: number; readiness: string; basis: string;
      advice: { assignments: readonly unknown[]; unassignedRoles: readonly unknown[];
        reviewRequiredPackages: readonly { draftPrompt: string; reason: string }[];
        isComparison: boolean }
    };
    expect(view.evidenceOperations).toBe(1);
    expect(view.readiness).toBe("unverified");
    expect(view.basis).toContain("no capabilities");
    expect(view.advice.assignments).toEqual([]);
    expect(view.advice.unassignedRoles).toHaveLength(3);
    expect(view.advice.reviewRequiredPackages).toHaveLength(3);
    expect(new Set(view.advice.reviewRequiredPackages.map((one) => one.draftPrompt)).size).toBe(3);
    expect(view.advice.reviewRequiredPackages.every((one) => one.reason.includes("owner review"))).toBe(true);
    expect(view.advice.isComparison).toBe(false);
    expect(JSON.stringify(view)).not.toContain("PRIVATE");
    const afterTurns = db.prepare("SELECT COUNT(*) AS count FROM case_turn").get() as { count: number };
    expect(afterTurns).toEqual(beforeTurns);
  });

  it("requires a trusted explicit review echo before an adaptive weight affects future advice", async () => {
    const caseId = openCase(db, { title: "Measured case", question: "Question" });
    for (let index = 0; index < 10; index += 1) {
      saveSessionReceipt(db, caseId, { version: 1, event: "finish", projectId,
        workspacePath: "/synthetic", snapshot: { operationId: `measured-${index}`, caseId,
          providerId: "claude", modelId: "sonnet", reportedModelId: "sonnet",
          sessionId: `session-${index}`, status: "completed", startedAt: 100,
          updatedAt: 200, text: "PRIVATE ANSWER", activity: [], permission: null,
          detail: "PRIVATE DETAIL" } });
    }
    install();
    const propose = handlers.get(IPC_CHANNELS.workstationModelAdaptationPropose)!;
    const accept = handlers.get(IPC_CHANNELS.workstationModelAdaptationAccept)!;
    await expect(propose(untrusted, { projectId })).rejects.toThrow("Untrusted sender");
    await expect(propose(trusted, { projectId, explicitChoice: {
      providerId: "claude", modelId: "sonnet" } })).rejects.toThrow();
    const proposal = await propose(trusted, { projectId }) as {
      id: string; proposalSha256: string; delta: { modelId: string; to: number };
    };
    expect(proposal.delta).toMatchObject({ modelId: "sonnet", to: 1.1 });
    expect(JSON.stringify(proposal)).not.toContain("PRIVATE");
    await expect(accept(untrusted, { projectId, proposalId: proposal.id,
      expectedProposalSha256: proposal.proposalSha256, confirmed: true }))
      .rejects.toThrow("Untrusted sender");
    await expect(accept(trusted, { projectId, proposalId: proposal.id,
      expectedProposalSha256: proposal.proposalSha256 }))
      .rejects.toThrow();
    const accepted = await accept(trusted, { projectId, proposalId: proposal.id,
      expectedProposalSha256: proposal.proposalSha256, confirmed: true }) as {
        revision: number; preferences: { providerModelWeights: Record<string, Record<string, number>> }
      };
    expect(accepted.revision).toBe(1);
    expect(accepted.preferences.providerModelWeights).toEqual({ claude: { sonnet: 1.1 } });
    const laterAdvice = await handlers.get(IPC_CHANNELS.workstationSoloModelAdvice)!(trusted, {
      projectId
    }) as { advice: { rankedCandidates: readonly { reasons: readonly string[] }[] } };
    expect(laterAdvice.advice.rankedCandidates[0]?.reasons.join(" "))
      .toContain("Project preference provider-model weight");
    expect(db.prepare("SELECT COUNT(*) AS count FROM case_turn WHERE kind = 'verbatim'").get())
      .toEqual({ count: 0 });
  });
});
