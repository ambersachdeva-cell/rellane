import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink
} from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  canonicalJson,
  inspectTarGzArchive,
  sha256,
  validateLlamaVersionOutput,
  type InspectedTarGzArchive,
  type RuntimeMemberManifest,
  type SafeArchiveMember
} from "./archive-safety.js";
export { LLAMA_B10182_MACOS_ARM64_PIN } from "./llama-b10182-macos-arm64-pin.js";
import { LLAMA_B10182_MACOS_ARM64_PIN } from "./llama-b10182-macos-arm64-pin.js";

const MAX_REDIRECTS = 5;
export const RUNTIME_DOWNLOAD_TOTAL_TIMEOUT_MS = 120_000;
export const RUNTIME_DOWNLOAD_IDLE_TIMEOUT_MS = 15_000;
const PINNED_REDIRECT_HOSTS = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com"
]);


export interface RuntimeAcquisitionOptions {
  resourceRoot: string;
  signal?: AbortSignal;
  fetchImpl?: PinnedFetch;
}

export interface RuntimeStagingOptions {
  resourceRoot: string;
  archive: Buffer;
  signal?: AbortSignal;
}

export interface StagedRuntimeReceipt {
  receiptVersion: 1;
  status: "verified-unsigned-staging";
  runtimeId: "llama.cpp";
  tag: "b10182";
  sourceCommit: string;
  target: "darwin-arm64";
  archiveSha256: string;
  memberManifestCanonicalSha256: string;
  versionOutput: string;
  signingRequired: true;
  notarizationRequired: true;
}

export interface StagedRuntime {
  stagingDirectory: string;
  payloadDirectory: string;
  serverPath: string;
  manifest: RuntimeMemberManifest;
  receipt: StagedRuntimeReceipt;
}

export type PinnedFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

/**
 * Downloads only the exact pinned upstream input and stages an unsigned,
 * verified payload. This does not activate the runtime. Switchboard signing,
 * notarization, and a native health test remain separate release gates.
 */
