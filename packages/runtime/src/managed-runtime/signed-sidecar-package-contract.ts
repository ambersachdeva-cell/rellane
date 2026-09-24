import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  canonicalJson,
  sha256,
  validateArchiveMembers,
  type RuntimeMemberManifest,
  type SafeArchiveMember
} from "../acquisition/archive-safety.js";
import { LLAMA_B10182_MACOS_ARM64_PIN } from "../acquisition/llama-b10182-macos-arm64-pin.js";
import type { RuntimeCodeSignatureVerifier } from "./integrity.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SIGNING_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u;
const TEAM_IDENTIFIER = /^[A-Z0-9]{10}$/u;
const PACKAGE_SEGMENTS = Object.freeze(["switchboard-runtime", "llama.cpp", "b10182", "darwin-arm64"] as const);
const EVIDENCE = Object.freeze({
  "member-manifest.json": Object.freeze({ bytes: 10165, sha256: "69db0370362224296af9886d6526f987125a798c65c5d4dfa91fef446fccff79" }),
  "source-receipt.json": Object.freeze({ bytes: 1803, sha256: "86fcb867e97c26df469825ef2f4fdfe33db084ec13ed4250098f9d2c1db6c93d" }),
  "NOTICE.md": Object.freeze({ bytes: 1824, sha256: "617cf53f70354c48e0dac7c269af6efca9632115de5bf72902afb9e222aa157c" })
});
const ASSEMBLY_RECEIPT = "switchboard-sidecar-assembly-receipt.json";
const SIGNED_MANIFEST = "switchboard-runtime-signed-member-manifest.json";
const CANDIDATE_RECEIPT = "switchboard-runtime-signed-candidate-receipt.json";
const MAX_JSON_BYTES = 128 * 1024;
const MAX_PAYLOAD_MEMBER_BYTES = 16 * 1024 * 1024;
const MAX_PAYLOAD_FILE_BYTES = 64 * 1024 * 1024;

export interface SignedSidecarPackageTrustAnchor {
  /** SHA-256 of the exact Task 4E assembly receipt bytes, supplied by this app build. */
  readonly assemblyReceiptSha256: string;
  /** SHA-256 of canonical candidate receipt JSON, supplied by this app build. */
  readonly candidateReceiptCanonicalSha256: string;
  readonly signingIdentifier: string;
  readonly teamIdentifier: string;
  /** The complete sorted code-member set expected by this app build. */
  readonly signedMemberPaths: readonly string[];
}

export interface SignedSidecarPackageContractOptions {
  /** Canonical absolute Contents/Resources directory of the future app bundle. */
  readonly resourcesDirectory: string;
  readonly trustAnchor: SignedSidecarPackageTrustAnchor;
  /** Required injection: this module never invokes codesign or a child process. */
  readonly codeSignatureVerifier: RuntimeCodeSignatureVerifier;
  /** Test-only race seam; final identities are always checked after it returns. */
  readonly beforeFinalPathRevalidation?: () => void | Promise<void>;
}

export interface SignedSidecarCandidateReceipt {
  readonly receiptVersion: 1;
  readonly status: "signed-inactive-notarization-required";
  readonly runtimeId: "llama.cpp";
  readonly tag: "b10182";
  readonly sourceCommit: string;
  readonly target: "darwin-arm64";
  readonly assemblyReceiptSha256: string;
  readonly sourceMemberManifestCanonicalSha256: string;
  readonly signedMemberManifestCanonicalSha256: string;
  readonly serverSha256: string;
  readonly signingIdentifier: string;
  readonly teamIdentifier: string;
  readonly signedMemberPaths: readonly string[];
  readonly notarizationRequired: true;
  readonly healthProbeRequired: true;
  readonly activationAllowed: false;
  readonly distributionAllowed: false;
  readonly executed: false;
}

