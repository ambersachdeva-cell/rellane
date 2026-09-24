import { createHash } from "node:crypto";
import { posix } from "node:path";
import { gunzipSync } from "node:zlib";

const TAR_BLOCK_BYTES = 512;
const TAR_END_BLOCKS = 2;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type SafeArchiveMemberType = "directory" | "file" | "symlink";

export interface SafeArchiveMember {
  path: string;
  type: SafeArchiveMemberType;
  mode: number;
  size: number;
  sha256?: string;
  linkTarget?: string;
}

export interface RuntimeMemberManifest {
  schemaVersion: 1;
  archiveSha256: string;
  payloadRoot: string;
  members: SafeArchiveMember[];
}

export interface ArchiveInspectionLimits {
  expectedPayloadRoot: string;
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxMemberBytes: number;
  maxMembers: number;
  maxTotalFileBytes: number;
}

export interface InspectedTarGzArchive {
  manifest: RuntimeMemberManifest;
  manifestCanonicalSha256: string;
  expandedBytes: number;
  extractionEntries: readonly ExtractionEntry[];
}

interface ExtractionEntry extends SafeArchiveMember {
  data?: Buffer;
}

export function inspectTarGzArchive(
  archive: Buffer,
  expectedArchiveSha256: string,
  limits: ArchiveInspectionLimits
): InspectedTarGzArchive {
  if (archive.byteLength === 0 || archive.byteLength > limits.maxCompressedBytes) {
    throw new Error("The runtime archive is empty or exceeds the compressed-size limit.");
  }

  const observedArchiveSha256 = sha256(archive);
  if (!constantTimeDigestMatch(observedArchiveSha256, expectedArchiveSha256)) {
    throw new Error("The runtime archive SHA-256 does not match the pinned source receipt.");
  }

  let expanded: Buffer;
  try {
    expanded = gunzipSync(archive, {
      maxOutputLength: limits.maxExpandedBytes
    });
  } catch {
    throw new Error("The runtime archive is not a valid bounded gzip stream.");
  }
  if (expanded.byteLength === 0 || expanded.byteLength > limits.maxExpandedBytes) {
    throw new Error("The runtime archive exceeds the expanded-size limit.");
  }

  const extractionEntries = parseTar(expanded, limits);
  validateArchiveMembers(extractionEntries, limits.expectedPayloadRoot);

  const members = extractionEntries
    .map(({ data: _data, ...member }) => member)
    .sort(compareMembers);
  const manifest: RuntimeMemberManifest = {
    schemaVersion: 1,
    archiveSha256: observedArchiveSha256,
    payloadRoot: limits.expectedPayloadRoot,
    members
  };

  return {
    manifest,
    manifestCanonicalSha256: sha256(Buffer.from(canonicalJson(manifest), "utf8")),
    expandedBytes: expanded.byteLength,
    extractionEntries
  };
}

export function validateArchiveMembers(
  members: readonly SafeArchiveMember[],
  expectedPayloadRoot: string
): void {
  const canonicalRoot = validateMemberPath(expectedPayloadRoot, false);
  if (canonicalRoot.includes("/")) {
    throw new Error("The expected archive payload root must be one directory name.");
  }

  const membersByPath = new Map<string, SafeArchiveMember>();
  for (const member of members) {
    if (
      member.type !== "directory" &&
      member.type !== "file" &&
      member.type !== "symlink"
    ) {
      throw new Error(`Archive contains a forbidden special member type: ${member.path}`);
    }
    const canonicalPath = validateMemberPath(member.path, member.type === "directory");
    if (canonicalPath !== member.path) {
      throw new Error(`Archive member path is not canonical: ${member.path}`);
    }
    if (
      canonicalPath !== canonicalRoot &&
      !canonicalPath.startsWith(`${canonicalRoot}/`)
    ) {
      throw new Error(`Archive member escapes the pinned payload root: ${member.path}`);
    }
    if (membersByPath.has(canonicalPath)) {
      throw new Error(`Archive contains a duplicate member path: ${member.path}`);
    }
    if (!Number.isSafeInteger(member.mode) || member.mode < 0 || member.mode > 0o777) {
      throw new Error(`Archive member has an unsafe mode: ${member.path}`);
    }
    if (!Number.isSafeInteger(member.size) || member.size < 0) {
      throw new Error(`Archive member has an invalid size: ${member.path}`);
    }
    if (member.type !== "file" && member.size !== 0) {
      throw new Error(`Non-file archive member declares data: ${member.path}`);
    }
    if (member.type === "file") {
      if (
        member.sha256 !== undefined &&
        !/^[a-f0-9]{64}$/u.test(member.sha256)
      ) {
        throw new Error(`Archive member has an invalid SHA-256: ${member.path}`);
      }
      if (member.linkTarget !== undefined) {
        throw new Error(`Regular archive member has a link target: ${member.path}`);
      }
    } else if (member.type === "directory") {
      if (member.sha256 !== undefined || member.linkTarget !== undefined) {
        throw new Error(`Directory archive member has file or link metadata: ${member.path}`);
      }
    } else {
      if (member.sha256 !== undefined) {
        throw new Error(`Symbolic link archive member has a file digest: ${member.path}`);
      }
      validateLinkTarget(member.linkTarget, member.path);
    }
    membersByPath.set(canonicalPath, member);
  }

  const rootMember = membersByPath.get(canonicalRoot);
  if (rootMember?.type !== "directory") {
    throw new Error("The runtime archive is missing its pinned root directory.");
  }

  for (const member of members) {
    const pathParts = member.path.split("/");
    for (let index = 1; index < pathParts.length; index += 1) {
      const ancestorPath = pathParts.slice(0, index).join("/");
      const ancestor = membersByPath.get(ancestorPath);
      if (ancestor?.type === "symlink") {
        throw new Error(`Archive member is nested below a symbolic link: ${member.path}`);
      }
      if (ancestor === undefined) {
        throw new Error(`Archive member is missing a declared parent directory: ${member.path}`);
      }
      if (ancestor !== undefined && ancestor.type !== "directory") {
        throw new Error(`Archive member is nested below a non-directory: ${member.path}`);
      }
    }
    if (member.type === "symlink") {
      resolveLinkToRegularFile(member, membersByPath, canonicalRoot);
    }
  }
}

