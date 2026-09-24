/** Native subscriptions must not inherit unrelated outbound connectors from the editor.
 * Inspect configuration declarations only: values and authentication files are never
 * exposed, copied or used. Each discovered MCP server is disabled for this child. */
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";

const SAFE_NAME = /^[A-Za-z0-9_-]{1,100}$/u;
const DISABLED_FEATURES = ["apps", "plugins", "remote_plugin", "hooks", "memories", "multi_agent", "browser_use", "computer_use", "image_generation", "skill_mcp_dependency_install", "tool_suggest"] as const;

/** Unsupported inline declarations fail closed instead of leaving a connector enabled. */
export function codexMcpDeclaration(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (!trimmed.startsWith("[")) {
    if (/^[^=]*\bmcp_servers\b[^=]*=/u.test(trimmed))
      throw new Error("Codex uses an inline connector configuration this connection cannot isolate. Use a standard MCP table declaration before connecting.");
    return null;
  }
  const header = /^\[([^\]]+)\]\s*(?:#.*)?$/u.exec(trimmed)?.[1]?.trim();
  if (!trimmed.includes("mcp_servers")) return null;
  if (!header) throw new Error("Codex uses a connector table this connection cannot isolate.");
  // Parse the supported TOML key forms, including a quoted mcp_servers key.
  // Unknown syntax is refused rather than accidentally leaving a server active.
  const parts: string[] = [];
  let remaining = header;
  while (remaining.length) {
    const match = /^(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))\s*(?:\.\s*|$)/u.exec(remaining);
    if (!match) throw new Error("A Codex connector declaration cannot be safely isolated by this connection.");
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
    remaining = remaining.slice(match[0].length);
  }
  const marker = parts.indexOf("mcp_servers");
  if (marker !== 0 && !(marker === 2 && parts[0] === "profiles"))
    throw new Error("Codex uses a connector table this connection cannot isolate.");
  const name = parts[marker + 1];
  if (!name || !SAFE_NAME.test(name)) throw new Error("A Codex connector name cannot be safely isolated by this connection.");
  return name;
}

export function codexIsolatedArgs(serverNames: readonly string[]): string[] {
  if (serverNames.some(name => !SAFE_NAME.test(name))) throw new Error("Invalid native connector name.");
  return ["app-server", ...DISABLED_FEATURES.flatMap(name => ["--disable", name]),
    "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"',
    "-c", 'web_search="disabled"', "-c", "analytics.enabled=false", "-c", "project_doc_max_bytes=0",
    ...[...new Set(serverNames)].flatMap(name => ["-c", `mcp_servers.${name}.enabled=false`])];
}

/** A bounded metadata pass over the configuration layers used by a local invocation. */
export async function codexPolicyArgs(cwd: string): Promise<string[]> {
  const nativeHome = process.env["CODEX_HOME"] ?? path.join(homedir(), ".codex");
  const candidates = new Set([path.join(nativeHome, "config.toml"), "/etc/codex/config.toml", "/etc/codex/managed_config.toml"]);
  let directory = path.resolve(cwd);
  for (let count = 0; count < 64; count++) {
    candidates.add(path.join(directory, ".codex", "config.toml"));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const names = new Set<string>();
  for (const candidate of candidates) {
    try { await access(candidate); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw new Error("A native Codex configuration cannot be checked for connector isolation.");
    }
    const info = await stat(candidate);
    if (!info.isFile() || info.size > 1_000_000) throw new Error("The native Codex configuration is too large to check safely.");
    const stream = createReadStream(candidate, { encoding: "utf8", highWaterMark: 4096 });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (line.length > 100_000) throw new Error("A native configuration declaration is too large.");
        const name = codexMcpDeclaration(line);
        if (name) names.add(name);
        if (names.size > 200) throw new Error("Too many native connectors to isolate in one session.");
      }
    } finally { reader.close(); stream.destroy(); }
  }
  return codexIsolatedArgs([...names]);
}
