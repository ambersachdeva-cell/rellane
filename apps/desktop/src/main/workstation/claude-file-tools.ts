/** Make each Claude file request reviewable without inheriting folder-wide permission. */
import { constants } from "node:fs";
import { lstat, realpath, open, mkdtemp, writeFile, chmod, unlink, rmdir } from "node:fs/promises";
import { resolve, relative, basename, join, sep, extname } from "node:path";
import { createHash } from "node:crypto";

export interface ClaudeFileReview {
  readonly title: string;
  readonly detail: string;
  allow(): Promise<Readonly<Record<string, unknown>>>;
  dispose(): Promise<void>;
}
const MAX_BYTES = 64_000;
const MAX_CHARS = 16_000;
const COPY_PREFIX = ".rellane-approved-read-";
const EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".svg", ".yaml", ".yml"]);
const SENSITIVE_NAME = /(?:^|[-_.])(?:credentials?|secrets?|tokens?|passwords?|private[-_]?keys?)(?:[-_.]|$)/iu;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("That is not a supported file request.");
  return value as Record<string, unknown>;
}
function text(bytes: Buffer): string {
  if (bytes.length > MAX_BYTES) throw new Error("This file is too large for one review. Select a smaller text file.");
  const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (value.length > MAX_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
    throw new Error("This request needs a smaller plain UTF-8 text file.");
  return value;
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Resolve only ordinary, visible text files under the folder chosen for this work. */
async function targetInFolder(cwd: string, requested: string): Promise<{ root: string; target: string }> {
  if (!requested || requested.length > 2048 || /[\u0000-\u001f\u007f]/u.test(requested)) throw new Error("That file path is not supported.");
  const root = await realpath(cwd);
  const target = resolve(root, requested);
  const within = relative(root, target);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || within.startsWith(sep)) throw new Error("Claude can only request files inside this work’s folder.");
  const pieces = within.split(sep);
  if (pieces.some(piece => piece.startsWith(".") || SENSITIVE_NAME.test(piece)) || !EXTENSIONS.has(extname(target).toLowerCase()))
    throw new Error("Hidden files, credentials and non-text files are outside this connection’s file tools.");
  let parent = root;
  for (const piece of pieces.slice(0, -1)) {
    parent = join(parent, piece);
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("A parent folder changed or is a symbolic link. Choose an ordinary folder.");
  }
  return { root, target };
}
interface FileVersion { readonly bytes: Buffer; readonly text: string; readonly fingerprint: string; }
async function readVersion(target: string): Promise<FileVersion | null> {
  let info;
  try { info = await lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES)
    throw new Error("This file must be a small regular file, without symbolic or hard links.");
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev || before.nlink !== 1 || before.size > MAX_BYTES)
      throw new Error("The file changed while it was being opened. Ask again.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const part = await file.read(buffer, length, buffer.length - length, length);
      if (part.bytesRead === 0) break;
      length += part.bytesRead;
    }
    const after = await file.stat();
    if (length > MAX_BYTES || after.size !== before.size || after.mtimeMs !== before.mtimeMs || length !== after.size)
      throw new Error("The file changed or became too large while it was being read. Ask again.");
    const bytes = buffer.subarray(0, length);
    return { bytes, text: text(bytes), fingerprint: `${before.dev}:${before.ino}:${digest(bytes)}` };
  } finally { await file.close(); }
}

export async function reviewClaudeFileAction(cwd: string, tool: string, input: unknown): Promise<ClaudeFileReview> {
  if (tool !== "Read" && tool !== "Write") throw new Error("This connection supports reviewed text reads and writes only.");
  const request = record(input);
  const allowed = tool === "Read" ? new Set(["file_path", "offset", "limit"]) : new Set(["file_path", "content"]);
  if (Object.keys(request).some(key => !allowed.has(key)) || typeof request["file_path"] !== "string")
    throw new Error("That file request contains unsupported options.");
  const requested = request["file_path"];
  const location = await targetInFolder(cwd, requested);
  const before = await readVersion(location.target);
  const nativeInput: Record<string, unknown> = { file_path: location.target };
  let nextText = "";
  if (tool === "Read") {
    if (!before) throw new Error("That file does not exist in this work’s folder.");
    for (const key of ["offset", "limit"]) {
      const value = request[key];
      if (value !== undefined) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100_000)
          throw new Error("That reading range is not supported.");
        nativeInput[key] = value;
      }
    }
  } else {
    if (typeof request["content"] !== "string") throw new Error("A write needs the complete proposed text.");
    nextText = text(Buffer.from(request["content"], "utf8"));
    if (nextText !== request["content"]) throw new Error("The proposed text is not valid UTF-8.");
    nativeInput["content"] = nextText;
  }
  const title = tool === "Read" ? `Share ${basename(location.target)} with Claude?`
    : `${before ? "Replace" : "Create"} ${basename(location.target)}?`;
  const detail = tool === "Read"
    ? `Claude will read a frozen copy of this text. This permission applies to this read only.\n\n${location.target}\n\n${before!.text}`
    : `Claude will ${before ? "replace this file" : "create this file"} with the proposed text. This permission applies to this write only.\n\n${location.target}\n\n${before ? `CURRENT TEXT\n${before.text}\n\n` : ""}PROPOSED TEXT\n${nextText}`;
  let disposed = false;
  let consumed = false;
  let copy: { directory: string; file: string; inode: number } | null = null;
  let preparingCopy: Promise<void> | null = null;
  async function removeCopy() {
    const entry = copy;
    copy = null;
    if (!entry) return;
    const info = await lstat(entry.directory).catch(() => null);
    // Never recursively remove a folder someone replaced or added files to.
    if (!info?.isDirectory() || info.isSymbolicLink() || info.ino !== entry.inode) return;
    await unlink(entry.file).catch(() => undefined);
    await rmdir(entry.directory).catch(() => undefined);
  }
  return {
    title, detail,
    async allow() {
      if (disposed || consumed) throw new Error("That file review is no longer available.");
      consumed = true;
      const currentLocation = await targetInFolder(cwd, requested);
      if (currentLocation.root !== location.root || currentLocation.target !== location.target) throw new Error("The work’s folder changed. Ask again.");
      const current = await readVersion(location.target);
      if (current?.fingerprint !== before?.fingerprint) throw new Error("The file changed after its review. Nothing was approved; ask again.");
      if (disposed) throw new Error("That file review was cancelled.");
      if (tool === "Write") return Object.freeze({ ...nativeInput });
      // Keep the actual Read result fixed even if the original changes after approval.
      // Stop may arrive during any await. Disposal waits for creation to settle,
      // so a late write cannot recreate a copy after cleanup has already run.
      let approvedPath = "";
      preparingCopy = (async () => {
        const directory = await mkdtemp(join(location.root, COPY_PREFIX));
        const file = join(directory, basename(location.target));
        copy = { directory, file, inode: (await lstat(directory)).ino };
        await chmod(directory, 0o700);
        await writeFile(file, before!.bytes, { flag: "wx", mode: 0o400 });
        approvedPath = file;
      })();
      try {
        await preparingCopy;
        if (disposed) throw new Error("That file review was cancelled.");
        return Object.freeze({ ...nativeInput, file_path: approvedPath });
      } catch (error) { await removeCopy(); throw error; }
    },
    async dispose() {
      disposed = true;
      await preparingCopy?.catch(() => undefined);
      await removeCopy();
    }
  };
}
