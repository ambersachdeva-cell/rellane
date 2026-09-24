import { chmod, lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assemblePinnedLlamaB10182MacosArm64Sidecar } from "./unsigned-sidecar-assembler.js";
import { canonicalJson, sha256, validateArchiveMembers, type SafeArchiveMember } from "./archive-safety.js";
import { LLAMA_B10182_MACOS_ARM64_PIN } from "./llama-b10182-macos-arm64-pin.js";

const describeNative = process.env.SWITCHBOARD_ATOMIC_PUBLISH_TEST === "1" ? describe : describe.skip;
const roots: string[] = [];
const archivePath = "/private/tmp/llama-b10182-bin-macos-arm64.tar.gz";
const evidenceRoot = fileURLToPath(new URL("../../../../third_party/llama.cpp/b10182/macos-arm64/", import.meta.url));
const sourcePath = fileURLToPath(new URL("./unsigned-sidecar-assembler.ts", import.meta.url));
const pinPath = fileURLToPath(new URL("./llama-b10182-macos-arm64-pin.ts", import.meta.url));
const runtimeIndexPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const desktopSource = fileURLToPath(new URL("../../../../apps/desktop/src/", import.meta.url));
const daemonSource = fileURLToPath(new URL("../../../../apps/daemon/src/", import.meta.url));

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function sandbox(): Promise<string> { const root = await realpath(await mkdtemp(join(tmpdir(), "switchboard-sidecar-"))); await chmod(root, 0o700); roots.push(root); return root; }
function options(root: string, output: string) { return { archivePath, outputPath: join(root, output), memberManifestPath: join(evidenceRoot, "member-manifest.json"), sourceReceiptPath: join(evidenceRoot, "source-receipt.json"), noticePath: join(evidenceRoot, "NOTICE.md") }; }
async function collectTree(root: string, current = root, entries = new Map<string, { type: string; mode?: number; size?: number; sha256?: string; target?: string }>()): Promise<Map<string, { type: string; mode?: number; size?: number; sha256?: string; target?: string }>> { for (const name of await readdir(current)) { const path = join(current, name); const status = await lstat(path); const key = relative(root, path); if (status.isDirectory() && !status.isSymbolicLink()) { entries.set(key, { type: "directory", mode: status.mode & 0o7777 }); await collectTree(root, path, entries); } else if (status.isFile() && !status.isSymbolicLink()) entries.set(key, { type: "file", mode: status.mode & 0o7777, size: status.size, sha256: createHash("sha256").update(await readFile(path)).digest("hex") }); else if (status.isSymbolicLink()) entries.set(key, { type: "symlink", target: await (await import("node:fs/promises")).readlink(path) }); else throw new Error("Unexpected special test entry."); } return entries; }
function allFrozen(value: unknown): boolean { return value === null || typeof value !== "object" ? true : Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(allFrozen); }
function receiptKeys(value: unknown, keys = new Set<string>()): Set<string> { if (value !== null && typeof value === "object") for (const [key, nested] of Object.entries(value as Record<string, unknown>)) { keys.add(key); receiptKeys(nested, keys); } return keys; }
async function sourceFiles(root: string): Promise<string[]> { const results: string[] = []; for (const name of await readdir(root)) { const path = join(root, name); const status = await lstat(path); if (status.isDirectory()) results.push(...await sourceFiles(path)); else if (/\.tsx?$/u.test(name)) results.push(path); } return results; }
async function expectFailure(root: string, output: string, action: Promise<unknown>): Promise<void> { await expect(action).rejects.toThrow(); await expect(lstat(join(root, output))).rejects.toMatchObject({ code: "ENOENT" }); expect((await readdir(root)).filter((name) => name.startsWith("switchboard-sidecar-tmp-")).length).toBe(0); }

