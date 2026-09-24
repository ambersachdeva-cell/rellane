import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { WorkstationProvider } from "@cadrane/contracts";
import { describeConnection } from "./connection-readiness.js";
import type { NativeProviderLaunch } from "./types.js";

const EXTENSION_BIN_SUBPATHS: readonly string[] = [
  join("resources", "native-binary", "claude"),
  join("bin", "claude"),
  join("out", "bin", "claude")
];

export interface ProviderDiscoveryOverrides {
  readonly codexPath?: string | null;
  readonly claudePath?: string | null;
  readonly agyPath?: string | null;
  readonly setupDir?: string;
  readonly homeDirectory?: string;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) {
      return false;
    }
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchDirs(envPath?: string, homeDirectory?: string): string[] {
  const rawPath = envPath ?? process.env["PATH"] ?? "";
  const fromPath = rawPath
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && isAbsolute(entry));

  const home = homeDirectory ?? homedir();
  const wellKnown = [
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ];

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const dir of [...fromPath, ...wellKnown]) {
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    ordered.push(dir);
  }
  return ordered;
}

function editorExtensionRoots(homeDirectory?: string): string[] {
  const home = homeDirectory ?? homedir();
  return [
    join(home, ".vscode", "extensions"),
    join(home, ".vscode-insiders", "extensions"),
    join(home, ".cursor", "extensions"),
    join(home, ".windsurf", "extensions")
  ];
}

interface ClaudeCandidate {
  readonly path: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly mtimeMs: number;
}

function parseSemver(dirName: string): { major: number; minor: number; patch: number } | null {
  const match = dirName.match(/anthropic\.claude-code-(?:v)?(\d+)\.(\d+)\.(\d+)/);
  if (match) {
    return {
      major: Number.parseInt(match[1] ?? "0", 10),
      minor: Number.parseInt(match[2] ?? "0", 10),
      patch: Number.parseInt(match[3] ?? "0", 10)
    };
  }
  const shortMatch = dirName.match(/anthropic\.claude-code-(?:v)?(\d+)\.(\d+)/);
  if (shortMatch) {
    return {
      major: Number.parseInt(shortMatch[1] ?? "0", 10),
      minor: Number.parseInt(shortMatch[2] ?? "0", 10),
      patch: 0
    };
  }
  return null;
}

