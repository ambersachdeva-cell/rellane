/** A failed receipt must not become a false claim about what happened to files. */
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../security/ledger.js";
import { SecretStore } from "../security/secrets.js";
import { SkillHost } from "./host.js";

let directory: string;
let folder: string;
let state: string;
let secrets: SecretStore;
let ledger: Ledger;
let host: SkillHost;
const original = "FICTIONAL FILE FOR ACTION/HISTORY CHECKS ONLY\n";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cadrane-skill-history-"));
  folder = join(directory, "fixtures");
  state = join(directory, "state");
  await mkdir(folder);
  const file = join(folder, "invoice.pdf");
  await writeFile(file, original);
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  await utimes(file, old, old);
  secrets = new SecretStore({ directory: state, crypto: {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(`fixture:${text}`),
    decryptString: bytes => bytes.toString().slice(8)
  } });
  ledger = new Ledger(state, secrets);
  await ledger.append({ kind: "synthetic.baseline", detail: {} });
  host = new SkillHost();
  host.useLedger(ledger);
  await host.grant(folder);
});
afterEach(async () => { vi.restoreAllMocks(); await host.dispose(); await rm(directory, { recursive: true, force: true }); });

describe("action-history failures", () => {
  it("admits a preview once while its history check is still pending", async () => {
    const preview = await host.preview("librarian", folder);
    let entered!: () => void;
    let release!: () => void;
    const enteredCheck = new Promise<void>(resolve => { entered = resolve; });
    const finishCheck = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(ledger, "verify").mockImplementationOnce(async () => {
      entered(); await finishCheck;
      return { status: "intact", entries: 1 };
    });
    const first = host.run(preview.planId, async () => true);
    await enteredCheck;
    const approveAgain = vi.fn(async () => true);
    const second = await host.run(preview.planId, approveAgain).then(
      () => "ran twice", error => error instanceof Error ? error.message : "unknown error"
    );
    release();
    await first;
    expect(second).toContain("expired");
    expect(approveAgain).not.toHaveBeenCalled();
    expect(await readFile(join(folder, "Documents/invoice.pdf"), "utf8")).toBe(original);
  });

  it("refuses a new file action before approval or mutation when history is damaged", async () => {
    const preview = await host.preview("librarian", folder);
    expect(preview.steps.length).toBeGreaterThan(0);
    await writeFile(join(state, "ledger.jsonl"), "fictional damage\n");
    const before = await readFile(join(state, "secrets.bin"));
    const approve = vi.fn(async () => true);
    await expect(host.run(preview.planId, approve)).rejects.toThrow("No plan actions were run");
    expect(approve).not.toHaveBeenCalled();
    expect(await readdir(folder)).toEqual(["invoice.pdf"]);
    expect(await readFile(join(folder, "invoice.pdf"), "utf8")).toBe(original);
    expect(await readFile(join(state, "secrets.bin"))).toEqual(before);
  });

  it("keeps actual outcomes and undo after a later receipt failure without advancing damaged history", async () => {
    const preview = await host.preview("librarian", folder);
    const set = secrets.set.bind(secrets);
    vi.spyOn(secrets, "set").mockImplementation(async (key, value) => {
      if (key === "ledger.anchor.head") throw new Error("fictional checkpoint write failure");
      await set(key, value);
    });
    const result = await host.run(preview.planId, async () => true);
    expect(result.steps.some(step => step.outcome === "done")).toBe(true);
    expect(result.historyWarning).toContain("action finished");
    expect(result.canUndo).toBe(true);
    expect(await readFile(join(folder, "Documents/invoice.pdf"), "utf8")).toBe(original);
    expect((await ledger.verify()).status).toBe("ahead");
    const bytes = await readFile(join(state, "ledger.jsonl"));
    const restored = await host.undoRun(result.receiptId);
    expect(restored.undone).toBe(true);
    expect(restored.historyWarning).toContain("files were restored");
    expect(await readdir(folder)).toEqual(["invoice.pdf"]);
    expect(await readFile(join(folder, "invoice.pdf"), "utf8")).toBe(original);
    expect(await readFile(join(state, "ledger.jsonl"))).toEqual(bytes);
    expect(await host.undoRun(result.receiptId)).toEqual({ undone: false });
  });

  it("rechecks access if a grant changes during history preflight", async () => {
    const preview = await host.preview("librarian", folder);
    vi.spyOn(ledger, "verify").mockImplementationOnce(async () => {
      await host.revoke(folder);
      return { status: "intact", entries: 1 };
    });
    const approve = vi.fn(async () => true);
    await expect(host.run(preview.planId, approve)).rejects.toThrow("Folder access changed");
    expect(approve).not.toHaveBeenCalled();
    expect(await readFile(join(folder, "invoice.pdf"), "utf8")).toBe(original);
  });
});
