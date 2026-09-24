/** A checksum must not read beyond the folder the owner granted. Resolve against
 * the host's grant snapshot, refuse links at open, then read one pinned file. */
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import type { ContentDigest } from "@cadrane/contracts";
import { resolveInSandbox, SandboxError, type Sandbox } from "../tools/sandbox.js";

export const MAX_HASH_BYTES = 512 * 1024 * 1024;
// Darwin's public open(2) flag rejects links in EVERY path component. Node's
// O_NOFOLLOW checks only the leaf. Numeric flags pass through fs.open to open(2).
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/open.2
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const CHANGED = "The file or its folder changed during this check. No result was kept. Try again after it settles.";
const WITHDRAWN = "Folder access changed during this check. No result was kept.";
const LINK = "That path contains a link or leaves the granted folder. Check the original file in its own granted folder.";

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameVersion(a: BigIntStats, b: BigIntStats): boolean {
  return sameFile(a, b) && b.isFile() && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** No portable fallback silently drops the kernel path guard. The shipped app
 * is macOS; another OS needs its own verified safe-open primitive first. */
export async function hashGrantedFile(
  folder: string, path: string, currentGrant: () => Sandbox | null,
  maximumBytes = MAX_HASH_BYTES
): Promise<ContentDigest> {
  const { content: _content, ...result } = await readGrantedFile(folder, path, currentGrant, maximumBytes, false);
  return result;
}

/** A small snapshot uses the very same pinned read as a checksum. Nothing is
 * released to the caller until final grant and file-version checks pass. */
export function snapshotGrantedFile(
  folder: string, path: string, currentGrant: () => Sandbox | null
): Promise<ContentDigest & { content: Buffer | null }> {
  return readGrantedFile(folder, path, currentGrant, 32_768, true);
}

async function readGrantedFile(
  folder: string, path: string, currentGrant: () => Sandbox | null,
  maximumBytes: number, keepContent: boolean
): Promise<ContentDigest & { content: Buffer | null }> {
  const spelling = normalize(folder);
  const grant = currentGrant();
  const index = grant?.spelledRoots.indexOf(spelling) ?? -1;
  if (!grant || index < 0) throw new Error("That folder has not been granted to Rellane.");
  const root = grant.roots[index]!;
  const scope: Sandbox = { roots: [root], spelledRoots: [spelling] };
  const back = relative(spelling, normalize(join(spelling, path)));
  if (isAbsolute(path) || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back))
    throw new Error("That is not a path inside the folder.");
  const refusal = (problem: string) => ({ path, digest: null, problem, content: null });
  if (back.split(sep).some(part => part.startsWith(".")))
    return refusal("Hidden files and configuration folders cannot be read here.");
  if (process.platform !== "darwin")
    return refusal("Safe file checks are not yet available on this operating system.");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAX_HASH_BYTES)
    throw new Error("Invalid checksum read limit.");

  const target = join(root, back);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const assertGranted = () => {
      const now = currentGrant();
      const at = now?.spelledRoots.indexOf(spelling) ?? -1;
      if (!now || now !== grant || at < 0 || now.roots[at] !== root) throw new Error(WITHDRAWN);
    };
    assertGranted();
    // Do not rebind a previously granted spelling to a new symlink target.
    if (await realpath(spelling) !== root) return refusal(LINK);
    const folderInfo = await lstat(root, { bigint: true });
    if (!folderInfo.isDirectory()) return refusal(LINK);
    if (await realpath(target) !== target ||
        await resolveInSandbox(scope, target, { mustExist: true }) !== target) return refusal(LINK);
    const info = await lstat(target, { bigint: true });
    if (info.isSymbolicLink()) return refusal(LINK);
    if (!info.isFile()) return refusal("That file is not there any more.");
    if (keepContent && info.size > BigInt(maximumBytes))
      return refusal("Choose a text file of 32 KB or less for this preview.");
    if (info.size > BigInt(maximumBytes))
      return refusal(`That file is ${Math.round(Number(info.size) / 1024 / 1024)} MB. Rellane will not read all of it just to compare a checksum.`);

    assertGranted();
    // O_NONBLOCK prevents a raced FIFO/device open from waiting for input. Its
    // descriptor still has to match the regular file inspected above.
    handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | DARWIN_O_NOFOLLOW_ANY);
    const pinned = handle;
    const assertUnchanged = async () => {
      assertGranted();
      if (await realpath(spelling) !== root ||
          !sameFile(folderInfo, await lstat(root, { bigint: true })) ||
          await resolveInSandbox(scope, target, { mustExist: true }) !== target ||
          !sameVersion(info, await lstat(target, { bigint: true })) ||
          !sameVersion(info, await pinned.stat({ bigint: true }))) throw new Error(CHANGED);
      assertGranted();
    };
    await assertUnchanged();
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    const length = Number(info.size);
    let read = 0;
    // Bound actual requested bytes, not just the earlier stat. A growing file
    // cannot extend this read; the final version check rejects its digest.
    while (read < length) {
      assertGranted();
      const next = await pinned.read(buffer, 0, Math.min(buffer.length, length - read), read);
      assertGranted();
      if (next.bytesRead === 0) throw new Error(CHANGED);
      hash.update(buffer.subarray(0, next.bytesRead));
      if (keepContent) chunks.push(Buffer.from(buffer.subarray(0, next.bytesRead)));
      read += next.bytesRead;
    }
    await assertUnchanged();
    return { path, digest: hash.digest("hex"), problem: null, content: keepContent ? Buffer.concat(chunks) : null };
  } catch (error) {
    if (error instanceof SandboxError) return refusal(LINK);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return refusal("That file is not there any more.");
    if (code === "ELOOP") return refusal(LINK);
    const message = error instanceof Error ? error.message : "";
    return refusal(message === CHANGED || message === WITHDRAWN ? message : "That file could not be read.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
