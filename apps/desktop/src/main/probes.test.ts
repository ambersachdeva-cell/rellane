import { describe, expect, it } from "vitest";
import { countWord, probeSentence, runProbe, runProbes, type Probe } from "./probes.js";

const clock = (start = 1_000) => {
  let at = start;
  return { now: () => (at += 100), set: (v: number) => { at = v; } };
};

const passing: Probe = {
  id: "tests",
  claim: "Every test passes",
  run: async () => ({ ok: true, said: "1,988 tests, all passing", detail: "…output…" })
};
const failing: Probe = {
  id: "ledger",
  claim: "The record is unbroken",
  run: async () => ({ ok: false, said: "the record was changed at entry 7" })
};
const broken: Probe = {
  id: "engine",
  claim: "The engine answers",
  run: async () => { throw new Error("no such binary"); }
};

describe("running a probe", () => {
  it("reports what it measured rather than that it succeeded", () => {
    return runProbe(passing, clock().now).then((result) => {
      expect(result.outcome).toBe("passed");
      // "Success!" says nothing. A measurement says what it looked at.
      expect(result.said).toContain("1,988 tests");
    });
  });

  it("treats a failing check as a result, not an error", async () => {
    const result = await runProbe(failing, clock().now);
    expect(result.outcome).toBe("failed");
    expect(result.said).toContain("entry 7");
  });

  it("never throws, because the screen it feeds is the one that says what is true", async () => {
    const result = await runProbe(broken, clock().now);
    expect(result.outcome).toBe("unavailable");
    expect(result.detail).toContain("no such binary");
  });

  it("does not let an unavailable probe leave a green light standing", async () => {
    const result = await runProbe(broken, clock().now);
    // Never report a readiness that was not observed — which cuts both ways.
    expect(result.outcome).not.toBe("passed");
    expect(result.said).toMatch(/could not run|nothing here has been re-verified/iu);
  });

  it("records how long it took, so a slow check is visibly slow", async () => {
    const result = await runProbe(passing, clock().now);
    expect(result.tookMs).toBeGreaterThan(0);
  });

  it("trims a probe that returns far too much to read", async () => {
    const noisy: Probe = {
      id: "noisy", claim: "c",
      run: async () => ({ ok: true, said: "fine", detail: "x".repeat(50_000) })
    };
    expect((await runProbe(noisy, clock().now)).detail.length).toBeLessThanOrEqual(8_000);
  });
});

describe("running several", () => {
  it("lets one failure not hide the others", async () => {
    const results = await runProbes([passing, broken, failing], clock().now);
    expect(results.map((r) => r.outcome)).toEqual(["passed", "unavailable", "failed"]);
  });
});

describe("what a person reads", () => {
  it("matches the tense of the button that ran it", async () => {
    const result = await runProbe(passing, clock().now);
    // "Prove it" then "Checked just now" — not "Verify" then "Success!".
    expect(probeSentence(result)).toMatch(/^Checked just now — /u);
    expect(probeSentence(result)).not.toMatch(/success|✓|!/iu);
  });

  it("says how long it took once it is long enough to notice", async () => {
    const slow: Probe = { id: "s", claim: "c", run: async () => ({ ok: true, said: "done" }) };
    const time = clock(0);
    // Two ticks of 100ms would be too quick; push the clock instead.
    const result = await runProbe({ ...slow, run: async () => { time.set(41_000); return { ok: true, said: "done" }; } }, time.now);
    expect(probeSentence(result)).toMatch(/in \d+ seconds/u);
  });

  it("says the refusal itself when a check could not run", async () => {
    const result = await runProbe(broken, clock().now);
    expect(probeSentence(result)).toBe(result.said);
    expect(probeSentence(result)).not.toContain("Checked");
  });
});

describe("counting for a reader", () => {
  it("groups a big number and is singular-aware", () => {
    expect(countWord(1988, "test")).toBe("1,988 tests");
    expect(countWord(1, "test")).toBe("1 test");
    expect(countWord(2, "entry", "entries")).toBe("2 entries");
    expect(countWord(1, "entry", "entries")).toBe("1 entry");
  });
});
