import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  inspectTarGzArchive,
  sha256,
  validateArchiveMembers,
  validateLlamaVersionOutput,
  type ArchiveInspectionLimits,
  type RuntimeMemberManifest,
  type SafeArchiveMember
} from "./archive-safety.js";
import {
  LLAMA_B10182_MACOS_ARM64_PIN,
  RUNTIME_DOWNLOAD_IDLE_TIMEOUT_MS,
  RUNTIME_DOWNLOAD_TOTAL_TIMEOUT_MS,
  downloadPinnedArchive
} from "./llama-b10182-macos-arm64.js";

const fixtureLimits: ArchiveInspectionLimits = {
  expectedPayloadRoot: "runtime",
  maxCompressedBytes: 32 * 1024,
  maxExpandedBytes: 64 * 1024,
  maxMemberBytes: 8 * 1024,
  maxMembers: 16,
  maxTotalFileBytes: 16 * 1024
};

describe("runtime archive safety", () => {
  it("inspects a bounded ustar archive and creates a deterministic manifest", () => {
    const archive = createTarGz([
      { path: "runtime/", type: "directory", mode: 0o755 },
      {
        path: "runtime/llama-server",
        type: "file",
        mode: 0o755,
        data: Buffer.from("server")
      },
      {
        path: "runtime/LICENSE",
        type: "file",
        mode: 0o644,
        data: Buffer.from("license")
      },
      {
        path: "runtime/libserver.dylib",
        type: "symlink",
        mode: 0o755,
        linkTarget: "llama-server"
      }
    ]);

    const first = inspectTarGzArchive(archive, sha256(archive), fixtureLimits);
    const second = inspectTarGzArchive(archive, sha256(archive), fixtureLimits);

    expect(first.manifest).toEqual(second.manifest);
    expect(first.manifestCanonicalSha256).toBe(
      second.manifestCanonicalSha256
    );
    expect(first.manifest.members.map((member) => member.path)).toEqual([
      "runtime",
      "runtime/LICENSE",
      "runtime/libserver.dylib",
      "runtime/llama-server"
    ]);
    expect(
      first.manifest.members.find(
        (member) => member.path === "runtime/llama-server"
      )?.sha256
    ).toBe(sha256("server"));
  });

  it("verifies the compressed digest before parsing", () => {
    const archive = createTarGz([
      { path: "runtime/", type: "directory", mode: 0o755 }
    ]);
    expect(() =>
      inspectTarGzArchive(archive, "0".repeat(64), fixtureLimits)
    ).toThrow(/SHA-256/u);
  });

  it.each([
    "/absolute",
    "../escape",
    "runtime/../escape",
    "C:/escape",
    "runtime\\escape"
  ])("rejects unsafe member path %s", (path) => {
    expect(() =>
      validateArchiveMembers(
        [
          directory("runtime"),
          {
            path,
            type: "file",
            mode: 0o600,
            size: 0,
            sha256: sha256("")
          }
        ],
        "runtime"
      )
    ).toThrow(/unsafe|canonical|escapes/u);
  });

  it("rejects duplicate paths and undeclared parent directories", () => {
    expect(() =>
      validateArchiveMembers(
        [directory("runtime"), directory("runtime")],
        "runtime"
      )
    ).toThrow(/duplicate/u);
    expect(() =>
      validateArchiveMembers(
        [
          directory("runtime"),
          {
            path: "runtime/missing/file",
            type: "file",
            mode: 0o600,
            size: 0,
            sha256: sha256("")
          }
        ],
        "runtime"
      )
    ).toThrow(/parent directory/u);
  });

  it("rejects escaping, dangling, cyclic, and ancestor symbolic links", () => {
    const base = [
      directory("runtime"),
      file("runtime/target")
    ] satisfies SafeArchiveMember[];

    expect(() =>
      validateArchiveMembers(
        [
          ...base,
          link("runtime/escape", "../outside")
        ],
        "runtime"
      )
    ).toThrow(/canonical|escapes/u);
    expect(() =>
      validateArchiveMembers(
        [
          ...base,
          link("runtime/dangling", "missing")
        ],
        "runtime"
      )
    ).toThrow(/no declared target/u);
    expect(() =>
      validateArchiveMembers(
        [
          ...base,
          link("runtime/a", "b"),
          link("runtime/b", "a")
        ],
        "runtime"
      )
    ).toThrow(/cycle/u);
    expect(() =>
      validateArchiveMembers(
        [
          ...base,
          link("runtime/directory-link", "target"),
          file("runtime/directory-link/nested")
        ],
        "runtime"
      )
    ).toThrow(/nested below a symbolic link/u);
  });

  it("rejects hard links and other special tar member types", () => {
    const archive = createTarGz([
      { path: "runtime/", type: "directory", mode: 0o755 },
      {
        path: "runtime/hard-link",
        type: "special",
        mode: 0o644,
        typeFlag: "1"
      }
    ]);
    expect(() =>
      inspectTarGzArchive(archive, sha256(archive), fixtureLimits)
    ).toThrow(/forbidden special/u);
  });

  it("rejects corrupted tar headers and hidden trailing data", () => {
    const validTar = createTar([
      { path: "runtime/", type: "directory", mode: 0o755 }
    ]);
    const corruptedHeader = Buffer.from(validTar);
    corruptedHeader[0] = 0x58;
    const corruptedArchive = gzipSync(corruptedHeader, { level: 9 });
    expect(() =>
      inspectTarGzArchive(
        corruptedArchive,
        sha256(corruptedArchive),
        fixtureLimits
      )
    ).toThrow(/checksum/u);

    const hiddenDataTar = Buffer.concat([
      validTar,
      Buffer.alloc(512, 0x41)
    ]);
    const hiddenDataArchive = gzipSync(hiddenDataTar, { level: 9 });
    expect(() =>
      inspectTarGzArchive(
        hiddenDataArchive,
        sha256(hiddenDataArchive),
        fixtureLimits
      )
    ).toThrow(/hidden data/u);
  });

  it("requires the exact pinned llama-server version and native target", () => {
    expect(() =>
      validateLlamaVersionOutput(
        "version: 10182 (afeebe103)\n" +
          "built with AppleClang 21.0.0.21000101 for Darwin arm64\n"
      )
    ).not.toThrow();
    expect(() =>
      validateLlamaVersionOutput(
        "version: 10183 (different)\n" +
          "built with AppleClang for Darwin arm64\n"
      )
    ).toThrow(/pinned build/u);
    expect(() =>
      validateLlamaVersionOutput(
        "version: 10182 (afeebe103)\n" +
          "built with AppleClang for Linux x86_64\n"
      )
    ).toThrow(/Darwin arm64/u);
  });

  it("rejects redirects away from the approved GitHub asset hosts", async () => {
    await expect(
      downloadPinnedArchive(async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://example.invalid/llama.tar.gz"
          }
        })
      )
    ).rejects.toThrow(/approved release host/u);
  });

  it("rejects non-default HTTPS ports on approved redirect hosts", async () => {
    await expect(
      downloadPinnedArchive(async () =>
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://release-assets.githubusercontent.com:444/llama.tar.gz"
          }
        })
      )
    ).rejects.toThrow(/non-default HTTPS port/u);
  });

  it("enforces an internal total deadline without a caller signal", async () => {
    vi.useFakeTimers();
    let lateBodyCancelled = false;
    try {
      const lateBody = new ReadableStream<Uint8Array>({
        cancel() {
          lateBodyCancelled = true;
        }
      });
      const pendingDownload = downloadPinnedArchive(
        async () => new Promise<Response>((resolvePromise) => {
          setTimeout(() => {
            resolvePromise(new Response(lateBody, { status: 200 }));
          }, RUNTIME_DOWNLOAD_TOTAL_TIMEOUT_MS + 100);
        })
      );
      const rejection = expect(pendingDownload).rejects.toThrow(/total deadline/u);
      await vi.advanceTimersByTimeAsync(
        RUNTIME_DOWNLOAD_TOTAL_TIMEOUT_MS + 1
      );
      await rejection;
      expect(lateBodyCancelled).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(lateBodyCancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces an internal idle deadline and cancels the response body", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    try {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        }
      });
      const pendingDownload = downloadPinnedArchive(async () =>
        new Response(body, {
          status: 200,
          headers: {
            "content-length": String(
              LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes
            )
          }
        })
      );
      const rejection = expect(pendingDownload).rejects.toThrow(/idle deadline/u);
      await vi.advanceTimersByTimeAsync(
        RUNTIME_DOWNLOAD_IDLE_TIMEOUT_MS + 1
      );
      await rejection;
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses an exact bounded buffer and cancels an overflowing body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array(
            LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes + 1
          )
        );
      },
      cancel() {
        cancelled = true;
      }
    });

    await expect(
      downloadPinnedArchive(async () =>
        new Response(body, {
          status: 200,
          headers: {
            "content-length": String(
              LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes
            )
          }
        })
      )
    ).rejects.toThrow(/exceeded its exact size/u);
    expect(cancelled).toBe(true);
  });

  it("binds the checked-in member manifest and source receipt to the code pin", async () => {
    const receiptDirectory = new URL(
      "../../../../third_party/llama.cpp/b10182/macos-arm64/",
      import.meta.url
    );
    const manifest = JSON.parse(
      await readFile(
        fileURLToPath(new URL("member-manifest.json", receiptDirectory)),
        "utf8"
      )
    ) as RuntimeMemberManifest;
    const receipt = JSON.parse(
      await readFile(
        fileURLToPath(new URL("source-receipt.json", receiptDirectory)),
        "utf8"
      )
    ) as {
      archive: { sha256: string };
      memberManifest: { canonicalSha256: string; members: number };
    };

    const canonicalManifestSha256 = sha256(canonicalJson(manifest));
    expect(canonicalManifestSha256).toBe(
      LLAMA_B10182_MACOS_ARM64_PIN.memberManifestCanonicalSha256
    );
    expect(receipt.memberManifest.canonicalSha256).toBe(
      canonicalManifestSha256
    );
    expect(receipt.memberManifest.members).toBe(manifest.members.length);
    expect(receipt.archive.sha256).toBe(
      LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256
    );
    validateArchiveMembers(manifest.members, manifest.payloadRoot);
  });
});