export function validateLlamaVersionOutput(output: string): void {
  if (output.length === 0 || output.length > 64 * 1024 || output.includes("\0")) {
    throw new Error("llama-server returned an invalid version response.");
  }
  const normalized = output.replace(/\r\n/gu, "\n");
  if (!/^version: 10182 \(afeebe103\)$/mu.test(normalized)) {
    throw new Error("llama-server does not match pinned build 10182 and commit afeebe103.");
  }
  if (!/^built with .+ for Darwin arm64$/mu.test(normalized)) {
    throw new Error("llama-server does not identify the pinned Darwin arm64 target.");
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot canonicalize a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Cannot canonicalize an unsupported value.");
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseTar(
  tar: Buffer,
  limits: ArchiveInspectionLimits
): ExtractionEntry[] {
  const entries: ExtractionEntry[] = [];
  let offset = 0;
  let totalFileBytes = 0;
  let foundTerminator = false;

  while (offset + TAR_BLOCK_BYTES <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      const secondEndBlockOffset = offset + TAR_BLOCK_BYTES;
      if (
        secondEndBlockOffset + TAR_BLOCK_BYTES > tar.byteLength ||
        !isZeroBlock(
          tar.subarray(
            secondEndBlockOffset,
            secondEndBlockOffset + TAR_BLOCK_BYTES
          )
        )
      ) {
        throw new Error("The tar archive does not contain two end-of-archive blocks.");
      }
      if (
        tar
          .subarray(secondEndBlockOffset + TAR_BLOCK_BYTES)
          .some((byte) => byte !== 0)
      ) {
        throw new Error("The tar archive contains hidden data after its terminator.");
      }
      foundTerminator = true;
      break;
    }

    validateTarHeaderChecksum(header);
    const magic = readTarString(header, 257, 6);
    if (magic !== "ustar") {
      throw new Error("The runtime archive is not a supported ustar archive.");
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const rawPath = prefix.length === 0 ? name : `${prefix}/${name}`;
    const mode = readTarOctal(header, 100, 8, "mode");
    const size = readTarOctal(header, 124, 12, "size");
    const linkTarget = readTarString(header, 157, 100);
    const typeFlag = header[156];
    const type = parseTarType(typeFlag);

    if (entries.length >= limits.maxMembers) {
      throw new Error("The runtime archive contains too many members.");
    }
    if (size > limits.maxMemberBytes) {
      throw new Error(`Archive member exceeds its size limit: ${rawPath}`);
    }
    if (type !== "file" && size !== 0) {
      throw new Error(`Special archive member declares data: ${rawPath}`);
    }

    const dataStart = offset + TAR_BLOCK_BYTES;
    const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    const nextOffset = dataStart + paddedSize;
    if (
      !Number.isSafeInteger(nextOffset) ||
      nextOffset < dataStart ||
      nextOffset > tar.byteLength
    ) {
      throw new Error(`Archive member data is truncated: ${rawPath}`);
    }

    const canonicalPath = validateMemberPath(rawPath, type === "directory");
    if (type === "file") {
      totalFileBytes += size;
      if (
        !Number.isSafeInteger(totalFileBytes) ||
        totalFileBytes > limits.maxTotalFileBytes
      ) {
        throw new Error("The runtime archive exceeds its total file-size limit.");
      }
      const data = tar.subarray(dataStart, dataStart + size);
      entries.push({
        path: canonicalPath,
        type,
        mode,
        size,
        sha256: sha256(data),
        data
      });
    } else if (type === "directory") {
      entries.push({
        path: canonicalPath,
        type,
        mode,
        size
      });
    } else {
      entries.push({
        path: canonicalPath,
        type,
        mode,
        size,
        linkTarget
      });
    }
    offset = nextOffset;
  }

  if (!foundTerminator) {
    throw new Error("The tar archive is missing its end-of-archive marker.");
  }
  return entries;
}

function parseTarType(typeFlag: number | undefined): SafeArchiveMemberType {
  if (typeFlag === 0 || typeFlag === 0x30) {
    return "file";
  }
  if (typeFlag === 0x35) {
    return "directory";
  }
  if (typeFlag === 0x32) {
    return "symlink";
  }
  throw new Error("The runtime archive contains a forbidden special member type.");
}

function validateTarHeaderChecksum(header: Buffer): void {
  const expected = readTarOctal(header, 148, 8, "checksum");
  let observed = 0;
  for (let index = 0; index < header.length; index += 1) {
    observed += index >= 148 && index < 156 ? 0x20 : header[index] ?? 0;
  }
  if (observed !== expected) {
    throw new Error("The tar archive contains a header with an invalid checksum.");
  }
}

function readTarString(
  header: Buffer,
  start: number,
  length: number
): string {
  const field = header.subarray(start, start + length);
  const nulIndex = field.indexOf(0);
  const value = nulIndex === -1 ? field : field.subarray(0, nulIndex);
  try {
    return utf8Decoder.decode(value);
  } catch {
    throw new Error("The tar archive contains invalid UTF-8 metadata.");
  }
}

function readTarOctal(
  header: Buffer,
  start: number,
  length: number,
  label: string
): number {
  const field = header.subarray(start, start + length);
  if (((field[0] ?? 0) & 0x80) !== 0) {
    throw new Error(`The tar archive uses unsupported base-256 ${label} metadata.`);
  }
  const raw = field.toString("ascii").replace(/\0.*$/u, "").trim();
  if (!/^[0-7]+$/u.test(raw)) {
    throw new Error(`The tar archive contains invalid ${label} metadata.`);
  }
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`The tar archive contains unsafe ${label} metadata.`);
  }
  return parsed;
}