export async function acquirePinnedLlamaB10182MacosArm64(
  options: RuntimeAcquisitionOptions
): Promise<StagedRuntime> {
  const archive = await downloadPinnedArchive(
    options.fetchImpl ?? fetch,
    options.signal
  );
  return stagePinnedLlamaB10182MacosArm64Archive({
    resourceRoot: options.resourceRoot,
    archive,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
}

/**
 * Offline entry point used by controlled packaging jobs after an upstream
 * archive has already been acquired. Digest verification always occurs before
 * decompression or filesystem extraction.
 */
export async function stagePinnedLlamaB10182MacosArm64Archive(
  options: RuntimeStagingOptions
): Promise<StagedRuntime> {
  throwIfAborted(options.signal);
  const resourceRoot = validateResourceRoot(options.resourceRoot);
  const inspection = inspectTarGzArchive(
    options.archive,
    LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256,
    {
      expectedPayloadRoot: LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot,
      maxCompressedBytes: LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes,
      maxExpandedBytes: LLAMA_B10182_MACOS_ARM64_PIN.expandedArchiveBytes,
      maxMemberBytes: 16 * 1024 * 1024,
      maxMembers: 256,
      maxTotalFileBytes: 64 * 1024 * 1024
    }
  );
  if (
    inspection.expandedBytes !==
    LLAMA_B10182_MACOS_ARM64_PIN.expandedArchiveBytes
  ) {
    throw new Error("The runtime archive expanded size does not match the source receipt.");
  }
  if (
    inspection.manifestCanonicalSha256 !==
    LLAMA_B10182_MACOS_ARM64_PIN.memberManifestCanonicalSha256
  ) {
    throw new Error("The runtime archive member manifest does not match the source receipt.");
  }

  const stagedRoot = join(
    resourceRoot,
    ...LLAMA_B10182_MACOS_ARM64_PIN.resourceVersionPath
  );
  await mkdir(stagedRoot, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(
    join(stagedRoot, ".acquiring-b10182-darwin-arm64-")
  );
  await chmod(temporaryDirectory, 0o700);

  try {
    throwIfAborted(options.signal);
    await extractInspectedArchive(
      inspection,
      temporaryDirectory,
      options.signal
    );
    await verifyExtractedPayload(
      inspection.manifest,
      temporaryDirectory,
      options.signal
    );

    const serverPath = join(
      temporaryDirectory,
      LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath
    );
    const payloadDirectory = join(
      temporaryDirectory,
      LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot
    );
    await verifyRequiredFile(
      serverPath,
      LLAMA_B10182_MACOS_ARM64_PIN.serverSha256,
      "llama-server"
    );
    await verifyRequiredFile(
      join(
        temporaryDirectory,
        LLAMA_B10182_MACOS_ARM64_PIN.licenseRelativePath
      ),
      LLAMA_B10182_MACOS_ARM64_PIN.licenseSha256,
      "LICENSE"
    );

    throwIfAborted(options.signal);
    const versionOutput = await runPinnedVersionProbe(
      serverPath,
      payloadDirectory,
      options.signal
    );
    validateLlamaVersionOutput(versionOutput);

    const receipt: StagedRuntimeReceipt = {
      receiptVersion: 1,
      status: "verified-unsigned-staging",
      runtimeId: "llama.cpp",
      tag: "b10182",
      sourceCommit: LLAMA_B10182_MACOS_ARM64_PIN.sourceCommit,
      target: "darwin-arm64",
      archiveSha256: LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256,
      memberManifestCanonicalSha256:
        inspection.manifestCanonicalSha256,
      versionOutput: normalizeVersionOutput(versionOutput),
      signingRequired: true,
      notarizationRequired: true
    };
    await writeDurableJson(
      join(temporaryDirectory, "switchboard-runtime-member-manifest.json"),
      inspection.manifest
    );
    await writeDurableJson(
      join(temporaryDirectory, "switchboard-runtime-acquisition-receipt.json"),
      receipt
    );

    const finalDirectory = join(
      stagedRoot,
      inspection.manifestCanonicalSha256
    );
    await assertDestinationAbsent(finalDirectory);
    await rename(temporaryDirectory, finalDirectory);

    return {
      stagingDirectory: finalDirectory,
      payloadDirectory: join(
        finalDirectory,
        LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot
      ),
      serverPath: join(
        finalDirectory,
        LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath
      ),
      manifest: inspection.manifest,
      receipt
    };
  } catch (error) {
    await removeOwnedTemporaryDirectory(temporaryDirectory, stagedRoot);
    throw error;
  }
}

export async function downloadPinnedArchive(
  fetchImpl: PinnedFetch,
  signal?: AbortSignal
): Promise<Buffer> {
  const deadlineController = new AbortController();
  const combinedSignal = signal === undefined
    ? deadlineController.signal
    : AbortSignal.any([signal, deadlineController.signal]);
  const totalDeadlineError = new Error(
    "The pinned runtime download exceeded its total deadline."
  );
  const totalTimer = setTimeout(() => {
    deadlineController.abort(totalDeadlineError);
  }, RUNTIME_DOWNLOAD_TOTAL_TIMEOUT_MS);
  totalTimer.unref();

  try {
    return await downloadPinnedArchiveWithinDeadline(
      fetchImpl,
      combinedSignal,
      deadlineController
    );
  } catch (error) {
    if (deadlineController.signal.aborted) {
      throw abortReason(deadlineController.signal, totalDeadlineError);
    }
    if (signal?.aborted === true) {
      throw abortReason(signal, new Error("The runtime acquisition was cancelled."));
    }
    throw error;
  } finally {
    clearTimeout(totalTimer);
  }
}

async function downloadPinnedArchiveWithinDeadline(
  fetchImpl: PinnedFetch,
  signal: AbortSignal,
  deadlineController: AbortController
): Promise<Buffer> {
  let currentUrl = new URL(LLAMA_B10182_MACOS_ARM64_PIN.archiveUrl);
  const visited = new Set<string>();

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    throwIfAborted(signal);
    validateHttpsEndpoint(currentUrl);
    if (visited.has(currentUrl.href)) {
      throw new Error("The pinned runtime download entered a redirect loop.");
    }
    visited.add(currentUrl.href);

    const response = await awaitFetchWithAbort(
      fetchImpl(currentUrl.href, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
          "User-Agent": "Switchboard-Runtime-Acquisition/1"
        },
        signal
      }),
      signal
    );

    if (isRedirect(response.status)) {
      if (redirectCount === MAX_REDIRECTS) {
        requestResponseBodyCancellation(
          response.body,
          new Error("The pinned runtime download exceeded its redirect limit.")
        );
        throw new Error("The pinned runtime download exceeded its redirect limit.");
      }
      const location = response.headers.get("location");
      requestResponseBodyCancellation(
        response.body,
        new Error("The pinned runtime download is following a validated redirect.")
      );
      if (location === null) {
        throw new Error("The pinned runtime download returned a redirect without a location.");
      }
      const nextUrl = new URL(location, currentUrl);
      validatePinnedRedirect(currentUrl, nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    if (response.status !== 200 || response.body === null) {
      requestResponseBodyCancellation(
        response.body,
        new Error(`The pinned runtime download failed with HTTP ${response.status}.`)
      );
      throw new Error(`The pinned runtime download failed with HTTP ${response.status}.`);
    }
    const contentEncoding = response.headers.get("content-encoding");
    if (
      contentEncoding !== null &&
      contentEncoding.trim().toLowerCase() !== "identity"
    ) {
      requestResponseBodyCancellation(
        response.body,
        new Error("The pinned runtime download returned transformed bytes.")
      );
      throw new Error("The pinned runtime download returned transformed bytes.");
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      (
        !/^[0-9]+$/u.test(contentLength) ||
        Number.parseInt(contentLength, 10) !==
        LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes
      )
    ) {
      requestResponseBodyCancellation(
        response.body,
        new Error("The pinned runtime download size does not match its source receipt.")
      );
      throw new Error("The pinned runtime download size does not match its source receipt.");
    }

    const archive = await readExactPinnedBody(
      response.body,
      signal,
      deadlineController
    );
    if (sha256(archive) !== LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256) {
      requestResponseBodyCancellation(
        response.body,
        new Error("The pinned runtime download SHA-256 is invalid.")
      );
      throw new Error("The pinned runtime download SHA-256 is invalid.");
    }
    return archive;
  }

  throw new Error("The pinned runtime download did not produce an archive.");
}

async function readExactPinnedBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  deadlineController: AbortController
): Promise<Buffer> {
  const archive = Buffer.allocUnsafe(
    LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes
  );
  const reader = body.getReader();
  let receivedBytes = 0;
  let completed = false;

  try {
    while (true) {
      throwIfAborted(signal);
      const result = await readWithIdleDeadline(
        reader,
        signal,
        deadlineController
      );
      if (result.done) {
        break;
      }
      const chunk = Buffer.from(
        result.value.buffer,
        result.value.byteOffset,
        result.value.byteLength
      );
      if (chunk.byteLength === 0) {
        throw new Error("The pinned runtime download returned an empty body chunk.");
      }
      const nextReceivedBytes = receivedBytes + chunk.byteLength;
      if (
        !Number.isSafeInteger(nextReceivedBytes) ||
        nextReceivedBytes > archive.byteLength
      ) {
        throw new Error("The pinned runtime download exceeded its exact size.");
      }
      chunk.copy(archive, receivedBytes);
      receivedBytes = nextReceivedBytes;
    }
    if (receivedBytes !== archive.byteLength) {
      throw new Error("The pinned runtime download was truncated.");
    }
    completed = true;
    return archive;
  } catch (error) {
    requestReaderCancellation(reader, error);
    throw error;
  } finally {
    if (!completed && signal.aborted) {
      requestReaderCancellation(reader, abortReason(
        signal,
        new Error("The runtime acquisition was cancelled.")
      ));
    }
    try {
      reader.releaseLock();
    } catch {
      // A pending read owns the lock until cancellation settles.
    }
  }
}

async function readWithIdleDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  deadlineController: AbortController
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const idleDeadlineError = new Error(
    "The pinned runtime download exceeded its idle deadline."
  );
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const idleDeadline = new Promise<never>((_resolve, reject) => {
    idleTimer = setTimeout(() => {
      deadlineController.abort(idleDeadlineError);
      reject(idleDeadlineError);
    }, RUNTIME_DOWNLOAD_IDLE_TIMEOUT_MS);
    idleTimer.unref();
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      reject(abortReason(
        signal,
        new Error("The runtime acquisition was cancelled.")
      ));
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) {
      abortListener();
    }
  });

  try {
    return await Promise.race([
      reader.read(),
      idleDeadline,
      aborted
    ]);
  } finally {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    if (abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function awaitFetchWithAbort(
  pendingResponse: Promise<Response>,
  signal: AbortSignal
): Promise<Response> {
  throwIfAborted(signal);
  return new Promise((resolvePromise, rejectPromise) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      rejectPromise(abortReason(
        signal,
        new Error("The runtime acquisition was cancelled.")
      ));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    pendingResponse.then(
      (response) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted || signal.aborted) {
          requestResponseBodyCancellation(
            response.body,
            abortReason(
              signal,
              new Error("The runtime acquisition was cancelled.")
            )
          );
          return;
        }
        resolvePromise(response);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (!aborted) {
          rejectPromise(error);
        }
      }
    );
  });
}

