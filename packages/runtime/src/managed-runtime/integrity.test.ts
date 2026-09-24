import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  type RuntimeMemberManifest,
  type SafeArchiveMember
} from "../acquisition/archive-safety.js";
import { LLAMA_B10182_MACOS_ARM64_PIN } from "../acquisition/llama-b10182-macos-arm64-pin.js";
import { RuntimeBoundaryError } from "../errors.js";
import {
  buildAppleDeveloperIdRequirement,
  MacOsCodeSignatureVerifier,
  NodeRuntimeIntegrityVerifier,
  type RuntimeCodeSignatureVerifier,
  type TrustedSignedRuntimeActivation
} from "./integrity.js";
import {
  promoteVerifiedManagedRuntimeAuthority
} from "./activation-provenance.js";
import { promoteVerifiedManagedModel } from "./promoted-model-provenance.js";
import type {
  LlamaServerLaunchInput,
  SignedActiveRuntimeReceipt
} from "./types.js";

const execFileAsync = promisify(execFile);

describe("NodeRuntimeIntegrityVerifier", () => {
  it("accepts only a build-anchored receipt and verifies every code object", async () => {
    const fixture = await createIntegrityFixture();
    try {
      const signatures = new FakeCodeSignatureVerifier();
      const verifier = createVerifier(fixture.trust, signatures);

      await expect(
        verifier.verify(fixture.input, new AbortController().signal)
      ).resolves.toBeUndefined();
      expect(signatures.paths.sort()).toEqual(
        [...fixture.trust.signedMemberPaths]
          .map((path) => join(fixture.runtimeRoot, ...path.split("/")))
          .sort()
      );
    } finally {
      await fixture.remove();
    }
  });

  it("rejects an identical-looking model that lacks process-local promotion", async () => {
    const fixture = await createIntegrityFixture();
    try {
      const forgedInput: LlamaServerLaunchInput = {
        ...fixture.input,
        model: { ...fixture.input.model }
      };
      const verifier = createVerifier(
        fixture.trust,
        new FakeCodeSignatureVerifier()
      );

      await expect(
        verifier.verify(forgedInput, new AbortController().signal)
      ).rejects.toMatchObject({
        detail: {
          code: "SECURITY_BOUNDARY",
          message: expect.stringContaining("not promoted by this process")
        }
      });
    } finally {
      await fixture.remove();
    }
  });

  it("rejects a cloned activation before consulting the build trust anchor", async () => {
    const fixture = await createIntegrityFixture();
    try {
      const forgedInput: LlamaServerLaunchInput = {
        ...fixture.input,
        runtime: {
          ...fixture.input.runtime,
          receipt: {
            ...fixture.input.runtime.receipt,
            serverSha256: "f".repeat(64)
          }
        }
      };
      const verifier = createVerifier(
        fixture.trust,
        new FakeCodeSignatureVerifier()
      );

      await expect(
        verifier.verify(forgedInput, new AbortController().signal)
      ).rejects.toMatchObject({
        detail: {
          code: "SECURITY_BOUNDARY",
          message: expect.stringContaining("not promoted by this process")
        }
      });
    } finally {
      await fixture.remove();
    }
  });

  it("rejects an undeclared dylib in the active runtime tree", async () => {
    const fixture = await createIntegrityFixture();
    try {
      await writeFile(
        join(fixture.payloadDirectory, "libinjected.dylib"),
        "not declared"
      );
      const verifier = createVerifier(
        fixture.trust,
        new FakeCodeSignatureVerifier()
      );

      await expect(
        verifier.verify(fixture.input, new AbortController().signal)
      ).rejects.toMatchObject({
        detail: {
          code: "INTEGRITY_FAILED",
          message: expect.stringContaining("undeclared")
        }
      });
    } finally {
      await fixture.remove();
    }
  });

  it("rejects a same-byte server path replacement before launch", async () => {
    const fixture = await createIntegrityFixture();
    try {
      const originalBytes = await readFile(fixture.input.runtime.serverPath);
      const verifier = createVerifier(
        fixture.trust,
        new FakeCodeSignatureVerifier(),
        async () => {
          await rename(
            fixture.input.runtime.serverPath,
            join(fixture.root, "replaced-server")
          );
          await writeFile(fixture.input.runtime.serverPath, originalBytes);
          await chmod(fixture.input.runtime.serverPath, 0o755);
        }
      );

      await expect(
        verifier.verify(fixture.input, new AbortController().signal)
      ).rejects.toMatchObject({
        detail: {
          code: "INTEGRITY_FAILED",
          message: expect.stringContaining("changed before")
        }
      });
    } finally {
      await fixture.remove();
    }
  });

  it("rejects a same-byte model path replacement before launch", async () => {
    const fixture = await createIntegrityFixture();
    try {
      const originalBytes = await readFile(fixture.input.model.modelPath);
      const verifier = createVerifier(
        fixture.trust,
        new FakeCodeSignatureVerifier(),
        async () => {
          await rename(
            fixture.input.model.modelPath,
            join(fixture.root, "replaced-model.gguf")
          );
          await writeFile(fixture.input.model.modelPath, originalBytes);
          await chmod(fixture.input.model.modelPath, 0o600);
        }
      );

      await expect(
        verifier.verify(fixture.input, new AbortController().signal)
      ).rejects.toMatchObject({
        detail: {
          code: "INTEGRITY_FAILED",
          message: expect.stringContaining("changed before")
        }
      });
    } finally {
      await fixture.remove();
    }
  });

  it("rejects a symlink retargeted at the final launch boundary", async () => {
    const fixture = await createIntegrityFixture();
    try {
      const linkPath = join(
        fixture.payloadDirectory,
        "libggml-base.0.dylib"
      );
      const verifier = createVerifier(
        fixture.trust,
        new FakeCodeSignatureVerifier(),
        async () => {
          await unlink(linkPath);
          await symlink("libggml-base.dylib", linkPath);
        }
      );

      await expect(
        verifier.verify(fixture.input, new AbortController().signal)
      ).rejects.toMatchObject({
        detail: {
          code: "INTEGRITY_FAILED",
          message: expect.stringContaining("symlink")
        }
      });
    } finally {
      await fixture.remove();
    }
  });

  it("accepts a valid symlink when its portable lstat mode differs from the source manifest", async () => {
    const fixture = await createIntegrityFixture();
    try {
      const linkPath = join(
        fixture.payloadDirectory,
        "libggml-base.0.dylib"
      );
      await setPortableSymlinkMode(linkPath);
      const manifestMember = fixture.input.runtime.manifest.members.find(
        (member) => member.path === "llama-b10182/libggml-base.0.dylib"
      );
      const stats = await lstat(linkPath);

      expect(manifestMember).toMatchObject({ type: "symlink", mode: 0o755 });
      expect(Number(stats.mode & 0o777)).toBe(0o777);
      await expect(
        createVerifier(
          fixture.trust,
          new FakeCodeSignatureVerifier()
        ).verify(fixture.input, new AbortController().signal)
      ).resolves.toBeUndefined();
    } finally {
      await fixture.remove();
    }
  });

  it("rejects a symlink replaced with a regular file at the final launch boundary", async () => {
    const fixture = await createIntegrityFixture();
    try {
      const linkPath = join(
        fixture.payloadDirectory,
        "libggml-base.0.dylib"
      );
      const verifier = createVerifier(
        fixture.trust,
        new FakeCodeSignatureVerifier(),
        async () => {
          await unlink(linkPath);
          await writeFile(linkPath, "replacement", { mode: 0o755 });
          await chmod(linkPath, 0o755);
        }
      );

      await expect(
        verifier.verify(fixture.input, new AbortController().signal)
      ).rejects.toMatchObject({
        detail: {
          code: "INTEGRITY_FAILED",
          message: expect.stringContaining("symlink")
        }
      });
    } finally {
      await fixture.remove();
    }
  });

  it("keeps regular-file and directory modes exact", async () => {
    const fileFixture = await createIntegrityFixture();
    try {
      await chmod(fileFixture.input.runtime.serverPath, 0o700);

      await expect(
        createVerifier(
          fileFixture.trust,
          new FakeCodeSignatureVerifier()
        ).verify(fileFixture.input, new AbortController().signal)
      ).rejects.toMatchObject({
        detail: {
          code: "INTEGRITY_FAILED",
          message: expect.stringContaining("mode changed")
        }
      });
    } finally {
      await fileFixture.remove();
    }

    const directoryFixture = await createIntegrityFixture();
    try {
      await chmod(directoryFixture.payloadDirectory, 0o700);

      await expect(
        createVerifier(
          directoryFixture.trust,
          new FakeCodeSignatureVerifier()
        ).verify(directoryFixture.input, new AbortController().signal)
      ).rejects.toMatchObject({
        detail: {
          code: "INTEGRITY_FAILED",
          message: expect.stringContaining("mode changed")
        }
      });
    } finally {
      await directoryFixture.remove();
    }
  });

  it("rejects a regular-file mode change at the final launch boundary", async () => {
    const fixture = await createIntegrityFixture();
    try {
      const verifier = createVerifier(
        fixture.trust,
        new FakeCodeSignatureVerifier(),
        async () => {
          await chmod(fixture.input.runtime.serverPath, 0o700);
        }
      );

      await expect(
        verifier.verify(fixture.input, new AbortController().signal)
      ).rejects.toMatchObject({
        detail: {
          code: "INTEGRITY_FAILED",
          message: expect.stringContaining("file path changed")
        }
      });
    } finally {
      await fixture.remove();
    }
  });

  it("rejects a directory mode change at the final launch boundary", async () => {
    const fixture = await createIntegrityFixture();
    try {
      const verifier = createVerifier(
        fixture.trust,
        new FakeCodeSignatureVerifier(),
        async () => {
          await chmod(fixture.payloadDirectory, 0o700);
        }
      );

      await expect(
        verifier.verify(fixture.input, new AbortController().signal)
      ).rejects.toMatchObject({
        detail: {
          code: "INTEGRITY_FAILED",
          message: expect.stringContaining("directory changed")
        }
      });
    } finally {
      await fixture.remove();
    }
  });
});