function validateMemberPath(rawPath: string, allowTrailingSlash: boolean): string {
  if (
    rawPath.length === 0 ||
    rawPath.length > 4_096 ||
    rawPath.includes("\0") ||
    rawPath.includes("\\") ||
    rawPath.startsWith("/") ||
    /^[A-Za-z]:/u.test(rawPath) ||
    /[\u0000-\u001f\u007f]/u.test(rawPath)
  ) {
    throw new Error(`Archive contains an unsafe member path: ${rawPath}`);
  }

  const path = allowTrailingSlash && rawPath.endsWith("/")
    ? rawPath.slice(0, -1)
    : rawPath;
  const parts = path.split("/");
  if (
    path.length === 0 ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        Buffer.byteLength(part, "utf8") > 255
    ) ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`Archive contains a non-canonical member path: ${rawPath}`);
  }
  return path;
}

function validateLinkTarget(
  linkTarget: string | undefined,
  memberPath: string
): asserts linkTarget is string {
  if (
    linkTarget === undefined ||
    linkTarget.length === 0 ||
    linkTarget.length > 4_096 ||
    linkTarget.includes("\0") ||
    linkTarget.includes("\\") ||
    linkTarget.startsWith("/") ||
    /^[A-Za-z]:/u.test(linkTarget) ||
    /[\u0000-\u001f\u007f]/u.test(linkTarget)
  ) {
    throw new Error(`Archive contains an unsafe symbolic-link target: ${memberPath}`);
  }
  const parts = linkTarget.split("/");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        Buffer.byteLength(part, "utf8") > 255
    ) ||
    posix.normalize(linkTarget) !== linkTarget
  ) {
    throw new Error(`Archive contains a non-canonical symbolic-link target: ${memberPath}`);
  }
}

function resolveLinkToRegularFile(
  start: SafeArchiveMember,
  membersByPath: ReadonlyMap<string, SafeArchiveMember>,
  payloadRoot: string
): void {
  let current = start;
  const visited = new Set<string>();

  while (current.type === "symlink") {
    if (visited.has(current.path)) {
      throw new Error(`Archive contains a symbolic-link cycle: ${start.path}`);
    }
    visited.add(current.path);
    validateLinkTarget(current.linkTarget, current.path);
    const targetPath = posix.join(posix.dirname(current.path), current.linkTarget);
    if (
      targetPath !== payloadRoot &&
      !targetPath.startsWith(`${payloadRoot}/`)
    ) {
      throw new Error(`Archive symbolic link escapes the payload root: ${start.path}`);
    }
    const target = membersByPath.get(targetPath);
    if (target === undefined) {
      throw new Error(`Archive symbolic link has no declared target: ${start.path}`);
    }
    current = target;
  }

  if (current.type !== "file") {
    throw new Error(`Archive symbolic link does not resolve to a regular file: ${start.path}`);
  }
}

function compareMembers(left: SafeArchiveMember, right: SafeArchiveMember): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function constantTimeDigestMatch(observed: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error("The pinned archive SHA-256 is malformed.");
  }
  let difference = 0;
  for (let index = 0; index < observed.length; index += 1) {
    difference |= observed.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
