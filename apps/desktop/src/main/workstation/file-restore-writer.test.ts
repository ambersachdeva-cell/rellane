import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  safeRestoreFile,
  SafeRestoreError,
  SafeRestorePreWriteError,
  SafeRestoreWriteError
} from "./file-restore-writer.js";

describe("file-restore-writer safeRestoreFile", () => {
  let testRoot: string;
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "safe-restore-test-"));
    workspaceDir = path.join(testRoot, "workspace");
    outsideDir = path.join(testRoot, "outside");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    if (testRoot) {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("restores unchanged nested existing file and preserves mode where practical", async () => {
    const nestedDir = path.join(workspaceDir, "nested", "existing");
    await mkdir(nestedDir, { recursive: true });
    const filePath = path.join(nestedDir, "file.txt");
    await writeFile(filePath, "original content", "utf8");
    await chmod(filePath, 0o644);

    await safeRestoreFile(workspaceDir, "nested/existing/file.txt", "updated content");

    const content = await readFile(filePath, "utf8");
    expect(content).toBe("updated content");

    const fileStat = await stat(filePath);
    expect(fileStat.mode & 0o777).toBe(0o644);
  });

  it("recreates removed nested file creating missing intermediate directories", async () => {
    const relPath = "missing/intermediate/dir/recreated.txt";
    const fullPath = path.join(workspaceDir, relPath);

    await safeRestoreFile(workspaceDir, relPath, "brand new content");

    const content = await readFile(fullPath, "utf8");
    expect(content).toBe("brand new content");

    const parentStat = await lstat(path.join(workspaceDir, "missing", "intermediate"));
    expect(parentStat.isDirectory()).toBe(true);
    expect(parentStat.isSymbolicLink()).toBe(false);
  });

  it("refuses restore when nested parent directory is a symlink pointing outside", async () => {
    const outsideTarget = path.join(outsideDir, "secret.txt");
    await writeFile(outsideTarget, "top secret outside", "utf8");

    const linkParent = path.join(workspaceDir, "parent_link");
    await symlink(outsideDir, linkParent);

    await expect(
      safeRestoreFile(workspaceDir, "parent_link/secret.txt", "overwritten payload")
    ).rejects.toThrow(SafeRestorePreWriteError);

    const outsideContent = await readFile(outsideTarget, "utf8");
    expect(outsideContent).toBe("top secret outside");
  });

  it("refuses restore when target leaf is a symlink pointing outside", async () => {
    const outsideTarget = path.join(outsideDir, "victim.txt");
    await writeFile(outsideTarget, "victim content untouched", "utf8");

    const linkLeaf = path.join(workspaceDir, "leaf_link.txt");
    await symlink(outsideTarget, linkLeaf);

    await expect(
      safeRestoreFile(workspaceDir, "leaf_link.txt", "overwritten payload")
    ).rejects.toThrow(SafeRestorePreWriteError);

    const outsideContent = await readFile(outsideTarget, "utf8");
    expect(outsideContent).toBe("victim content untouched");
  });

  it("refuses lexical traversal paths before writing", async () => {
    const outsideTarget = path.join(outsideDir, "traversal.txt");
    await writeFile(outsideTarget, "outside data", "utf8");

    await expect(
      safeRestoreFile(workspaceDir, "../outside/traversal.txt", "attack")
    ).rejects.toThrow(SafeRestorePreWriteError);

    await expect(
      safeRestoreFile(workspaceDir, "dir/../../outside/traversal.txt", "attack")
    ).rejects.toThrow(SafeRestorePreWriteError);

    await expect(
      safeRestoreFile(workspaceDir, "dir/./../../outside/traversal.txt", "attack")
    ).rejects.toThrow(SafeRestorePreWriteError);

    await expect(
      safeRestoreFile(workspaceDir, "/etc/passwd", "attack")
    ).rejects.toThrow(SafeRestorePreWriteError);

    await expect(
      safeRestoreFile(workspaceDir, "bad\0file.txt", "attack")
    ).rejects.toThrow(SafeRestorePreWriteError);

    const content = await readFile(outsideTarget, "utf8");
    expect(content).toBe("outside data");
  });

  it("fails closed when parent directory is replaced with a symlink immediately before call", async () => {
    const raceDir = path.join(workspaceDir, "raced_parent");
    await mkdir(raceDir, { recursive: true });

    await rm(raceDir, { recursive: true, force: true });
    await symlink(outsideDir, raceDir);

    await expect(
      safeRestoreFile(workspaceDir, "raced_parent/payload.txt", "injected")
    ).rejects.toThrow(SafeRestorePreWriteError);

    const outsideTarget = path.join(outsideDir, "payload.txt");
    let exists = false;
    try {
      await lstat(outsideTarget);
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("guarantees no outside file is touched across failed restore attempts", async () => {
    const canaryFile = path.join(outsideDir, "canary.txt");
    await writeFile(canaryFile, "canary value", "utf8");
    const initialStat = await stat(canaryFile);

    const linkParent = path.join(workspaceDir, "bad_link");
    await symlink(outsideDir, linkParent);

    const attempts = [
      "bad_link/canary.txt",
      "../outside/canary.txt",
      "sub/../../outside/canary.txt",
      "bad_link\0bad"
    ];

    for (const attempt of attempts) {
      await expect(safeRestoreFile(workspaceDir, attempt, "corrupt")).rejects.toThrow(SafeRestoreError);
    }

    const afterContent = await readFile(canaryFile, "utf8");
    expect(afterContent).toBe("canary value");
    const afterStat = await stat(canaryFile);
    expect(afterStat.mtimeMs).toBe(initialStat.mtimeMs);
  });

  it("retains existing workspace source file unmodified on pre-write rejection", async () => {
    const existingFile = path.join(workspaceDir, "source.txt");
    await writeFile(existingFile, "original source file data", "utf8");

    const outsideVictim = path.join(outsideDir, "outside_victim.txt");
    await writeFile(outsideVictim, "original victim data", "utf8");

    const symlinkLeaf = path.join(workspaceDir, "target_link.txt");
    await symlink(outsideVictim, symlinkLeaf);

    await expect(
      safeRestoreFile(workspaceDir, "target_link.txt", "malicious payload")
    ).rejects.toThrow(SafeRestorePreWriteError);

    const sourceContent = await readFile(existingFile, "utf8");
    expect(sourceContent).toBe("original source file data");

    const victimContent = await readFile(outsideVictim, "utf8");
    expect(victimContent).toBe("original victim data");
  });
});
