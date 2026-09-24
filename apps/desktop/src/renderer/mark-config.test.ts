import { describe, expect, it } from "vitest";
import {
  autonomyRank,
  ceilingFor,
  DEFAULT_MARK,
  DEFAULT_POLICY,
  effectiveAutonomy,
  MARK_ABILITIES,
  resolveAbilities,
  type MarkConfig
} from "./mark-config";

describe("autonomy is ordered", () => {
  it("ranks off below draft below confirm below auto", () => {
    expect(autonomyRank("off")).toBeLessThan(autonomyRank("draft"));
    expect(autonomyRank("draft")).toBeLessThan(autonomyRank("confirm"));
    expect(autonomyRank("confirm")).toBeLessThan(autonomyRank("auto"));
  });
});

describe("the platform ceiling always wins", () => {
  it("caps a tenant that asks for more than policy allows", () => {
    expect(effectiveAutonomy("auto", "confirm")).toBe("confirm");
    expect(effectiveAutonomy("confirm", "draft")).toBe("draft");
    expect(effectiveAutonomy("auto", "off")).toBe("off");
  });

  it("leaves a request below the ceiling alone", () => {
    expect(effectiveAutonomy("draft", "auto")).toBe("draft");
    expect(effectiveAutonomy("off", "auto")).toBe("off");
  });

  it("caps outward abilities harder than inward ones by default", () => {
    const outward = MARK_ABILITIES.find((ability) => ability.outward);
    const inward = MARK_ABILITIES.find((ability) => !ability.outward);
    expect(ceilingFor(outward!, DEFAULT_POLICY)).toBe("confirm");
    expect(ceilingFor(inward!, DEFAULT_POLICY)).toBe("auto");
  });
});

describe("defaults are safe", () => {
  it("never lets Mark reply to a buyer out of the box", () => {
    expect(DEFAULT_MARK.abilities["buyer-reply"]).toBe("off");
  });

  it("only ever drafts a quotation out of the box", () => {
    expect(DEFAULT_MARK.abilities["draft-quote"]).toBe("draft");
  });

  it("keeps every outward ability below auto out of the box", () => {
    for (const ability of MARK_ABILITIES.filter((entry) => entry.outward)) {
      expect(autonomyRank(DEFAULT_MARK.abilities[ability.id] ?? "off")).toBeLessThan(
        autonomyRank("auto")
      );
    }
  });

  it("has the dead-man's switch on, because silence must not look like calm", () => {
    expect(DEFAULT_MARK.abilities["deadman"]).toBe("auto");
  });
});

describe("resolveAbilities", () => {
  it("clamps a tenant who turned everything up to maximum", () => {
    const greedy: MarkConfig = {
      ...DEFAULT_MARK,
      abilities: Object.fromEntries(MARK_ABILITIES.map((a) => [a.id, "auto" as const]))
    };
    const resolved = resolveAbilities(greedy, DEFAULT_POLICY);
    expect(resolved["buyer-reply"]).toBe("confirm");
    expect(resolved["draft-quote"]).toBe("confirm");
    expect(resolved["digest"]).toBe("auto");
  });

  it("can be shut down entirely from the platform side", () => {
    const resolved = resolveAbilities(DEFAULT_MARK, {
      outwardCeiling: "off",
      inwardCeiling: "off"
    });
    expect(Object.values(resolved).every((level) => level === "off")).toBe(true);
  });

  it("treats an unknown ability as off rather than guessing", () => {
    const sparse: MarkConfig = { ...DEFAULT_MARK, abilities: {} };
    const resolved = resolveAbilities(sparse, DEFAULT_POLICY);
    expect(Object.values(resolved).every((level) => level === "off")).toBe(true);
  });

  it("covers every declared ability", () => {
    const resolved = resolveAbilities(DEFAULT_MARK, DEFAULT_POLICY);
    expect(Object.keys(resolved).sort()).toEqual(MARK_ABILITIES.map((a) => a.id).sort());
  });
});
