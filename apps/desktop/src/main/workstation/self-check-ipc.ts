import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import {
  countWord,
  probeSentence,
  runProbes,
  type Probe,
  type ProbeResult
} from "../probes.js";

/** Budget in milliseconds before in-flight probes are abandoned and reported as unknown. */
export const SELF_CHECK_BUDGET_MS = 8_000;

export const WorkstationSelfCheckInputSchema = z
  .object({
    includeProbeSentences: z.boolean().optional()
  })
  .strict();
export type WorkstationSelfCheckInput = z.infer<typeof WorkstationSelfCheckInputSchema>;

export const SelfCheckInputSchema = WorkstationSelfCheckInputSchema;
export type SelfCheckInput = WorkstationSelfCheckInput;

export interface InstallSelfCheckOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** Opens the book and counts its tables. Throws or returns null when it cannot. */
  readonly probeBook: () => Promise<{ readonly open: boolean; readonly tables: number | null }>;
  /** Discovery, run now. Not a cached list. */
  readonly probeProviders: () => Promise<readonly {
    readonly id: string; readonly label: string; readonly detected: boolean; readonly detail: string;
  }[]>;
  readonly probeLocalModel: () => Promise<{ readonly ready: boolean; readonly detail: string }>;
  readonly probeFolders: () => Promise<{ readonly granted: number; readonly lost: readonly string[] }>;
  readonly probeTelegram: () => Promise<{ readonly linked: boolean; readonly chatPaired: boolean }>;
  readonly probeKeychain: () => boolean;
  readonly probeDisk: () => Promise<number | null>;
  readonly lastBackupAt: () => Promise<number | null>;
}

export interface ProbedFacts {
  readonly bookOpen: boolean;
  readonly bookTables: number | null;
  readonly providersDetected: readonly { readonly id: string; readonly label: string }[];
  readonly providersMissing: readonly { readonly id: string; readonly label: string; readonly detail: string }[];
  readonly localModelReady: boolean;
  readonly localModelDetail: string;
  readonly foldersGranted: number;
  readonly foldersLost: readonly string[];
  readonly telegramLinked: boolean;
  readonly telegramChatPaired: boolean;
  readonly keychainAvailable: boolean;
  readonly diskFreeBytes: number | null;
  readonly lastBackupAt: number | null;
  readonly now: number;
  readonly probeResults?: readonly (ProbeResult & { readonly sentence: string })[];
}

export type SelfCheckProbes = Omit<InstallSelfCheckOptions, "assertTrusted">;

export async function summarizeProbedFactsWithProbes(
  facts: ProbedFacts,
  now?: () => number
): Promise<readonly (ProbeResult & { readonly sentence: string })[]> {
  const probes: Probe[] = [
    {
      id: "book",
      claim: "Local SQLite Book",
      run: async () => ({
        ok: facts.bookOpen,
        said: facts.bookOpen
          ? `Book open with ${countWord(facts.bookTables ?? 0, "table")}`
          : "Book is not open"
      })
    },
    {
      id: "local-model",
      claim: "Local GGUF Model",
      run: async () => ({
        ok: facts.localModelReady,
        said: facts.localModelDetail
      })
    },
    {
      id: "keychain",
      claim: "OS Keychain",
      run: async () => ({
        ok: facts.keychainAvailable,
        said: facts.keychainAvailable
          ? "OS encryption available"
          : "OS keychain unavailable"
      })
    }
  ];

  const results = await runProbes(probes, now);
  return results.map((r) => ({
    ...r,
    sentence: probeSentence(r)
  }));
}

/**
 * Strips absolute filesystem paths, binary names, authentication tokens, and stack traces
 * so that internal machine details and secrets never reach renderer diagnostics.
 */
