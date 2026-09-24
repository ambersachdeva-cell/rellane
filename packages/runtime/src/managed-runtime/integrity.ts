import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { RuntimeBoundaryError } from "../errors.js";
import {
  canonicalJson,
  validateArchiveMembers,
  type SafeArchiveMember
} from "../acquisition/archive-safety.js";
import { LLAMA_B10182_MACOS_ARM64_PIN } from "../acquisition/llama-b10182-macos-arm64-pin.js";
import type {
  LlamaServerLaunchInput,
  RuntimeIntegrityVerifier
} from "./types.js";
import {
  assertProcessVerifiedManagedRuntimeAuthority,
  assertProcessVerifiedRuntimeActivation
} from "./activation-provenance.js";
import { assertProcessVerifiedManagedModel } from "./promoted-model-provenance.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SIGNING_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u;
const TEAM_IDENTIFIER_PATTERN = /^[A-Z0-9]{10}$/u;
const CODE_SIGN_TIMEOUT_MS = 5_000;
const CODE_SIGN_OUTPUT_LIMIT = 64 * 1024;

export interface TrustedSignedRuntimeActivation {
  /** Build-generated and app-signature-protected digest of the active receipt. */
  readonly receiptCanonicalSha256: string;
  readonly signingIdentifier: string;
  readonly teamIdentifier: string;
  /** Exact post-sign manifest members expected to be Mach-O code. */
  readonly signedMemberPaths: readonly string[];
}

export interface RuntimeCodeSignatureVerifier {
  verify(
    filePath: string,
    signingIdentifier: string,
    teamIdentifier: string,
    signal: AbortSignal
  ): Promise<void>;
}

export type RuntimeCodeSignCommandRunner = (
  args: readonly string[],
  signal: AbortSignal
) => Promise<string>;

interface VerifiedRegularFileIdentity {
  readonly kind: "file";
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

interface VerifiedDirectoryIdentity {
  readonly kind: "directory";
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
}

interface VerifiedSymlinkIdentity {
  readonly kind: "symlink";
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly linkTarget: string;
}

type VerifiedMemberIdentity =
  | VerifiedRegularFileIdentity
  | VerifiedDirectoryIdentity
  | VerifiedSymlinkIdentity;

interface VerifiedRuntimePayload {
  readonly runtimeRoot: string;
  readonly payloadDirectory: string;
  readonly memberIdentities: readonly VerifiedMemberIdentity[];
}

export interface NodeRuntimeIntegrityVerifierOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly trustedActivation?: TrustedSignedRuntimeActivation;
  readonly codeSignatureVerifier?: RuntimeCodeSignatureVerifier;
  /** Deterministic test seam for rename/replacement race coverage. */
  readonly beforeFinalPathRevalidation?: () => void | Promise<void>;
}

export class NodeRuntimeIntegrityVerifier implements RuntimeIntegrityVerifier {
  private readonly platform: NodeJS.Platform;
  private readonly architecture: string;
  private readonly trustedActivation: TrustedSignedRuntimeActivation | undefined;
  private readonly codeSignatureVerifier: RuntimeCodeSignatureVerifier;
  private readonly beforeFinalPathRevalidation:
    (() => void | Promise<void>) | undefined;

  constructor(options: NodeRuntimeIntegrityVerifierOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.architecture = options.architecture ?? process.arch;
    this.trustedActivation = options.trustedActivation;
    this.codeSignatureVerifier =
      options.codeSignatureVerifier ?? new MacOsCodeSignatureVerifier();
    this.beforeFinalPathRevalidation = options.beforeFinalPathRevalidation;
  }

  async verify(
    input: LlamaServerLaunchInput,
    signal: AbortSignal
  ): Promise<void> {
    try {
      throwIfAborted(signal);
      this.verifyPinnedIdentity(input);
      const runtime = await this.verifyRuntimePayload(input, signal);
      const modelIdentity = await this.verifyManagedModel(input, signal);
      await this.beforeFinalPathRevalidation?.();
      throwIfAborted(signal);
      await assertExactRuntimeTree(
        runtime.runtimeRoot,
        runtime.payloadDirectory,
        input.runtime.manifest.members
      );
      const fileAndSymlinkIdentities = runtime.memberIdentities.filter(
        (identity) => identity.kind !== "directory"
      );
      const directoryIdentities = runtime.memberIdentities.filter(
        (identity) => identity.kind === "directory"
      );
      for (const identity of [
        ...fileAndSymlinkIdentities,
        modelIdentity,
        ...directoryIdentities
      ]) {
        await assertPathStillNamesMember(identity);
      }
    } catch (error) {
      if (error instanceof RuntimeBoundaryError) {
        throw error;
      }
      if (signal.aborted || isAbortError(error)) {
        throw cancelled(error);
      }
      throw integrityFailure(
        "The managed runtime or model did not match its verified identity.",
        error
      );
    }
  }

