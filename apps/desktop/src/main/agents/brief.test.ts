import { describe, expect, it } from "vitest";
import {
  describeBrief,
  describeReads,
  MAX_MINUTES_CEILING,
  MAX_STEPS_CEILING,
  newBrief,
  resolveBrief,
  type Ceiling
} from "./brief.js";

const ceiling: Ceiling = {
  grantedFolders: ["/Users/a/Downloads", "/Users/a/Clients"],
  availableCapabilities: ["librarian", "paste-as"], storedAgents: []
};

const filing = () =>
  newBrief({
    id: "filing",
    name: "Filing clerk",
    purpose: "Keep Downloads tidy",
    folders: ["/Users/a/Downloads"],
    capabilities: ["librarian"],
    maxSteps: 40
  });

describe("writing a brief", () => {
  it("gives an agent nothing until it is told otherwise", () => {
    // The safe default for a thing that touches files is nothing. An agent that
    // can read every folder you ever granted is one you cannot reason about.
    const bare = newBrief({ id: "a", name: "A", purpose: "p" });

    expect(bare.workspace.folders).toEqual([]);
    expect(bare.capabilities).toEqual([]);
  });

  it("defaults to asking before anything leaves the Mac", () => {
    expect(newBrief({ id: "a", name: "A", purpose: "p" }).outbound).toBe("ask");
  });

  it("cannot express an agent that sends without asking", () => {
    // Enforced by the type system: OutboundPolicy has two members and "auto" is
    // not one of them. This test exists so that a future widening of that union
    // fails here rather than shipping.
    const brief = newBrief({ id: "a", name: "A", purpose: "p" });
    const allowed: readonly string[] = ["never", "ask"];

    expect(allowed).toContain(brief.outbound);
  });

  it("clamps limits to the platform ceiling", () => {
    // An agent that can take 500 steps can spend an afternoon and a
    // subscription before anybody notices, and whoever wrote "be thorough" did
    // not agree to that.
    const greedy = newBrief({
      id: "a",
      name: "A",
      purpose: "p",
      maxSteps: 5_000,
      maxMinutes: 5_000
    });

    expect(greedy.limits.maxSteps).toBe(MAX_STEPS_CEILING);
    expect(greedy.limits.maxMinutes).toBe(MAX_MINUTES_CEILING);
  });

  it("refuses a nonsensical limit rather than storing NaN", () => {
    const broken = newBrief({
      id: "a",
      name: "A",
      purpose: "p",
      maxSteps: Number.NaN
    });

    expect(broken.limits.maxSteps).toBe(1);
  });
});

describe("resolving against what this Mac will actually allow", () => {
  it("passes through what is granted", () => {
    const resolved = resolveBrief(filing(), ceiling);

    expect(resolved.folders).toEqual(["/Users/a/Downloads"]);
    expect(resolved.capabilities).toEqual(["librarian"]);
    expect(resolved.withheld).toEqual([]);
    expect(resolved.inert).toBe(false);
  });

  it("names a folder it cannot have, rather than dropping it", () => {
    // A brief that silently loses a folder is how somebody comes to believe an
    // agent is watching something it has not looked at in a month.
    const brief = newBrief({
      id: "a",
      name: "A",
      purpose: "p",
      folders: ["/Users/a/Downloads", "/Users/a/Secrets"],
      capabilities: ["librarian"]
    });

    const resolved = resolveBrief(brief, ceiling);

    expect(resolved.folders).toEqual(["/Users/a/Downloads"]);
    expect(resolved.withheld).toHaveLength(1);
    expect(resolved.withheld[0]?.what).toBe("Secrets");
  });

  it("blames the ordinary cause first when a grant is missing", () => {
    // On an ad-hoc-signed app a grant withdrawn by an update is the normal
    // case. Saying so before the reader panics is DESIGN.md §7.
    const brief = newBrief({
      id: "a",
      name: "A",
      purpose: "p",
      folders: ["/Users/a/Gone"],
      capabilities: ["librarian"]
    });

    expect(resolveBrief(brief, ceiling).withheld[0]?.why).toMatch(/usually means/u);
  });

  it("names a skill that is not installed", () => {
    const brief = newBrief({
      id: "a",
      name: "A",
      purpose: "p",
      folders: ["/Users/a/Downloads"],
      capabilities: ["librarian", "invented"]
    });

    const resolved = resolveBrief(brief, ceiling);

    expect(resolved.capabilities).toEqual(["librarian"]);
    expect(resolved.withheld[0]?.what).toBe("invented");
  });

  it("says plainly when an agent would do nothing", () => {
    // Well-formed and useless is a real state. Saying so beats letting somebody
    // arm it and wonder why nothing happens.
    const noFolder = newBrief({ id: "a", name: "A", purpose: "p", capabilities: ["librarian"] });
    const noSkill = newBrief({ id: "b", name: "B", purpose: "p", folders: ["/Users/a/Downloads"] });

    expect(resolveBrief(noFolder, ceiling).inert).toBe(true);
    expect(resolveBrief(noSkill, ceiling).inert).toBe(true);
  });
});

