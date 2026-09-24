import { describe, expect, it } from "vitest";
import { agentCards } from "../../main/agents/cards.js";
import { allAgents, rehydrate } from "../../main/agents/roster.js";
import { BLANK, draftFromCard, newBriefId, renameDraft } from "./BriefEditor";

const saved = {
  id: "synthetic-reader", name: "Synthetic reader", purpose: "Read a specific job",
  instructions: "Keep every quantity alternative. Never claim artwork is approved.",
  folders: ["/synthetic/available", "/synthetic/paused"],
  capabilities: ["read_text", "unavailable_tool"],
  tier: "frontier", maxSteps: 7, maxMinutes: 11, outbound: "never"
};
const card = () => agentCards({ grantedFolders: ["/synthetic/available"],
  availableCapabilities: ["read_text"], storedAgents: [saved] }).find(value => value.id === saved.id)!;

describe("editing the actual saved agent brief", () => {
  it("retains instructions, requested tier, limits and withheld requests through an edit and save", () => {
    const resolved = card();
    expect(resolved.folders).toEqual(["/synthetic/available"]);
    expect(resolved.capabilities).toEqual(["read_text"]);
    const draft = draftFromCard(resolved);
    const renamed = renameDraft(draft, "Renamed reader");
    expect(renamed.id).toBe(saved.id);
    const reopened = rehydrate(renamed);
    expect(reopened).toMatchObject({
      name: "Renamed reader", instructions: saved.instructions,
      workspace: { folders: saved.folders }, capabilities: saved.capabilities,
      engine: { tier: "frontier" }, limits: { maxSteps: 7, maxMinutes: 11 }, outbound: "never"
    });
    // Keeping a requested folder is not granting it when the brief is resolved again.
    const after = agentCards({ grantedFolders: ["/synthetic/available"],
      availableCapabilities: ["read_text"], storedAgents: [renamed] }).find(value => value.id === saved.id)!;
    expect(after.folders).toEqual(["/synthetic/available"]);
    expect(after.withheld.map(value => value.what)).toEqual(["paused", "unavailable_tool"]);
  });
  it("duplicates the instructions and limits while making a separate identity", () => {
    const original = card();
    const duplicate = draftFromCard({ ...original, id: "", name: "Synthetic reader copy" });
    expect(duplicate.id).toMatch(/^agent-[a-f0-9-]{36}$/);
    expect(duplicate.id).not.toBe(original.id);
    expect(duplicate.instructions).toBe(saved.instructions);
    expect(duplicate.maxSteps).toBe(7);
    expect(duplicate.maxMinutes).toBe(11);
    expect(duplicate.folders).toEqual(saved.folders);
    expect(original.id).toBe(saved.id);
  });
  it("keeps repeated copies and same-name imports separate while renames retain their identity", () => {
    const original = card();
    const first = draftFromCard({ ...original, id: "", name: "Synthetic reader copy" });
    const second = draftFromCard({ ...original, id: "", name: "Synthetic reader copy" });
    const imported = { ...first, id: newBriefId() };
    expect(new Set([saved.id, first.id, second.id, imported.id]).size).toBe(4);
    const renamed = renameDraft(first, saved.name);
    const roster = allAgents([], [saved, renamed, second, imported]);
    for (const entry of [saved, renamed, second, imported])
      expect(roster.find(value => value.id === entry.id)?.instructions).toBe(saved.instructions);
    expect(renamed.id).toBe(first.id);
    const hindi = renameDraft(BLANK, "मेरी मदद");
    expect(hindi.id).toMatch(/^agent-[a-f0-9-]{36}$/);
    expect(renameDraft(hindi, "").id).toBe(hindi.id);
    expect(renameDraft(hindi, "मेरी नई मदद").id).toBe(hindi.id);
  });
});
