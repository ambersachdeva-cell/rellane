import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceFile = fileURLToPath(new URL("./inventory.c", import.meta.url));
const nativeSupported = process.platform === "darwin" &&
  spawnSync("xcrun", ["--find", "clang"], { stdio: "ignore" }).status === 0;
let base: string;
let executable: string;

type RunResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

async function run(root: string): Promise<RunResult> {
  const child = spawn(executable, [root], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "close") as [number | null];
  return { code, stdout, stderr };
}

async function syntheticRoot(name: string): Promise<string> {
  const root = path.join(base, name);
  await fs.mkdir(root);
  return root;
}

describe.skipIf(!nativeSupported)("R24 descriptor-pinned native inventory", () => {
beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "r24-native-inventory-")));
  executable = path.join(base, "r24-inventory");
  const compiler = spawn("xcrun", [
    "clang", "-std=c11", "-Wall", "-Wextra", "-Werror",
    "-Wno-deprecated-declarations", "-O2", "-DR24_INVENTORY_TESTING",
    sourceFile, "-o", executable
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let errorText = "";
  compiler.stderr.setEncoding("utf8").on("data", chunk => { errorText += chunk; });
  const [code] = await once(compiler, "close") as [number | null];
  if (code !== 0) throw new Error(`Native test compiler failed: ${errorText}`);
}, 15_000);

afterAll(async () => {
  if (base) await fs.rm(base, { recursive: true, force: true });
});

  it("emits a bytewise deterministic manifest with streaming hashes", async () => {
    const root = await syntheticRoot("stable");
    await fs.mkdir(path.join(root, "b"));
    await fs.writeFile(path.join(root, "b", "note.txt"), "synthetic note");
    await fs.writeFile(path.join(root, "a.txt"), "synthetic a");
    const first = await run(root);
    const second = await run(root);
    expect(first.code, first.stderr).toBe(0);
    expect(second).toEqual(first);
    const lines = first.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("R24-NOFOLLOW-INVENTORY\t1");
    const paths = lines.slice(1).map(line => Buffer.from(line.split("\t")[1]!, "hex").toString("utf8"));
    expect(paths).toEqual(["a.txt", "b", "b/note.txt"]);
    const note = lines.find(line => line.includes(Buffer.from("b/note.txt").toString("hex")));
    expect(note).toBe(`F\t${Buffer.from("b/note.txt").toString("hex")}\t14\t${createHash("sha256").update("synthetic note").digest("hex")}`);
  });

  it("accepts a symlinked system-style ancestor but rejects a symlinked root leaf", async () => {
    const root = await syntheticRoot("alias-root");
    await fs.writeFile(path.join(root, "note.txt"), "synthetic");
    const alias = path.join(base, "alias");
    await fs.symlink(base, alias);
    expect((await run(path.join(alias, "alias-root"))).code).toBe(0);
    const leaf = path.join(base, "linked-root");
    await fs.symlink(root, leaf);
    const result = await run(leaf);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("rejects symlinks and hard links without listing outside bytes", async () => {
    const outside = path.join(base, "outside.txt");
    await fs.writeFile(outside, "outside sentinel");
    const linked = await syntheticRoot("symlink");
    await fs.symlink(outside, path.join(linked, "linked.txt"));
    const symlinkResult = await run(linked);
    expect(symlinkResult.code).not.toBe(0);
    expect(symlinkResult.stdout).toBe("");
    const hard = await syntheticRoot("hardlink");
    await fs.link(outside, path.join(hard, "hard.txt"));
    const hardResult = await run(hard);
    expect(hardResult.code).not.toBe(0);
    expect(hardResult.stdout).toBe("");
    expect(await fs.readFile(outside, "utf8")).toBe("outside sentinel");
  });

  it("rejects a sparse file above the byte cap before reading it", async () => {
    const root = await syntheticRoot("oversize");
    const handle = await fs.open(path.join(root, "large.bin"), "wx");
    try {
      await handle.truncate(64 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    const result = await run(root);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("oversized file");
  });

  it("rejects a tree deeper than the fixed directory bound", async () => {
    const root = await syntheticRoot("too-deep");
    let current = root;
    for (let i = 0; i < 33; i++) {
      current = path.join(current, "d");
      await fs.mkdir(current);
    }
    const result = await run(root);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("depth limit");
  });

  it("rejects a directory swapped to an outside symlink between fstatat and openat", async () => {
    const root = await syntheticRoot("swap");
    const nested = path.join(root, "nested");
    await fs.mkdir(nested);
    const outside = await syntheticRoot("outside-directory");
    await fs.writeFile(path.join(outside, "secret.txt"), "outside sentinel");
    const child = spawn(executable, [root], {
      env: { ...process.env, R24_TEST_PAUSE_BEFORE_OPEN: "nested" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("native race seam did not pause")), 3_000);
      child.stderr.on("data", () => {
        if (stderr.includes("R24_TEST_PAUSED")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", reject);
    });
    await fs.rmdir(nested);
    await fs.symlink(outside, nested);
    child.stdin.end("\n");
    const [code] = await once(child, "close") as [number | null];
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("linked or changing directory");
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside sentinel");
  });
});
