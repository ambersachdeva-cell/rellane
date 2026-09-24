import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256, type RuntimeMemberManifest, type SafeArchiveMember } from "../acquisition/archive-safety.js";
import { LLAMA_B10182_MACOS_ARM64_PIN } from "../acquisition/llama-b10182-macos-arm64-pin.js";
import type { RuntimeCodeSignatureVerifier } from "./integrity.js";
import { verifySignedInactiveSidecarPackageCandidate, type SignedSidecarCandidateReceipt, type SignedSidecarPackageTrustAnchor } from "./signed-sidecar-package-contract.js";

const roots: string[] = [];
const evidenceRoot = fileURLToPath(new URL("../../../../third_party/llama.cpp/b10182/macos-arm64/", import.meta.url));
const contractPath = fileURLToPath(new URL("./signed-sidecar-package-contract.ts", import.meta.url));
const runtimeIndexPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const TASK_4E_RECEIPT_SHA256 = "9bad5a4f34893a1e25b842ab5e65037602ca77c06e3b667814ca6bbf226dbddf";

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class FakeSignatureVerifier implements RuntimeCodeSignatureVerifier {
  readonly calls: Array<{ path: string; identifier: string; team: string }> = [];
  constructor(private readonly fail = false) {}
  async verify(filePath: string, signingIdentifier: string, teamIdentifier: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.calls.push({ path: filePath, identifier: signingIdentifier, team: teamIdentifier });
    if (this.fail) throw new Error("synthetic signature rejection");
  }
}

interface Fixture {
  readonly root: string;
  readonly resources: string;
  readonly packageRoot: string;
  readonly signed: RuntimeMemberManifest;
  readonly trust: SignedSidecarPackageTrustAnchor;
  readonly candidate: SignedSidecarCandidateReceipt;
  readonly verifier: FakeSignatureVerifier;
}

async function sandbox(): Promise<string> { const root = await realpath(await mkdtemp(join(tmpdir(), "switchboard-signed-candidate-"))); await chmod(root, 0o700); roots.push(root); return root; }

/**
 * The upstream LICENSE bytes, retained in `third_party/` rather than extracted
 * from the 10.9 MB release archive at test time.
 *
 * These tests are about byte-level tampering, so the fixture has to be the real
 * upstream bytes and not a stand-in — but "real" is established by the pinned
 * hash, not by where the file came from. Reading it from the repo and checking
 * it against `licenseSha256` proves exactly what unpacking the archive proved,
 * and it proves it on a machine that has never downloaded anything.
 *
 * Retaining a dependency's licence text is also the thing its licence asks of
 * us, so this file has to exist here regardless.
 */
async function licenseBytes(): Promise<Buffer> {
  const license = await readFile(join(evidenceRoot, "LICENSE"));
  const actual = sha256(license);
  if (actual !== LLAMA_B10182_MACOS_ARM64_PIN.licenseSha256) {
    throw new Error(`Retained b10182 LICENSE is ${actual}, pinned at ${LLAMA_B10182_MACOS_ARM64_PIN.licenseSha256}.`);
  }
  return license;
}

function assemblyReceipt(): Record<string, unknown> {
  return {
    receiptVersion: 1, status: "assembled-inactive-unsigned", runtimeId: "llama.cpp", upstreamRepository: LLAMA_B10182_MACOS_ARM64_PIN.upstreamRepository, upstreamRepositoryUrl: LLAMA_B10182_MACOS_ARM64_PIN.upstreamRepositoryUrl, tag: "b10182", sourceCommit: LLAMA_B10182_MACOS_ARM64_PIN.sourceCommit,
    target: { platform: "darwin", architecture: "arm64", acceleration: ["cpu", "metal"] }, archive: { filename: LLAMA_B10182_MACOS_ARM64_PIN.archiveFilename, url: LLAMA_B10182_MACOS_ARM64_PIN.archiveUrl, bytes: LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes, expandedBytes: LLAMA_B10182_MACOS_ARM64_PIN.expandedArchiveBytes, sha256: LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256 },
    sourceReceipt: { name: "source-receipt.json", bytes: 1803, sha256: "86fcb867e97c26df469825ef2f4fdfe33db084ec13ed4250098f9d2c1db6c93d" }, memberManifest: { name: "member-manifest.json", bytes: 10165, fileSha256: "69db0370362224296af9886d6526f987125a798c65c5d4dfa91fef446fccff79", canonicalSha256: LLAMA_B10182_MACOS_ARM64_PIN.memberManifestCanonicalSha256, members: 62, types: { directories: 1, files: 43, symlinks: 18 }, modePolicy: "exact-source-manifest" },
    requiredPayload: { server: { path: LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath, size: 33472, mode: 0o755, sha256: LLAMA_B10182_MACOS_ARM64_PIN.serverSha256 }, license: { path: LLAMA_B10182_MACOS_ARM64_PIN.licenseRelativePath, size: 1078, mode: 0o644, sha256: LLAMA_B10182_MACOS_ARM64_PIN.licenseSha256 } },
    evidence: [{ name: "member-manifest.json", bytes: 10165, sha256: "69db0370362224296af9886d6526f987125a798c65c5d4dfa91fef446fccff79", mode: 0o600 }, { name: "source-receipt.json", bytes: 1803, sha256: "86fcb867e97c26df469825ef2f4fdfe33db084ec13ed4250098f9d2c1db6c93d", mode: 0o600 }, { name: "NOTICE.md", bytes: 1824, sha256: "617cf53f70354c48e0dac7c269af6efca9632115de5bf72902afb9e222aa157c", mode: 0o600 }],
    outerMode: 0o700, signingRequired: true, notarizationRequired: true, activationAllowed: false, distributionAllowed: false, executed: false
  };
}

