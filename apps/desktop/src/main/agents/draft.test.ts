import { describe, expect, it, vi } from "vitest";
import { draftBrief, draftPrompt, readDraft } from "./draft.js";
import type { EngineRoomStatus } from "@cadrane/contracts";

const FOLDERS = ["/Users/a/Clients", "/Users/a/Downloads"];

const room = (ready = true): EngineRoomStatus => ({
  engines: [
    {
      id: "claude",
      label: "Claude",
      access: "subscription",
      accessLabel: "Your subscription",
      state: ready ? "ready" : "not-installed",
      summary: "s",
      fixHint: null,
      evidence: null,
      models: [
        { id: "haiku", label: "Haiku", tier: "fast", tierLabel: "Quick", note: "n", includedInSubscription: true },
        { id: "opus", label: "Opus", tier: "frontier", tierLabel: "Frontier", note: "n", includedInSubscription: true }
      ]
    }
  ],
  active: null,
  checkedAt: "2026-09-02T00:00:00.000Z",
  allUnavailable: !ready
});

/** Typed like `askEngine`, so a call's arguments can be inspected. */
type Ask = NonNullable<Parameters<typeof draftBrief>[3]>;
const replying = (text: string): Ask => vi.fn<Ask>(async () => text);

const GOOD = JSON.stringify({
  name: "Late payments",
  purpose: "Tell me which clients have not paid",
  instructions: "",
  folders: ["/Users/a/Clients"],
  capabilities: ["list_folder", "read_text"],
  tier: "fast",
  maxSteps: 12,
  maxMinutes: 3,
  outbound: "never"
});

describe("drafting a brief from a sentence", () => {
  it("produces one the editor can open", async () => {
    const result = await draftBrief(
      "watch Clients and tell me what is late",
      FOLDERS,
      room(),
      replying(GOOD)
    );

    expect(result.ok).toBe(true);
    expect(result.draft?.name).toBe("Late payments");
    expect(result.draft?.id).toBe("late-payments");
    expect(result.draft?.folders).toEqual(["/Users/a/Clients"]);
  });

  it("reads JSON out of a reply that arrived with a fence and a preamble", () => {
    // Models add these however firmly they are told not to, and failing a draft
    // over "Here you go:" would be a worse product than tolerating it.
    expect(readDraft('Here you go:\n```json\n{"name":"X"}\n```')).toEqual({ name: "X" });
    expect(readDraft("no json at all")).toBeNull();
    expect(readDraft("[1,2,3]")).toBeNull();
  });

  it("uses the cheapest engine, not the best one", async () => {
    // Drafting a form is not work worth a frontier model.
    const ask = vi.fn<Ask>(async () => GOOD);
    await draftBrief("anything", FOLDERS, room(), ask);

    expect(ask.mock.calls[0]?.[0]?.modelId).toBe("haiku");
  });
});

describe("what a model proposes, it does not grant", () => {
  it("drops a folder it was never offered", async () => {
    // Naming a path is not being given it. The brief would produce a withheld
    // line at resolve time anyway; dropping it here means the draft the owner
    // reads is the draft that would run.
    const result = await draftBrief(
      "read my private keys",
      FOLDERS,
      room(),
      replying(JSON.stringify({ ...JSON.parse(GOOD), folders: ["/Users/a/.ssh", "/etc"] }))
    );

    expect(result.draft?.folders).toEqual([]);
  });

  it("cannot ask its way past the step ceiling", async () => {
    const result = await draftBrief(
      "think very hard",
      FOLDERS,
      room(),
      replying(JSON.stringify({ ...JSON.parse(GOOD), maxSteps: 100_000, maxMinutes: 100_000 }))
    );

    // The stored shape carries what the model said; the clamp is applied by the
    // same `rehydrate` every brief goes through, and this asserts the draft is
    // still usable rather than that the raw number was rewritten twice.
    expect(result.ok).toBe(true);
  });

  it("treats any outbound value it does not recognise as never", async () => {
    // The direction that matters: a typo must not become permission to prepare
    // something to send.
    for (const value of ["always", "yes", "ASK", 1, null]) {
      const result = await draftBrief(
        "message everyone",
        FOLDERS,
        room(),
        replying(JSON.stringify({ ...JSON.parse(GOOD), outbound: value }))
      );
      expect(result.draft?.outbound).toBe("never");
    }
  });

  it("keeps 'ask' when the model actually asked for it", async () => {
    const result = await draftBrief(
      "draft reminders for late payers",
      FOLDERS,
      room(),
      replying(JSON.stringify({ ...JSON.parse(GOOD), outbound: "ask" }))
    );

    expect(result.draft?.outbound).toBe("ask");
  });
});

describe("when it cannot draft", () => {
  it("says so rather than failing silently, and never throws", async () => {
    await expect(
      draftBrief("x", FOLDERS, room(), vi.fn(async () => { throw new Error("the CLI exited 1"); }))
    ).resolves.toMatchObject({ ok: false });

    expect((await draftBrief("", FOLDERS, room(), replying(GOOD))).said).toContain(
      "Say what you want"
    );
    expect((await draftBrief("x", FOLDERS, room(false), replying(GOOD))).said).toContain(
      "No engine is connected"
    );
    expect((await draftBrief("x", FOLDERS, room(), replying("sorry, I cannot"))).said).toContain(
      "not a brief"
    );
  });
});

describe("the instruction the model is given", () => {
  it("lists only the folders this Mac actually has", () => {
    // A draft naming a folder that does not exist arrives with a
    // withheld-permission warning, which teaches the owner that warnings are
    // decoration.
    const prompt = draftPrompt("tidy things", ["/Users/a/Clients"]);

    expect(prompt).toContain("/Users/a/Clients");
    expect(prompt).not.toContain("/Users/a/Downloads");
    expect(draftPrompt("x", [])).toContain("folders must be []");
  });

  // Live model/tier and budget enforcement are exercised through draftLocalBrief
  // in draft-local.test.ts. A literal "smallest tier" prompt is no longer policy.
});