export function sanitizeDetail(raw: string): string {
  if (typeof raw !== "string") {
    return "Unknown";
  }

  // Discard stack traces to avoid exposing internal source paths and runtime line numbers.
  const atSplit = raw.split(/\r?\n\s*at\s+/);
  let text = atSplit[0] ?? "";
  const lineSplit = text.split(/\r?\n/);
  text = lineSplit[0] ?? "";
  text = text.replace(/\bat\s+[^\s]+:\d+(?::\d+)?\b/gi, "");
  text = text.replace(/\([^)]*:\d+:\d+\)/g, "");
  text = text.replace(/:\d+:\d+/g, "");

  // Redact bearer tokens, API keys, and long credential signatures.
  text = text.replace(/\b(?:bearer\s+)?[a-zA-Z0-9_\-\.]{32,}\b/gi, "");
  text = text.replace(/\b(?:sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9]+|glpat-[a-zA-Z0-9_-]+)\b/gi, "");
  text = text.replace(/\b(?:token|secret|key|password|bearer)[:=\s]+[^\s,;)]+/gi, "");

  // Redact absolute, tilde, and relative directory paths to keep filesystem structure private.
  text = text.replace(/(?:^|[\s"'(])(?:[a-zA-Z]:[\\/]|~[\\/]|\.\.?[\\/]|[\\/])[^\s"'):;,]+/g, " ");
  text = text.replace(/\b[a-zA-Z0-9._-]+(?:[/\\][a-zA-Z0-9._-]+){2,}\b/g, " ");

  // Remove executable filenames and script extensions.
  text = text.replace(/\b[a-zA-Z0-9._-]+\.(?:exe|bat|cmd|sh|bin|app|dylib|so|dll)\b/gi, "");

  // Strip CLI parameter noise and technical invocation prefixes.
  text = text.replace(/--[a-zA-Z0-9_-]+/g, "");
  text = text.replace(/\bcommand failed\b[:\s]*/gi, "Command failed");
  text = text.replace(/\bspawn\b\s*(?:ENOENT|EACCES|EPERM)?/gi, "Not found");
  text = text.replace(/\bENOENT[:\s]*/gi, "");

  // Normalise spacing and clean trailing punctuation left behind by redactions.
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/\b(?:with|at|in|from|open)\s*$/i, "").trim();
  text = text.replace(/^[:\s,-]+/, "").replace(/[:\s,-]+$/, "").trim();

  return text.length > 0 ? text : "Unknown";
}

/**
 * Extracts only the trailing folder name so user file hierarchies are not revealed.
 */
export function extractFolderBasename(folderPath: string): string {
  if (typeof folderPath !== "string") {
    return "Unknown folder";
  }
  const trimmed = folderPath.trim().replace(/[/\\]+$/, "");
  if (trimmed.length === 0) {
    return "Unknown folder";
  }
  const segments = trimmed.split(/[/\\]/);
  if (segments.length === 0) {
    return "Unknown folder";
  }
  const last = segments[segments.length - 1];
  if (last === undefined || last.trim().length === 0 || last.endsWith(":")) {
    return "Unknown folder";
  }
  return last.trim();
}

/**
 * Ensures an asynchronous probe settles before the budget expires or safely returns a fallback.
 */
function withTimeout<T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, timeoutMs);

    // Prevent background timers from keeping the Node event loop alive.
    if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }

    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      }
    );
  });
}

/**
 * Runs all probes concurrently, recording only observed facts and never guessing missing state.
 */
