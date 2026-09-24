import { describe, expect, it } from "vitest";
import type { CaseTurnView, WorkstationSnapshot } from "@cadrane/contracts";
import { conversationTurns, previousWorkModel } from "./conversation.js";
function turn(seq: number, seat: string, body: string, kind: CaseTurnView["kind"] = "verbatim"): CaseTurnView {
  return {id: `turn-${seq}`, seq, seat, body, kind, at: seq, compactedFrom: null};
}
describe("workstation conversation", () => {
  it("shows a newly sent opening question once without changing the evidence", () => {
    const evidence = [turn(1,"owner","Make a checklist"),turn(2,"Source · Brief","Facts"),turn(3,"owner","Make a checklist"),turn(4,"workstation","Started","receipt"),turn(5,"Workstation · Codex","A checklist")];
    expect(conversationTurns(evidence,"Make a checklist").map(value=>value.id)).toEqual(["turn-3","turn-5"]);
    expect(evidence.map(value=>value.id)).toEqual(["turn-1","turn-2","turn-3","turn-4","turn-5"]);
  });
  it("keeps an unsent opening question, distinct first request and genuine later repetitions", () => {
    const opening = turn(1,"owner","Make a checklist");
    expect(conversationTurns([opening],opening.body)).toEqual([opening]);
    const changed = turn(2,"owner","Make an outline");
    expect(conversationTurns([opening,changed],opening.body)).toEqual([opening,changed]);
    const sent = turn(2,"owner",opening.body), repeated = turn(4,"owner",opening.body);
    expect(conversationTurns([opening,sent,turn(3,"Workstation · Codex","Try again"),repeated],opening.body).map(value=>value.id)).toEqual(["turn-2","turn-3","turn-4"]);
  });
});

describe("the previous AI choice", () => {
  const native: WorkstationSnapshot = { operationId: "op", caseId: "case", providerId: "claude", modelId: "opus", reportedModelId: "claude-opus-5", sessionId: "session", status: "completed", startedAt: 1, updatedAt: 10, text: "Answer", activity: [], permission: null, detail: "Done" };
  it("restores the selected alias rather than substituting the reported model id", () => {
    expect(previousWorkModel([], native)).toEqual({ providerId: "claude", modelId: "opus" });
    expect(previousWorkModel([], { ...native, modelId: null })).toEqual({ providerId: "claude", modelId: "" });
    expect(previousWorkModel([], null)).toBeNull();
  });
  it("prefers a more recent local answer and never accepts an injected model value", () => {
    const local = turn(11, "Local · qwen3-4b-q4-k-m", "Local answer");
    expect(previousWorkModel([local], native)).toEqual({ providerId: "local", modelId: "qwen3-4b-q4-k-m" });
    expect(previousWorkModel([turn(9,local.seat,"Older answer")], native)?.providerId).toBe("claude");
    expect(previousWorkModel([turn(11,"Local · --tool-override","Bad metadata")], null)).toBeNull();
  });
});
