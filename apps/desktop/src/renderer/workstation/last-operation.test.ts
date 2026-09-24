import { describe, expect, it } from "vitest";
import type { CaseTurnView } from "@cadrane/contracts";
import { lastOperationIn } from "./last-operation.js";

function turn(overrides: Partial<CaseTurnView>): CaseTurnView {
  return {
    id: "t1",
    seq: 1,
    seat: "owner",
    kind: "verbatim",
    body: "",
    at: 0,
    compactedFrom: null,
    ...overrides
  } as CaseTurnView;
}

function receipt(operationId: string, seq: number): CaseTurnView {
  return turn({
    id: `r${seq}`,
    seq,
    seat: "workstation-session",
    kind: "receipt",
    body: JSON.stringify({ version: 1, event: "finish", snapshot: { operationId, caseId: "c1" } })
  });
}

describe("lastOperationIn", () => {
  it("finds the most recent session, not the first", () => {
    const turns = [receipt("op-old", 1), turn({ seq: 2, body: "a question" }), receipt("op-new", 3)];
    expect(lastOperationIn(turns)).toBe("op-new");
  });

  it("answers null when this work has never run", () => {
    expect(lastOperationIn([turn({ body: "a question" })])).toBeNull();
    expect(lastOperationIn([])).toBeNull();
  });

  it("skips a receipt it cannot read rather than treating it as the answer", () => {
    const turns = [
      receipt("op-real", 1),
      turn({ seq: 2, seat: "workstation-session", kind: "receipt", body: "{not json" }),
      turn({ seq: 3, seat: "workstation-session", kind: "receipt", body: JSON.stringify({ version: 1 }) })
    ];
    expect(lastOperationIn(turns)).toBe("op-real");
  });

  it("ignores an ordinary turn that happens to contain a snapshot", () => {
    const turns = [
      turn({ seq: 1, body: JSON.stringify({ snapshot: { operationId: "op-not-a-receipt" } }) })
    ];
    expect(lastOperationIn(turns)).toBeNull();
  });
});