function signedManifest(source: RuntimeMemberManifest): RuntimeMemberManifest {
  return { ...source, members: source.members.map((member) => {
    if (member.type !== "file" || (member.mode & 0o111) === 0 && !member.path.endsWith(".dylib")) return { ...member };
    const bytes = syntheticCode(member.path);
    return { ...member, size: bytes.byteLength, sha256: sha256(bytes) };
  }) };
}
function syntheticCode(path: string): Buffer { return Buffer.from(`synthetic signed code candidate:${path}\n`, "utf8"); }
function signedPaths(manifest: RuntimeMemberManifest): string[] { return manifest.members.filter((member) => member.type === "file" && ((member.mode & 0o111) !== 0 || member.path.endsWith(".dylib"))).map((member) => member.path).sort(); }

async function fixture(): Promise<Fixture> {
  const root = await sandbox();
  const resources = join(root, "Switchboard.app", "Contents", "Resources");
  const packageRoot = join(resources, "switchboard-runtime", "llama.cpp", "b10182", "darwin-arm64");
  await mkdir(packageRoot, { recursive: true, mode: 0o700 }); await chmod(packageRoot, 0o700);
  const sourceBytes = await readFile(join(evidenceRoot, "member-manifest.json"));
  const source = JSON.parse(sourceBytes.toString("utf8")) as RuntimeMemberManifest;
  const signed = signedManifest(source);
  const license = await licenseBytes();
  for (const member of signed.members) {
    const path = join(packageRoot, ...member.path.split("/"));
    if (member.type === "directory") { await mkdir(path, { mode: member.mode }); await chmod(path, member.mode); }
    else if (member.type === "symlink") await symlink(member.linkTarget!, path);
    else { const bytes = member.path.endsWith("LICENSE") ? license : syntheticCode(member.path); await writeFile(path, bytes, { mode: member.mode }); await chmod(path, member.mode); }
  }
  const assembly = assemblyReceipt();
  const signedMemberPaths = signedPaths(signed);
  const server = signed.members.find((member) => member.path === LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath)!;
  const candidate: SignedSidecarCandidateReceipt = {
    receiptVersion: 1, status: "signed-inactive-notarization-required", runtimeId: "llama.cpp", tag: "b10182", sourceCommit: LLAMA_B10182_MACOS_ARM64_PIN.sourceCommit, target: "darwin-arm64", assemblyReceiptSha256: sha256(Buffer.from(`${canonicalJson(assembly)}\n`, "utf8")), sourceMemberManifestCanonicalSha256: sha256(canonicalJson(source)), signedMemberManifestCanonicalSha256: sha256(canonicalJson(signed)), serverSha256: server.sha256!, signingIdentifier: "com.switchboard.runtime.llama", teamIdentifier: "ABCDE12345", signedMemberPaths, notarizationRequired: true, healthProbeRequired: true, activationAllowed: false, distributionAllowed: false, executed: false
  };
  await writeExact(join(packageRoot, "member-manifest.json"), sourceBytes, 0o600);
  await writeExact(join(packageRoot, "source-receipt.json"), await readFile(join(evidenceRoot, "source-receipt.json")), 0o600);
  await writeExact(join(packageRoot, "NOTICE.md"), await readFile(join(evidenceRoot, "NOTICE.md")), 0o600);
  await writeExact(join(packageRoot, "switchboard-sidecar-assembly-receipt.json"), Buffer.from(`${canonicalJson(assembly)}\n`, "utf8"), 0o600);
  await writeExact(join(packageRoot, "switchboard-runtime-signed-member-manifest.json"), Buffer.from(`${canonicalJson(signed)}\n`, "utf8"), 0o600);
  await writeExact(join(packageRoot, "switchboard-runtime-signed-candidate-receipt.json"), Buffer.from(`${canonicalJson(candidate)}\n`, "utf8"), 0o600);
  const trust: SignedSidecarPackageTrustAnchor = { assemblyReceiptSha256: TASK_4E_RECEIPT_SHA256, candidateReceiptCanonicalSha256: sha256(canonicalJson(candidate)), signingIdentifier: candidate.signingIdentifier, teamIdentifier: candidate.teamIdentifier, signedMemberPaths };
  expect(candidate.assemblyReceiptSha256).toBe(TASK_4E_RECEIPT_SHA256);
  return { root, resources, packageRoot, signed, trust, candidate, verifier: new FakeSignatureVerifier() };
}

