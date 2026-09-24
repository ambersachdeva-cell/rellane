import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  describeAction,
  whyRefused,
  runAction,
  MAX_SHORTCUT_INPUT,
  type MacAction
} from "./mac-actions.js";

describe("describeAction", () => {
  it("names the target file and folder for reveal and marks it reversible", () => {
    const action: MacAction = {
      kind: "reveal",
      path: "/Users/owner/Projects/report.pdf"
    };
    const description = describeAction(action);
    expect(description.title).toContain("report.pdf");
    expect(description.detail).toContain("report.pdf");
    expect(description.detail).toContain("/Users/owner/Projects");
    expect(description.reversible).toBe(true);
  });

  it("names the target file and folder for open and marks it irreversible", () => {
    const action: MacAction = {
      kind: "open",
      path: "/Users/owner/Projects/data.csv"
    };
    const description = describeAction(action);
    expect(description.title).toContain("data.csv");
    expect(description.detail).toContain("data.csv");
    expect(description.detail).toContain("/Users/owner/Projects");
    expect(description.reversible).toBe(false);
  });

  it("names the target shortcut and marks it irreversible", () => {
    const action: MacAction = {
      kind: "shortcut",
      name: "Generate Monthly Invoice"
    };
    const description = describeAction(action);
    expect(description.title).toContain("Generate Monthly Invoice");
    expect(description.detail).toContain("Generate Monthly Invoice");
    expect(description.reversible).toBe(false);
  });
});

