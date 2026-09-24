import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertNotSymlink,
  createSandbox,
  isInside,
  resolveInSandbox,
  SandboxError,
  type Sandbox
} from "./sandbox.js";
import {
  canUndo,
  newPlan,
  summarise,
  undoableUntil,
  UNDO_WINDOW_MS,
  type Receipt,
  type StepReceipt
} from "./receipt.js";
import { decide, HARD_CEILING, LOCKED_RISKS, type ToolDefinition } from "./types.js";
import { READ_TEXT } from "./registry.js";

let workspace: string;
let outside: string;
let sandbox: Sandbox;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "cadrane-sandbox-"));
  workspace = join(base, "granted");
  outside = join(base, "not-granted");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, "invoice.pdf"), "pdf");
  await writeFile(join(outside, "secrets.env"), "TOKEN=1");
  sandbox = await createSandbox([workspace]);
});

afterAll(async () => {
  await rm(resolve(workspace, ".."), { recursive: true, force: true });
});

describe("path containment", () => {
  it("allows a file inside a granted root", async () => {
    const target = join(workspace, "invoice.pdf");
    await expect(resolveInSandbox(sandbox, target, { mustExist: true })).resolves.toContain(
      "invoice.pdf"
    );
  });

  it("refuses a path outside every granted root", async () => {
    await expect(
      resolveInSandbox(sandbox, join(outside, "secrets.env"), { mustExist: true })
    ).rejects.toMatchObject({ denial: "outside-roots" });
  });

  it("refuses a traversal that climbs out", async () => {
    await expect(
      resolveInSandbox(sandbox, join(workspace, "..", "not-granted", "secrets.env"), {
        mustExist: true
      })
    ).rejects.toMatchObject({ denial: "outside-roots" });
  });

  it("refuses a relative path outright", async () => {
    await expect(
      resolveInSandbox(sandbox, "invoice.pdf", { mustExist: true })
    ).rejects.toMatchObject({ denial: "not-absolute" });
  });

  it("catches a symlink inside the workspace pointing out of it", async () => {
    // The realistic case: a model follows a link it found while listing a
    // folder. The lexical path looks fine; only realpath reveals the escape.
    const escape = join(workspace, "looks-innocent");
    await symlink(outside, escape);
    await expect(
      resolveInSandbox(sandbox, join(escape, "secrets.env"), { mustExist: true })
    ).rejects.toMatchObject({ denial: "symlink-escape" });
  });

  it("refuses credential stores even when they sit inside a granted root", async () => {
    await expect(createSandbox([join(homedir(), ".ssh")])).rejects.toMatchObject({
      denial: "sensitive-path"
    });
    await expect(
      resolveInSandbox(sandbox, join(homedir(), ".aws", "credentials"), { mustExist: false })
    ).rejects.toMatchObject({ denial: "sensitive-path" });
  });

  it("refuses everything when no root has been granted", async () => {
    const empty = await createSandbox([]);
    await expect(
      resolveInSandbox(empty, join(workspace, "invoice.pdf"), { mustExist: true })
    ).rejects.toMatchObject({ denial: "no-roots-granted" });
  });

  it("allows a new file whose parent is inside the workspace", async () => {
    await expect(
      resolveInSandbox(sandbox, join(workspace, "new-file.txt"), { mustExist: false })
    ).resolves.toContain("new-file.txt");
  });

  it("refuses a new file whose parent is outside", async () => {
    await expect(
      resolveInSandbox(sandbox, join(outside, "new-file.txt"), { mustExist: false })
    ).rejects.toBeInstanceOf(SandboxError);
  });

  it("will not write through a link", async () => {
    const link = join(workspace, "link-to-invoice");
    await symlink(join(workspace, "invoice.pdf"), link);
    await expect(assertNotSymlink(link)).rejects.toMatchObject({ denial: "symlink-escape" });
    await expect(assertNotSymlink(join(workspace, "invoice.pdf"))).resolves.toBeUndefined();
  });

  it("compares by path segment, not by prefix", () => {
    // /granted-evil must not count as inside /granted.
    expect(isInside("/a/granted", "/a/granted-evil")).toBe(false);
    expect(isInside("/a/granted", "/a/granted/x")).toBe(true);
    expect(isInside("/a/granted", "/a/granted")).toBe(true);
  });
});

function tool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "read_file",
    description: "Read a file",
    parameters: {},
    risk: "read",
    engine: "local",
    reversible: true,
    summarise: () => "Read a file",
    ...over
  };
}