interface TarFixtureEntry {
  path: string;
  type: "directory" | "file" | "symlink" | "special";
  mode: number;
  data?: Buffer;
  linkTarget?: string;
  typeFlag?: string;
}

function createTarGz(entries: readonly TarFixtureEntry[]): Buffer {
  return gzipSync(createTar(entries), { level: 9 });
}

function createTar(entries: readonly TarFixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, entry.path);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, data.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (
      entry.typeFlag ??
      (entry.type === "file"
        ? "0"
        : entry.type === "directory"
          ? "5"
          : entry.type === "symlink"
            ? "2"
            : "9")
    ).charCodeAt(0);
    writeTarString(header, 157, 100, entry.linkTarget ?? "");
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const encodedChecksum = checksum.toString(8).padStart(6, "0");
    header.write(encodedChecksum, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header);
    if (data.byteLength > 0) {
      blocks.push(data);
      const padding = (512 - (data.byteLength % 512)) % 512;
      if (padding > 0) {
        blocks.push(Buffer.alloc(padding));
      }
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function writeTarString(
  header: Buffer,
  start: number,
  length: number,
  value: string
): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) {
    throw new Error("Fixture tar field is too long.");
  }
  bytes.copy(header, start);
}

function writeTarOctal(
  header: Buffer,
  start: number,
  length: number,
  value: number
): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  header.write(encoded, start, length - 1, "ascii");
  header[start + length - 1] = 0;
}

function directory(path: string): SafeArchiveMember {
  return {
    path,
    type: "directory",
    mode: 0o700,
    size: 0
  };
}

function file(path: string): SafeArchiveMember {
  return {
    path,
    type: "file",
    mode: 0o600,
    size: 0,
    sha256: sha256("")
  };
}

function link(path: string, linkTarget: string): SafeArchiveMember {
  return {
    path,
    type: "symlink",
    mode: 0o700,
    size: 0,
    linkTarget
  };
}