describe("whyRefused path gatekeeping", () => {
  it("refuses relative paths", () => {
    const action: MacAction = { kind: "reveal", path: "relative/path.txt" };
    expect(whyRefused(action, "/tmp")).toBe("The path must be an absolute path.");
  });

  it("refuses paths with null bytes", () => {
    const action: MacAction = { kind: "open", path: "/tmp/file\0evil.txt" };
    expect(whyRefused(action, "/tmp")).toBe("The path contains an invalid null character.");
  });

  it("refuses paths that do not exist", () => {
    const action: MacAction = { kind: "reveal", path: "/tmp/nonexistent-file-404.txt" };
    expect(whyRefused(action, "/tmp")).toContain("does not exist");
  });

  it("refuses path escape via .. outside the allowed boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-outside-"));
    try {
      const outsideFile = path.join(outside, "secret.txt");
      await fs.writeFile(outsideFile, "secret content");

      const escapePath = path.join(root, "..", path.basename(outside), "secret.txt");
      const refusal = whyRefused({ kind: "reveal", path: escapePath }, root);
      expect(refusal).not.toBeNull();
      expect(refusal).toContain(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses path escape via a symlink pointing outside the allowed boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-outside-"));
    try {
      const outsideFile = path.join(outside, "secret.txt");
      await fs.writeFile(outsideFile, "secret content");

      const symlinkPath = path.join(root, "symlink-outside");
      await fs.symlink(outsideFile, symlinkPath);

      const refusal = whyRefused({ kind: "open", path: symlinkPath }, root);
      expect(refusal).not.toBeNull();
      expect(refusal).toContain(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("allows valid files inside the allowed boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-root-"));
    try {
      const validFile = path.join(root, "valid.txt");
      await fs.writeFile(validFile, "safe content");

      expect(whyRefused({ kind: "reveal", path: validFile }, root)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("whyRefused shortcut gatekeeping", () => {
  it("refuses shortcut names with semicolons, quotes, slashes, or newlines", () => {
    expect(whyRefused({ kind: "shortcut", name: "Run; rm -rf" }, "/tmp")).toContain("metacharacters");
    expect(whyRefused({ kind: "shortcut", name: "Run 'Quick'" }, "/tmp")).toContain("quotes");
    expect(whyRefused({ kind: "shortcut", name: 'Run "Quick"' }, "/tmp")).toContain("quotes");
    expect(whyRefused({ kind: "shortcut", name: "Run/Shortcut" }, "/tmp")).toContain("slashes");
    expect(whyRefused({ kind: "shortcut", name: "Run\nShortcut" }, "/tmp")).toContain("newlines");
  });

  it("refuses shortcut input exceeding MAX_SHORTCUT_INPUT", () => {
    const oversize = "a".repeat(MAX_SHORTCUT_INPUT + 1);
    const refusal = whyRefused({ kind: "shortcut", name: "ValidShortcut", input: oversize }, "/tmp");
    expect(refusal).toContain("4,000");

    const exact = "a".repeat(MAX_SHORTCUT_INPUT);
    expect(whyRefused({ kind: "shortcut", name: "ValidShortcut", input: exact }, "/tmp")).toBeNull();
  });
});

describe("runAction child process bounding", () => {
  it("refuses immediately without spawning if validation fails", async () => {
    const outcome = await runAction({ kind: "reveal", path: "relative/path.txt" }, "/tmp");
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("expected a refusal");
    expect(outcome.reason).toBe("The path must be an absolute path.");
  });

  it("spawns with an argv array and shell disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-argv-"));
    try {
      const file = path.join(root, "doc.txt");
      await fs.writeFile(file, "content");

      const mockStdin = new PassThrough();
      const mockStdout = new PassThrough();
      const mockStderr = new PassThrough();

      const emitter = new EventEmitter();
      let capturedBinary = "";
      let capturedArgs: readonly string[] = [];
      let capturedShell: boolean | string | undefined = true;

      // `Object.assign(emitter, { on })` replaced the emitter's own `on`, so the
      // override called itself forever. Keep the real emitter separate from the
      // object handed to the module.
      const fakeChild = {
        stdin: mockStdin,
        stdout: mockStdout,
        stderr: mockStderr,
        kill: vi.fn(),
        once: (event: string, handler: (...args: unknown[]) => void) =>
          fakeChild.on(event, handler),
        removeListener: (event: string, handler: (...args: unknown[]) => void) => {
          emitter.removeListener(event, handler);
          return fakeChild;
        },
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          emitter.on(event, handler);
          if (event === "close") {
            setTimeout(() => {
              (handler as (code: number | null, signal: string | null) => void)(0, null);
            }, 5);
          }
          return fakeChild;
        })
      } as unknown as ChildProcess;

      const fakeSpawn = vi.fn((cmd: string, args: readonly string[], opts: { shell?: boolean }) => {
        capturedBinary = cmd;
        capturedArgs = args;
        capturedShell = opts.shell;
        return fakeChild;
      }) as unknown as typeof spawn;

      await runAction({ kind: "reveal", path: file }, root, { spawnFn: fakeSpawn });

      expect(capturedBinary).toBe("open");
      expect(capturedArgs).toEqual(["-R", file]);
      expect(capturedShell).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("enforces timeout by terminating the child with SIGTERM and SIGKILL", async () => {
    const signalsSent: string[] = [];
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockStderr = new PassThrough();

    let closeHandler: ((code: number | null, signal: string | null) => void) | null = null;

    const emitter = new EventEmitter();
    // Same fix as above: assigning `on` onto the emitter shadowed the emitter's
    // own `on`, so the override recursed into itself.
    const fakeChild = {
      stdin: mockStdin,
      stdout: mockStdout,
      stderr: mockStderr,
      once: (event: string, handler: (...args: unknown[]) => void) =>
        fakeChild.on(event, handler),
      removeListener: (event: string, handler: (...args: unknown[]) => void) => {
        emitter.removeListener(event, handler);
        return fakeChild;
      },
      kill: vi.fn((sig?: NodeJS.Signals | number) => {
        const signalName = typeof sig === "string" ? sig : "SIGTERM";
        signalsSent.push(signalName);
        if (signalName === "SIGKILL" && closeHandler !== null) {
          closeHandler(null, "SIGKILL");
        }
        return true;
      }),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "close") {
          closeHandler = handler as (code: number | null, signal: string | null) => void;
        }
        emitter.on(event, handler);
        return fakeChild;
      })
    } as unknown as ChildProcess;

    const fakeSpawn = vi.fn().mockReturnValue(fakeChild) as unknown as typeof spawn;

    const outcome = await runAction(
      { kind: "shortcut", name: "HangingShortcut" },
      "/tmp",
      { timeoutMs: 20, spawnFn: fakeSpawn }
    );

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("expected a refusal");
    expect(outcome.reason).toContain("ran out of time");
    expect(signalsSent).toContain("SIGTERM");
  });
});