describe("MacOsCodeSignatureVerifier", () => {
  it("passes an exact Apple Developer ID requirement to codesign", async () => {
    const calls: string[][] = [];
    const verifier = new MacOsCodeSignatureVerifier(async (args) => {
      calls.push([...args]);
      return "";
    });

    await verifier.verify(
      "/Applications/Switchboard.app/Contents/Resources/llama-server",
      "com.switchboard.runtime.llama",
      "ABCDE12345",
      new AbortController().signal
    );

    const requirement = buildAppleDeveloperIdRequirement(
      "com.switchboard.runtime.llama",
      "ABCDE12345"
    );
    expect(calls).toEqual([[
      "--verify",
      "--strict",
      "--verbose=4",
      "--test-requirement",
      `=${requirement}`,
      "/Applications/Switchboard.app/Contents/Resources/llama-server"
    ]]);
    expect(requirement).toContain("anchor apple generic");
    expect(requirement).toContain(
      "certificate 1[field.1.2.840.113635.100.6.2.6] exists"
    );
    expect(requirement).toContain(
      "certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
    );
    expect(calls.flat()).not.toContain("--display");
  });

  it("fails closed when codesign rejects the Apple trust requirement", async () => {
    const verifier = new MacOsCodeSignatureVerifier(async () => {
      throw new Error("fixture requirement mismatch");
    });

    await expect(
      verifier.verify(
        "/Applications/Switchboard.app/Contents/Resources/llama-server",
        "com.switchboard.runtime.llama",
        "ABCDE12345",
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      detail: {
        code: "INTEGRITY_FAILED",
        message: expect.stringContaining("Apple-anchored")
      }
    });
  });

  it("rejects requirement-expression injection in trusted identity fields", () => {
    expect(() => buildAppleDeveloperIdRequirement(
      "com.switchboard.runtime.llama\" or true",
      "ABCDE12345"
    )).toThrow(RuntimeBoundaryError);
    expect(() => buildAppleDeveloperIdRequirement(
      "com.switchboard.runtime.llama",
      "NOT-A-TEAM"
    )).toThrow(RuntimeBoundaryError);
  });
});