  private verifyPinnedIdentity(input: LlamaServerLaunchInput): void {
    assertProcessVerifiedManagedRuntimeAuthority(input.authority);
    assertProcessVerifiedRuntimeActivation(input.runtime);
    if (input.authority.activation !== input.runtime) {
      throw securityBoundary(
        "The managed runtime activation did not match its verifier authority."
      );
    }
    assertProcessVerifiedManagedModel(input.model);
    const receipt = input.runtime.receipt;
    const trustedActivation = this.trustedActivation;
    if (
      this.platform !== "darwin" ||
      this.architecture !== "arm64" ||
      receipt.receiptVersion !== 1 ||
      receipt.status !== "signed-active" ||
      receipt.runtimeId !== "llama.cpp" ||
      receipt.tag !== LLAMA_B10182_MACOS_ARM64_PIN.tag ||
      receipt.sourceCommit !== LLAMA_B10182_MACOS_ARM64_PIN.sourceCommit ||
      receipt.target !== LLAMA_B10182_MACOS_ARM64_PIN.target ||
      input.model.target !== "darwin-arm64"
    ) {
      throw securityBoundary(
        "The managed runtime is not activated for the pinned macOS arm64 target."
      );
    }
    if (
      trustedActivation === undefined ||
      !SHA256_PATTERN.test(trustedActivation.receiptCanonicalSha256) ||
      !SIGNING_IDENTIFIER_PATTERN.test(trustedActivation.signingIdentifier) ||
      !TEAM_IDENTIFIER_PATTERN.test(trustedActivation.teamIdentifier) ||
      trustedActivation.signedMemberPaths.length === 0
    ) {
      throw securityBoundary(
        "No trusted build-generated signed-runtime activation is configured."
      );
    }
    if (!digestMatches(
      sha256Text(canonicalJson(receipt)),
      trustedActivation.receiptCanonicalSha256
    )) {
      throw integrityFailure(
        "The signed runtime receipt is not anchored by this application build."
      );
    }

    const sourceManifestCanonicalSha256 = sha256Text(
      canonicalJson(input.runtime.sourceManifest)
    );
    const activeManifestCanonicalSha256 = sha256Text(
      canonicalJson(input.runtime.manifest)
    );
    if (
      input.runtime.sourceManifest.archiveSha256 !==
        LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256 ||
      input.runtime.manifest.archiveSha256 !==
        LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256 ||
      input.runtime.sourceManifest.payloadRoot !==
        LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot ||
      input.runtime.manifest.payloadRoot !==
        LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot ||
      !digestMatches(
        sourceManifestCanonicalSha256,
        LLAMA_B10182_MACOS_ARM64_PIN.memberManifestCanonicalSha256
      ) ||
      !digestMatches(
        receipt.sourceMemberManifestCanonicalSha256,
        sourceManifestCanonicalSha256
      ) ||
      !digestMatches(
        receipt.memberManifestCanonicalSha256,
        activeManifestCanonicalSha256
      )
    ) {
      throw integrityFailure(
        "The activated runtime manifest does not match the b10182 source pin."
      );
    }

    validateArchiveMembers(
      input.runtime.sourceManifest.members,
      LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot
    );
    validateArchiveMembers(
      input.runtime.manifest.members,
      LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot
    );
    assertSameRuntimeMemberLayout(
      input.runtime.sourceManifest.members,
      input.runtime.manifest.members
    );
    const requiredSignedMemberPaths = input.runtime.manifest.members
      .filter((member) =>
        member.type === "file" &&
        (
          (member.mode & 0o111) !== 0 ||
          member.path.endsWith(".dylib")
        )
      )
      .map((member) => member.path)
      .sort();
    if (!sameSortedStrings(
      [...trustedActivation.signedMemberPaths].sort(),
      requiredSignedMemberPaths
    )) {
      throw securityBoundary(
        "The trusted activation does not cover every executable and dylib."
      );
    }
    const sourceServerMember = input.runtime.sourceManifest.members.find(
      (member) =>
        member.path === LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath
    );
    const activeServerMember = input.runtime.manifest.members.find(
      (member) =>
        member.path === LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath
    );
    if (
      sourceServerMember?.type !== "file" ||
      sourceServerMember.sha256 === undefined ||
      !digestMatches(
        sourceServerMember.sha256,
        LLAMA_B10182_MACOS_ARM64_PIN.serverSha256
      ) ||
      activeServerMember?.type !== "file" ||
      activeServerMember.sha256 === undefined ||
      !digestMatches(
        activeServerMember.sha256,
        receipt.serverSha256
      )
    ) {
      throw integrityFailure(
        "The activated runtime manifest does not contain the pinned server."
      );
    }

    if (
      !SHA256_PATTERN.test(input.model.artifactSha256) ||
      !Number.isSafeInteger(input.model.downloadBytes) ||
      input.model.downloadBytes <= 0 ||
      !Number.isSafeInteger(input.model.catalogGeneration) ||
      input.model.catalogGeneration < 0 ||
      !/^[a-z0-9][a-z0-9._-]{0,255}$/u.test(input.model.modelId)
    ) {
      throw securityBoundary("The promoted model identity is malformed.");
    }
  }