export interface SignedSidecarPackageCandidate {
  readonly resourcesDirectory: string;
  readonly packageRoot: string;
  readonly payloadDirectory: string;
  readonly serverPath: string;
  readonly sourceManifest: RuntimeMemberManifest;
  readonly signedManifest: RuntimeMemberManifest;
  readonly receipt: SignedSidecarCandidateReceipt;
}

interface AssemblyReceipt {
  readonly receiptVersion: 1;
  readonly status: "assembled-inactive-unsigned";
  readonly runtimeId: "llama.cpp";
  readonly upstreamRepository: string;
  readonly upstreamRepositoryUrl: string;
  readonly tag: "b10182";
  readonly sourceCommit: string;
  readonly target: { readonly platform: "darwin"; readonly architecture: "arm64"; readonly acceleration: readonly ["cpu", "metal"] };
  readonly archive: { readonly filename: string; readonly url: string; readonly bytes: number; readonly expandedBytes: number; readonly sha256: string };
  readonly sourceReceipt: { readonly name: "source-receipt.json"; readonly bytes: 1803; readonly sha256: string };
  readonly memberManifest: { readonly name: "member-manifest.json"; readonly bytes: 10165; readonly fileSha256: string; readonly canonicalSha256: string; readonly members: 62; readonly types: { readonly directories: 1; readonly files: 43; readonly symlinks: 18 }; readonly modePolicy: "exact-source-manifest" };
  readonly requiredPayload: { readonly server: { readonly path: string; readonly size: 33472; readonly mode: 0o755; readonly sha256: string }; readonly license: { readonly path: string; readonly size: 1078; readonly mode: 0o644; readonly sha256: string } };
  readonly evidence: readonly { readonly name: string; readonly bytes: number; readonly sha256: string; readonly mode: 0o600 }[];
  readonly outerMode: 0o700;
  readonly signingRequired: true;
  readonly notarizationRequired: true;
  readonly activationAllowed: false;
  readonly distributionAllowed: false;
  readonly executed: false;
}

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly nlink: bigint;
  readonly type: "file" | "directory" | "symlink";
  readonly linkTarget?: string;
}

/**
 * Verifies a pre-signed package candidate only. This is deliberately not an
 * activation, distribution, notarization, health, execution, or registration API.
 */