describeNative("unsigned sidecar assembler", () => {
  it("assembles two deterministic inactive 62-member sidecars with exact evidence", async () => {
    const root = await sandbox();
    const previousUmask = process.umask(0o077);
    let first; let second;
    try { first = await assemblePinnedLlamaB10182MacosArm64Sidecar(options(root, "sidecar-one")); second = await assemblePinnedLlamaB10182MacosArm64Sidecar(options(root, "sidecar-two")); } finally { process.umask(previousUmask); }
    expect(first.receipt).toEqual(second.receipt);
    for (const output of [first.outputPath, second.outputPath]) { const status = await lstat(output); expect(status.uid).toBe(process.getuid?.()); expect(status.mode & 0o7777).toBe(0o700); }
    expect((await lstat(first.payloadPath)).mode & 0o777).toBe(0o755);
    const manifest = JSON.parse(await readFile(join(evidenceRoot, "member-manifest.json"), "utf8")) as { members: { path: string; type: string; mode: number; size: number; sha256?: string; linkTarget?: string }[] };
    expect(manifest.members).toHaveLength(62);
    expect(manifest.members.filter((member) => member.type === "directory")).toHaveLength(1);
    expect(manifest.members.filter((member) => member.type === "file")).toHaveLength(43);
    expect(manifest.members.filter((member) => member.type === "symlink")).toHaveLength(18);
    const expectedEntries = new Set([...manifest.members.map((member) => member.path), "member-manifest.json", "source-receipt.json", "NOTICE.md", "switchboard-sidecar-assembly-receipt.json"]);
    const firstTree = await collectTree(first.outputPath); const secondTree = await collectTree(second.outputPath);
    expect([...firstTree.keys()].sort()).toEqual([...expectedEntries].sort()); expect(firstTree.size).toBe(66); expect(secondTree).toEqual(firstTree);
    for (const output of [first.outputPath, second.outputPath]) for (const member of manifest.members) {
      const path = join(output, member.path); const status = await lstat(path);
      expect(status.uid).toBe(process.getuid?.()); if (member.type === "directory") expect(status.isDirectory() && !status.isSymbolicLink()).toBe(true);
      else if (member.type === "file") { expect(status.isFile() && !status.isSymbolicLink()).toBe(true); expect(status.size).toBe(member.size); expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(member.sha256); }
      else { expect(status.isSymbolicLink()).toBe(true); expect(await (await import("node:fs/promises")).readlink(path)).toBe(member.linkTarget); }
      if (member.type !== "symlink") expect(status.mode & 0o7777).toBe(member.mode);
    }
    for (const name of ["member-manifest.json", "source-receipt.json", "NOTICE.md"]) {
      for (const output of [first.outputPath, second.outputPath]) { const status = await lstat(join(output, name)); expect(status.uid).toBe(process.getuid?.()); expect(status.isFile() && !status.isSymbolicLink()).toBe(true); expect(status.mode & 0o7777).toBe(0o600); await expect(readFile(join(output, name))).resolves.toEqual(await readFile(join(evidenceRoot, name))); }
    }
    const firstReceipt = await readFile(join(first.outputPath, "switchboard-sidecar-assembly-receipt.json"));
    const secondReceipt = await readFile(join(second.outputPath, "switchboard-sidecar-assembly-receipt.json"));
    expect(firstReceipt.equals(secondReceipt)).toBe(true); expect(first.receipt).toEqual(second.receipt);
    for (const output of [first.outputPath, second.outputPath]) { const status = await lstat(join(output, "switchboard-sidecar-assembly-receipt.json")); expect(status.uid).toBe(process.getuid?.()); expect(status.isFile() && !status.isSymbolicLink()).toBe(true); expect(status.mode & 0o7777).toBe(0o600); await expect(readFile(join(output, "switchboard-sidecar-assembly-receipt.json"), "utf8")).resolves.toBe(`${canonicalJson(first.receipt)}\n`); }
    expect(Object.keys(first)).toEqual(["outputPath", "payloadPath", "serverPath", "receipt"]);
    expect(first.receipt).toMatchObject({ signingRequired: true, notarizationRequired: true, activationAllowed: false, distributionAllowed: false, executed: false });
    expect(allFrozen(first.receipt)).toBe(true);
    expect([...receiptKeys(first.receipt)].filter((key) => ["outputPath", "stagingPath", "timestamp", "createdAt", "updatedAt", "inode", "dev", "signature", "signedAuthority", "activationToken"].includes(key))).toEqual([]);
    expect(Object.keys(first.receipt)).not.toEqual(expect.arrayContaining(["outputPath", "timestamp", "time", "inode", "signed"]));
  });

  it("rejects existing final entries and bad evidence before leaving a temporary directory", async () => {
    const root = await sandbox();
    for (const kind of ["file", "directory", "link"] as const) {
      const output = join(root, `existing-${kind}`);
      if (kind === "file") await writeFile(output, "original-file"); else if (kind === "directory") { await (await import("node:fs/promises")).mkdir(output); await writeFile(join(output, "sentinel"), "original-directory"); } else await symlink("missing-target", output);
      await expect(assemblePinnedLlamaB10182MacosArm64Sidecar({ ...options(root, `existing-${kind}`) })).rejects.toThrow(/already exists/u);
      if (kind === "file") await expect(readFile(output, "utf8")).resolves.toBe("original-file"); else if (kind === "directory") await expect(readFile(join(output, "sentinel"), "utf8")).resolves.toBe("original-directory"); else await expect(readlink(output)).resolves.toBe("missing-target");
    }
    const bad = join(root, "bad-notice"); await writeFile(bad, "bad");
    await expect(assemblePinnedLlamaB10182MacosArm64Sidecar({ ...options(root, "bad-evidence"), noticePath: bad })).rejects.toThrow(/Pinned assembly input|digest/u);
    expect((await (await import("node:fs/promises")).readdir(root)).filter((name) => name.startsWith("switchboard-sidecar-tmp-")).length).toBe(0);
  });

  it("rejects retained archive and each evidence mutation without residue", async () => {
    const root = await sandbox(); const archive = await readFile(archivePath);
    for (const [name, bytes] of [["truncated", archive.subarray(0, archive.length - 1)], ["flipped", Buffer.from(archive)] ] as const) {
      if (name === "flipped") bytes[0] = bytes[0]! ^ 1;
      const path = join(root, `${name}.tar.gz`); await writeFile(path, bytes);
      await expectFailure(root, `output-${name}`, assemblePinnedLlamaB10182MacosArm64Sidecar({ ...options(root, `output-${name}`), archivePath: path }));
    }
    for (const name of ["member-manifest.json", "source-receipt.json", "NOTICE.md"] as const) {
      const bytes = Buffer.from(await readFile(join(evidenceRoot, name))); bytes[0] = bytes[0]! ^ 1; const path = join(root, `mutated-${name}`); await writeFile(path, bytes);
      await expectFailure(root, `output-${name}`, assemblePinnedLlamaB10182MacosArm64Sidecar({ ...options(root, `output-${name}`), ...(name === "member-manifest.json" ? { memberManifestPath: path } : name === "source-receipt.json" ? { sourceReceiptPath: path } : { noticePath: path }) }));
    }
  });

  it("rejects output lexical and symlink boundaries without residue", async () => {
    const root = await sandbox(); const linked = join(root, "linked-parent"); await symlink(root, linked);
    for (const output of [`${root}/../escape`, `${root}//double`, `${root}/trailing/`, join(root, "é"), join(root, "a".repeat(129)), `${root}\0nul`, join(linked, "final")]) await expectFailure(root, "never", assemblePinnedLlamaB10182MacosArm64Sidecar({ ...options(root, "never"), outputPath: output }));
    const realAncestor = join(root, "real-ancestor"); const nested = join(realAncestor, "nested"); await (await import("node:fs/promises")).mkdir(nested, { recursive: true, mode: 0o700 }); const ancestorLink = join(root, "ancestor-link"); await symlink(realAncestor, ancestorLink);
    await expect(assemblePinnedLlamaB10182MacosArm64Sidecar({ ...options(root, "never"), outputPath: join(ancestorLink, "nested", "final") })).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name.startsWith("switchboard-sidecar-tmp-")).length).toBe(0);
  });

  it("rejects archive/evidence links and unsafe output parent modes", async () => {
    const root = await sandbox(); const archiveLink = join(root, "archive-link"); await symlink(archivePath, archiveLink);
    await expectFailure(root, "archive-link-output", assemblePinnedLlamaB10182MacosArm64Sidecar({ ...options(root, "archive-link-output"), archivePath: archiveLink }));
    const evidenceLink = join(root, "evidence-link"); await symlink(evidenceRoot, evidenceLink);
    await expectFailure(root, "evidence-link-output", assemblePinnedLlamaB10182MacosArm64Sidecar({ ...options(root, "evidence-link-output"), memberManifestPath: join(evidenceLink, "member-manifest.json"), sourceReceiptPath: join(evidenceLink, "source-receipt.json") }));
    try { for (const mode of [0o770, 0o707]) { await chmod(root, mode); await expectFailure(root, `mode-${mode}`, assemblePinnedLlamaB10182MacosArm64Sidecar(options(root, `mode-${mode}`))); } } finally { await chmod(root, 0o700); }
  });

  it("permits exactly one concurrent same-final assembler", async () => {
    const root = await sandbox(); const shared = options(root, "shared-final");
    const results = await Promise.allSettled([assemblePinnedLlamaB10182MacosArm64Sidecar(shared), assemblePinnedLlamaB10182MacosArm64Sidecar(shared)]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof assemblePinnedLlamaB10182MacosArm64Sidecar>>> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1); expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as { code?: string }).code).toBe("DESTINATION_EXISTS");
    expect((await lstat(join(root, "shared-final"))).isDirectory()).toBe(true);
    const manifest = JSON.parse(await readFile(join(evidenceRoot, "member-manifest.json"), "utf8")) as { members: { path: string }[] };
    const expected = new Set([...manifest.members.map((member) => member.path), "member-manifest.json", "source-receipt.json", "NOTICE.md", "switchboard-sidecar-assembly-receipt.json"]);
    const finalTree = await collectTree(join(root, "shared-final"));
    expect([...finalTree.keys()].sort()).toEqual([...expected].sort()); expect(finalTree.size).toBe(66);
    expect(JSON.parse(await readFile(join(root, "shared-final", "switchboard-sidecar-assembly-receipt.json"), "utf8"))).toEqual(fulfilled[0]!.value.receipt);
    expect((await readdir(root)).filter((name) => name.startsWith("switchboard-sidecar-tmp-")).length).toBe(0);
  });

  it("rejects adversarial archive-member matrices and binds canonical manifest variants", async () => {
    const root: SafeArchiveMember = { path: "runtime", type: "directory", mode: 0o755, size: 0 };
    const file = (): SafeArchiveMember => ({ path: "runtime/file", type: "file", mode: 0o644, size: 0, sha256: sha256("") });
    const invalid = [
      [{ ...file(), path: "/absolute" }], [{ ...file(), path: "../escape" }], [{ ...file(), path: "runtime\\escape" }], [{ ...file(), path: "runtime//escape" }], [{ ...file(), path: "runtime/./escape" }],
      [root, file(), file()], [{ ...file(), path: "other/file" }], [file()], [root, { ...file(), path: "runtime/missing/file" }],
      [root, { ...file(), type: "hardlink" as never }], [root, { ...file(), mode: 0o1000 }], [root, { ...file(), mode: 0o4755 }], [root, { ...file(), mode: 0o1000 + 0o777 }],
      [root, { path: "runtime/link", type: "symlink", mode: 0o755, size: 0, linkTarget: "/absolute" }], [root, { path: "runtime/link", type: "symlink", mode: 0o755, size: 0, linkTarget: "../escape" }], [root, { path: "runtime/link", type: "symlink", mode: 0o755, size: 0, linkTarget: "missing" }], [root, { path: "runtime/a", type: "symlink", mode: 0o755, size: 0, linkTarget: "b" }, { path: "runtime/b", type: "symlink", mode: 0o755, size: 0, linkTarget: "a" }], [root, file(), { path: "runtime/link", type: "symlink", mode: 0o755, size: 0, linkTarget: "file" }, { ...file(), path: "runtime/link/nested" }]
    ] satisfies SafeArchiveMember[][];
    for (const members of invalid) expect(() => validateArchiveMembers(members, "runtime")).toThrow(/unsafe|canonical|duplicate|root|parent|special|mode|link|target|cycle|nested/u);
    expect(() => validateArchiveMembers([root, file(), { path: "runtime/link", type: "symlink", mode: 0o755, size: 0, linkTarget: "file" }, { ...file(), path: "runtime/link/nested" }], "runtime")).toThrow(/nested.*symbolic link/u);
    const manifest = JSON.parse(await readFile(join(evidenceRoot, "member-manifest.json"), "utf8")) as { members: SafeArchiveMember[] } & Record<string, unknown>;
    expect(sha256(canonicalJson(manifest))).toBe(LLAMA_B10182_MACOS_ARM64_PIN.memberManifestCanonicalSha256);
    const unexpected: SafeArchiveMember = { path: "llama-b10182/unexpected", type: "file", mode: 0o644, size: 0, sha256: sha256("") };
    const variants = [
      { ...manifest, members: [...manifest.members, unexpected] },
      { ...manifest, members: manifest.members.slice(1) },
      { ...manifest, members: manifest.members.map((member, index) => index === 1 ? { ...member, mode: 0o755 } : member) }
    ];
    for (const variant of variants) expect(sha256(canonicalJson(variant))).not.toBe(LLAMA_B10182_MACOS_ARM64_PIN.memberManifestCanonicalSha256);
    validateArchiveMembers(variants[0]!.members, "llama-b10182");
    expect(() => validateArchiveMembers(variants[1]!.members, "llama-b10182")).toThrow(/root/u);
  });

});

describe("unsigned sidecar capability boundary", () => {
  it("contains no executable capability or public runtime export", async () => {
    const source = await readFile(sourcePath, "utf8");
    const pin = await readFile(pinPath, "utf8"); const runtimeIndex = await readFile(runtimeIndexPath, "utf8");
    expect(pin).not.toMatch(/^import /mu);
    expect(`${source}\n${pin}`).not.toMatch(/node:child_process|node:net|node:http|node:https|fetch\(|spawn\(|exec\(|execFile\(|copyFile|\bcp\(|clone\(/u);
    expect(runtimeIndex).not.toMatch(/unsigned-sidecar-assembler|atomic-publish/u);
    for (const file of [...await sourceFiles(desktopSource), ...await sourceFiles(daemonSource)]) expect(await readFile(file, "utf8")).not.toMatch(/unsigned-sidecar-assembler|atomic-publish/u);
  });
});