  private async verifyRuntimePayload(
    input: LlamaServerLaunchInput,
    signal: AbortSignal
  ): Promise<VerifiedRuntimePayload> {
    const runtimeRoot = await canonicalDirectory(input.runtime.runtimeRoot);
    const expectedPayloadDirectory = join(
      runtimeRoot,
      LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot
    );
    const expectedServerPath = join(
      runtimeRoot,
      LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath
    );
    if (
      resolve(input.runtime.payloadDirectory) !== expectedPayloadDirectory ||
      resolve(input.runtime.serverPath) !== expectedServerPath
    ) {
      throw securityBoundary(
        "The activated runtime paths do not match the pinned payload layout."
      );
    }

    const payloadDirectory = await canonicalDirectory(expectedPayloadDirectory);
    await assertExactRuntimeTree(
      runtimeRoot,
      payloadDirectory,
      input.runtime.manifest.members
    );
    const memberIdentities: VerifiedMemberIdentity[] = [];
    for (const member of input.runtime.manifest.members) {
      throwIfAborted(signal);
      const memberPath = join(runtimeRoot, ...member.path.split("/"));
      assertWithin(runtimeRoot, memberPath);
      const identity = await verifyRuntimeMember(memberPath, member, signal);
      memberIdentities.push(identity);
    }
    const trustedActivation = this.trustedActivation;
    if (trustedActivation === undefined) {
      throw securityBoundary(
        "No trusted signed-runtime activation is configured."
      );
    }
    for (const memberPath of trustedActivation.signedMemberPaths) {
      throwIfAborted(signal);
      await this.codeSignatureVerifier.verify(
        join(runtimeRoot, ...memberPath.split("/")),
        trustedActivation.signingIdentifier,
        trustedActivation.teamIdentifier,
        signal
      );
    }
    return { runtimeRoot, payloadDirectory, memberIdentities };
  }

  private async verifyManagedModel(
    input: LlamaServerLaunchInput,
    signal: AbortSignal
  ): Promise<VerifiedRegularFileIdentity> {
    const modelRoot = await canonicalDirectory(input.model.rootDirectory);
    const modelPath = resolve(input.model.modelPath);
    assertWithin(modelRoot, modelPath);
    if (
      dirname(modelPath) === modelRoot ||
      !modelPath.toLowerCase().endsWith(".gguf")
    ) {
      throw securityBoundary(
        "The promoted model path does not match the private managed-model layout."
      );
    }

    const observed = await sha256StableRegularFile(
      modelPath,
      input.model.downloadBytes,
      signal
    );
    if (!digestMatches(observed.sha256, input.model.artifactSha256)) {
      throw integrityFailure(
        "The promoted model digest changed before runtime launch."
      );
    }
    return observed.identity;
  }
}

export class MacOsCodeSignatureVerifier
implements RuntimeCodeSignatureVerifier {
  constructor(
    private readonly commandRunner: RuntimeCodeSignCommandRunner = runCodeSign
  ) {}

  async verify(
    filePath: string,
    signingIdentifier: string,
    teamIdentifier: string,
    signal: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    if (
      process.platform !== "darwin" ||
      !isAbsolute(filePath) ||
      !SIGNING_IDENTIFIER_PATTERN.test(signingIdentifier) ||
      !TEAM_IDENTIFIER_PATTERN.test(teamIdentifier)
    ) {
      throw securityBoundary(
        "The managed runtime code-signing verification input is invalid."
      );
    }
    const requirement = buildAppleDeveloperIdRequirement(
      signingIdentifier,
      teamIdentifier
    );
    try {
      await this.commandRunner(
        [
          "--verify",
          "--strict",
          "--verbose=4",
          "--test-requirement",
          `=${requirement}`,
          filePath
        ],
        signal
      );
    } catch (error) {
      if (signal.aborted) {
        throw cancelled(error);
      }
      if (error instanceof RuntimeBoundaryError) {
        throw error;
      }
      throw integrityFailure(
        "A managed runtime code object failed its Apple-anchored Developer ID requirement.",
        error
      );
    }
  }
}

