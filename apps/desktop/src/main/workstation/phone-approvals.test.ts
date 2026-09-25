import { describe, expect, it } from "vitest";
import {
  AnnouncedCalls,
  describeCall,
  readDecision,
  waitingCalls,
  type LiveRun
} from "./phone-approvals.js";

function run(overrides: Partial<LiveRun>): LiveRun {
  return {
    operationId: "op-1",
    status: "needs-approval",
    updatedAt: 1000,
    permission: { id: "p-1", title: "Write notes.md", detail: "In the project folder." },
    ...overrides
  };
}

describe("waitingCalls", () => {
  it("ignores a session that is running rather than asking", () => {
    expect(waitingCalls([run({ status: "running", permission: null })])).toHaveLength(0);
    expect(waitingCalls([run({ status: "running" })])).toHaveLength(0);
  });

  it("puts the oldest question first, so yes is never ambiguous", () => {
    const calls = waitingCalls([
      run({ operationId: "op-new", updatedAt: 5000, permission: { id: "p-new", title: "B", detail: "" } }),
      run({ operationId: "op-old", updatedAt: 1000, permission: { id: "p-old", title: "A", detail: "" } })
    ]);
    expect(calls.map((call) => call.permissionId)).toEqual(["p-old", "p-new"]);
  });
});

describe("describeCall", () => {
  it("uses the session's own words rather than a second description of them", () => {
    const [call] = waitingCalls([run({})]);
    const said = describeCall(call!);
    expect(said).toContain("Write notes.md");
    expect(said).toContain("In the project folder.");
    expect(said).toContain("Reply yes to allow it once");
  });

  it("does not print the detail twice when it repeats the title", () => {
    const [call] = waitingCalls([run({ permission: { id: "p", title: "Read brief.md", detail: "Read brief.md" } })]);
    const said = describeCall(call!);
    expect(said.split("Read brief.md")).toHaveLength(2);
  });
});

describe("readDecision", () => {
  it("reads a plain yes or no", () => {
    for (const yes of ["yes", "Yes", "y", "ok", "allow", "go ahead", "yep!", "/yes"]) {
      expect(readDecision(yes)).toBe("allow");
    }
    for (const no of ["no", "No.", "nope", "deny", "decline", "don't", "do not"]) {
      expect(readDecision(no)).toBe("deny");
    }
  });

  /**
   * The case this exists for: a message that starts with yes and then asks for
   * something else is a new request, not consent to the call he was shown.
   */
  it("refuses to read consent out of a message that carries a second request", () => {
    expect(readDecision("yes, and also rewrite the config")).toBeNull();
    expect(readDecision("no need, just tell me the answer")).toBeNull();
    expect(readDecision("yes please delete the old folder too")).toBeNull();
  });

  it("answers null for anything that is not a decision", () => {
    expect(readDecision("")).toBeNull();
    expect(readDecision("what is it asking for?")).toBeNull();
    expect(readDecision("status")).toBeNull();
  });
});

describe("AnnouncedCalls", () => {
  it("announces each question once", () => {
    const announced = new AnnouncedCalls();
    const calls = waitingCalls([run({})]);

    expect(announced.fresh(calls)).toHaveLength(1);
    announced.markDelivered(calls[0]!);
    expect(announced.fresh(calls)).toHaveLength(0);
    expect(announced.fresh(calls)).toHaveLength(0);
  });

  it("asks again when a permission id comes back after the first was settled", () => {
    const announced = new AnnouncedCalls();
    const first = waitingCalls([run({})]);
    expect(announced.fresh(first)).toHaveLength(1);
    announced.markDelivered(first[0]!);

    // Settled: nothing is waiting.
    announced.keepOnly([]);

    // The provider reuses the id for a second, different call.
    expect(announced.fresh(first)).toHaveLength(1);
  });

  it("keeps remembering a question that is still waiting", () => {
    const announced = new AnnouncedCalls();
    const calls = waitingCalls([run({})]);
    expect(announced.fresh(calls)).toHaveLength(1);
    announced.markDelivered(calls[0]!);
    announced.keepOnly(calls);
    expect(announced.fresh(calls)).toHaveLength(0);
  });

  it("retries failed delivery and reissues a challenge after expiry", () => {
    const announced = new AnnouncedCalls();
    const calls = waitingCalls([run({})]);
    expect(announced.fresh(calls)).toHaveLength(1);
    expect(announced.fresh(calls)).toHaveLength(1);
    announced.markDelivered(calls[0]!);
    expect(announced.fresh(calls)).toHaveLength(0);
    announced.forget(calls[0]!);
    expect(announced.fresh(calls)).toHaveLength(1);
  });
});