describe("the sentence the owner actually reads", () => {
  it("says what it is, where, what it may do, and when it stops", () => {
    // A permission list is a thing people tick through. A sentence is a thing
    // they either recognise as what they wanted, or do not.
    const sentence = resolveBrief(filing(), ceiling).sentence;

    expect(sentence).toBe(
      "Filing clerk works in Downloads, may use librarian, asks before anything leaves this Mac, thinks with the everyday model, and stops after 40 steps or 10 minutes."
    );
  });

  it("names folders rather than paths", () => {
    const sentence = resolveBrief(filing(), ceiling).sentence;

    expect(sentence).toContain("Downloads");
    expect(sentence).not.toContain("/Users/a");
  });

  it("does not pretend an inert agent is capable", () => {
    const bare = newBrief({ id: "a", name: "Idle", purpose: "p" });

    const sentence = resolveBrief(bare, ceiling).sentence;

    expect(sentence).toContain("has no folder to work in");
    expect(sentence).toContain("has nothing it can do");
  });

  it("says when an agent never sends anything", () => {
    const sealed = newBrief({
      id: "a",
      name: "Reader",
      purpose: "p",
      folders: ["/Users/a/Downloads"],
      capabilities: ["librarian"],
      outbound: "never"
    });

    expect(resolveBrief(sealed, ceiling).sentence).toContain("never sends anything");
  });

  it("reads the tier as a phrase, not a product name", () => {
    const deep = newBrief({
      id: "a",
      name: "Thinker",
      purpose: "p",
      folders: ["/Users/a/Downloads"],
      capabilities: ["librarian"],
      tier: "frontier"
    });

    expect(resolveBrief(deep, ceiling).sentence).toContain("deepest model available");
  });

  it("counts one step as one", () => {
    const once = newBrief({
      id: "a",
      name: "A",
      purpose: "p",
      folders: ["/Users/a/Downloads"],
      capabilities: ["librarian"],
      maxSteps: 1,
      maxMinutes: 1
    });

    expect(resolveBrief(once, ceiling).sentence).toContain("1 step or 1 minute");
  });
});

describe("what it may read", () => {
  it("names sources in the owner's nouns, not the code's", () => {
    // Somebody reading this is deciding whether to trust the thing. "book"
    // means nothing to them.
    expect(describeReads(["book", "vault"])).toBe("your records and your notes");
  });

  it("says so when it reads nothing", () => {
    expect(describeReads([])).toBe("nothing but what you give it directly");
  });

  it("speaks to the agent differently from how it speaks about it", () => {
    // Same list, two readers. The owner reads about the agent; the agent is
    // addressed directly. One set of labels for both is how "You may draw on
    // the files in its folders" shipped.
    expect(describeReads(["folders"], "owner")).toBe("the files in its folders");
    expect(describeReads(["folders"], "agent")).toBe("the files in those folders");
    expect(describeReads(["book"], "owner")).toBe("your records");
    expect(describeReads(["book"], "agent")).toBe("the owner's records");
  });
});

describe("the sentence never shows the owner a hole", () => {
  it("does not render an undefined engine", () => {
    // `newBrief` normalises `pinnedEngineId` to null, so this is unreachable
    // through it — but a brief arriving from JSON without the key would have
    // rendered "thinks with the everyday model on undefined".
    const resolved = resolveBrief(
      newBrief({ id: "a", name: "A", purpose: "p", folders: ["/Users/a/Downloads"] }),
      ceiling
    );
    const loose = {
      ...resolved,
      brief: {
        ...resolved.brief,
        engine: { ...resolved.brief.engine, pinnedEngineId: undefined }
      }
    };

    expect(describeBrief(loose as unknown as typeof resolved)).not.toContain("undefined");
  });
});
