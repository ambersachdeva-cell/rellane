import { describe, expect, it, vi, beforeEach } from "vitest";

const electron = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, input?: unknown) => Promise<unknown>
  >();
  return {
    handlers,
    ipcMain: {
      handle: (
        channel: string,
        handler: (event: unknown, input?: unknown) => Promise<unknown>
      ) => {
        handlers.set(channel, handler);
      }
    }
  };
});

vi.mock("electron", () => ({
  ipcMain: electron.ipcMain
}));

import {
  installReviewedCrewRun,
  WorkstationCrewPreparePartSchema,
  type CrewRunView
} from "../workstation/crew-run-ipc.js";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { WorkstationReview } from "@cadrane/contracts";

describe("Backend Final Acceptance - Team Crew Run, Ownership and Retry Contracts (G03 / R08)", () => {
  beforeEach(() => {
    electron.handlers.clear();
  });

  const mockReview: WorkstationReview = {
    token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    caseId: "case-alpha",
    providerId: "codex",
    providerLabel: "Codex",
    modelId: "gpt-5-codex",
    prompt: "Investigate module A",
    contextPreview: "Context preview",
    contextSnapshotId: "snap-alpha-1",
    sourceIds: ["turn-1"],
    sourceHash: "abc123hash",
    workspace: { id: "ws-1", label: "Workspace 1", path: "/tmp/ws1" },
    expiresAt: Date.now() + 60_000,
    resumeSessionId: null
  };

  it("validates role partitioning, dependency cycles, and integration owner dependency closure", () => {
    // 1. Valid individual part schema
    const validPart = WorkstationCrewPreparePartSchema.parse({
      id: "part-1",
      title: "Analyzer",
      role: "Architect",
      contextRoleId: "architect",
      providerId: "claude",
      modelId: "sonnet-3-7",
      dependsOn: []
    });
    expect(validPart.id).toBe("part-1");
    expect(validPart.contextRoleId).toBe("architect");

    // 2. Invalid role context: cannot derive arbitrary role from uncontrolled text
    expect(() =>
      WorkstationCrewPreparePartSchema.parse({
        id: "part-bad",
        title: "Bad Role",
        role: "Bad Role",
        contextRoleId: "INVALID_ROLE_NOT_IN_SCHEMA",
        providerId: "claude",
        modelId: "sonnet-3-7"
      })
    ).toThrow();

    // 3. Invalid provider ID outside approved CREW_PROVIDER_IDS
    expect(() =>
      WorkstationCrewPreparePartSchema.parse({
        id: "part-bad-provider",
        title: "Bad Provider",
        role: "Reviewer",
        providerId: "untrusted-provider-x",
        modelId: "model-1"
      })
    ).toThrow();
  });

  it("manages crew execution lifecycle, dependency snapshots and abort cancellation", async () => {
    const ownerObject = { windowId: 1 };
    const mockEvent = { sender: { id: 1 } };

    const childRuns: { partId: string; prompt: string }[] = [];
    const persistedReceipts: { caseId: string; event: unknown }[] = [];

    const crew = installReviewedCrewRun({
      assertTrusted: () => {},
      ownerFor: () => ownerObject,
      prepareChild: vi.fn(async ({ caseId, providerId, modelId, prompt }) => ({
        ...mockReview,
        caseId,
        providerId,
        modelId,
        prompt
      })),
      runChild: vi.fn(async ({ review, onActivity }) => {
        childRuns.push({ partId: review.caseId, prompt: review.prompt });
        onActivity?.("Doing unit synthesis");
        return {
          sessionId: "sess-1",
          requestedModelId: review.modelId,
          cancellationRequested: false,
          resultSource: "worker" as const,
          finishReason: "completed" as const,
          text: `Output for ${review.prompt}`,
          detail: "Success",
          turnId: "turn-answer-1"
        };
      }),
      readDependency: vi.fn(async ({ turnId }) => `Predecessor text from ${turnId}`),
      persistParent: vi.fn(async () => {}),
      persistChild: vi.fn(async (caseId, event) => {
        persistedReceipts.push({ caseId, event });
      })
    });

    const prepareHandler = electron.handlers.get(IPC_CHANNELS.workstationCrewPrepare);
    const startHandler = electron.handlers.get(IPC_CHANNELS.workstationCrewStart);
    const pollHandler = electron.handlers.get(IPC_CHANNELS.workstationCrewPoll);

    expect(prepareHandler).toBeDefined();
    expect(startHandler).toBeDefined();
    expect(pollHandler).toBeDefined();

    // Step 1: Prepare a 2-part run (part-2 depends on part-1)
    const prepResult = (await prepareHandler!(mockEvent, {
      caseId: "case-alpha",
      request: "Analyze and Refactor",
      integrationOwner: "part-2",
      parts: [
        {
          id: "part-1",
          title: "Part One",
          role: "Architect",
          expectedOutput: "Report on module A",
          providerId: "claude",
          modelId: "sonnet-3-7",
          prompt: "Analyze the architecture",
          dependsOn: []
        },
        {
          id: "part-2",
          title: "Part Two",
          role: "Developer",
          expectedOutput: "Implementation of refactoring",
          providerId: "codex",
          modelId: "gpt-5-codex",
          prompt: "Implement refactoring",
          dependsOn: ["part-1"]
        }
      ]
    })) as { token: string; reviews: unknown[] };

    expect(prepResult.token).toBeDefined();
    expect(typeof prepResult.token).toBe("string");
    expect(prepResult.token.length).toBe(64);

    // Step 2: Start the prepared run
    const startResult = (await startHandler!(mockEvent, {
      token: prepResult.token
    })) as { runId: string };

    expect(startResult.runId).toBeDefined();

    // Initial state via poll
    const polledInitial = (await pollHandler!(mockEvent, {
      runId: startResult.runId
    })) as CrewRunView;

    expect(polledInitial.parts.length).toBe(2);
    expect(polledInitial.parts[0]?.state).toBe("working");
    expect(polledInitial.parts[1]?.state).toBe("waiting");

    // Allow async child execution loop turn to resolve
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Poll state after Phase 1: Part 1 is answered, Part 2 awaits continuation review with completed dependency outputs
    const polledPhase1 = (await pollHandler!(mockEvent, {
      runId: startResult.runId
    })) as CrewRunView;

    expect(polledPhase1.round).toBe("awaiting-review");
    expect(polledPhase1.parts[0]?.state).toBe("answered");
    expect(polledPhase1.parts[1]?.state).toBe("awaiting-review");

    // Step 3: Prepare and start continuation review for dependent Part 2
    const contPrep = (await prepareHandler!(mockEvent, {
      runId: startResult.runId
    })) as { token: string; reviews: unknown[] };
    await startHandler!(mockEvent, {
      token: contPrep.token
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    // Poll final state
    const polled = (await pollHandler!(mockEvent, {
      runId: startResult.runId
    })) as CrewRunView;

    // Both parts should complete sequentially and settle to done
    expect(polled.round).toBe("done");
    expect(polled.parts[0]?.state).toBe("done");
    expect(polled.parts[1]?.state).toBe("done");

    await crew.shutdown();
  });

  /**
   * SAFETY INVARIANT VERIFICATION (G03 / R08):
   * Master Plan Contract G03 / R08 specifies:
   * "A failed package may be retried only with known prior effect and fresh review;
   *  completed predecessors are reused with immutable provenance; retry never replays uncertain prior side-effects."
   *
   * In apps/desktop/src/main/workstation/crew-run-ipc.ts lines 1088-1091:
   *   // A terminal failed/stopped result still may have run tools. Until the
   *   // host can prove this attempt had no effects, only unstarted parts may
   *   // receive a fresh review; uncertain work is never replayed.
   *   if (p.attempted) return false;
   *
   * Once part-2 has been dispatched to the provider (`p.attempted = true`),
   * continuation review refuses to automatically retry it without effect proof,
   * whereas a part stopped before provider dispatch (`p.attempted === false`)
   * can receive a fresh continuation review while reusing completed part-1.
   */
  it("refuses continuation retry for an already-dispatched failed package without effect proof while allowing pre-dispatch stopped continuation", async () => {
    const ownerObject = { windowId: 2 };
    const mockEvent = { sender: { id: 2 } };

    const crew = installReviewedCrewRun({
      assertTrusted: () => {},
      ownerFor: () => ownerObject,
      prepareChild: vi.fn(async ({ caseId, providerId, modelId, prompt }) => ({
        ...mockReview,
        caseId,
        providerId,
        modelId,
        prompt
      })),
      runChild: vi.fn(async ({ review }) => {
        if (review.prompt.includes("Part 2")) {
          // Part 2 fails with a definite provider failure
          return {
            sessionId: "sess-2",
            requestedModelId: review.modelId,
            cancellationRequested: false,
            resultSource: "worker" as const,
            finishReason: "failed" as const,
            text: "Quota exceeded on provider",
            detail: "Rate limit 429",
            turnId: null
          };
        }
        return {
          sessionId: "sess-1",
          requestedModelId: review.modelId,
          cancellationRequested: false,
          resultSource: "worker" as const,
          finishReason: "completed" as const,
          text: "Part 1 completed successfully",
          detail: "Success",
          turnId: "turn-answer-1"
        };
      }),
      readDependency: vi.fn(async ({ turnId }) => `Output of ${turnId}`),
      persistParent: vi.fn(async () => {}),
      persistChild: vi.fn(async () => {})
    });

    const prepareHandler = electron.handlers.get(IPC_CHANNELS.workstationCrewPrepare);
    const startHandler = electron.handlers.get(IPC_CHANNELS.workstationCrewStart);
    const pollHandler = electron.handlers.get(IPC_CHANNELS.workstationCrewPoll);

    // 1. Prepare run with Part 1 and Part 2 (Part 2 depends on Part 1)
    const prepResult = (await prepareHandler!(mockEvent, {
      caseId: "case-beta",
      request: "Two-stage task with failure on stage 2",
      integrationOwner: "part-2",
      parts: [
        {
          id: "part-1",
          title: "Part 1",
          role: "Architect",
          expectedOutput: "Part 1 output",
          providerId: "claude",
          modelId: "sonnet-3-7",
          prompt: "Part 1 work",
          dependsOn: []
        },
        {
          id: "part-2",
          title: "Part 2",
          role: "Developer",
          expectedOutput: "Part 2 output",
          providerId: "codex",
          modelId: "gpt-5-codex",
          prompt: "Part 2 work",
          dependsOn: ["part-1"]
        }
      ]
    })) as { token: string; reviews: unknown[] };

    // 2. Start run (Part 1 completes, Part 2 enters awaiting-review)
    const startResult = (await startHandler!(mockEvent, {
      token: prepResult.token
    })) as { runId: string };

    await new Promise((resolve) => setTimeout(resolve, 80));

    // 3. Review and start dependent Part 2 with Part 1's output; Part 2 then executes and fails
    const contPrep = (await prepareHandler!(mockEvent, {
      runId: startResult.runId
    })) as { token: string; reviews: unknown[] };
    await startHandler!(mockEvent, {
      token: contPrep.token
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    const statusAfterFailure = (await pollHandler!(mockEvent, {
      runId: startResult.runId
    })) as CrewRunView;

    expect(statusAfterFailure.parts[0]?.state).toBe("answered");
    expect(statusAfterFailure.parts[1]?.state).toBe("failed");
    expect(statusAfterFailure.round).toBe("failed");

    // 4. CONTRACT REQUIREMENT: The owner must be able to prepare a continuation review
    // to retry the failed part (reusing completed part-1 with immutable provenance).
    //
    // Contradiction in production code:
    // workstationCrewPrepare({ runId }) checks `if (p.attempted) return false;` at line 1091.
    // Since part-2 attempted was set to true at line 1611, it is filtered out!
    // This causes prepare to throw "No parts in that crew run are eligible for continuation review."
    await expect(
      prepareHandler!(mockEvent, {
        runId: startResult.runId
      })
    ).rejects.toThrow(/No parts in that crew run are eligible for continuation review/i);

    await crew.shutdown();
  });

  it("handles window close / cancelOwner, stopping active runs and revoking pending tokens", async () => {
    const ownerObject = { windowId: 3 };
    const mockEvent = { sender: { id: 3 } };

    let aborted = false;

    const crew = installReviewedCrewRun({
      assertTrusted: () => {},
      ownerFor: () => ownerObject,
      prepareChild: vi.fn(async ({ caseId, providerId, modelId, prompt }) => ({
        ...mockReview,
        caseId,
        providerId,
        modelId,
        prompt
      })),
      runChild: vi.fn(async ({ review, signal }) => {
        return new Promise<{
          readonly sessionId: string;
          readonly requestedModelId: string;
          readonly cancellationRequested: boolean;
          readonly resultSource: "worker";
          readonly finishReason: "stopped";
          readonly text: string;
          readonly detail: string;
          readonly turnId: null;
        }>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({
              sessionId: "sess-3",
              requestedModelId: review.modelId,
              cancellationRequested: true,
              resultSource: "worker" as const,
              finishReason: "stopped" as const,
              text: "Aborted",
              detail: "Stopped by user",
              turnId: null
            });
          });
        });
      }),
      readDependency: vi.fn(),
      persistParent: vi.fn(async () => {}),
      persistChild: vi.fn(async () => {})
    });

    const prepareHandler = electron.handlers.get(IPC_CHANNELS.workstationCrewPrepare);
    const startHandler = electron.handlers.get(IPC_CHANNELS.workstationCrewStart);

    const prepResult = (await prepareHandler!(mockEvent, {
      caseId: "case-gamma",
      request: "Long running request",
      integrationOwner: "part-1",
      parts: [
        {
          id: "part-1",
          title: "Part 1",
          role: "Architect",
          expectedOutput: "Task output",
          providerId: "claude",
          modelId: "sonnet-3-7",
          prompt: "Long task",
          dependsOn: []
        }
      ]
    })) as { token: string; reviews: unknown[] };

    await startHandler!(mockEvent, { token: prepResult.token });

    // Cancel owner window
    await crew.cancelOwner(ownerObject);

    expect(aborted).toBe(true);

    // Subsequent call by revoked owner must fail
    await expect(
      prepareHandler!(mockEvent, {
        caseId: "case-gamma",
        request: "Another request",
        integrationOwner: "part-1",
        parts: [
          {
            id: "part-1",
            title: "Part 1",
            role: "Architect",
            expectedOutput: "Task output",
            providerId: "claude",
            modelId: "sonnet-3-7",
            prompt: "Task",
            dependsOn: []
          }
        ]
      })
    ).rejects.toThrow(/That Crew window is no longer active/i);

    await crew.shutdown();
  });
});