export function buildAppleDeveloperIdRequirement(
  signingIdentifier: string,
  teamIdentifier: string
): string {
  if (
    !SIGNING_IDENTIFIER_PATTERN.test(signingIdentifier) ||
    !TEAM_IDENTIFIER_PATTERN.test(teamIdentifier)
  ) {
    throw securityBoundary(
      "The managed runtime code-signing requirement identity is invalid."
    );
  }
  return [
    "anchor apple generic",
    "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
    "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
    `certificate leaf[subject.OU] = "${teamIdentifier}"`,
    `identifier "${signingIdentifier}"`
  ].join(" and ");
}

function assertSameRuntimeMemberLayout(
  sourceMembers: readonly SafeArchiveMember[],
  activeMembers: readonly SafeArchiveMember[]
): void {
  if (sourceMembers.length !== activeMembers.length) {
    throw integrityFailure(
      "The active runtime member set differs from the source manifest."
    );
  }
  const activeByPath = new Map(
    activeMembers.map((member) => [member.path, member])
  );
  for (const source of sourceMembers) {
    const active = activeByPath.get(source.path);
    if (
      active === undefined ||
      active.type !== source.type ||
      active.mode !== source.mode ||
      active.linkTarget !== source.linkTarget
    ) {
      throw integrityFailure(
        "The active runtime member layout differs from the source manifest."
      );
    }
  }
}

async function assertExactRuntimeTree(
  runtimeRoot: string,
  payloadDirectory: string,
  members: readonly SafeArchiveMember[]
): Promise<void> {
  const observed: string[] = [
    portableRelative(runtimeRoot, payloadDirectory)
  ];
  const pending = [payloadDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = portableRelative(runtimeRoot, path);
      observed.push(relativePath);
      const stats = await lstat(path);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        pending.push(path);
      }
    }
  }
  const expected = members.map((member) => member.path).sort();
  observed.sort();
  if (!sameSortedStrings(observed, expected)) {
    throw integrityFailure(
      "The active runtime tree contains missing or undeclared members."
    );
  }
}

async function assertPathStillNamesMember(
  identity: VerifiedMemberIdentity
): Promise<void> {
  const current = await lstat(identity.path, { bigint: true });
  if (identity.kind === "symlink") {
    if (
      !current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.mode !== identity.mode ||
      current.mtimeNs !== identity.mtimeNs
    ) {
      throw integrityFailure(
        "A verified managed symlink changed before the launch boundary."
      );
    }
    const linkTarget = await readlink(identity.path);
    const afterRead = await lstat(identity.path, { bigint: true });
    if (
      linkTarget !== identity.linkTarget ||
      !afterRead.isSymbolicLink() ||
      afterRead.dev !== identity.dev ||
      afterRead.ino !== identity.ino ||
      afterRead.mode !== identity.mode ||
      afterRead.mtimeNs !== identity.mtimeNs
    ) {
      throw integrityFailure(
        "A verified managed symlink target changed before the launch boundary."
      );
    }
    return;
  }
  if (identity.kind === "directory") {
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.mode !== identity.mode ||
      current.mtimeNs !== identity.mtimeNs
    ) {
      throw integrityFailure(
        "A verified managed directory changed before the launch boundary."
      );
    }
    return;
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1n ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    current.mode !== identity.mode ||
    current.size !== identity.size ||
    current.mtimeNs !== identity.mtimeNs
  ) {
    throw integrityFailure(
      "A verified managed file path changed before the launch boundary."
    );
  }
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path);
  assertWithin(root, path);
  return value.split(sep).join("/");
}

