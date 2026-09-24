import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandbox, type Sandbox } from "../tools/sandbox.js";
import { SkillHost } from "../skills/host.js";
import { hashGrantedFile, snapshotGrantedFile } from "./hash-file.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let base: string;
let root: string;
let outside: string;
let grant: Sandbox | null;
const current = () => grant;
beforeEach(async () => {
  vi.mocked(fs.open).mockReset().mockImplementation(realFs.open);
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cadrane-hash-boundary-")));
  root = join(base, "granted"); outside = join(base, "outside");
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(join(root, "job.txt"), "original fictional job");
  await fs.writeFile(join(outside, "job.txt"), "outside fictional job");
  grant = await createSandbox([root]);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(base, { recursive: true, force: true }); });

describe.runIf(process.platform === "darwin")("checksums stay within the active grant", () => {
  it.each(["withdrawn", "changed"] as const)("releases no snapshot bytes when the source is %s during a read", async cause => {
    const originalOpen = realFs.open;
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode); const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof handle.read>) => {
        const result = await read(...args);
        if (cause === "withdrawn") grant = null;
        else await fs.appendFile(join(root, "job.txt"), " changed");
        return result;
      });
      return handle;
    });
    expect(await snapshotGrantedFile(root, "job.txt", current)).toMatchObject({
      digest: null, content: null, problem: expect.stringMatching(/changed/u)
    });
  });

  it("hashes the exact normal bytes and an empty file, and reports a missing file", async () => {
    const digest = createHash("sha256").update("original fictional job").digest("hex");
    expect(await hashGrantedFile(root, "job.txt", current)).toEqual({ path: "job.txt", digest, problem: null });
    await fs.writeFile(join(root, "empty"), "");
    expect((await hashGrantedFile(root, "empty", current)).digest).toBe(createHash("sha256").digest("hex"));
    expect(await hashGrantedFile(root, "missing", current)).toMatchObject({ digest: null, problem: "That file is not there any more." });
  });

  it("denies traversal, another granted root, leaf links and linked parents before opening data", async () => {
    grant = await createSandbox([root, outside]);
    await fs.symlink(join(outside, "job.txt"), join(root, "leaf"));
    await fs.symlink(outside, join(root, "parent"));
    await fs.symlink(join(root, "job.txt"), join(root, "internal-link"));
    const opened = vi.spyOn(fs, "open");
    for (const path of ["leaf", "parent/job.txt", "internal-link"])
      expect(await hashGrantedFile(root, path, current)).toMatchObject({ digest: null, problem: expect.stringMatching(/link/u) });
    await expect(hashGrantedFile(root, "../outside/job.txt", current)).rejects.toThrow("not a path inside");
    await expect(hashGrantedFile(root, join(outside, "job.txt"), current)).rejects.toThrow("not a path inside");
    expect(opened).not.toHaveBeenCalled();
  });

  it("keeps the original canonical grant when another folder is added, and revokes immediately", async () => {
    const alias = join(base, "picked-folder"); await fs.symlink(root, alias);
    const host = new SkillHost(); await host.grant(alias);
    await fs.unlink(alias); await fs.symlink(outside, alias);
    await host.grant(outside);
    const opened = vi.spyOn(fs, "open");
    expect((await hashGrantedFile(alias, "job.txt", () => host.grantedSandbox())).digest).toBeNull();
    expect(opened).not.toHaveBeenCalled();
    const revocation = host.revoke(alias);
    await expect(hashGrantedFile(alias, "job.txt", () => host.grantedSandbox())).rejects.toThrow("not been granted");
    await revocation;
  });

  it("refuses sensitive paths without opening them, even under an overbroad grant", async () => {
    // Synthetic home: never touch the actual user's credential directories.
    const os = await import("node:os");
    vi.spyOn(os, "homedir").mockReturnValue(root);
    await fs.mkdir(join(root, "Library", "Keychains"), { recursive: true });
    await fs.writeFile(join(root, "Library", "Keychains", "fictional"), "not a credential");
    const opened = vi.spyOn(fs, "open");
    expect(await hashGrantedFile(root, "Library/Keychains/fictional", current)).toMatchObject({ digest: null, problem: expect.stringMatching(/link|granted/u) });
    expect(opened).not.toHaveBeenCalled();
  });

  it("does not read hidden configuration files through the checksum path", async () => {
    await fs.writeFile(join(root, ".env"), "FICTIONAL SETTING ONLY");
    await fs.mkdir(join(root, ".config"));
    await fs.writeFile(join(root, ".config", "fictional"), "FICTIONAL SETTING ONLY");
    const opened = vi.spyOn(fs, "open");
    for (const path of [".env", ".config/fictional"])
      expect(await hashGrantedFile(root, path, current)).toMatchObject({ digest: null, problem: expect.stringMatching(/hidden/iu) });
    expect(opened).not.toHaveBeenCalled();
  });

  it.each(["leaf", "parent"] as const)("the OS refuses a %s symlink swapped in just before open", async kind => {
    await fs.mkdir(join(root, "nested")); await fs.writeFile(join(root, "nested", "job.txt"), "original nested job");
    const originalOpen = realFs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (path, flags, mode) => {
      if (kind === "leaf") {
        await fs.unlink(join(root, "nested", "job.txt"));
        await fs.symlink(join(outside, "job.txt"), join(root, "nested", "job.txt"));
      } else {
        await fs.rename(join(root, "nested"), join(root, "moved"));
        await fs.symlink(outside, join(root, "nested"));
      }
      return originalOpen(path, flags, mode);
    });
    expect(await hashGrantedFile(root, "nested/job.txt", current)).toMatchObject({ digest: null, problem: expect.stringMatching(/link/u) });
  });

  it.each(["file", "root"] as const)("refuses a replaced %s identity before reading and closes the descriptor", async kind => {
    const originalOpen = realFs.open;
    let reads = 0; let closes = 0;
    vi.spyOn(fs, "open").mockImplementationOnce(async (path, flags, mode) => {
      if (kind === "file") await fs.rename(join(outside, "job.txt"), join(root, "job.txt"));
      else { await fs.rename(root, join(base, "old-root")); await fs.rename(outside, root); }
      const handle = await originalOpen(path, flags, mode);
      const read = handle.read.bind(handle); const close = handle.close.bind(handle);
      vi.spyOn(handle, "read").mockImplementation((...args: Parameters<typeof handle.read>) => { reads++; return read(...args); });
      vi.spyOn(handle, "close").mockImplementation(() => { closes++; return close(); });
      return handle;
    });
    expect(await hashGrantedFile(root, "job.txt", current)).toMatchObject({ digest: null, problem: expect.stringMatching(/changed/u) });
    expect(reads).toBe(0); expect(closes).toBe(1);
  });

  it("stops reading after grant withdrawal and keeps no digest", async () => {
    await fs.writeFile(join(root, "large"), "x".repeat(150_000));
    const originalOpen = realFs.open; let reads = 0;
    vi.spyOn(fs, "open").mockImplementationOnce(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode); const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof handle.read>) => {
        reads++; const result = await read(...args); grant = null; return result;
      });
      return handle;
    });
    expect(await hashGrantedFile(root, "large", current)).toMatchObject({ digest: null, problem: expect.stringMatching(/access changed/u) });
    expect(reads).toBe(1);
  });

  it("refuses oversized input before open and never reads a growing file beyond its original bound", async () => {
    const opened = vi.spyOn(fs, "open");
    expect((await hashGrantedFile(root, "job.txt", current, 3)).digest).toBeNull();
    expect(opened).not.toHaveBeenCalled(); opened.mockRestore();
    await fs.writeFile(join(root, "growing"), "1234");
    const originalOpen = realFs.open; let bytes = 0;
    vi.spyOn(fs, "open").mockImplementationOnce(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode); const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof handle.read>) => {
        await fs.appendFile(join(root, "growing"), "567890");
        const result = await read(...args); bytes += result.bytesRead; return result;
      });
      return handle;
    });
    expect(await hashGrantedFile(root, "growing", current, 4)).toMatchObject({ digest: null, problem: expect.stringMatching(/changed/u) });
    expect(bytes).toBe(4);
  });
});

it.runIf(process.platform !== "darwin")("does not fall back to unsafe opening on another OS", async () => {
  expect(await hashGrantedFile(root, "job.txt", current)).toMatchObject({ digest: null, problem: expect.stringMatching(/not yet available/u) });
});