async function extractInspectedArchive(
  inspection: InspectedTarGzArchive,
  destinationRoot: string,
  signal?: AbortSignal
): Promise<void> {
  const directories = inspection.extractionEntries
    .filter((entry) => entry.type === "directory")
    .sort((left, right) => pathDepth(left.path) - pathDepth(right.path));
  const files = inspection.extractionEntries
    .filter((entry) => entry.type === "file")
    .sort(comparePaths);
  const links = inspection.extractionEntries
    .filter((entry) => entry.type === "symlink")
    .sort(comparePaths);

  for (const directory of directories) {
    throwIfAborted(signal);
    const destination = safeDestination(destinationRoot, directory.path);
    await mkdir(destination, {
      recursive: false,
      mode: safeDirectoryMode(directory.mode)
    });
    await chmod(destination, safeDirectoryMode(directory.mode));
  }
  for (const file of files) {
    throwIfAborted(signal);
    if (file.data === undefined || file.data.byteLength !== file.size) {
      throw new Error(`Archive file data is missing: ${file.path}`);
    }
    const destination = safeDestination(destinationRoot, file.path);
    const handle = await open(
      destination,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      safeFileMode(file.mode)
    );
    try {
      await handle.writeFile(file.data);
      await handle.chmod(safeFileMode(file.mode));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  for (const link of links) {
    throwIfAborted(signal);
    if (link.linkTarget === undefined) {
      throw new Error(`Archive symbolic-link target is missing: ${link.path}`);
    }
    await symlink(
      link.linkTarget,
      safeDestination(destinationRoot, link.path)
    );
  }
}

async function verifyExtractedPayload(
  manifest: RuntimeMemberManifest,
  destinationRoot: string,
  signal?: AbortSignal
): Promise<void> {
  for (const member of manifest.members) {
    throwIfAborted(signal);
    const destination = safeDestination(destinationRoot, member.path);
    const status = await lstat(destination);
    if (member.type === "directory") {
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new Error(`Extracted runtime directory has the wrong type: ${member.path}`);
      }
    } else if (member.type === "file") {
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error(`Extracted runtime file has the wrong type: ${member.path}`);
      }
      if (status.size !== member.size || sha256(await readFile(destination)) !== member.sha256) {
        throw new Error(`Extracted runtime file failed verification: ${member.path}`);
      }
    } else {
      if (!status.isSymbolicLink()) {
        throw new Error(`Extracted runtime link has the wrong type: ${member.path}`);
      }
      if (await readlink(destination) !== member.linkTarget) {
        throw new Error(`Extracted runtime link target changed: ${member.path}`);
      }
    }
  }
}