export async function verifySignedInactiveSidecarPackageCandidate(
  options: SignedSidecarPackageContractOptions
): Promise<SignedSidecarPackageCandidate> {
  requireDarwinArm64();
  const trust = validateTrustAnchor(options.trustAnchor);
  if (options.codeSignatureVerifier === undefined || typeof options.codeSignatureVerifier.verify !== "function") {
    throw new Error("A package candidate requires an injected code-signature verifier.");
  }
  const resourcesDirectory = await canonicalDirectory(options.resourcesDirectory, "Resources directory");
  const packageRoot = join(resourcesDirectory, ...PACKAGE_SEGMENTS);
  await assertCanonicalDirectoryPath(packageRoot, "package root");
  const packageIdentity = await identityFor(packageRoot);
  if (packageIdentity.type !== "directory" || Number(packageIdentity.mode & 0o7777n) !== 0o700) {
    throw new Error("The signed sidecar package root is not an exact private directory.");
  }

  const paths = Object.freeze({
    sourceManifest: join(packageRoot, "member-manifest.json"),
    sourceReceipt: join(packageRoot, "source-receipt.json"),
    notice: join(packageRoot, "NOTICE.md"),
    assemblyReceipt: join(packageRoot, ASSEMBLY_RECEIPT),
    signedManifest: join(packageRoot, SIGNED_MANIFEST),
    candidateReceipt: join(packageRoot, CANDIDATE_RECEIPT)
  });
  const sourceManifestBytes = await readStableRegular(paths.sourceManifest, EVIDENCE["member-manifest.json"].bytes);
  const sourceReceiptBytes = await readStableRegular(paths.sourceReceipt, EVIDENCE["source-receipt.json"].bytes);
  const noticeBytes = await readStableRegular(paths.notice, EVIDENCE["NOTICE.md"].bytes);
  const assemblyReceiptBytes = await readStableRegular(paths.assemblyReceipt, MAX_JSON_BYTES);
  const signedManifestBytes = await readStableRegular(paths.signedManifest, MAX_JSON_BYTES);
  const candidateReceiptBytes = await readStableRegular(paths.candidateReceipt, MAX_JSON_BYTES);

  assertDigest(sourceManifestBytes.bytes, EVIDENCE["member-manifest.json"].sha256, "source manifest");
  assertDigest(sourceReceiptBytes.bytes, EVIDENCE["source-receipt.json"].sha256, "source receipt");
  assertDigest(noticeBytes.bytes, EVIDENCE["NOTICE.md"].sha256, "NOTICE");
  assertDigest(assemblyReceiptBytes.bytes, trust.assemblyReceiptSha256, "assembly receipt");

  const sourceManifest = parseManifest(sourceManifestBytes.bytes, "source manifest");
  if (sha256(canonicalJson(sourceManifest)) !== LLAMA_B10182_MACOS_ARM64_PIN.memberManifestCanonicalSha256) {
    throw new Error("The source manifest is not the exact b10182 canonical manifest pin.");
  }
  assertExactSourceManifest(sourceManifest);
  const sourceReceipt = parseJson(sourceReceiptBytes.bytes, "source receipt");
  if (canonicalJson(sourceReceipt) !== canonicalJson(expectedSourceReceipt())) {
    throw new Error("The source receipt does not match the exact b10182 source pin.");
  }
  const assemblyReceipt = parseAssemblyReceipt(assemblyReceiptBytes.bytes);
  assertAssemblyReceipt(assemblyReceipt, sourceManifestBytes.bytes, sourceReceiptBytes.bytes, noticeBytes.bytes);
  if (!assemblyReceiptBytes.bytes.equals(Buffer.from(`${canonicalJson(assemblyReceipt)}\n`, "utf8"))) {
    throw new Error("The assembly receipt is not canonical Task 4E evidence.");
  }

  const signedManifest = parseManifest(signedManifestBytes.bytes, "signed manifest");
  assertSignedLayout(sourceManifest, signedManifest);
  const candidateReceipt = parseCandidateReceipt(candidateReceiptBytes.bytes);
  assertCandidateReceipt(candidateReceipt, trust, assemblyReceiptBytes.bytes, sourceManifest, signedManifest);
  if (sha256(canonicalJson(candidateReceipt)) !== trust.candidateReceiptCanonicalSha256) {
    throw new Error("The candidate receipt is not anchored by this app build.");
  }
  if (!candidateReceiptBytes.bytes.equals(Buffer.from(`${canonicalJson(candidateReceipt)}\n`, "utf8"))) {
    throw new Error("The signed candidate receipt is not canonical evidence.");
  }

  const identities = await verifyExactTree(packageRoot, sourceManifest, signedManifest, paths, assemblyReceipt, candidateReceipt);
  const signal = new AbortController().signal;
  for (const path of trust.signedMemberPaths) {
    await options.codeSignatureVerifier.verify(join(packageRoot, ...path.split("/")), trust.signingIdentifier, trust.teamIdentifier, signal);
  }
  await options.beforeFinalPathRevalidation?.();
  await assertCanonicalDirectoryPath(packageRoot, "package root");
  await assertIdentity(packageRoot, packageIdentity);
  for (const [path, identity] of identities) await assertIdentity(path, identity);
  await verifyExactTree(packageRoot, sourceManifest, signedManifest, paths, assemblyReceipt, candidateReceipt);

  return deepFreeze({
    resourcesDirectory,
    packageRoot,
    payloadDirectory: join(packageRoot, LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot),
    serverPath: join(packageRoot, LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath),
    sourceManifest,
    signedManifest,
    receipt: candidateReceipt
  });
}

function requireDarwinArm64(): void {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Signed sidecar package candidates are supported only on darwin/arm64.");
}

