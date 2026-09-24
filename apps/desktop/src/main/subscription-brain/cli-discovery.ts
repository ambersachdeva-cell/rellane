/**
 * Finds CLIs the user has already installed.
 *
 * A packaged Electron app launched from Finder does not inherit the login
 * shell's PATH, so a plain PATH lookup misses tools installed by npm, pipx, or
 * a dotfiles script. We therefore search PATH *and* the usual install
 * directories, and we confirm a candidate by running it rather than by
 * trusting that the file exists.
 */

import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { BrainInstallation, BrainProviderDefinition } from "./types.js";
import { runProcess } from "./cli-invoker.js";

const VERSION_TIMEOUT_MS = 5_000;

/**
 * Editors that ship a CLI inside an extension rather than onto PATH.
 *
 * This is not a hypothetical. Claude Code installs as a VS Code extension and
 * puts its binary at
 * `~/.vscode/extensions/anthropic.claude-code-<version>-<arch>/resources/native-binary/claude`,
 * which no PATH search will ever find. A user who has been talking to Claude
 * all day would otherwise be told, by our own status board, that Claude is not
 * installed — which is the kind of confident wrongness that makes someone stop
 * believing the rest of the screen.
 */
function editorExtensionRoots(): string[] {
  const home = homedir();
  return [
    join(home, ".vscode", "extensions"),
    join(home, ".vscode-insiders", "extensions"),
    join(home, ".cursor", "extensions"),
    join(home, ".windsurf", "extensions")
  ];
}

/** Where a CLI sits inside an extension folder, relative to it. */
const EXTENSION_BIN_SUBPATHS = [
  join("resources", "native-binary"),
  "bin",
  join("out", "bin")
];

/**
 * Executables named `binary` inside any installed editor extension.
 *
 * Extension folders carry a version in their name, so they cannot be listed
 * statically — the directory has to be read. Failures are swallowed per root:
 * a missing `~/.cursor` is the ordinary case, not a problem to report.
 */
async function bundledCandidates(binary: string): Promise<string[]> {
  const found: string[] = [];

  for (const root of editorExtensionRoots()) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      for (const subpath of EXTENSION_BIN_SUBPATHS) {
        found.push(join(root, entry.name, subpath, binary));
      }
    }
  }
  return found;
}

/**
 * Directories a user-installed CLI realistically lives in on macOS/Linux,
 * searched after PATH. `~/.local/bin` is first because pipx and several
 * install scripts default to it and it is almost never on a GUI app's PATH.
 */
function wellKnownBinDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ];
}

function searchDirs(): string[] {
  const fromPath = (process.env["PATH"] ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && isAbsolute(entry));

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const dir of [...fromPath, ...wellKnownBinDirs()]) {
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    ordered.push(dir);
  }
  return ordered;
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

/**
 * Every executable matching `binary`, in search order.
 *
 * PATH and the well-known bin directories first, because a CLI a user
 * deliberately installed should win over one that arrived inside an editor.
 * Extension bundles are the fallback, and they are what finds Claude Code.
 */
export async function locateExecutables(binary: string): Promise<string[]> {
  if (binary.includes("/") || binary.includes("\0")) {
    // A provider definition is ours, not user input, but refuse anything
    // path-shaped rather than let it escape the search directories.
    return [];
  }

  const candidates = [
    ...searchDirs().map((dir) => join(dir, binary)),
    ...(await bundledCandidates(binary))
  ];

  const found: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (await isExecutableFile(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

/**
 * Resolves a provider to an installation by running its version command.
 * Returns null when the binary is absent or does not respond — we never
 * report an installation we have not seen execute.
 */
export async function discoverProvider(
  definition: BrainProviderDefinition,
  /**
   * Which account to look as.
   *
   * This changes the version-command environment only. A version response
   * does not verify this account, its subscription or its model access.
   */
  home?: string
): Promise<BrainInstallation | null> {
  for (const executablePath of await locateExecutables(definition.binary)) {
    try {
      const result = await runProcess({
        executablePath,
        args: definition.versionArgs,
        timeoutMs: VERSION_TIMEOUT_MS,
        ...(home === undefined ? {} : { home })
      });
      if (result.code !== 0) {
        continue;
      }
      return {
        providerId: definition.id,
        label: definition.label,
        executablePath,
        version: result.stdout.trim().split("\n")[0]?.trim() ?? ""
      };
    } catch {
      // Unreadable, killed, or not the tool we expected. Try the next match.
      continue;
    }
  }
  return null;
}
