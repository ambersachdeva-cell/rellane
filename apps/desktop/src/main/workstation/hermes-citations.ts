/**
 * The citation link checker.
 *
 * One bounded Python run, started by the host: a fixed interpreter, a fixed
 * bridge script, and the pinned upstream `sources.py` whose bytes are hashed
 * before the child is spawned. Nothing here takes a path, an argument or a
 * fragment of code from the renderer — `runtimeOptions` exists for tests and
 * for install-time wiring in the main process, never for IPC input.
 *
 * The child's output is data, not truth: it is parsed against a strict schema,
 * and the source list and the disclaimer shown to the person are re-imposed
 * here so a wrong or altered child cannot weaken either.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WorkstationCitationCheckResultSchema,
  WORKSTATION_CITATION_DRAFT_LIMIT,
  WORKSTATION_CITATION_SOURCES_TEXT_LIMIT,
  WORKSTATION_SOURCE_LIMIT,
  type WorkstationCitationCheckResult,
  type WorkstationCitationSource
} from "@cadrane/contracts";

export const PINNED_SOURCES_PY_SHA256 = "a867ae6ba99166b4114bfef1c15b57036e286fe22c48534caec28cc8335bde0c";
export const PINNED_HERMES_HOME_PY_SHA256 = "4bfa31ce48ffaca3ae3fdd2ba5f093a2bedc34b057eec22a38f46e2d68b333d4";

/** The only claim this feature is allowed to make, imposed on every result. */
export const CITATION_DISCLAIMER =
  "Checks numbered [n] references against the sources you selected on this Mac. " +
  "It does not check other citation styles, and it does not judge whether any claim is true.";

export const QUOTE_CHECK_NOTE_NORMAL =
  "Checks inline quotes followed by one source reference. Matches ignore case, spacing and Markdown. A match does not prove the claim.";
export const QUOTE_CHECK_NOTE_BOUNDED =
  "Checks inline quotes followed by one source reference. Matches ignore case, spacing and Markdown. A match does not prove the claim. Only the first 40 quoted passages were checked.";
export const QUOTE_CHECK_NOTE_NONE = "No quoted passages were checked.";

export const MAX_OUTPUT_CAP_BYTES = 65_536;
export const MAX_STDERR_CAP_BYTES = 8_192;
export const MAX_CHILD_LIFETIME_MS = 10_000;
export const TEMP_DIR_PREFIX = "rellane-citations-";

/** Isolated, no site dir, no bytecode, UTF-8 regardless of the locale. */
export const PYTHON_ARGS = ["-I", "-S", "-B", "-X", "utf8"] as const;

/**
 * `/usr/bin/python3` is a stub on macOS until the developer tools are present,
 * and spawning the stub raises Apple's installer dialog out of a background
 * check. Real interpreters only, in a fixed order.
 */
export const PYTHON_CANDIDATES = [
  "/Library/Developer/CommandLineTools/usr/bin/python3",
  "/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3"
] as const;

export const DEFAULT_PYTHON_PATH = PYTHON_CANDIDATES[0];

const VENDOR_SCRIPTS_RELATIVE = path.join(
  "vendor",
  "hermes-agent",
  "skills",
  "research",
  "grounded-citations",
  "scripts"
);