function validateTrustAnchor(value: SignedSidecarPackageTrustAnchor): SignedSidecarPackageTrustAnchor {
  if (!isRecord(value) || !SHA256.test(value.assemblyReceiptSha256) || !SHA256.test(value.candidateReceiptCanonicalSha256) || !SIGNING_IDENTIFIER.test(value.signingIdentifier) || !TEAM_IDENTIFIER.test(value.teamIdentifier) || !Array.isArray(value.signedMemberPaths) || value.signedMemberPaths.length === 0 || !sameSortedUnique(value.signedMemberPaths, value.signedMemberPaths)) throw new Error("The signed package build trust anchor is malformed.");
  for (const path of value.signedMemberPaths) if (typeof path !== "string" || !isMemberPath(path)) throw new Error("The signed package build trust anchor has an invalid member path.");
  return value;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  if (!isCanonicalAbsolute(path)) throw new Error(`${label} must be a canonical absolute path.`);
  await assertCanonicalDirectoryPath(path, label);
  return path;
}

async function assertCanonicalDirectoryPath(path: string, label: string): Promise<void> {
  if (!isCanonicalAbsolute(path)) throw new Error(`${label} must be a canonical absolute path.`);
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} has a symlink or alias ancestor.`);
  const segments = path.split("/").filter(Boolean);
  let current = "/";
  for (const segment of segments) {
    current = join(current, segment);
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`${label} has a non-directory or symbolic-link ancestor.`);
  }
}

function isCanonicalAbsolute(path: string): boolean { return typeof path === "string" && path.length > 1 && !path.includes("\0") && isAbsolute(path) && resolve(path) === path; }

async function readStableRegular(path: string, maximumBytes: number): Promise<{ readonly bytes: Buffer; readonly identity: Identity }> {
  if (!isCanonicalAbsolute(path) || basename(path).length > 128) throw new Error("Package evidence path is invalid.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = identityFromStats(await handle.stat({ bigint: true }));
    if (before.type !== "file" || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximumBytes)) throw new Error("Package evidence is not a bounded unlinked regular file.");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) throw new Error("Package evidence changed while it was being read.");
      offset += result.bytesRead;
    }
    const probe = Buffer.alloc(1);
    if ((await handle.read(probe, 0, 1, bytes.byteLength)).bytesRead !== 0) throw new Error("Package evidence changed while it was being read.");
    const after = identityFromStats(await handle.stat({ bigint: true }));
    const named = await identityFor(path);
    if (!sameIdentity(before, after) || !sameIdentity(before, named)) throw new Error("Package evidence changed while it was being read.");
    return Object.freeze({ bytes, identity: before });
  } finally { await handle.close(); }
}

function parseManifest(bytes: Buffer, label: string): RuntimeMemberManifest {
  const parsed = parseJson(bytes, label);
  if (!isRecord(parsed) || !exactKeys(parsed, ["schemaVersion", "archiveSha256", "payloadRoot", "members"]) || parsed.schemaVersion !== 1 || typeof parsed.archiveSha256 !== "string" || typeof parsed.payloadRoot !== "string" || !Array.isArray(parsed.members)) throw new Error(`The ${label} has an invalid shape.`);
  const manifest = parsed as unknown as RuntimeMemberManifest;
  validateArchiveMembers(manifest.members, LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot);
  return manifest;
}

function parseAssemblyReceipt(bytes: Buffer): AssemblyReceipt { return parseJson(bytes, "assembly receipt") as AssemblyReceipt; }
function parseCandidateReceipt(bytes: Buffer): SignedSidecarCandidateReceipt { return parseJson(bytes, "candidate receipt") as SignedSidecarCandidateReceipt; }
function parseJson(bytes: Buffer, label: string): unknown { try { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (text.includes("\0")) throw new Error(); return JSON.parse(text); } catch { throw new Error(`The ${label} is not valid UTF-8 JSON.`); } }

function assertExactSourceManifest(manifest: RuntimeMemberManifest): void {
  if (manifest.schemaVersion !== 1 || manifest.archiveSha256 !== LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256 || manifest.payloadRoot !== LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot || manifest.members.length !== 62) throw new Error("The source manifest is not the exact b10182 layout.");
  const counts = countTypes(manifest.members);
  if (counts.directories !== 1 || counts.files !== 43 || counts.symlinks !== 18) throw new Error("The source manifest has the wrong b10182 member distribution.");
}

function assertAssemblyReceipt(receipt: AssemblyReceipt, manifestBytes: Buffer, sourceReceiptBytes: Buffer, noticeBytes: Buffer): void {
  const expected = expectedAssemblyReceipt();
  if (canonicalJson(receipt) !== canonicalJson(expected)) throw new Error("The assembly receipt is not exact accepted Task 4E provenance.");
  const evidence = new Map(receipt.evidence.map((entry) => [entry.name, entry]));
  if (evidence.size !== 3 || evidence.get("member-manifest.json")?.sha256 !== sha256(manifestBytes) || evidence.get("source-receipt.json")?.sha256 !== sha256(sourceReceiptBytes) || evidence.get("NOTICE.md")?.sha256 !== sha256(noticeBytes)) throw new Error("The Task 4E evidence list does not bind the package evidence.");
}

function assertSignedLayout(source: RuntimeMemberManifest, signed: RuntimeMemberManifest): void {
  if (signed.schemaVersion !== 1 || signed.archiveSha256 !== source.archiveSha256 || signed.payloadRoot !== source.payloadRoot || signed.members.length !== 62) throw new Error("The signed manifest does not retain the exact source identity.");
  const signedByPath = new Map<string, SafeArchiveMember>();
  for (const member of signed.members) { if (signedByPath.has(member.path)) throw new Error("The signed manifest has duplicate paths."); signedByPath.set(member.path, member); }
  let totalFileBytes = 0;
  for (const original of source.members) {
    const candidate = signedByPath.get(original.path);
    if (candidate === undefined || candidate.type !== original.type || candidate.mode !== original.mode || candidate.linkTarget !== original.linkTarget) throw new Error("The signed manifest changed its source member layout.");
    if (original.type !== "file" && candidate.size !== 0) throw new Error("The signed manifest has invalid non-file metadata.");
    if (original.type === "file" && !isCodeMember(original) && (candidate.size !== original.size || candidate.sha256 !== original.sha256)) throw new Error("A non-code member changed after signing.");
    if (candidate.type === "file") {
      if (!SHA256.test(candidate.sha256 ?? "") || !Number.isSafeInteger(candidate.size) || candidate.size < 1 || candidate.size > MAX_PAYLOAD_MEMBER_BYTES) throw new Error("The signed manifest has invalid regular-file metadata.");
      totalFileBytes += candidate.size;
      if (!Number.isSafeInteger(totalFileBytes) || totalFileBytes > MAX_PAYLOAD_FILE_BYTES) throw new Error("The signed manifest exceeds the package file-size limit.");
    }
  }
}

function assertCandidateReceipt(receipt: SignedSidecarCandidateReceipt, trust: SignedSidecarPackageTrustAnchor, assemblyReceiptBytes: Buffer, source: RuntimeMemberManifest, signed: RuntimeMemberManifest): void {
  if (!isRecord(receipt) || !exactKeys(receipt, ["receiptVersion", "status", "runtimeId", "tag", "sourceCommit", "target", "assemblyReceiptSha256", "sourceMemberManifestCanonicalSha256", "signedMemberManifestCanonicalSha256", "serverSha256", "signingIdentifier", "teamIdentifier", "signedMemberPaths", "notarizationRequired", "healthProbeRequired", "activationAllowed", "distributionAllowed", "executed"])) throw new Error("The candidate receipt has an invalid shape.");
  const signedPaths = codeMemberPaths(signed);
  const server = signed.members.find((member) => member.path === LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath);
  if (receipt.receiptVersion !== 1 || receipt.status !== "signed-inactive-notarization-required" || receipt.runtimeId !== "llama.cpp" || receipt.tag !== "b10182" || receipt.sourceCommit !== LLAMA_B10182_MACOS_ARM64_PIN.sourceCommit || receipt.target !== "darwin-arm64" || receipt.assemblyReceiptSha256 !== sha256(assemblyReceiptBytes) || receipt.sourceMemberManifestCanonicalSha256 !== sha256(canonicalJson(source)) || receipt.signedMemberManifestCanonicalSha256 !== sha256(canonicalJson(signed)) || receipt.serverSha256 !== server?.sha256 || receipt.signingIdentifier !== trust.signingIdentifier || receipt.teamIdentifier !== trust.teamIdentifier || !sameSortedUnique(receipt.signedMemberPaths, signedPaths) || !sameSortedUnique(trust.signedMemberPaths, signedPaths) || receipt.notarizationRequired !== true || receipt.healthProbeRequired !== true || receipt.activationAllowed !== false || receipt.distributionAllowed !== false || receipt.executed !== false) throw new Error("The signed candidate receipt is not a truthful, anchored inactive package candidate.");
}

async function verifyExactTree(packageRoot: string, source: RuntimeMemberManifest, signed: RuntimeMemberManifest, paths: Readonly<Record<string, string>>, assembly: AssemblyReceipt, candidate: SignedSidecarCandidateReceipt): Promise<Map<string, Identity>> {
  const expected = new Set([...source.members.map((member) => member.path), "member-manifest.json", "source-receipt.json", "NOTICE.md", ASSEMBLY_RECEIPT, SIGNED_MANIFEST, CANDIDATE_RECEIPT]);
  const observed = await listTreeNoFollow(packageRoot);
  if (observed.size !== expected.size || [...observed].some((path) => !expected.has(path))) throw new Error("The signed package has missing or unexpected members.");
  const identities = new Map<string, Identity>();
  for (const member of signed.members) {
    const path = memberPath(packageRoot, member.path);
    const identity = await identityFor(path);
    if (member.type === "directory") {
      if (identity.type !== "directory" || Number(identity.mode & 0o7777n) !== member.mode) throw new Error("A signed package directory does not match its manifest.");
    } else if (member.type === "symlink") {
      if (identity.type !== "symlink" || identity.linkTarget !== member.linkTarget) throw new Error("A signed package symbolic link does not match its manifest.");
    } else {
      if (identity.type !== "file" || identity.nlink !== 1n || Number(identity.mode & 0o7777n) !== member.mode || identity.size !== BigInt(member.size) || sha256((await readStableRegular(path, Number(identity.size))).bytes) !== member.sha256) throw new Error("A signed package regular file does not match its manifest.");
    }
    identities.set(path, identity);
  }
  const evidenceExpected: readonly [string, Buffer, number][] = [["member-manifest.json", Buffer.alloc(0), 0o600], ["source-receipt.json", Buffer.alloc(0), 0o600], ["NOTICE.md", Buffer.alloc(0), 0o600], [ASSEMBLY_RECEIPT, Buffer.from(`${canonicalJson(assembly)}\n`, "utf8"), 0o600], [SIGNED_MANIFEST, Buffer.from(`${canonicalJson(signed)}\n`, "utf8"), 0o600], [CANDIDATE_RECEIPT, Buffer.from(`${canonicalJson(candidate)}\n`, "utf8"), 0o600]];
  for (const [name, expectedBytes, mode] of evidenceExpected) {
    const path = paths[name === "member-manifest.json" ? "sourceManifest" : name === "source-receipt.json" ? "sourceReceipt" : name === "NOTICE.md" ? "notice" : name === ASSEMBLY_RECEIPT ? "assemblyReceipt" : name === SIGNED_MANIFEST ? "signedManifest" : "candidateReceipt"]!;
    const item = await readStableRegular(path, MAX_JSON_BYTES);
    const sourceEvidence = EVIDENCE[name as keyof typeof EVIDENCE];
    if (Number(item.identity.mode & 0o7777n) !== mode || (sourceEvidence !== undefined ? sha256(item.bytes) !== sourceEvidence.sha256 : !item.bytes.equals(expectedBytes))) throw new Error("A package evidence file does not match its required bytes or mode.");
    identities.set(path, item.identity);
  }
  if (Number((await identityFor(packageRoot)).mode & 0o7777n) !== assembly.outerMode) throw new Error("The package root mode no longer matches Task 4E evidence.");
  return identities;
}

async function listTreeNoFollow(root: string): Promise<Set<string>> {
  const found = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.name)) throw new Error("The signed package contains a non-canonical member name.");
      const path = join(directory, entry.name);
      const item = await identityFor(path);
      const key = relative(root, path);
      if (!isMemberPath(key) || found.has(key)) throw new Error("The signed package contains a non-canonical or duplicate member path.");
      found.add(key);
      if (item.type === "directory") pending.push(path);
      else if (item.type !== "file" && item.type !== "symlink") throw new Error("The signed package contains a special member.");
    }
  }
  return found;
}

async function identityFor(path: string): Promise<Identity> { const stats = await lstat(path, { bigint: true }); const identity = identityFromStats(stats); if (identity.type === "symlink") return Object.freeze({ ...identity, linkTarget: await readlink(path) }); return identity; }
function identityFromStats(stats: BigIntStats): Identity {
  const type = stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : stats.isFile() ? "file" : undefined;
  if (type === undefined) throw new Error("The signed package contains a special member.");
  return Object.freeze({ dev: stats.dev, ino: stats.ino, size: stats.size, mode: stats.mode, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, nlink: stats.nlink, type });
}
async function assertIdentity(path: string, expected: Identity): Promise<void> { const observed = await identityFor(path); if (!sameIdentity(expected, observed)) throw new Error("A signed package path was replaced during verification."); }
function sameIdentity(left: Identity, right: Identity): boolean { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink && left.type === right.type && left.linkTarget === right.linkTarget; }
function memberPath(root: string, path: string): string { if (!isMemberPath(path)) throw new Error("A manifest member path is invalid."); const result = join(root, ...path.split("/")); if (!result.startsWith(`${root}/`)) throw new Error("A manifest member path escaped its root."); return result; }
function isMemberPath(path: string): boolean { return typeof path === "string" && path.length > 0 && !path.includes("\\") && !path.includes("\0") && !path.startsWith("/") && path.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part)); }
function isCodeMember(member: SafeArchiveMember): boolean { return member.type === "file" && ((member.mode & 0o111) !== 0 || member.path.endsWith(".dylib")); }
function codeMemberPaths(manifest: RuntimeMemberManifest): string[] { return manifest.members.filter(isCodeMember).map((member) => member.path).sort(); }
function countTypes(members: readonly SafeArchiveMember[]): { directories: number; files: number; symlinks: number } { return members.reduce((counts, member) => ({ ...counts, directories: counts.directories + Number(member.type === "directory"), files: counts.files + Number(member.type === "file"), symlinks: counts.symlinks + Number(member.type === "symlink") }), { directories: 0, files: 0, symlinks: 0 }); }
function assertDigest(bytes: Buffer, expected: string, label: string): void { if (sha256(bytes) !== expected) throw new Error(`The ${label} digest does not match its build trust anchor.`); }
function sameSortedUnique(actual: readonly string[], expected: readonly string[]): boolean { return actual.length === expected.length && actual.every((value, index) => index === 0 ? value === expected[index] : value > actual[index - 1]! && value === expected[index]); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === "object") { for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested); Object.freeze(value); } return value; }

function expectedSourceReceipt(): Record<string, unknown> { return { receiptVersion: 1, status: "pinned-source-input-not-distributed", runtimeId: "llama.cpp", upstreamRepository: LLAMA_B10182_MACOS_ARM64_PIN.upstreamRepository, upstreamRepositoryUrl: LLAMA_B10182_MACOS_ARM64_PIN.upstreamRepositoryUrl, tag: "b10182", sourceCommit: LLAMA_B10182_MACOS_ARM64_PIN.sourceCommit, releaseUrl: "https://github.com/ggml-org/llama.cpp/releases/tag/b10182", target: { platform: "darwin", architecture: "arm64", acceleration: ["cpu", "metal"] }, archive: { filename: LLAMA_B10182_MACOS_ARM64_PIN.archiveFilename, url: LLAMA_B10182_MACOS_ARM64_PIN.archiveUrl, bytes: LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes, expandedBytes: LLAMA_B10182_MACOS_ARM64_PIN.expandedArchiveBytes, sha256: LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256, observedAt: "2026-07-30" }, memberManifest: { path: "member-manifest.json", members: 62, canonicalSha256: LLAMA_B10182_MACOS_ARM64_PIN.memberManifestCanonicalSha256 }, requiredPayload: { server: { path: LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath, sha256: LLAMA_B10182_MACOS_ARM64_PIN.serverSha256 }, license: { path: LLAMA_B10182_MACOS_ARM64_PIN.licenseRelativePath, sha256: LLAMA_B10182_MACOS_ARM64_PIN.licenseSha256 } }, versionProbe: { arguments: ["--version"], expectedVersionLine: "version: 10182 (afeebe103)", expectedTargetSuffix: "for Darwin arm64" }, distributionGates: ["Switchboard code-signs the complete payload", "The outer macOS app and sidecar pass notarization", "The signed staged runtime passes a loopback health smoke test", "The previous known-good runtime remains available for rollback"] }; }
function expectedAssemblyReceipt(): AssemblyReceipt { return { receiptVersion: 1, status: "assembled-inactive-unsigned", runtimeId: "llama.cpp", upstreamRepository: LLAMA_B10182_MACOS_ARM64_PIN.upstreamRepository, upstreamRepositoryUrl: LLAMA_B10182_MACOS_ARM64_PIN.upstreamRepositoryUrl, tag: "b10182", sourceCommit: LLAMA_B10182_MACOS_ARM64_PIN.sourceCommit, target: { platform: "darwin", architecture: "arm64", acceleration: ["cpu", "metal"] }, archive: { filename: LLAMA_B10182_MACOS_ARM64_PIN.archiveFilename, url: LLAMA_B10182_MACOS_ARM64_PIN.archiveUrl, bytes: LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes, expandedBytes: LLAMA_B10182_MACOS_ARM64_PIN.expandedArchiveBytes, sha256: LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256 }, sourceReceipt: { name: "source-receipt.json", bytes: 1803, sha256: EVIDENCE["source-receipt.json"].sha256 }, memberManifest: { name: "member-manifest.json", bytes: 10165, fileSha256: EVIDENCE["member-manifest.json"].sha256, canonicalSha256: LLAMA_B10182_MACOS_ARM64_PIN.memberManifestCanonicalSha256, members: 62, types: { directories: 1, files: 43, symlinks: 18 }, modePolicy: "exact-source-manifest" }, requiredPayload: { server: { path: LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath, size: 33472, mode: 0o755, sha256: LLAMA_B10182_MACOS_ARM64_PIN.serverSha256 }, license: { path: LLAMA_B10182_MACOS_ARM64_PIN.licenseRelativePath, size: 1078, mode: 0o644, sha256: LLAMA_B10182_MACOS_ARM64_PIN.licenseSha256 } }, evidence: [{ name: "member-manifest.json", bytes: 10165, sha256: EVIDENCE["member-manifest.json"].sha256, mode: 0o600 }, { name: "source-receipt.json", bytes: 1803, sha256: EVIDENCE["source-receipt.json"].sha256, mode: 0o600 }, { name: "NOTICE.md", bytes: 1824, sha256: EVIDENCE["NOTICE.md"].sha256, mode: 0o600 }], outerMode: 0o700, signingRequired: true, notarizationRequired: true, activationAllowed: false, distributionAllowed: false, executed: false }; }