describe("autonomy decisions", () => {
  it("refuses a risk class the skill was never granted", () => {
    expect(decide({ tool: tool({ risk: "write" }), policy: { byRisk: { read: "auto" } } }))
      .toMatchObject({ decision: "refuse" });
  });

  it("runs a reversible read on automatic", () => {
    expect(decide({ tool: tool(), policy: { byRisk: { read: "auto" } } })).toMatchObject({
      decision: "run"
    });
  });

  it("asks before anything outbound, even when the skill demands automatic", () => {
    const result = decide({
      tool: tool({ risk: "outbound", name: "send_message" }),
      policy: { byRisk: { outbound: "auto" } }
    });
    expect(result.decision).toBe("ask");
    expect(result.reason).toMatch(/leaves this machine/u);
  });

  it("asks before a shell command however it is configured", () => {
    expect(
      decide({ tool: tool({ risk: "shell" }), policy: { byRisk: { shell: "auto" } } }).decision
    ).toBe("ask");
  });

  it("asks before an irreversible action even on automatic", () => {
    const result = decide({
      tool: tool({ risk: "write", reversible: false, name: "delete_file" }),
      policy: { byRisk: { write: "auto" } }
    });
    expect(result.decision).toBe("ask");
    expect(result.reason).toMatch(/cannot be undone/u);
  });

  it("prepares rather than acts when set to draft", () => {
    expect(
      decide({ tool: tool({ risk: "write" }), policy: { byRisk: { write: "draft" } } }).decision
    ).toBe("draft");
  });

  it("locks exactly the risks that reach outside this machine", () => {
    expect([...LOCKED_RISKS].sort()).toEqual(["outbound", "shell"]);
    expect(HARD_CEILING.outbound).toBe("confirm");
    expect(HARD_CEILING.shell).toBe("confirm");
  });
});

describe("receipts and undo", () => {
  const NOW = Date.parse("2026-08-21T10:00:00.000Z");

  function step(over: Partial<StepReceipt> = {}): StepReceipt {
    return {
      stepId: "s1",
      tool: "move_file",
      summary: "Move invoice.pdf",
      startedAt: new Date(NOW).toISOString(),
      finishedAt: new Date(NOW + 12).toISOString(),
      durationMs: 12,
      outcome: "done",
      reversal: { kind: "restore-path", from: "/a/new", to: "/a/old" },
      ...over
    };
  }

  function receipt(steps: readonly StepReceipt[]): Receipt {
    return {
      id: "r1",
      planId: "p1",
      skill: "librarian",
      intent: "tidy downloads",
      steps,
      finishedAt: new Date(NOW).toISOString(),
      undoableUntil: undoableUntil(steps, NOW)
    };
  }

  it("offers undo only while something is reversible", () => {
    expect(canUndo(receipt([step()]), NOW + 1_000)).toBe(true);
    expect(canUndo(receipt([step({ reversal: { kind: "none" } })]), NOW)).toBe(false);
  });

  it("stops offering undo once the window closes", () => {
    expect(canUndo(receipt([step()]), NOW + UNDO_WINDOW_MS + 1)).toBe(false);
  });

  it("reports what happened rather than claiming success", () => {
    const mixed = receipt([
      step(),
      step({ stepId: "s2", outcome: "refused" }),
      step({ stepId: "s3", outcome: "failed" })
    ]);
    expect(summarise(mixed)).toBe("1 done · 1 not allowed · 1 failed");
  });

  it("says so plainly when there was nothing to do", () => {
    expect(summarise(receipt([]))).toBe("Nothing to do.");
  });

  it("gives every planned step its own id", () => {
    const plan = newPlan({
      skill: "librarian",
      intent: "tidy",
      now: NOW,
      steps: [
        { tool: "a", risk: "read", summary: "s", args: {}, decision: "run", reason: "r" },
        { tool: "b", risk: "read", summary: "s", args: {}, decision: "run", reason: "r" }
      ]
    });
    expect(new Set(plan.steps.map((s) => s.id)).size).toBe(2);
  });
});

describe("read_text refuses what is not a file", () => {
  it("will not open a named pipe", async () => {
    // A FIFO reports `size: 0`, so the size ceiling waved it through, and
    // `readFile` on a pipe with no writer blocks forever — an agent would sit
    // on it until its whole budget expired, having done nothing.
    const pipe = join(workspace, "hang.fifo");
    await new Promise<void>((done, fail) => {
      execFile("/usr/bin/mkfifo", [pipe], (error) => (error ? fail(error) : done()));
    });

    await expect(
      READ_TEXT.handler({ path: pipe }, { sandbox })
    ).rejects.toThrow(/not an ordinary file/u);
  });
});

describe("read_text refuses a hidden file", () => {
  it("will not open a dotfile inside a granted folder", async () => {
    // `list_folder` skips dotfiles as "where configuration and credentials
    // hide", and `read_text` did not — so the only protection on a `.env` in a
    // granted project folder was that the model could not see its name. The
    // sandbox does not cover it either: `NEVER` names credential stores under
    // the owner's home, not a dotfile in a folder the owner granted on purpose.
    const secret = join(workspace, ".env");
    await writeFile(secret, "STRIPE_KEY=sk_live_do_not_read_me");

    await expect(READ_TEXT.handler({ path: secret }, { sandbox })).rejects.toThrow(/hidden file/u);
  });

  it("says which file, so the refusal is legible", async () => {
    const secret = join(workspace, ".npmrc");
    await writeFile(secret, "//registry.npmjs.org/:_authToken=nope");

    await expect(READ_TEXT.handler({ path: secret }, { sandbox })).rejects.toThrow(/\.npmrc/u);
  });

  it("still reads an ordinary file in the same folder", async () => {
    // The guard must not become a reason the tool stops working: a bill sitting
    // beside a dotfile is the ordinary case.
    const bill = join(workspace, "invoice-4471.txt");
    await writeFile(bill, "Total 9,465. Paid 4,000. Balance 5,465.");

    const result = (await READ_TEXT.handler({ path: bill }, { sandbox })) as { text: string };

    expect(result.text).toContain("5,465");
  });
});