async function verifyRequiredFile(
  path: string,
  expectedSha256: string,
  displayName: string
): Promise<void> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`The runtime is missing required regular file ${displayName}.`);
  }
  if (sha256(await readFile(path)) !== expectedSha256) {
    throw new Error(`The runtime ${displayName} digest does not match the source receipt.`);
  }
}

async function runPinnedVersionProbe(
  executablePath: string,
  workingDirectory: string,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal);
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      executablePath,
      ["--version"],
      {
        cwd: workingDirectory,
        encoding: "utf8",
        env: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin"
        },
        maxBuffer: 64 * 1024,
        timeout: 10_000,
        ...(signal === undefined ? {} : { signal })
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectPromise(new Error("The pinned llama-server version probe failed."));
          return;
        }
        resolvePromise(`${stdout}${stderr}`);
      }
    );
  });
}

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  const serialized = `${canonicalJson(value)}\n`;
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validatePinnedRedirect(currentUrl: URL, nextUrl: URL): void {
  validateHttpsEndpoint(currentUrl);
  validateHttpsEndpoint(nextUrl);
  if (
    currentUrl.href === LLAMA_B10182_MACOS_ARM64_PIN.archiveUrl &&
    !PINNED_REDIRECT_HOSTS.has(nextUrl.hostname)
  ) {
    throw new Error("The pinned runtime download left the approved release host.");
  }
  if (
    currentUrl.href !== LLAMA_B10182_MACOS_ARM64_PIN.archiveUrl &&
    !PINNED_REDIRECT_HOSTS.has(currentUrl.hostname)
  ) {
    throw new Error("The pinned runtime download has an unapproved redirect origin.");
  }
  if (!PINNED_REDIRECT_HOSTS.has(nextUrl.hostname)) {
    throw new Error("The pinned runtime download reached an unapproved asset host.");
  }
}

