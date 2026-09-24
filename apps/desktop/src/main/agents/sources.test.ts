import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandbox, type Sandbox } from "../tools/sandbox.js";
import type { Ceiling } from "./brief.js";
import { consumeAgentSource, createAgentSourceState, discardAgentSource, previewAgentSource } from "./sources.js";

let base: string; let root: string; let other: string; let grant: Sandbox | null;
let ceiling: Ceiling;
const owner = {};
const state = createAgentSourceState();
const exact = "  FICTIONAL काम\nQuantity: 240. Artwork NOT approved.\n";
const host = { currentCeiling: async () => ceiling, currentGrant: () => grant };
const choose = () => previewAgentSource(state, owner, "reader", host, async () => join(root, "job.txt"));
const consume = (token: string, who = owner, id = "reader") => consumeAgentSource(state, who, id, token, ceiling, host);

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "cadrane-required-source-")));
  root = join(base, "granted"); other = join(base, "another-agent");
  await mkdir(root); await mkdir(other);
  await writeFile(join(root, "job.txt"), exact);
  await writeFile(join(other, "job.txt"), "FICTIONAL different scope");
  grant = await createSandbox([root, other]);
  ceiling = { grantedFolders: [root, other], availableCapabilities: ["read_text", "list_folder"],
    storedAgents: [{ id: "reader", name: "Reader", purpose: "Read a chosen source", folders: [root],
      capabilities: ["read_text"], tier: "on-device", outbound: "never" }] };
  state.previews.clear(); state.opening = null;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(base, { recursive: true, force: true }); });

describe.runIf(process.platform === "darwin")("agent source previews", () => {
  it("captures exact whitespace and Unicode once, not the file later at the same path", async () => {
    const preview = (await choose())!;
    expect(preview.text).toBe(exact);
    expect(preview.fileSha256).toBe(createHash("sha256").update(exact).digest("hex"));
    expect(preview.bytes).toBe(Buffer.byteLength(exact));
    expect(preview).not.toHaveProperty("path");
    await writeFile(join(root, "job.txt"), "Changed after preview");
    const selected = consume(preview.token);
    await selected.assertCurrent();
    expect(selected.snapshot.text).toBe(exact);
    expect(selected.snapshot).not.toHaveProperty("token");
    expect(selected.sandbox.roots).toEqual([root]);
    expect(() => consume(preview.token)).toThrow("no longer available");
  });

  it("refuses forged, foreign-window and different-agent tokens without consuming the legitimate preview", async () => {
    const preview = (await choose())!;
    expect(() => consume("forged")).toThrow("no longer available");
    expect(() => consume(preview.token, {})).toThrow("no longer available");
    expect(() => consume(preview.token, owner, "filing-clerk")).toThrow("no longer available");
    expect(consume(preview.token).snapshot.text).toBe(exact);
  });

  it("expires and explicitly discards previews, including an old selection when replacing it", async () => {
    const first = (await choose())!;
    const replacement = (await choose())!;
    expect(() => consume(first.token)).toThrow("no longer available");
    const now = vi.spyOn(Date, "now").mockReturnValue(replacement.expiresAt);
    expect(() => consume(replacement.token)).toThrow("no longer available");
    now.mockRestore();
    const last = (await choose())!;
    expect(discardAgentSource(state, {}, "reader", last.token)).toBe(false);
    expect(discardAgentSource(state, owner, "reader", last.token)).toBe(true);
    expect(() => consume(last.token)).toThrow("no longer available");
  });

  it.each(["brief", "paused", "tool", "grant"] as const)("invalidates after a %s change", async change => {
    const preview = (await choose())!;
    if (change === "brief") ceiling = { ...ceiling, storedAgents: [{ ...ceiling.storedAgents[0]!, name: "Changed reader" }] };
    if (change === "paused") ceiling = { ...ceiling, grantedFolders: [other] };
    if (change === "tool") ceiling = { ...ceiling, availableCapabilities: ["list_folder"] };
    if (change === "grant") grant = await createSandbox([root, other]);
    expect(() => consume(preview.token)).toThrow(/changed|read_text/u);
    expect(state.previews.size).toBe(0);
  });

  it("rechecks the brief after the picker and retires a canceled picker even if it returns a file", async () => {
    let returnPath!: (value: string) => void;
    let opened!: () => void; const opening = new Promise<void>(resolve => { opened = resolve; });
    const pending = previewAgentSource(state, owner, "reader", host, () => {
      opened(); return new Promise(resolve => { returnPath = resolve; });
    });
    await opening;
    expect(discardAgentSource(state, owner, "reader")).toBe(true);
    returnPath(join(root, "job.txt"));
    expect(await pending).toBeNull(); expect(state.previews.size).toBe(0);
    await expect(previewAgentSource(state, owner, "reader", host, async () => {
      ceiling = { ...ceiling, storedAgents: [] }; return join(root, "job.txt");
    })).rejects.toThrow("changed");
  });

  it("never adopts another agent's root or follows linked or hidden paths", async () => {
    await symlink(join(other, "job.txt"), join(root, "linked.txt"));
    await mkdir(join(root, "nested"));
    await symlink(other, join(root, "nested", "linked"));
    await writeFile(join(root, ".hidden.txt"), "FICTIONAL CONFIGURATION");
    for (const file of [join(other, "job.txt"), join(root, "linked.txt"),
      join(root, "nested", "linked", "job.txt"), join(root, ".hidden.txt")]) {
      await expect(previewAgentSource(state, owner, "reader", host, async () => file))
        .rejects.toThrow(/granted|link|Hidden/u);
      expect(state.previews.size).toBe(0);
    }
  });

  it("refuses invalid UTF-8, binary text, empty, excessive and unsupported sources without partial previews", async () => {
    const cases = [
      ["bad.txt", Buffer.from([0xc3, 0x28])], ["binary.md", Buffer.from("fictional\0data")],
      ["empty.txt", Buffer.from(" \n")], ["long.txt", Buffer.from("a".repeat(8_001))],
      ["huge.txt", Buffer.from("a".repeat(32_769))], ["source.csv", Buffer.from("a,b\n1,2")],
    ] as const;
    for (const [name, bytes] of cases) {
      await writeFile(join(root, name), bytes);
      await expect(previewAgentSource(state, owner, "reader", host, async () => join(root, name))).rejects.toThrow();
      expect(state.previews.size).toBe(0);
    }
  });

  it("keeps checking the consumed snapshot's scope while a run is active", async () => {
    const selected = consume((await choose())!.token);
    await selected.assertCurrent();
    grant = null;
    await expect(selected.assertCurrent()).rejects.toThrow("changed");
  });
});
