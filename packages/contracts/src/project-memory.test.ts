import { describe, expect, it } from "vitest";
import {
  GovernedProjectMemoryCommandSchema,
  GovernedProjectMemoryConflictCommandSchema,
  ProjectMemoryRoleIdSchema,
  MAX_MEMORY_TEXT_LENGTH,
  MAX_REASON_LENGTH
} from "./project-memory.js";

describe("GovernedProjectMemoryCommandSchema", () => {
  it("uses one bounded canonical role ID for stored tags and Crew context", () => {
    expect(ProjectMemoryRoleIdSchema.parse("design-review")).toBe("design-review");
    for (const candidate of ["Lead Analyst", " design", "design_qa", "D", "a".repeat(65)])
      expect(ProjectMemoryRoleIdSchema.safeParse(candidate).success).toBe(false);
  });
  it("parses valid read command", () => {
    const parsed = GovernedProjectMemoryCommandSchema.safeParse({
      action: "read",
      projectId: "proj-alpha"
    });
    expect(parsed.success).toBe(true);
  });

  it("parses valid propose command with optional fields", () => {
    const parsed = GovernedProjectMemoryCommandSchema.safeParse({
      action: "propose",
      projectId: "proj-alpha",
      id: "entry-1",
      expectedRevision: 0,
      kind: "instruction",
      text: "Always require explicit user confirmation before writing changes.",
      sourceRefs: [
        {
          caseId: "case-1",
          turnId: "turn-1",
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }
      ]
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts bounded normalized finding roles only on findings", () => {
    const proposal = {
      action: "propose", projectId: "project-1", kind: "finding",
      text: "Source-backed design observation", roleTags: ["design", "reviewer"]
    };
    expect(GovernedProjectMemoryCommandSchema.safeParse(proposal).success).toBe(true);
    expect(GovernedProjectMemoryCommandSchema.safeParse({ ...proposal, roleTags: ["Lead Analyst"] }).success).toBe(false);
    expect(GovernedProjectMemoryCommandSchema.safeParse({ ...proposal, roleTags: ["design", "design"] }).success).toBe(false);
    expect(GovernedProjectMemoryCommandSchema.safeParse({ ...proposal, roleTags: Array.from({ length: 21 }, (_, i) => `role-${i}`) }).success).toBe(false);
    expect(GovernedProjectMemoryCommandSchema.safeParse({ ...proposal, kind: "instruction" }).success).toBe(false);
    expect(GovernedProjectMemoryCommandSchema.safeParse({
      action: "review", projectId: "project-1", id: "finding-1", expectedRevision: 1,
      decision: "approve", roleTags: ["design"]
    }).success).toBe(true);
    expect(GovernedProjectMemoryCommandSchema.safeParse({
      action: "review", projectId: "project-1", id: "finding-1", expectedRevision: 1,
      decision: "approve", roleTags: ["Lead Analyst"]
    }).success).toBe(false);
  });

  it("parses valid review and forget commands", () => {
    const reviewParsed = GovernedProjectMemoryCommandSchema.safeParse({
      action: "review",
      projectId: "proj-alpha",
      id: "entry-1",
      expectedRevision: 1,
      decision: "approve",
      reason: "Verified against policy"
    });
    expect(reviewParsed.success).toBe(true);

    const forgetParsed = GovernedProjectMemoryCommandSchema.safeParse({
      action: "forget",
      projectId: "proj-alpha",
      id: "entry-1",
      expectedRevision: 2,
      reason: "Superseded by new requirements"
    });
    expect(forgetParsed.success).toBe(true);
  });

  it("strictly rejects client actorId injection on all actions", () => {
    const proposeWithActor = GovernedProjectMemoryCommandSchema.safeParse({
      action: "propose",
      projectId: "proj-alpha",
      kind: "decision",
      text: "Use PostgreSQL",
      actorId: "injected-actor-id"
    });
    expect(proposeWithActor.success).toBe(false);

    const reviewWithActor = GovernedProjectMemoryCommandSchema.safeParse({
      action: "review",
      projectId: "proj-alpha",
      id: "entry-1",
      expectedRevision: 1,
      decision: "approve",
      actorId: "injected-actor-id"
    });
    expect(reviewWithActor.success).toBe(false);

    const readWithActor = GovernedProjectMemoryCommandSchema.safeParse({
      action: "read",
      projectId: "proj-alpha",
      actorId: "injected-actor-id"
    });
    expect(readWithActor.success).toBe(false);
  });

  it("strictly rejects client approver, epoch, or active revision injection", () => {
    const reviewWithApprover = GovernedProjectMemoryCommandSchema.safeParse({
      action: "review",
      projectId: "proj-alpha",
      id: "entry-1",
      expectedRevision: 1,
      decision: "approve",
      approverId: "root-user",
      approvedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(reviewWithApprover.success).toBe(false);

    const proposeWithEpoch = GovernedProjectMemoryCommandSchema.safeParse({
      action: "propose",
      projectId: "proj-alpha",
      kind: "finding",
      text: "Found edge case",
      epoch: 42,
      activeRevision: 1
    });
    expect(proposeWithEpoch.success).toBe(false);
  });

  it("enforces text boundaries and rejects empty or whitespace-only text", () => {
    const emptyText = GovernedProjectMemoryCommandSchema.safeParse({
      action: "propose",
      projectId: "proj-alpha",
      kind: "instruction",
      text: "   "
    });
    expect(emptyText.success).toBe(false);

    const oversizedText = GovernedProjectMemoryCommandSchema.safeParse({
      action: "propose",
      projectId: "proj-alpha",
      kind: "instruction",
      text: "a".repeat(MAX_MEMORY_TEXT_LENGTH + 1)
    });
    expect(oversizedText.success).toBe(false);

    const oversizedReason = GovernedProjectMemoryCommandSchema.safeParse({
      action: "review",
      projectId: "proj-alpha",
      id: "entry-1",
      expectedRevision: 1,
      decision: "reject",
      reason: "b".repeat(MAX_REASON_LENGTH + 1)
    });
    expect(oversizedReason.success).toBe(false);
  });

  it("validates source ref sha256 checksum format", () => {
    const badHash = GovernedProjectMemoryCommandSchema.safeParse({
      action: "propose",
      projectId: "proj-alpha",
      kind: "instruction",
      text: "Valid text",
      sourceRefs: [
        {
          caseId: "case-1",
          turnId: "turn-1",
          sha256: "not-a-valid-sha256"
        }
      ]
    });
    expect(badHash.success).toBe(false);
  });
});

describe("GovernedProjectMemoryConflictCommandSchema", () => {
  it("accepts exact owner pair commands and rejects renderer actor fields", () => {
    const command = {
      action: "declare", projectId: "project-1",
      firstMemoryId: "a", secondMemoryId: "b",
      expectedFirstActiveRevision: 2, expectedSecondActiveRevision: 3,
      expectedConflictRevision: 0, reason: "Contradictory owner directions"
    };
    expect(GovernedProjectMemoryConflictCommandSchema.safeParse(command).success).toBe(true);
    expect(GovernedProjectMemoryConflictCommandSchema.safeParse({
      ...command, actorId: "renderer"
    }).success).toBe(false);
    expect(GovernedProjectMemoryConflictCommandSchema.safeParse({
      ...command, reason: "x".repeat(MAX_REASON_LENGTH + 1)
    }).success).toBe(false);
    expect(GovernedProjectMemoryConflictCommandSchema.safeParse({
      action: "resolve", projectId: "project-1", conflictId: "conflict-1",
      expectedRevision: 1, expectedFirstActiveRevision: 2,
      expectedSecondActiveRevision: null,
      resolution: { kind: "winner", winnerId: "a", actorId: "renderer" },
      reason: "Keep A"
    }).success).toBe(false);
  });
});
