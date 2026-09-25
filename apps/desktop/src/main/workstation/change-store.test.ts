import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readBefore, readContentBefore, saveBefore, snapshotFolder } from "./change-store.js";
import { listWorkspace } from "./workspace-files.js";

let root: string;
let folder: string;

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "change-store-"));
  root = path.join(base, "history");
  folder = path.join(base, "work");
  await fs.mkdir(folder, { recursive: true });
});

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

const CASE = "11111111-1111-4111-8111-111111111111";
const OP = "22222222-2222-4222-8222-222222222222";

describe("change-store", () => {
  it("records a folder before a session and answers with it afterwards", async () => {
    await fs.writeFile(path.join(folder, "notes.txt"), "the original line", "utf8");
    await fs.mkdir(path.join(folder, "sub"), { recursive: true });
    await fs.writeFile(path.join(folder, "sub", "deep.txt"), "nested original", "utf8");

    expect(await saveBefore(root, CASE, OP, folder)).toBe(true);

    // The session changes one file and adds another.
    await fs.writeFile(path.join(folder, "notes.txt"), "the session rewrote this", "utf8");
    await fs.writeFile(path.join(folder, "new.txt"), "brand new", "utf8");

    const before = await readBefore(root, CASE, OP);
    expect(before).not.toBeNull();
    const paths = (before ?? []).map((entry) => entry.relativePath).sort();
    expect(paths).toContain("notes.txt");
    expect(paths).not.toContain("new.txt");

    expect(await readContentBefore(root, CASE, OP, "notes.txt")).toBe("the original line");
    expect(await readContentBefore(root, CASE, OP, path.join("sub", "deep.txt"))).toBe(
      "nested original"
    );
  });

  it("distinguishes never-snapshotted from snapshotted-and-empty", async () => {
    expect(await readBefore(root, CASE, OP)).toBeNull();

    expect(await saveBefore(root, CASE, OP, folder)).toBe(true);
    const before = await readBefore(root, CASE, OP);
    expect(before).not.toBeNull();
    expect(before).toHaveLength(0);
  });

  it("keeps a large file by hash without keeping its contents", async () => {
    const big = "x".repeat(1_048_577);
    await fs.writeFile(path.join(folder, "big.txt"), big, "utf8");

    await saveBefore(root, CASE, OP, folder);

    const before = await readBefore(root, CASE, OP);
    expect((before ?? []).some((entry) => entry.relativePath === "big.txt")).toBe(true);
    // Listed, so a change is still detected; not kept, so no undo is offered.
    expect(await readContentBefore(root, CASE, OP, "big.txt")).toBeNull();
  });

  it("refuses an id that is not an id rather than building a path from it", async () => {
    await fs.writeFile(path.join(folder, "notes.txt"), "text", "utf8");

    expect(await saveBefore(root, "../../escape", OP, folder)).toBe(false);
    expect(await readBefore(root, CASE, "..")).toBeNull();
    expect(await readContentBefore(root, "a/b", OP, "notes.txt")).toBeNull();
  });

  it("hashes contents, so a file touched but unchanged is unchanged", async () => {
    await fs.writeFile(path.join(folder, "same.txt"), "identical", "utf8");
    const first = await snapshotFolder(folder);

    await fs.writeFile(path.join(folder, "same.txt"), "identical", "utf8");
    const second = await snapshotFolder(folder);

    expect(first[0]?.hash).toBe(second[0]?.hash);
  });

  it("persists content whose hash and bytes match snapshot metadata", async () => {
    const text = "first line\nsecond line\n";
    await fs.writeFile(path.join(folder, "doc.txt"), text, "utf8");

    expect(await saveBefore(root, CASE, OP, folder)).toBe(true);

    const before = await readBefore(root, CASE, OP);
    expect(before).toHaveLength(1);
    const entry = before![0]!;
    expect(entry.relativePath).toBe("doc.txt");

    const content = await readContentBefore(root, CASE, OP, "doc.txt");
    expect(content).toBe(text);

    const raw = JSON.parse(
      await fs.readFile(path.join(root, `${CASE}__${OP}`, "snapshot.json"), "utf8")
    );
    expect(raw.entries[0].hash).toBe(entry.hash);
    expect(raw.entries[0].bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(raw.snapshotFormatVersion).toBe(2);
    expect(raw.keptFiles).toEqual([{
      relativePath: "doc.txt",
      blobName: expect.stringMatching(/^[0-9a-f]{64}$/),
      hash: entry.hash,
      bytes: Buffer.byteLength(text, "utf8")
    }]);
  });

  it("returns false and leaves no readable snapshot on unreadable workspace file", async () => {
    await fs.writeFile(path.join(folder, "readable.txt"), "content", "utf8");
    await fs.writeFile(path.join(folder, "unreadable.txt"), "secret", "utf8");

    const originalOpen = fs.open.bind(fs);
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const filePath = args[0];
        if (typeof filePath === "string" && filePath.endsWith("unreadable.txt")) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
        return originalOpen(...args);
      });

    try {
      const ok = await saveBefore(root, CASE, OP, folder);
      expect(ok).toBe(false);
      expect(await readBefore(root, CASE, OP)).toBeNull();
      expect(await readContentBefore(root, CASE, OP, "readable.txt")).toBeNull();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("rejects a listed file replaced by a symlink outside the workspace before capture", async () => {
    const listedPath = path.join(folder, "file.txt");
    const outsidePath = path.join(path.dirname(folder), "outside.txt");
    await fs.writeFile(listedPath, "inside", "utf8");
    await fs.writeFile(outsidePath, "outside-secret", "utf8");
    const originalRealpath = fs.realpath.bind(fs);
    let replaced = false;
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      if (args[0] === listedPath && !replaced) {
        replaced = true;
        await fs.unlink(listedPath);
        await fs.symlink(outsidePath, listedPath);
      }
      return originalRealpath(...args);
    });
    try {
      expect(await saveBefore(root, CASE, OP, folder)).toBe(false);
    } finally {
      realpathSpy.mockRestore();
    }
    expect(replaced).toBe(true);
    expect(await readBefore(root, CASE, OP)).toBeNull();
    expect(await readContentBefore(root, CASE, OP, "file.txt")).toBeNull();
  });

  it("also keeps outside symlink bytes out of the later comparison inventory", async () => {
    const listedPath = path.join(folder, "file.txt");
    const outsidePath = path.join(path.dirname(folder), "outside.txt");
    await fs.writeFile(listedPath, "inside", "utf8");
    await fs.writeFile(outsidePath, "outside-secret", "utf8");
    const originalRealpath = fs.realpath.bind(fs);
    let replaced = false;
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      if (args[0] === listedPath && !replaced) {
        replaced = true;
        await fs.unlink(listedPath);
        await fs.symlink(outsidePath, listedPath);
      }
      return originalRealpath(...args);
    });
    try {
      expect(await snapshotFolder(folder)).toEqual([]);
    } finally {
      realpathSpy.mockRestore();
    }
    expect(replaced).toBe(true);
  });

  it("blocks publication when a kept file cannot be written and synced", async () => {
    await fs.writeFile(path.join(folder, "file.txt"), "content", "utf8");
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (typeof args[0] === "string" && args[0].includes(".staging_") &&
          args[0].includes(`${path.sep}files${path.sep}`) && args[1] === "w") {
        vi.spyOn(handle, "writeFile").mockRejectedValue(
          Object.assign(new Error("Kept-file write failed"), { code: "EIO" })
        );
      }
      return handle;
    });
    try {
      expect(await saveBefore(root, CASE, OP, folder)).toBe(false);
    } finally {
      openSpy.mockRestore();
    }
    expect(await readBefore(root, CASE, OP)).toBeNull();
    expect(await fs.access(path.join(root, `.claim_${CASE}__${OP}`)).then(() => true).catch(() => false))
      .toBe(false);
  });

  it("returns false and leaves no readable snapshot when root is blocked", async () => {
    await fs.writeFile(path.join(folder, "file.txt"), "hello", "utf8");
    // Write a regular file at root so mkdir on staging fails with ENOTDIR
    await fs.writeFile(root, "blocking-file", "utf8");

    expect(await saveBefore(root, CASE, OP, folder)).toBe(false);
    expect(await readBefore(root, CASE, OP)).toBeNull();
    expect(await readContentBefore(root, CASE, OP, "file.txt")).toBeNull();
  });

  it("refuses a truncated workspace inventory instead of calling it a complete preimage", async () => {
    const deep = path.join(folder, "a", "b", "c", "d");
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, "beyond-depth.txt"), "not inventoried", "utf8");
    await expect(listWorkspace(folder)).resolves.toMatchObject({ truncated: true });

    expect(await saveBefore(root, CASE, OP, folder)).toBe(false);
    expect(await readBefore(root, CASE, OP)).toBeNull();
    expect(await fs.access(path.join(root, `.claim_${CASE}__${OP}`)).then(() => true).catch(() => false))
      .toBe(false);
  });

  it("does not overwrite an existing operation snapshot on duplicate save", async () => {
    await fs.writeFile(path.join(folder, "notes.txt"), "initial version", "utf8");
    expect(await saveBefore(root, CASE, OP, folder)).toBe(true);

    await fs.writeFile(path.join(folder, "notes.txt"), "modified version", "utf8");
    expect(await saveBefore(root, CASE, OP, folder)).toBe(false);

    expect(await readContentBefore(root, CASE, OP, "notes.txt")).toBe("initial version");
  });

  it("retains existing snapshot intact when subsequent saveBefore fails or is attempted", async () => {
    await fs.writeFile(path.join(folder, "notes.txt"), "initial version", "utf8");
    expect(await saveBefore(root, CASE, OP, folder)).toBe(true);

    const initialBefore = await readBefore(root, CASE, OP);
    expect(initialBefore).toEqual([{ relativePath: "notes.txt", hash: expect.any(String) }]);

    await fs.writeFile(path.join(folder, "notes.txt"), "modified version", "utf8");
    await fs.writeFile(path.join(folder, "new.txt"), "new file", "utf8");
    expect(await saveBefore(root, CASE, OP, folder)).toBe(false);

    const retainedBefore = await readBefore(root, CASE, OP);
    expect(retainedBefore).toEqual(initialBefore);
    expect(await readContentBefore(root, CASE, OP, "notes.txt")).toBe("initial version");
    expect(await readContentBefore(root, CASE, OP, "new.txt")).toBeNull();
  });

  it("fails saveBefore when directory fsync encounters durability failure", async () => {
    await fs.writeFile(path.join(folder, "file.txt"), "content", "utf8");

    const originalOpen = fs.open.bind(fs);
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        const flags = args[1];
        if (flags === "r") {
          vi.spyOn(handle, "sync").mockRejectedValue(
            Object.assign(new Error("EIO: i/o error during directory sync"), { code: "EIO" })
          );
        }
        return handle;
      });

    try {
      const ok = await saveBefore(root, CASE, OP, folder);
      expect(ok).toBe(false);
      expect(await readBefore(root, CASE, OP)).toBeNull();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("blocks launch when directory sync is unsupported", async () => {
    await fs.writeFile(path.join(folder, "file.txt"), "content", "utf8");

    const originalOpen = fs.open.bind(fs);
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        const flags = args[1];
        if (flags === "r") {
          vi.spyOn(handle, "sync").mockRejectedValue(
            Object.assign(new Error("ENOTSUP: operation not supported on directory"), {
              code: "ENOTSUP"
            })
          );
        }
        return handle;
      });

    try {
      const ok = await saveBefore(root, CASE, OP, folder);
      expect(ok).toBe(false);
      expect(await readBefore(root, CASE, OP)).toBeNull();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("exclusive claim prevents concurrent same-operation attempts from overwriting", async () => {
    await fs.writeFile(path.join(folder, "file.txt"), "content", "utf8");

    const [first, second] = await Promise.all([
      saveBefore(root, CASE, OP, folder),
      saveBefore(root, CASE, OP, folder)
    ]);

    expect([first, second].sort()).toEqual([false, true]);

    const before = await readBefore(root, CASE, OP);
    expect(before).not.toBeNull();
    expect(before).toHaveLength(1);
    expect(before![0]!.relativePath).toBe("file.txt");
  });

  it("pre-existing claim conservatively blocks saveBefore and does not remove the claim", async () => {
    await fs.writeFile(path.join(folder, "file.txt"), "content", "utf8");
    await fs.mkdir(root, { recursive: true });
    const claimPath = path.join(root, `.claim_${CASE}__${OP}`);
    await fs.writeFile(claimPath, "crashed-claim", "utf8");

    const ok = await saveBefore(root, CASE, OP, folder);
    expect(ok).toBe(false);

    const claimStillExists = await fs.access(claimPath).then(() => true).catch(() => false);
    expect(claimStillExists).toBe(true);
    expect(await readBefore(root, CASE, OP)).toBeNull();
  });

  it("fails saveBefore and leaves no readable snapshot on publication failure after rename", async () => {
    await fs.writeFile(path.join(folder, "file.txt"), "content", "utf8");

    const target = path.join(root, `${CASE}__${OP}`);
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const targetPath = args[0];
        const flags = args[1];
        if (targetPath === root && flags === "r") {
          const targetExists = await fs.access(target).then(() => true).catch(() => false);
          if (targetExists) {
            throw Object.assign(new Error("EIO: parent directory flush failed"), { code: "EIO" });
          }
        }
        return originalOpen(...args);
      });

    try {
      const ok = await saveBefore(root, CASE, OP, folder);
      expect(ok).toBe(false);
      expect(await readBefore(root, CASE, OP)).toBeNull();
      expect(await readContentBefore(root, CASE, OP, "file.txt")).toBeNull();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("retains the claim when failed publication cannot remove target or metadata", async () => {
    await fs.writeFile(path.join(folder, "file.txt"), "content", "utf8");
    const target = path.join(root, `${CASE}__${OP}`);
    const claim = path.join(root, `.claim_${CASE}__${OP}`);
    const originalOpen = fs.open.bind(fs);
    const originalRm = fs.rm.bind(fs);
    const originalUnlink = fs.unlink.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === root && args[1] === "r" && await fs.access(target).then(() => true).catch(() => false))
        throw Object.assign(new Error("Parent fsync failed"), { code: "EIO" });
      return originalOpen(...args);
    });
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === target) throw Object.assign(new Error("Target removal failed"), { code: "EACCES" });
      return originalRm(...args);
    });
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (...args: Parameters<typeof fs.unlink>) => {
      if (args[0] === path.join(target, "snapshot.json"))
        throw Object.assign(new Error("Metadata removal failed"), { code: "EACCES" });
      return originalUnlink(...args);
    });

    try {
      expect(await saveBefore(root, CASE, OP, folder)).toBe(false);
    } finally {
      openSpy.mockRestore();
      rmSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
    await expect(fs.access(claim)).resolves.toBeUndefined();
    await expect(fs.access(path.join(target, "snapshot.json"))).resolves.toBeUndefined();
    expect(await readBefore(root, CASE, OP)).toBeNull();
    expect(await readContentBefore(root, CASE, OP, "file.txt")).toBeNull();
  });

  it("returns false if the durable snapshot claim cannot be removed", async () => {
    await fs.writeFile(path.join(folder, "file.txt"), "content", "utf8");
    const claim = path.join(root, `.claim_${CASE}__${OP}`);
    const originalUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (...args: Parameters<typeof fs.unlink>) => {
      if (args[0] === claim) throw Object.assign(new Error("Claim removal failed"), { code: "EACCES" });
      return originalUnlink(...args);
    });
    try {
      expect(await saveBefore(root, CASE, OP, folder)).toBe(false);
    } finally {
      unlinkSpy.mockRestore();
    }
    await expect(fs.access(claim)).resolves.toBeUndefined();
    expect(await readBefore(root, CASE, OP)).toBeNull();
    expect(await readContentBefore(root, CASE, OP, "file.txt")).toBeNull();
  });

  it("treats uncertain target and claim checks as blockers", async () => {
    await fs.writeFile(path.join(folder, "file.txt"), "content", "utf8");
    const target = path.join(root, `${CASE}__${OP}`);
    const claim = path.join(root, `.claim_${CASE}__${OP}`);
    const originalAccess = fs.access.bind(fs);
    const targetSpy = vi.spyOn(fs, "access").mockImplementation(async (...args: Parameters<typeof fs.access>) => {
      if (args[0] === target) throw Object.assign(new Error("Target access uncertain"), { code: "EACCES" });
      return originalAccess(...args);
    });
    try {
      expect(await saveBefore(root, CASE, OP, folder)).toBe(false);
    } finally {
      targetSpy.mockRestore();
    }
    expect(await fs.access(claim).then(() => true).catch(() => false)).toBe(false);

    expect(await saveBefore(root, CASE, OP, folder)).toBe(true);
    const claimSpy = vi.spyOn(fs, "access").mockImplementation(async (...args: Parameters<typeof fs.access>) => {
      if (args[0] === claim) throw Object.assign(new Error("Claim access uncertain"), { code: "EACCES" });
      return originalAccess(...args);
    });
    try {
      expect(await readBefore(root, CASE, OP)).toBeNull();
      expect(await readContentBefore(root, CASE, OP, "file.txt")).toBeNull();
    } finally {
      claimSpy.mockRestore();
    }
    expect(await readContentBefore(root, CASE, OP, "file.txt")).toBe("content");
  });

  it("honestly records files exceeding MAX_KEPT_BYTES by hash without saving content", async () => {
    const oversized = "a".repeat(1_048_577);
    await fs.writeFile(path.join(folder, "big.txt"), oversized, "utf8");
    await fs.writeFile(path.join(folder, "small.txt"), "small text", "utf8");

    expect(await saveBefore(root, CASE, OP, folder)).toBe(true);

    const before = await readBefore(root, CASE, OP);
    expect(before).toHaveLength(2);

    expect(await readContentBefore(root, CASE, OP, "small.txt")).toBe("small text");
    expect(await readContentBefore(root, CASE, OP, "big.txt")).toBeNull();

    const target = path.join(root, `${CASE}__${OP}`);
    const files = await fs.readdir(path.join(target, "files"));
    expect(files).toHaveLength(1);
    const metadata = JSON.parse(await fs.readFile(path.join(target, "snapshot.json"), "utf8"));
    expect(metadata.keptFiles.map((item: { relativePath: string }) => item.relativePath)).toEqual(["small.txt"]);
  });

  it("honestly honors MAX_KEPT_FILES limit by keeping only first MAX_KEPT_FILES file contents", async () => {
    for (let i = 0; i < 402; i++) {
      const name = `f_${String(i).padStart(4, "0")}.txt`;
      await fs.writeFile(path.join(folder, name), `val ${i}`, "utf8");
    }

    expect(await saveBefore(root, CASE, OP, folder)).toBe(true);

    const before = await readBefore(root, CASE, OP);
    expect(before).toHaveLength(402);

    const target = path.join(root, `${CASE}__${OP}`);
    const files = await fs.readdir(path.join(target, "files"));
    expect(files.length).toBe(400);
    const metadata = JSON.parse(await fs.readFile(path.join(target, "snapshot.json"), "utf8"));
    expect(metadata.keptFiles).toHaveLength(400);
    expect(metadata.keptFiles.some((item: { relativePath: string }) => item.relativePath === "f_0400.txt")).toBe(false);

    expect(await readContentBefore(root, CASE, OP, "f_0000.txt")).toBe("val 0");
    expect(await readContentBefore(root, CASE, OP, "f_0400.txt")).toBeNull();
    expect(await readContentBefore(root, CASE, OP, "f_0401.txt")).toBeNull();
  });

  it("reads existing legacy snapshot files without migration", async () => {
    const oldTarget = path.join(root, `${CASE}__${OP}`);
    await fs.mkdir(path.join(oldTarget, "files"), { recursive: true });

    const content = "legacy text content";
    const { createHash } = await import("node:crypto");
    const relPath = "legacy.txt";
    const fileHash = createHash("sha256").update(content).digest("hex");
    const pathHash = createHash("sha256").update(relPath).digest("hex");

    await fs.writeFile(path.join(oldTarget, "files", pathHash), content, "utf8");
    await fs.writeFile(
      path.join(oldTarget, "snapshot.json"),
      JSON.stringify({
        takenAt: 1600000000000,
        folder: "/tmp/legacy",
        entries: [
          {
            relativePath: relPath,
            hash: fileHash,
            bytes: Buffer.byteLength(content, "utf8"),
            modifiedAt: 1600000000000
          }
        ]
      }),
      "utf8"
    );

    const before = await readBefore(root, CASE, OP);
    expect(before).toEqual([{ relativePath: "legacy.txt", hash: fileHash }]);

    const read = await readContentBefore(root, CASE, OP, "legacy.txt");
    expect(read).toBe(content);
  });

  it("refuses path traversal in readContentBefore", async () => {
    await fs.writeFile(path.join(folder, "notes.txt"), "text", "utf8");
    expect(await saveBefore(root, CASE, OP, folder)).toBe(true);

    expect(await readContentBefore(root, CASE, OP, "../escape")).toBeNull();
    expect(await readContentBefore(root, CASE, OP, "../../etc/passwd")).toBeNull();
    expect(await readContentBefore(root, CASE, OP, "/absolute/path")).toBeNull();
    expect(await readContentBefore(root, CASE, OP, "sub/../../escape")).toBeNull();
  });

  it("refuses corrupted content whose hash does not match metadata", async () => {
    await fs.writeFile(path.join(folder, "notes.txt"), "authentic content", "utf8");
    expect(await saveBefore(root, CASE, OP, folder)).toBe(true);

    const { createHash } = await import("node:crypto");
    const pathHash = createHash("sha256").update("notes.txt").digest("hex");
    const filePath = path.join(root, `${CASE}__${OP}`, "files", pathHash);
    await fs.writeFile(filePath, "tampered content", "utf8");

    expect(await readContentBefore(root, CASE, OP, "notes.txt")).toBeNull();
  });
});
