/** Explicit, bounded source intake. A picker selects within an existing agent
 * grant; it never creates one. The renderer receives a preview, not authority. */
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, isAbsolute, normalize, relative, sep } from "node:path";
import type { CaseSourcePreview } from "@cadrane/contracts";
import type { Sandbox } from "../tools/sandbox.js";
import { snapshotGrantedFile } from "../timeline/hash-file.js";
import { resolveBrief, type Ceiling } from "./brief.js";
import { findAgent } from "./roster.js";

export type AgentSourceSnapshot = Omit<CaseSourcePreview, "token" | "expiresAt">;
export interface AgentSourceHost {
  currentCeiling(): Promise<Ceiling>;
  currentGrant(): Sandbox | null;
}
interface Scope { grant: Sandbox; signature: string; folders: readonly string[] }
interface Preview {
  owner: object; agentId: string; scope: Scope; value: CaseSourcePreview;
}
interface Opening { owner: object; agentId: string; cancelled: boolean }
export interface AgentSourceState {
  previews: Map<string, Preview>;
  opening: Opening | null;
}
export function createAgentSourceState(): AgentSourceState {
  return { previews: new Map(), opening: null };
}
const UNAVAILABLE = "This source preview is no longer available for this agent. Choose the file again.";
const CHANGED = "This agent's brief or folder access changed. Choose the source again after reviewing its access.";
const TTL = 10 * 60_000;

function sourceScope(agentId: string, ceiling: Ceiling, grant: Sandbox | null): Scope {
  const brief = findAgent(ceiling.grantedFolders, ceiling.storedAgents, agentId);
  if (!brief || !grant) throw new Error(CHANGED);
  const access = resolveBrief(brief, ceiling);
  if (access.inert || !access.capabilities.includes("read_text"))
    throw new Error("This agent needs a granted folder and the read_text tool before it can use a required file.");
  const folders = access.folders.filter(folder => grant.spelledRoots.includes(normalize(folder)));
  if (!folders.length) throw new Error(CHANGED);
  return { grant, folders, signature: createHash("sha256").update(JSON.stringify({
    brief, folders: access.folders, tools: access.capabilities
  })).digest("hex") };
}

function assertScope(expected: Scope, current: Scope): void {
  if (expected.grant !== current.grant || expected.signature !== current.signature) throw new Error(CHANGED);
}

/** No partial, binary or silently truncated text becomes a model source. */
export async function readAgentSource(
  chosen: string, scope: Scope, currentGrant: () => Sandbox | null
): Promise<AgentSourceSnapshot> {
  const name = basename(chosen);
  const extension = extname(name).toLowerCase();
  if (!isAbsolute(chosen) || ![".txt", ".md"].includes(extension) ||
      name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name))
    throw new Error("Choose a .txt or .md file with an ordinary file name.");
  // Use the most specific granted spelling, not an unrelated host-wide root.
  const folder = [...scope.folders].sort((a, b) => b.length - a.length).find(root => {
    const back = relative(root, chosen);
    return back !== "" && back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back);
  });
  if (!folder) throw new Error("Choose a file inside this agent's already granted folders. Selecting a file does not grant access.");
  if (currentGrant() !== scope.grant) throw new Error(CHANGED);
  const result = await snapshotGrantedFile(folder, relative(folder, chosen), currentGrant);
  if (result.content === null || result.digest === null) throw new Error(result.problem ?? "The source could not be read.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.content); }
  catch { throw new Error("This file is not valid UTF-8 text. Export a plain-text copy before selecting it."); }
  if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    throw new Error("Choose a nonempty text file without binary control characters.");
  if (text.length > 8_000) throw new Error("This source is longer than 8,000 characters. Make a shorter text file; no excerpt was selected silently.");
  return Object.freeze({ fileName: name, format: extension === ".md" ? "md" : "txt",
    text, bytes: result.content.length, fileSha256: result.digest,
    textSha256: createHash("sha256").update(text).digest("hex"),
    coverage: "Complete UTF-8 text, including its original whitespace. Captured once; the file is not watched." });
}

/** A late picker/read result cannot resurrect a discarded or replaced preview. */
export async function previewAgentSource(
  state: AgentSourceState, owner: object, agentId: string, host: AgentSourceHost,
  choose: () => Promise<string | null>
): Promise<CaseSourcePreview | null> {
  if (state.opening) throw new Error("A source is already being opened. Finish or cancel that preview first.");
  discardAgentSource(state, owner, agentId);
  for (const [token, preview] of state.previews)
    if (preview.value.expiresAt <= Date.now()) state.previews.delete(token);
  if (state.previews.size >= 16) throw new Error("Remove an unused source preview before opening another.");
  const active: Opening = { owner, agentId, cancelled: false };
  state.opening = active;
  try {
    const scope = sourceScope(agentId, await host.currentCeiling(), host.currentGrant());
    if (active.cancelled) return null;
    const chosen = await choose();
    if (chosen === null || active.cancelled) return null;
    assertScope(scope, sourceScope(agentId, await host.currentCeiling(), host.currentGrant()));
    if (active.cancelled) return null;
    const source = await readAgentSource(chosen, scope, () => active.cancelled ? null : host.currentGrant());
    if (active.cancelled) return null;
    assertScope(scope, sourceScope(agentId, await host.currentCeiling(), host.currentGrant()));
    if (active.cancelled) return null;
    const value: CaseSourcePreview = Object.freeze({ ...source, token: randomUUID(), expiresAt: Date.now() + TTL });
    state.previews.set(value.token, { owner, agentId, scope, value });
    return value;
  } finally {
    if (state.opening === active) state.opening = null;
  }
}

/** Consumed synchronously before the run can yield. A retry needs a new preview.
 * The returned access check is also used before/after model and tool steps. */
export function consumeAgentSource(
  state: AgentSourceState, owner: object, agentId: string, token: string,
  ceiling: Ceiling, host: AgentSourceHost
): { snapshot: AgentSourceSnapshot; sandbox: Sandbox; assertCurrent(): Promise<void> } {
  const preview = state.previews.get(token);
  if (!preview || preview.owner !== owner || preview.agentId !== agentId) throw new Error(UNAVAILABLE);
  state.previews.delete(token);
  if (preview.value.expiresAt <= Date.now()) throw new Error(UNAVAILABLE);
  assertScope(preview.scope, sourceScope(agentId, ceiling, host.currentGrant()));
  const { token: _token, expiresAt: _expiresAt, ...snapshot } = preview.value;
  return {
    snapshot: Object.freeze(snapshot),
    sandbox: {
      spelledRoots: preview.scope.folders.map(folder => normalize(folder)),
      roots: preview.scope.folders.map(folder => preview.scope.grant.roots[
        preview.scope.grant.spelledRoots.indexOf(normalize(folder))
      ]!)
    },
    assertCurrent: async () => assertScope(preview.scope, sourceScope(agentId, await host.currentCeiling(), host.currentGrant()))
  };
}

export function discardAgentSource(
  state: AgentSourceState, owner: object, agentId?: string, token?: string
): boolean {
  let discarded = false;
  if (token === undefined && state.opening?.owner === owner &&
      (agentId === undefined || state.opening.agentId === agentId)) {
    state.opening.cancelled = true; discarded = true;
  }
  for (const [key, preview] of state.previews)
    if (preview.owner === owner && (agentId === undefined || preview.agentId === agentId) &&
        (token === undefined || key === token)) {
      state.previews.delete(key); discarded = true;
    }
  return discarded;
}