function validateHttpsEndpoint(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.username.length !== 0 ||
    url.password.length !== 0
  ) {
    throw new Error("The pinned runtime download attempted an unsafe HTTPS endpoint.");
  }
  if (url.port !== "") {
    throw new Error("The pinned runtime download attempted a non-default HTTPS port.");
  }
}

function validateResourceRoot(resourceRoot: string): string {
  if (
    resourceRoot.length === 0 ||
    resourceRoot.includes("\0") ||
    !isAbsolute(resourceRoot) ||
    resolve(resourceRoot) !== resourceRoot
  ) {
    throw new Error("The runtime resource root must be a canonical absolute path.");
  }
  return resourceRoot;
}

function safeDestination(root: string, relativePath: string): string {
  const destination = resolve(root, relativePath);
  if (!destination.startsWith(`${root}${sep}`)) {
    throw new Error("The runtime archive destination escaped its staging root.");
  }
  return destination;
}

function safeFileMode(mode: number): number {
  return (mode & 0o111) === 0 ? 0o600 : 0o700;
}

function safeDirectoryMode(_mode: number): number {
  return 0o700;
}

function isRedirect(status: number): boolean {
  return status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308;
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function comparePaths(
  left: Pick<SafeArchiveMember, "path">,
  right: Pick<SafeArchiveMember, "path">
): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function normalizeVersionOutput(output: string): string {
  return output.replace(/\r\n/gu, "\n").trim();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The runtime acquisition was cancelled.");
  }
}

function abortReason(signal: AbortSignal, fallback: Error): Error {
  return signal.reason instanceof Error ? signal.reason : fallback;
}

function requestResponseBodyCancellation(
  body: ReadableStream<Uint8Array> | null,
  reason: unknown
): void {
  if (body === null) {
    return;
  }
  try {
    void body.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation is best effort and must not block the bounded failure path.
  }
}

function requestReaderCancellation(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown
): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation is best effort and must not block the bounded failure path.
  }
}

async function assertDestinationAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("The deterministic runtime staging destination already exists.");
}

async function removeOwnedTemporaryDirectory(
  temporaryDirectory: string,
  stagedRoot: string
): Promise<void> {
  const requiredPrefix = `${stagedRoot}${sep}.acquiring-b10182-darwin-arm64-`;
  if (!temporaryDirectory.startsWith(requiredPrefix)) {
    throw new Error("Refused to clean an unowned runtime acquisition directory.");
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