export async function collectProbedFacts(
  probes: SelfCheckProbes,
  budgetMs: number = SELF_CHECK_BUDGET_MS
): Promise<ProbedFacts> {
  const bookPromise = withTimeout(
    Promise.resolve().then(() => probes.probeBook()),
    null,
    budgetMs
  );

  const providersPromise = withTimeout(
    Promise.resolve().then(() => probes.probeProviders()),
    [],
    budgetMs
  );

  const localModelPromise = withTimeout(
    Promise.resolve().then(() => probes.probeLocalModel()),
    { ready: false, detail: "Unknown" },
    budgetMs
  );

  const foldersPromise = withTimeout(
    Promise.resolve().then(() => probes.probeFolders()),
    { granted: 0, lost: [] },
    budgetMs
  );

  const telegramPromise = withTimeout(
    Promise.resolve().then(() => probes.probeTelegram()),
    { linked: false, chatPaired: false },
    budgetMs
  );

  const keychainPromise = withTimeout(
    Promise.resolve().then(() => probes.probeKeychain()),
    false,
    budgetMs
  );

  const diskPromise = withTimeout(
    Promise.resolve().then(() => probes.probeDisk()),
    null,
    budgetMs
  );

  const backupPromise = withTimeout(
    Promise.resolve().then(() => probes.lastBackupAt()),
    null,
    budgetMs
  );

  const [
    bookResult,
    providersResult,
    localModelResult,
    foldersResult,
    telegramResult,
    keychainResult,
    diskResult,
    backupResult
  ] = await Promise.all([
    bookPromise,
    providersPromise,
    localModelPromise,
    foldersPromise,
    telegramPromise,
    keychainPromise,
    diskPromise,
    backupPromise
  ]);

  let bookOpen = false;
  let bookTables: number | null = null;
  if (bookResult && typeof bookResult === "object") {
    bookOpen = Boolean(bookResult.open);
    bookTables =
      typeof bookResult.tables === "number" && Number.isFinite(bookResult.tables)
        ? bookResult.tables
        : null;
  }

  const providersDetected: { readonly id: string; readonly label: string }[] = [];
  const providersMissing: {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
  }[] = [];

  if (Array.isArray(providersResult)) {
    for (const provider of providersResult) {
      if (!provider || typeof provider !== "object") {
        continue;
      }
      const id = sanitizeDetail(typeof provider.id === "string" ? provider.id : "unknown");
      const label = sanitizeDetail(typeof provider.label === "string" ? provider.label : "Unknown");
      if (provider.detected === true) {
        providersDetected.push({ id, label });
      } else {
        const detail = sanitizeDetail(typeof provider.detail === "string" ? provider.detail : "Not detected");
        providersMissing.push({ id, label, detail });
      }
    }
  }

  let localModelReady = false;
  let localModelDetail = "Unknown";
  if (localModelResult && typeof localModelResult === "object") {
    localModelReady = Boolean(localModelResult.ready);
    localModelDetail = sanitizeDetail(
      typeof localModelResult.detail === "string" ? localModelResult.detail : "Unknown"
    );
  }

  let foldersGranted = 0;
  let foldersLost: readonly string[] = [];
  if (foldersResult && typeof foldersResult === "object") {
    foldersGranted =
      typeof foldersResult.granted === "number" &&
      Number.isFinite(foldersResult.granted) &&
      foldersResult.granted >= 0
        ? foldersResult.granted
        : 0;
    foldersLost = Array.isArray(foldersResult.lost)
      ? foldersResult.lost
          .filter((f): f is string => typeof f === "string")
          .map(extractFolderBasename)
      : [];
  }

  let telegramLinked = false;
  let telegramChatPaired = false;
  if (telegramResult && typeof telegramResult === "object") {
    telegramLinked = Boolean(telegramResult.linked);
    telegramChatPaired = Boolean(telegramResult.chatPaired);
  }

  const keychainAvailable = Boolean(keychainResult);

  const diskFreeBytes =
    typeof diskResult === "number" && Number.isFinite(diskResult) && diskResult >= 0
      ? diskResult
      : null;

  const lastBackupAt =
    typeof backupResult === "number" && Number.isFinite(backupResult) && backupResult > 0
      ? backupResult
      : null;

  return {
    bookOpen,
    bookTables,
    providersDetected,
    providersMissing,
    localModelReady,
    localModelDetail,
    foldersGranted,
    foldersLost,
    telegramLinked,
    telegramChatPaired,
    keychainAvailable,
    diskFreeBytes,
    lastBackupAt,
    now: Date.now()
  };
}

export function installSelfCheck(options: InstallSelfCheckOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);

  let inFlightProbe: Promise<ProbedFacts> | null = null;

  // Multiple UI widgets or repeated taps coalesce onto the same in-flight probe to avoid redundant CLI invocations.
  const runCoalescedProbe = (): Promise<ProbedFacts> => {
    if (inFlightProbe !== null) {
      return inFlightProbe;
    }

    const current = collectProbedFacts(options, SELF_CHECK_BUDGET_MS).finally(() => {
      if (inFlightProbe === current) {
        inFlightProbe = null;
      }
    });

    inFlightProbe = current;
    return current;
  };

  ipcMain.handle(
    IPC_CHANNELS.workstationSelfCheck,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<ProbedFacts> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const parsed = WorkstationSelfCheckInputSchema.parse(input === undefined ? {} : input);

      const result = await runCoalescedProbe();

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while checking your system.");
      }

      if (parsed.includeProbeSentences === true) {
        const probeResults = await summarizeProbedFactsWithProbes(result);
        return {
          ...result,
          probeResults
        };
      }

      return result;
    }
  );
}