export async function findCodexExecutable(homeDirectory?: string): Promise<string | null> {
  const home = homeDirectory ?? homedir();
  const candidates = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
    ...searchDirs(undefined, home).map((dir) => join(dir, "codex"))
  ];

  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function findClaudeExecutable(homeDirectory?: string): Promise<string | null> {
  const home = homeDirectory ?? homedir();
  const candidates: ClaudeCandidate[] = [];

  for (const root of editorExtensionRoots(home)) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("anthropic.claude-code")) {
          continue;
        }
        const semver = parseSemver(entry.name) ?? { major: 0, minor: 0, patch: 0 };
        for (const subpath of EXTENSION_BIN_SUBPATHS) {
          const candidatePath = join(root, entry.name, subpath);
          if (await isExecutableFile(candidatePath)) {
            let mtimeMs = 0;
            try {
              const fileStat = await stat(candidatePath);
              mtimeMs = fileStat.mtimeMs;
            } catch {
              // File stat unreadable, default mtime to 0
            }
            candidates.push({
              path: candidatePath,
              major: semver.major,
              minor: semver.minor,
              patch: semver.patch,
              mtimeMs
            });
          }
        }
      }
    } catch {
      continue;
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (b.major !== a.major) return b.major - a.major;
      if (b.minor !== a.minor) return b.minor - a.minor;
      if (b.patch !== a.patch) return b.patch - a.patch;
      return b.mtimeMs - a.mtimeMs;
    });
    return candidates[0]?.path ?? null;
  }

  const fallbackCandidates = [
    join(home, ".local", "bin", "claude"),
    ...searchDirs(undefined, home).map((dir) => join(dir, "claude"))
  ];
  for (const candidate of fallbackCandidates) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function findAgyExecutable(homeDirectory?: string): Promise<string | null> {
  const home = homeDirectory ?? homedir();
  const candidates = [
    join(home, ".local", "bin", "agy"),
    ...searchDirs(undefined, home).map((dir) => join(dir, "agy"))
  ];

  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveGeminiProfileHome(
  profileKey: "config1" | "config2" | "config3",
  setupDir?: string,
  homeDirectory?: string
): string {
  if (setupDir) {
    return join(setupDir, profileKey);
  }
  if (process.env["AGY_SETUP_DIR"]) {
    return join(process.env["AGY_SETUP_DIR"], profileKey);
  }
  const home = homeDirectory ?? process.env["HOME"] ?? homedir();
  return join(home, "agy-setup", profileKey);
}

/**
 * Whether a profile directory is there — and nothing beyond that.
 *
 * Deliberately a directory check: the files that would say whether an account is
 * signed in are that vendor's credentials, and this app does not open them. So
 * "the folder exists" is the strongest claim available here, and the labels
 * below say exactly that rather than implying a working account.
 */
async function directoryExists(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function discoverWorkstationProviders(
  overrides?: ProviderDiscoveryOverrides
): Promise<NativeProviderLaunch[]> {
  const home = overrides?.homeDirectory;
  const [codexExe, claudeExe, agyExe] = await Promise.all([
    overrides?.codexPath !== undefined ? Promise.resolve(overrides.codexPath) : findCodexExecutable(home),
    overrides?.claudePath !== undefined ? Promise.resolve(overrides.claudePath) : findClaudeExecutable(home),
    overrides?.agyPath !== undefined ? Promise.resolve(overrides.agyPath) : findAgyExecutable(home)
  ]);

  // "Detected" is a statement about a file on disk, never about an account.
  // Whether the subscription behind a CLI will answer is only knowable from a
  // real attempt, and the host upgrades or blocks the row once one has happened.
  const codexProvider: WorkstationProvider = {
    id: "codex",
    label: "Codex",
    family: "codex",
    state: codexExe !== null ? "detected" : "unavailable",
    detail: describeConnection({
      family: "codex",
      executable: codexExe
    }).detail,
    // Empty means "whatever the CLI is configured to use". Naming models this
    // app has not verified would imply the owner's plan includes them.
    models: [],
    canResume: true,
    // The app-server has a real approval protocol, and this adapter answers it.
    canApproveTools: true
  };

  const claudeProvider: WorkstationProvider = {
    id: "claude",
    label: "Claude",
    family: "claude",
    state: claudeExe !== null ? "detected" : "unavailable",
    detail: describeConnection({
      family: "claude",
      executable: claudeExe
    }).detail,
    models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }],
    canResume: true,
    // Native stdio control was verified with real Read/Write allow and deny decisions.
    canApproveTools: true
  };

  const geminiModels = [
    {
      id: "gemini-3.8-flash-high",
      label: "Gemini 3.8 Flash (High)"
    }
  ] as const;

  const createGeminiLaunch = async (
    id: "gemini1" | "gemini2" | "gemini3",
    label: string,
    profileKey: "config1" | "config2" | "config3"
  ): Promise<NativeProviderLaunch> => {
    const profileHome = resolveGeminiProfileHome(profileKey, overrides?.setupDir, home);
    const hasProfile = await directoryExists(profileHome);
    const provider: WorkstationProvider = {
      id,
      label,
      family: "gemini",
      state: agyExe !== null ? "detected" : "unavailable",
      detail: describeConnection({
        family: "gemini",
        executable: agyExe,
        profileReady: hasProfile,
        profileKey
      }).detail,
      models: geminiModels,
      canResume: true,
      // Headless stream-json carries no approval channel, so a tool this
      // session cannot run is refused by the sandbox rather than asked about.
      canApproveTools: false
    };

    return {
      provider,
      executable: agyExe,
      profileHome
    };
  };

  const geminiLaunches = await Promise.all([
    createGeminiLaunch("gemini1", "Gemini (Profile 1)", "config1"),
    createGeminiLaunch("gemini2", "Gemini (Profile 2)", "config2"),
    createGeminiLaunch("gemini3", "Gemini (Profile 3)", "config3")
  ]);

  return [
    {
      provider: codexProvider,
      executable: codexExe
    },
    {
      provider: claudeProvider,
      executable: claudeExe
    },
    ...geminiLaunches
  ];
}
