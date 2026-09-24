/** A file review authorizes exactly visible text and cannot become a folder-wide grant. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, readdir, rm, symlink, link, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewClaudeFileAction } from "./claude-file-tools.js";
const folders: string[] = [];
async function folder() { const path = await realpath(await mkdtemp(join(tmpdir(), "rellane-file-review-"))); folders.push(path); return path; }
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("reviewed Claude files", () => {
  it("shares the exact reviewed bytes through a frozen copy until explicitly disposed", async () => {
    const cwd = await folder(); const path = join(cwd, "brief.md"); const original = "\uFEFFColour: apricot\nPrice: ₹125\n";
    await writeFile(path, original); const item = await reviewClaudeFileAction(cwd, "Read", { file_path: path, offset: 1 });
    expect(item.detail).toContain(original); expect(item.detail).toContain(path);
    const allowed = await item.allow(); const copy = allowed["file_path"] as string;
    await writeFile(path, "Changed after Allow");
    expect(copy).not.toBe(path); expect(await readFile(copy, "utf8")).toBe(original); expect(allowed["offset"]).toBe(1);
    await expect(item.allow()).rejects.toThrow(/no longer/);
    await item.dispose(); await expect(readFile(copy)).rejects.toThrow(/ENOENT/);
    expect(await readFile(path, "utf8")).toBe("Changed after Allow");
  });

  it.each(["Read", "Write"])("refuses %s if the reviewed file changes before the decision", async tool => {
    const cwd = await folder(); const path = join(cwd, "brief.txt"); await writeFile(path, "Before");
    const item = await reviewClaudeFileAction(cwd, tool, tool === "Read" ? { file_path: path } : { file_path: path, content: "Proposed" });
    await writeFile(path, "Changed"); await expect(item.allow()).rejects.toThrow(/file changed after/);
    expect(await readFile(path, "utf8")).toBe("Changed"); await item.dispose();
  });

  it("shows old and proposed text, snapshots native input, and performs no write just by reviewing or allowing", async () => {
    const cwd = await folder(); const path = join(cwd, "draft.txt"); await writeFile(path, "Old text\n");
    const input = { file_path: path, content: "New text ₹125\n" };
    const item = await reviewClaudeFileAction(cwd, "Write", input); input.content = "Unreviewed change";
    expect(item.detail).toContain("CURRENT TEXT\nOld text\n"); expect(item.detail).toContain("PROPOSED TEXT\nNew text ₹125\n");
    expect(await item.allow()).toEqual({ file_path: path, content: "New text ₹125\n" });
    expect(await readFile(path, "utf8")).toBe("Old text\n"); await item.dispose();
    const newFile = await reviewClaudeFileAction(cwd, "Write", { file_path: "new.md", content: "New" });
    expect(newFile.title).toBe("Create new.md?"); await newFile.dispose();
    await expect(newFile.allow()).rejects.toThrow(/no longer/); await expect(readFile(join(cwd, "new.md"))).rejects.toThrow(/ENOENT/);
  });

  it("refuses traversal, hidden and credential files, unknown tools and unreviewed options", async () => {
    const cwd = await folder();
    for (const file_path of ["../outside.md", ".env", "credentials.json", "a/private-key.txt", "picture.png"]) {
      await expect(reviewClaudeFileAction(cwd, "Write", { file_path, content: "No" })).rejects.toThrow();
    }
    await expect(reviewClaudeFileAction(cwd, "Bash", {})).rejects.toThrow(/only/);
    await expect(reviewClaudeFileAction(cwd, "Write", { file_path: "a.md", content: "No", bypass: true })).rejects.toThrow(/unsupported/);
    expect(await readdir(cwd)).toEqual([]);
  });

  it("refuses symbolic links, linked parents and hard-linked files", async () => {
    const cwd = await folder(); const other = await folder(); const file = join(other, "brief.md"); await writeFile(file, "Private");
    await symlink(file, join(cwd, "alias.md")); await symlink(other, join(cwd, "parent")); await link(file, join(cwd, "hard.md"));
    for (const name of ["alias.md", "parent/brief.md", "hard.md"]) {
      await expect(reviewClaudeFileAction(cwd, "Read", { file_path: name })).rejects.toThrow(/link/);
    }
  });

  it("bounds text and refuses invalid UTF-8, binary data and invalid read ranges", async () => {
    const cwd = await folder(); const path = join(cwd, "brief.txt");
    for (const value of [Buffer.from([0xff, 0xfe]), Buffer.from("a\u0000b"), Buffer.from("x".repeat(16_001))]) {
      await writeFile(path, value); await expect(reviewClaudeFileAction(cwd, "Read", { file_path: path })).rejects.toThrow();
    }
    await writeFile(path, "Text");
    await expect(reviewClaudeFileAction(cwd, "Read", { file_path: path, offset: -1 })).rejects.toThrow(/range/);
    await expect(reviewClaudeFileAction(cwd, "Write", { file_path: path, content: "\uD800" })).rejects.toThrow(/UTF-8/);
  });

  it("a cancelled approval leaves no copied file and cannot later authorize a native read", async () => {
    const cwd = await folder(); await writeFile(join(cwd, "brief.md"), "Text");
    const item = await reviewClaudeFileAction(cwd, "Read", { file_path: "brief.md" });
    const allow = item.allow(); const rejected = expect(allow).rejects.toThrow(/cancelled/);
    await item.dispose(); await rejected; expect(await readdir(cwd)).toEqual(["brief.md"]);
  });
});
