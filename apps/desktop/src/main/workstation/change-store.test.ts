import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readBefore, readContentBefore, saveBefore, snapshotFolder } from "./change-store.js";

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
});