async function verifyRuntimeMember(
  memberPath: string,
  member: SafeArchiveMember,
  signal: AbortSignal
): Promise<VerifiedMemberIdentity> {
  const stats = await lstat(memberPath, { bigint: true });
  if (member.type === "directory") {
    const observedMode = Number(stats.mode & 0o777n);
    if (observedMode !== member.mode) {
      throw integrityFailure("A managed runtime member mode changed.");
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw integrityFailure("A managed runtime directory changed identity.");
    }
    return {
      kind: "directory",
      path: memberPath,
      dev: stats.dev,
      ino: stats.ino,
      mode: stats.mode,
      mtimeNs: stats.mtimeNs
    };
  }
  if (member.type === "symlink") {
    if (!stats.isSymbolicLink()) {
      throw integrityFailure("A managed runtime link changed identity.");
    }
    const target = await readlink(memberPath);
    const after = await lstat(memberPath, { bigint: true });
    if (
      target !== member.linkTarget ||
      !after.isSymbolicLink() ||
      stats.dev !== after.dev ||
      stats.ino !== after.ino ||
      stats.mode !== after.mode ||
      stats.mtimeNs !== after.mtimeNs
    ) {
      throw integrityFailure("A managed runtime link target changed.");
    }
    return {
      kind: "symlink",
      path: memberPath,
      dev: after.dev,
      ino: after.ino,
      mode: after.mode,
      mtimeNs: after.mtimeNs,
      linkTarget: target
    };
  }
  const observedMode = Number(stats.mode & 0o777n);
  if (observedMode !== member.mode) {
    throw integrityFailure("A managed runtime member mode changed.");
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    member.sha256 === undefined ||
    stats.size !== BigInt(member.size)
  ) {
    throw integrityFailure("A managed runtime file changed identity.");
  }
  const observed = await sha256StableRegularFile(
    memberPath,
    member.size,
    signal,
    member.mode
  );
  if (!digestMatches(observed.sha256, member.sha256)) {
    throw integrityFailure("A managed runtime file digest changed.");
  }
  return observed.identity;
}

async function sha256StableRegularFile(
  filePath: string,
  expectedBytes: number,
  signal: AbortSignal,
  expectedMode?: number
): Promise<{
  readonly sha256: string;
  readonly identity: VerifiedRegularFileIdentity;
}> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size !== BigInt(expectedBytes) ||
      (expectedMode !== undefined &&
        Number(before.mode & 0o777n) !== expectedMode)
    ) {
      throw integrityFailure("A managed file is not a stable regular file.");
    }

    const hash = createHash("sha256");
    const stream = handle.createReadStream({
      autoClose: false,
      start: 0,
      signal
    });
    for await (const chunk of stream) {
      throwIfAborted(signal);
      hash.update(chunk);
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      after.nlink !== 1n
    ) {
      throw integrityFailure("A managed file changed during verification.");
    }
    return {
      sha256: hash.digest("hex"),
      identity: {
        kind: "file",
        path: filePath,
        dev: after.dev,
        ino: after.ino,
        mode: after.mode,
        size: after.size,
        mtimeNs: after.mtimeNs
      }
    };
  } finally {
    await handle.close();
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw securityBoundary("A managed runtime directory is not absolute.");
  }
  const resolved = resolve(path);
  if (resolved === sep) {
    throw securityBoundary("A filesystem root cannot be a managed runtime directory.");
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) {
    throw securityBoundary("A managed runtime directory contains a symbolic alias.");
  }
  const stats = await lstat(canonical);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw securityBoundary("A managed runtime directory changed identity.");
  }
  return canonical;
}

function assertWithin(root: string, candidate: string): void {
  const pathFromRoot = relative(root, resolve(candidate));
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw securityBoundary("A managed runtime path escaped its private root.");
  }
}

function digestMatches(left: string, right: string): boolean {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(left, "hex"),
    Buffer.from(right, "hex")
  );
}

function sameSortedStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runCodeSign(
  args: readonly string[],
  signal: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/codesign",
      [...args],
      {
        encoding: "utf8",
        env: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin"
        },
        timeout: CODE_SIGN_TIMEOUT_MS,
        maxBuffer: CODE_SIGN_OUTPUT_LIMIT,
        signal
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(signal.aborted
            ? cancelled(error)
            : integrityFailure(
              "A managed runtime code signature could not be verified.",
              error
            ));
          return;
        }
        resolve(`${stdout}${stderr}`);
      }
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelled(signal.reason);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function cancelled(cause?: unknown): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "CANCELLED",
    message: "Managed runtime verification was cancelled.",
    retryable: true
  }, cause instanceof Error ? { cause } : undefined);
}

function securityBoundary(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "SECURITY_BOUNDARY",
    message,
    retryable: false
  });
}

function integrityFailure(
  message: string,
  cause?: unknown
): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "INTEGRITY_FAILED",
    message,
    retryable: false
  }, cause instanceof Error ? { cause } : undefined);
}
