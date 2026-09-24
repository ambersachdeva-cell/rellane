import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  listWorkspace,
  previewFile,
  MAX_DEPTH,
  MAX_ENTRIES,
  MAX_PREVIEW_BYTES
} from "./workspace-files.js";

async function createTempWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "rellane-workspace-test-"));
}

async function removeTempWorkspace(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

describe("workspace-files", () => {
  it("does not follow symlinks pointing outside the workspace", async () => {
    const root = await createTempWorkspace();
    const outside = await createTempWorkspace();
    try {
      const secretFile = path.join(outside, "secret.txt");
      await fs.writeFile(secretFile, "confidential", "utf8");

      const insideFile = path.join(root, "inside.txt");
      await fs.writeFile(insideFile, "public", "utf8");

      const outsideLink = path.join(root, "outside-link.txt");
      await fs.symlink(secretFile, outsideLink);

      const insideLink = path.join(root, "inside-link.txt");
      await fs.symlink(insideFile, insideLink);

      const listing = await listWorkspace(root);
      const names = listing.entries.map((e) => e.name);
      expect(names).toContain("inside.txt");
      expect(names).toContain("inside-link.txt");
      expect(names).not.toContain("outside-link.txt");

      const previewOutside = await previewFile(root, "outside-link.txt");
      expect(previewOutside.status).toBe("unavailable");

      const previewInside = await previewFile(root, "inside-link.txt");
      expect(previewInside.status).toBe("text");
      if (previewInside.status === "text") {
        expect(previewInside.text).toBe("public");
      }
    } finally {
      await removeTempWorkspace(root);
      await removeTempWorkspace(outside);
    }
  });

  it("prevents .. from escaping the workspace root", async () => {
    const root = await createTempWorkspace();
    try {
      const sub = path.join(root, "sub");
      await fs.mkdir(sub);
      await fs.writeFile(path.join(sub, "file.txt"), "hello", "utf8");

      const escape1 = await previewFile(root, "../secret.txt");
      expect(escape1.status).toBe("unavailable");

      const escape2 = await previewFile(root, "sub/../../secret.txt");
      expect(escape2.status).toBe("unavailable");
    } finally {
      await removeTempWorkspace(root);
    }
  });

  it("refuses to preview a binary file and sniffs textuality accurately", async () => {
    const root = await createTempWorkspace();
    try {
      const binFile = path.join(root, "app.bin");
      await fs.writeFile(binFile, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));

      const logFile = path.join(root, "build.log");
      await fs.writeFile(logFile, "Build finished cleanly\n", "utf8");

      const listing = await listWorkspace(root);
      const binEntry = listing.entries.find((e) => e.name === "app.bin");
      const logEntry = listing.entries.find((e) => e.name === "build.log");

      expect(binEntry?.textual).toBe(false);
      expect(logEntry?.textual).toBe(true);

      const binPreview = await previewFile(root, "app.bin");
      expect(binPreview.status).toBe("unavailable");
      if (binPreview.status === "unavailable") {
        expect(binPreview.reason).toMatch(/binary/i);
      }

      const logPreview = await previewFile(root, "build.log");
      expect(logPreview.status).toBe("text");
      if (logPreview.status === "text") {
        expect(logPreview.text).toBe("Build finished cleanly\n");
        expect(logPreview.truncated).toBe(false);
      }
    } finally {
      await removeTempWorkspace(root);
    }
  });

  it("sets truncated when depth or entry caps bite", async () => {
    const root = await createTempWorkspace();
    try {
      const deepDir = path.join(root, "d1", "d2", "d3", "d4", "d5");
      await fs.mkdir(deepDir, { recursive: true });
      await fs.writeFile(path.join(deepDir, "deep.txt"), "too deep", "utf8");

      const listing = await listWorkspace(root);
      expect(listing.truncated).toBe(true);
      for (const entry of listing.entries) {
        expect(entry.depth).toBeLessThanOrEqual(MAX_DEPTH);
      }

      const capRoot = await createTempWorkspace();
      try {
        const totalFilesToCreate = MAX_ENTRIES + 5;
        const creates: Promise<void>[] = [];
        for (let i = 0; i < totalFilesToCreate; i++) {
          creates.push(
            fs.writeFile(path.join(capRoot, `file_${String(i).padStart(4, "0")}.txt`), "x", "utf8")
          );
        }
        await Promise.all(creates);

        const capListing = await listWorkspace(capRoot);
        expect(capListing.truncated).toBe(true);
        expect(capListing.entries.length).toBe(MAX_ENTRIES);
      } finally {
        await removeTempWorkspace(capRoot);
      }
    } finally {
      await removeTempWorkspace(root);
    }
  });

  it("skips dotfiles and node_modules at any depth", async () => {
    const root = await createTempWorkspace();
    try {
      await fs.mkdir(path.join(root, ".git"));
      await fs.writeFile(path.join(root, ".git", "config"), "git-config", "utf8");

      await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
      await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module", "utf8");

      await fs.writeFile(path.join(root, ".DS_Store"), "noise", "utf8");
      await fs.writeFile(path.join(root, ".env"), "SECRET=1", "utf8");
      await fs.writeFile(path.join(root, "visible.txt"), "visible content", "utf8");

      const sub = path.join(root, "nested");
      await fs.mkdir(sub);
      await fs.writeFile(path.join(sub, ".hidden"), "hidden", "utf8");
      await fs.writeFile(path.join(sub, "nested.txt"), "nested content", "utf8");

      const listing = await listWorkspace(root);
      const paths = listing.entries.map((e) => e.relativePath);

      expect(paths).toContain("visible.txt");
      expect(paths).toContain("nested");
      expect(paths).toContain("nested/nested.txt");

      for (const entryPath of paths) {
        expect(entryPath).not.toMatch(/(^|\/)\./);
        expect(entryPath).not.toContain("node_modules");
      }
    } finally {
      await removeTempWorkspace(root);
    }
  });

  it("orders folders before files, then by name case-insensitively", async () => {
    const root = await createTempWorkspace();
    try {
      await fs.writeFile(path.join(root, "zebra.txt"), "z", "utf8");
      await fs.mkdir(path.join(root, "beta-dir"));
      await fs.writeFile(path.join(root, "Alpha.txt"), "a", "utf8");
      await fs.mkdir(path.join(root, "alpha-dir"));
      await fs.writeFile(path.join(root, "beta.txt"), "b", "utf8");

      const listing = await listWorkspace(root);
      const names = listing.entries.map((e) => e.name);

      expect(names).toEqual([
        "alpha-dir",
        "beta-dir",
        "Alpha.txt",
        "beta.txt",
        "zebra.txt"
      ]);
    } finally {
      await removeTempWorkspace(root);
    }
  });

  it("previewFile truncates text files larger than MAX_PREVIEW_BYTES", async () => {
    const root = await createTempWorkspace();
    try {
      const largeContent = "a".repeat(MAX_PREVIEW_BYTES + 500);
      const largePath = path.join(root, "large.txt");
      await fs.writeFile(largePath, largeContent, "utf8");

      const outcome = await previewFile(root, "large.txt");
      expect(outcome.status).toBe("text");
      if (outcome.status === "text") {
        expect(outcome.truncated).toBe(true);
        expect(outcome.bytes).toBe(largeContent.length);
        expect(outcome.text.length).toBe(MAX_PREVIEW_BYTES);
      }
    } finally {
      await removeTempWorkspace(root);
    }
  });
});