async function writeExact(path: string, bytes: Buffer, mode: number): Promise<void> { await writeFile(path, bytes, { mode }); await chmod(path, mode); }
function allFrozen(value: unknown): boolean { return value === null || typeof value !== "object" ? true : Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(allFrozen); }
async function verify(input: Fixture, extra: Partial<Parameters<typeof verifySignedInactiveSidecarPackageCandidate>[0]> = {}) { return verifySignedInactiveSidecarPackageCandidate({ resourcesDirectory: input.resources, trustAnchor: input.trust, codeSignatureVerifier: input.verifier, ...extra }); }

describe("signed inactive sidecar package candidate contract", () => {
  it("accepts two deterministic exact-62-member synthetic signed candidates without promotion", async () => {
    const first = await fixture(); const second = await fixture();
    const firstCandidate = await verify(first); const secondCandidate = await verify(second);
    expect(firstCandidate.receipt).toEqual(secondCandidate.receipt);
    expect(firstCandidate.signedManifest).toEqual(secondCandidate.signedManifest);
    expect(firstCandidate.signedManifest.members).toHaveLength(62);
    expect(firstCandidate.receipt).toMatchObject({ status: "signed-inactive-notarization-required", notarizationRequired: true, healthProbeRequired: true, activationAllowed: false, distributionAllowed: false, executed: false });
    expect(first.verifier.calls.map((call) => call.path).sort()).toEqual(first.candidate.signedMemberPaths.map((path) => join(first.packageRoot, ...path.split("/"))).sort());
    expect(first.verifier.calls.every((call) => call.identifier === "com.switchboard.runtime.llama" && call.team === "ABCDE12345")).toBe(true);
    expect(allFrozen(firstCandidate)).toBe(true);
    expect(Object.keys(firstCandidate).sort()).toEqual(["packageRoot", "payloadDirectory", "receipt", "resourcesDirectory", "serverPath", "signedManifest", "sourceManifest"]);
  });

  it("fails closed for evidence, receipt-anchor, signed-path, identity, and signature tampering", async () => {
    const badEvidence = await fixture(); await writeExact(join(badEvidence.packageRoot, "NOTICE.md"), Buffer.from("tampered"), 0o600); await expect(verify(badEvidence)).rejects.toThrow();
    const badAnchor = await fixture(); await expect(verify(badAnchor, { trustAnchor: { ...badAnchor.trust, assemblyReceiptSha256: "0".repeat(64) } })).rejects.toThrow();
    const badSignedPaths = await fixture(); const forged = { ...badSignedPaths.candidate, signedMemberPaths: [...badSignedPaths.candidate.signedMemberPaths, "llama-b10182/LICENSE"] }; await writeExact(join(badSignedPaths.packageRoot, "switchboard-runtime-signed-candidate-receipt.json"), Buffer.from(`${canonicalJson(forged)}\n`), 0o600); await expect(verify(badSignedPaths)).rejects.toThrow();
    const badIdentity = await fixture(); await expect(verify(badIdentity, { trustAnchor: { ...badIdentity.trust, teamIdentifier: "ZZZZZ99999" } })).rejects.toThrow();
    const badSignature = await fixture(); await expect(verify(badSignature, { codeSignatureVerifier: new FakeSignatureVerifier(true) })).rejects.toThrow(/synthetic signature rejection/u);
  });

  it("rejects a same-size same-mode executable byte mutation before signature verification", async () => {
    const changed = await fixture();
    const serverPath = join(changed.packageRoot, "llama-b10182", "llama-server");
    const bytes = await readFile(serverPath);
    bytes[0] = bytes[0]! ^ 1;
    await writeExact(serverPath, bytes, 0o755);

    await expect(verify(changed)).rejects.toThrow(/regular file does not match/u);
    expect((await lstat(serverPath)).size).toBe(bytes.byteLength);
    expect((await lstat(serverPath)).mode & 0o7777).toBe(0o755);
    expect(changed.verifier.calls).toEqual([]);
  });

  it("rejects package aliases, partial and unexpected trees, special-looking layout changes, bad modes, and hard links", async () => {
    const alias = await fixture(); const linked = join(alias.root, "Resources-link"); await symlink(alias.resources, linked); await expect(verify(alias, { resourcesDirectory: linked })).rejects.toThrow();
    const partial = await fixture(); await unlink(join(partial.packageRoot, "llama-b10182", "llama-server")); await expect(verify(partial)).rejects.toThrow();
    const extra = await fixture(); await writeFile(join(extra.packageRoot, "unexpected"), "x"); await expect(verify(extra)).rejects.toThrow();
    const mode = await fixture(); await chmod(join(mode.packageRoot, "llama-b10182", "llama-server"), 0o644); await expect(verify(mode)).rejects.toThrow();
    const hard = await fixture(); const notice = join(hard.packageRoot, "NOTICE.md"); const copied = join(hard.packageRoot, "notice-copy"); await rename(notice, copied); await link(copied, notice); await expect(verify(hard)).rejects.toThrow();
  });

  it("rejects manifest layout changes, link retargeting, and final replacement races", async () => {
    const layout = await fixture(); const signedPath = join(layout.packageRoot, "switchboard-runtime-signed-member-manifest.json"); const manifest = JSON.parse(await readFile(signedPath, "utf8")) as RuntimeMemberManifest; manifest.members[0] = { ...manifest.members[0]!, path: "llama-b10182-renamed" }; await writeExact(signedPath, Buffer.from(`${canonicalJson(manifest)}\n`), 0o600); await expect(verify(layout)).rejects.toThrow();
    const retarget = await fixture(); const linkPath = join(retarget.packageRoot, "llama-b10182", "libggml-base.0.dylib"); await unlink(linkPath); await symlink("LICENSE", linkPath); await expect(verify(retarget)).rejects.toThrow();
    const traversal = await fixture(); const traversalPath = join(traversal.packageRoot, "switchboard-runtime-signed-member-manifest.json"); const traversalManifest = JSON.parse(await readFile(traversalPath, "utf8")) as RuntimeMemberManifest; traversalManifest.members[1] = { ...traversalManifest.members[1]!, path: "../escape" }; await writeExact(traversalPath, Buffer.from(`${canonicalJson(traversalManifest)}\n`), 0o600); await expect(verify(traversal)).rejects.toThrow();
    const duplicate = await fixture(); const duplicatePath = join(duplicate.packageRoot, "switchboard-runtime-signed-member-manifest.json"); const duplicateManifest = JSON.parse(await readFile(duplicatePath, "utf8")) as RuntimeMemberManifest; duplicateManifest.members[1] = { ...duplicateManifest.members[1]!, path: duplicateManifest.members[0]!.path }; await writeExact(duplicatePath, Buffer.from(`${canonicalJson(duplicateManifest)}\n`), 0o600); await expect(verify(duplicate)).rejects.toThrow();
    const race = await fixture(); const serverPath = join(race.packageRoot, "llama-b10182", "llama-server"); await expect(verify(race, { beforeFinalPathRevalidation: async () => { const saved = join(race.root, "saved-server"); await rename(serverPath, saved); await writeFile(serverPath, await readFile(saved), { mode: 0o755 }); await chmod(serverPath, 0o755); } })).rejects.toThrow(/replaced/u);
  });

  it("has no public runtime reachability or execution/network capability", async () => {
    const [source, runtimeIndex] = await Promise.all([readFile(contractPath, "utf8"), readFile(runtimeIndexPath, "utf8")]);
    expect(source).not.toMatch(/node:(?:child_process|net|http|https)|activation-provenance|\b(?:spawn|exec|execFile|fork)\s*\(|fetch\(/u);
    expect(runtimeIndex).not.toMatch(/signed-sidecar-package-contract/u);
  });
});