function createVerifier(
  trust: TrustedSignedRuntimeActivation,
  codeSignatureVerifier: RuntimeCodeSignatureVerifier,
  beforeFinalPathRevalidation?: () => void | Promise<void>
): NodeRuntimeIntegrityVerifier {
  return new NodeRuntimeIntegrityVerifier({
    platform: "darwin",
    architecture: "arm64",
    trustedActivation: trust,
    codeSignatureVerifier,
    ...(beforeFinalPathRevalidation === undefined
      ? {}
      : { beforeFinalPathRevalidation })
  });
}

interface IntegrityFixture {
  readonly root: string;
  readonly runtimeRoot: string;
  readonly payloadDirectory: string;
  readonly input: LlamaServerLaunchInput;
  readonly trust: TrustedSignedRuntimeActivation;
  remove(): Promise<void>;
}

async function createIntegrityFixture(): Promise<IntegrityFixture> {
  const createdRoot = await mkdtemp(
    join(tmpdir(), "switchboard-runtime-integrity-")
  );
  const root = await realpath(createdRoot);
  const runtimeRoot = join(root, "runtime");
  const payloadDirectory = join(
    runtimeRoot,
    LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot
  );
  const sourceManifestPath = fileURLToPath(new URL(
    "../../../../third_party/llama.cpp/b10182/macos-arm64/member-manifest.json",
    import.meta.url
  ));
  const sourceManifest = JSON.parse(
    await readFile(sourceManifestPath, "utf8")
  ) as RuntimeMemberManifest;
  const activeMembers: SafeArchiveMember[] = [];

  for (const sourceMember of sourceManifest.members) {
    const memberPath = join(runtimeRoot, ...sourceMember.path.split("/"));
    if (sourceMember.type === "directory") {
      await mkdir(memberPath, { recursive: true, mode: sourceMember.mode });
      await chmod(memberPath, sourceMember.mode);
      activeMembers.push({ ...sourceMember });
      continue;
    }
    await mkdir(dirname(memberPath), { recursive: true });
    if (sourceMember.type === "symlink") {
      await symlink(sourceMember.linkTarget!, memberPath);
      activeMembers.push({ ...sourceMember });
      continue;
    }
    const bytes = Buffer.from(`signed fixture:${sourceMember.path}`, "utf8");
    await writeFile(memberPath, bytes, { mode: sourceMember.mode });
    await chmod(memberPath, sourceMember.mode);
    activeMembers.push({
      path: sourceMember.path,
      type: "file",
      mode: sourceMember.mode,
      size: bytes.byteLength,
      sha256: sha256(bytes)
    });
  }

  const manifest: RuntimeMemberManifest = {
    schemaVersion: 1,
    archiveSha256: LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256,
    payloadRoot: LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot,
    members: activeMembers
  };
  const serverMember = manifest.members.find(
    (member) =>
      member.path === LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath
  );
  if (serverMember?.type !== "file" || serverMember.sha256 === undefined) {
    throw new Error("The fixture active manifest has no server.");
  }
  const receipt: SignedActiveRuntimeReceipt = {
    receiptVersion: 1,
    status: "signed-active",
    runtimeId: "llama.cpp",
    tag: "b10182",
    sourceCommit: LLAMA_B10182_MACOS_ARM64_PIN.sourceCommit,
    target: "darwin-arm64",
    sourceMemberManifestCanonicalSha256:
      LLAMA_B10182_MACOS_ARM64_PIN.memberManifestCanonicalSha256,
    memberManifestCanonicalSha256: sha256Text(canonicalJson(manifest)),
    serverSha256: serverMember.sha256
  };
  const signedMemberPaths = manifest.members
    .filter((member) =>
      member.type === "file" &&
      ((member.mode & 0o111) !== 0 || member.path.endsWith(".dylib"))
    )
    .map((member) => member.path);
  const trust: TrustedSignedRuntimeActivation = {
    receiptCanonicalSha256: sha256Text(canonicalJson(receipt)),
    signingIdentifier: "com.switchboard.runtime.llama",
    teamIdentifier: "ABCDE12345",
    signedMemberPaths
  };

  const modelRoot = join(root, "models");
  const modelPath = join(modelRoot, "qwen3", "model.gguf");
  const modelBytes = Buffer.from("fixture managed model", "utf8");
  await mkdir(dirname(modelPath), { recursive: true });
  await writeFile(modelPath, modelBytes, { mode: 0o600 });
  await chmod(modelPath, 0o600);

  const authority = promoteVerifiedManagedRuntimeAuthority({
    runtimeRoot,
    payloadDirectory,
    serverPath: join(
      runtimeRoot,
      ...LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath.split("/")
    ),
    sourceManifest,
    manifest,
    receipt
  }, {
    verify: async () => {}
  });

  return {
    root,
    runtimeRoot,
    payloadDirectory,
    input: {
      authority,
      runtime: authority.activation,
      model: promoteVerifiedManagedModel({
        rootDirectory: modelRoot,
        modelId: "qwen3-4b-q4-k-m",
        displayName: "Qwen3 4B",
        modelPath,
        artifactSha256: sha256(modelBytes),
        downloadBytes: modelBytes.byteLength,
        catalogGeneration: 1,
        target: "darwin-arm64"
      })
    },
    trust,
    remove: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };
}

class FakeCodeSignatureVerifier implements RuntimeCodeSignatureVerifier {
  readonly paths: string[] = [];

  async verify(
    filePath: string,
    _signingIdentifier: string,
    _teamIdentifier: string,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted();
    this.paths.push(filePath);
  }
}

async function setPortableSymlinkMode(linkPath: string): Promise<void> {
  const initial = await lstat(linkPath);
  if (Number(initial.mode & 0o777) === 0o777) {
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("The fixture platform does not expose portable symlink mode 0777.");
  }
  await execFileAsync("chmod", ["-h", "777", linkPath]);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