export interface HermesCitationsRuntimeOptions {
  readonly pythonPath?: string;
  readonly upstreamScriptsDir?: string;
  readonly bridgeScriptPath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface CheckHermesCitationsInput {
  readonly caseId: string;
  readonly draft: string;
  readonly sources: readonly {
    readonly sourceTurnId: string;
    readonly label: string;
    readonly body?: string;
  }[];
  readonly runtimeOptions?: HermesCitationsRuntimeOptions;
}

export type BridgeParseOutcome =
  | { readonly ok: true; readonly result: WorkstationCitationCheckResult }
  | { readonly ok: false; readonly reason: string };

export function resolvePythonPath(custom?: string): string | null {
  if (custom) return existsSync(custom) ? custom : null;
  for (const candidate of PYTHON_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Defaults are for source tests. The IPC host supplies fixed dev/packaged paths. */
export function resolveHermesScriptsDir(customDir?: string): string {
  return customDir ?? path.resolve(__dirname, "../../../../..", VENDOR_SCRIPTS_RELATIVE);
}

export function resolveBridgeScriptPath(customPath?: string): string {
  return customPath ?? path.resolve(__dirname, "../../../scripts/hermes-citations-bridge.py");
}

export async function verifyUpstreamHashes(scriptsDir: string): Promise<void> {
  const sourcesPath = path.join(scriptsDir, "sources.py");
  const hermesHomePath = path.join(scriptsDir, "_hermes_home.py");

  const [sourcesContent, hermesHomeContent] = await Promise.all([
    fs.readFile(sourcesPath).catch(() => {
      throw new Error(`Upstream sources.py missing at ${sourcesPath}`);
    }),
    fs.readFile(hermesHomePath).catch(() => {
      throw new Error(`Upstream _hermes_home.py missing at ${hermesHomePath}`);
    })
  ]);

  const sourcesHash = createHash("sha256").update(sourcesContent).digest("hex");
  const hermesHomeHash = createHash("sha256").update(hermesHomeContent).digest("hex");

  if (sourcesHash !== PINNED_SOURCES_PY_SHA256) {
    throw new Error(`sources.py hash mismatch: expected ${PINNED_SOURCES_PY_SHA256}, got ${sourcesHash}`);
  }
  if (hermesHomeHash !== PINNED_HERMES_HOME_PY_SHA256) {
    throw new Error(`_hermes_home.py hash mismatch: expected ${PINNED_HERMES_HOME_PY_SHA256}, got ${hermesHomeHash}`);
  }
}

function unavailable(
  sources: readonly WorkstationCitationSource[],
  summary: string,
  errors: readonly string[]
): WorkstationCitationCheckResult {
  return {
    status: "unavailable",
    summary,
    disclaimer: CITATION_DISCLAIMER,
    sources,
    citedIds: [],
    unknownReferences: [],
    missingFromSourcesBlock: [],
    unexpectedInSourcesBlock: [],
    mismatchedUrls: [],
    expectedSourcesBlock: "",
    warnings: [],
    errors,
    quotes: [],
    quoteCheckNote: QUOTE_CHECK_NOTE_NONE
  };
}

/**
 * Read the child's stdout as data.
 *
 * The schema is strict, so an unknown key or a wrong type is a failure rather
 * than something that reaches the renderer. The source list and the disclaimer
 * come from this process, and a result that says `ok` while carrying errors,
 * unknown references, or an id that was never selected is downgraded — the
 * child does not get to award a pass.
 */
export function parseBridgeResult(
  stdout: string,
  mappedSources: readonly WorkstationCitationSource[]
): BridgeParseOutcome {
  if (!stdout.trim()) return { ok: false, reason: "The citation checker produced no output." };

  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const parsed = WorkstationCitationCheckResultSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "result";
    return { ok: false, reason: `Unexpected checker output at "${where}": ${issue?.message ?? "invalid shape"}.` };
  }

  const value = parsed.data;
  const selectedIds = new Set(mappedSources.map((source) => source.id));
  const inconsistent =
    value.status === "ok" &&
    (value.errors.length > 0 ||
      value.unknownReferences.length > 0 ||
      value.missingFromSourcesBlock.length > 0 ||
      value.mismatchedUrls.length > 0 ||
      value.citedIds.length === 0 ||
      value.citedIds.some((id) => !selectedIds.has(id)));

  const finalStatus = inconsistent ? "mismatch" : value.status;
  const quoteCheckNote =
    finalStatus === "unavailable" || finalStatus === "uncited" || value.quotes.length === 0
      ? QUOTE_CHECK_NOTE_NONE
      : value.quotes.length >= 40
        ? QUOTE_CHECK_NOTE_BOUNDED
        : QUOTE_CHECK_NOTE_NORMAL;

  const { stats, runtime, ...checked } = value;
  return {
    ok: true,
    result: {
      ...checked,
      ...(stats === undefined ? {} : { stats }),
      ...(runtime === undefined ? {} : { runtime }),
      status: finalStatus,
      summary: inconsistent
        ? "The citation check returned an inconsistent result, so it is being treated as unresolved."
        : value.summary,
      disclaimer: CITATION_DISCLAIMER,
      sources: mappedSources,
      quoteCheckNote
    }
  };
}

export async function checkHermesCitations(
  input: CheckHermesCitationsInput
): Promise<WorkstationCitationCheckResult> {
  if (Buffer.byteLength(input.draft, "utf8") > WORKSTATION_CITATION_DRAFT_LIMIT) {
    throw new Error(`Draft exceeds ${WORKSTATION_CITATION_DRAFT_LIMIT} byte limit.`);
  }
  if (input.sources.length > WORKSTATION_SOURCE_LIMIT) {
    throw new Error(`Exceeded maximum of ${WORKSTATION_SOURCE_LIMIT} sources.`);
  }

  let totalSourceBytes = 0;
  for (const source of input.sources) {
    if (source.body) totalSourceBytes += Buffer.byteLength(source.body, "utf8");
  }
  if (totalSourceBytes > WORKSTATION_CITATION_SOURCES_TEXT_LIMIT) {
    throw new Error(`Selected sources exceed ${WORKSTATION_CITATION_SOURCES_TEXT_LIMIT} byte limit.`);
  }

  // Identities support reference checking. Explicitly selected source text is
  // passed separately to the local child for bounded quote matching.
  const mappedSources: readonly WorkstationCitationSource[] = input.sources.map((source, index) => ({
    id: index + 1,
    sourceTurnId: source.sourceTurnId,
    label: source.label,
    uri: `urn:rellane:source:${source.sourceTurnId}`
  }));

  const sourceBodies: Record<string, string> = {};
  input.sources.forEach((source, index) => {
    if (source.body) {
      sourceBodies[String(index + 1)] = source.body;
    }
  });

  const pythonPath = resolvePythonPath(input.runtimeOptions?.pythonPath);
  if (!pythonPath) {
    return unavailable(
      mappedSources,
      "Citation checking needs Python 3.9 or newer on this Mac.",
      [
        "No Python interpreter was found. Run `xcode-select --install` once to add Apple's Python, then try again."
      ]
    );
  }

  const upstreamDir = resolveHermesScriptsDir(input.runtimeOptions?.upstreamScriptsDir);
  try {
    await verifyUpstreamHashes(upstreamDir);
  } catch (error) {
    return unavailable(mappedSources, "The upstream citation scripts did not match their pinned hashes.", [
      error instanceof Error ? error.message : String(error)
    ]);
  }

  const bridgeScript = resolveBridgeScriptPath(input.runtimeOptions?.bridgeScriptPath);
  if (!existsSync(bridgeScript)) {
    return unavailable(mappedSources, "The citation bridge script is missing from this install.", [
      `Bridge script not found at ${bridgeScript}.`
    ]);
  }

  const timeoutMs = input.runtimeOptions?.timeoutMs ?? MAX_CHILD_LIFETIME_MS;
  const maxOutputBytes = input.runtimeOptions?.maxOutputBytes ?? MAX_OUTPUT_CAP_BYTES;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX));

  try {
    const payload = JSON.stringify({
      upstreamDir,
      draft: input.draft,
      sources: mappedSources,
      sourceBodies
    });

    return await new Promise<WorkstationCitationCheckResult>((resolve) => {
      const child = spawn(pythonPath, [...PYTHON_ARGS, bridgeScript], {
        cwd: tempDir,
        // No inherited environment: no tokens, no HERMES_HOME, no ledger outside
        // the temporary directory. -I already makes PYTHON* variables inert.
        env: { PATH: "/usr/bin:/bin" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });

      let stdout = "";
      let stdoutBytes = 0;
      let stderr = "";
      let stderrBytes = 0;
      let timedOut = false;
      let oversized = false;
      let settled = false;
      let startError: string | null = null;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const finish = (result: WorkstationCitationCheckResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          oversized = true;
          child.kill("SIGKILL");
          return;
        }
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          oversized = true;
          child.kill("SIGKILL");
          return;
        }
        if (stderr.length < MAX_STDERR_CAP_BYTES) {
          stderr += chunk.toString("utf8").slice(0, MAX_STDERR_CAP_BYTES - stderr.length);
        }
      });

      child.on("error", (error) => {
        startError = error.message;
      });

      // A closed stdin is reported by the exit code; an unhandled EPIPE here
      // would take the main process down with it.
      child.stdin.on("error", () => {});

      child.on("close", (code, signal) => {
        if (startError) {
          finish(unavailable(mappedSources, "The citation checker could not be started.", [startError]));
          return;
        }
        if (timedOut) {
          finish(
            unavailable(mappedSources, "The citation checker ran out of time and was stopped.", [
              `The check was stopped after ${timeoutMs} ms.`
            ])
          );
          return;
        }
        if (oversized) {
          finish(
            unavailable(mappedSources, "The citation checker produced too much output and was stopped.", [
              `Output passed the ${maxOutputBytes} byte limit.`
            ])
          );
          return;
        }
        if (code !== 0 || signal !== null) {
          const detail =
            stderr.trim().slice(0, 1_000) ||
            `The checker exited with ${code === null ? `signal ${String(signal)}` : `code ${code}`}.`;
          finish(unavailable(mappedSources, "The citation checker did not finish cleanly.", [detail]));
          return;
        }

        const parsed = parseBridgeResult(stdout, mappedSources);
        if (!parsed.ok) {
          const errors = stderr.trim()
            ? [parsed.reason, stderr.trim().slice(0, 500)]
            : [parsed.reason];
          finish(unavailable(mappedSources, "The citation checker returned output this app could not read.", errors));
          return;
        }
        finish(parsed.result);
      });

      child.stdin.end(payload, "utf8");
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
