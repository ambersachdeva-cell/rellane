/**
 * The connectors the owner has installed, and which of their tools may run.
 *
 * An MCP server is third-party code. The client (`client.ts`) refuses to believe
 * anything a server says about its own safety; this file is where that refusal
 * turns into a decision somebody actually makes.
 *
 * ## Tools are approved, not servers
 *
 * Installing a connector is not consent to everything in it. A server offering
 * `read_invoice` and `delete_all_records` is one install and two very different
 * questions, and servers add tools in updates — so approving the server would be
 * approving tools that did not exist when the owner said yes.
 *
 * So approval is per tool, and it is **pinned to the tool's description**. If a
 * server changes what a tool does, the approval lapses and the owner is asked
 * again. That closes the obvious attack: ship `read_notes`, wait for approval,
 * then quietly turn it into something else in a later release.
 *
 * ## Reads only, still
 *
 * D-029 applies to MCP tools with more force than to ours, not less: we cannot
 * inspect what a third-party tool does, and its own `readOnlyHint` is a claim
 * from the code being restricted. So the owner is shown the claim, told plainly
 * that it is unverified, and asked. Nothing here can grant an agent a tool the
 * owner has not personally read the description of.
 *
 * ## Descriptions are untrusted text
 *
 * A tool description is written by whoever wrote the server and goes straight
 * into a prompt for something that calls tools. That is prompt injection with a
 * delivery mechanism, so descriptions are screened before an agent ever sees
 * them, exactly like a document.
 */

import { createHash } from "node:crypto";
import { McpConnection, type McpTool } from "./client.js";
import { screen } from "../security/injection.js";
import { diagnostics } from "../foundations/diagnostics.js";

/** A connector the owner has installed, as stored. */
export interface McpServerConfig {
  readonly id: string;
  /** What the owner calls it. */
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * One approval, pinned to what was approved.
 *
 * `descriptionHash` is the pin. A server that rewrites a tool's description has
 * changed what the owner agreed to, whatever the name still says.
 */
export interface McpApproval {
  readonly serverId: string;
  readonly toolName: string;
  readonly descriptionHash: string;
}

/**
 * The pin that says a tool's description is the one the owner approved.
 *
 * The whole digest, not the first sixteen characters it used to be.
 *
 * Sixteen hex characters is 64 bits, and the threat model here is not a random
 * clash — it is a **third-party server that controls both descriptions.** It can
 * offer a harmless one, wait for approval, and later serve a malicious one whose
 * pin still matches. Choosing two inputs that collide at 64 bits is birthday
 * work, around 2^32, which is minutes rather than an obstacle. The whole digest
 * puts that back where SHA-256 puts it.
 *
 * Truncation bought a shorter string in a debug log and nothing else; the value
 * is never shown to a person and never typed by one.
 *
 * **Approvals stored before this change stop matching**, and the owner is asked
 * again for each tool. That is the correct direction to fail: `verifyApproval`
 * reads a mismatch as "changed since you approved it" and refuses until somebody
 * looks, so the worst case is a re-approval rather than a silent allow.
 */
export function describeHash(description: string): string {
  return createHash("sha256").update(description).digest("hex");
}

/** A tool as the owner sees it, with everything needed to decide. */
export interface McpToolView {
  readonly serverId: string;
  readonly serverLabel: string;
  readonly name: string;
  readonly description: string;
  /**
   * The pin, computed here and sent to the screen.
   *
   * The renderer must never derive this itself: two implementations that have
   * to agree is how an approval silently stops matching and every tool quietly
   * becomes unusable — or worse, keeps working after a description changed.
   */
  readonly descriptionHash: string;
  /** The server's unverified claim. Shown as a claim, never as a fact. */
  readonly claimsReadOnly: boolean;
  readonly approved: boolean;
  /**
   * Set when the owner approved this tool and the description has since
   * changed. The most important state on this screen: it means a connector
   * altered something already agreed to.
   */
  readonly changedSinceApproval: boolean;
  /**
   * Set when the description contains text that reads like an instruction to a
   * model rather than a description of a tool.
   */
  readonly suspicious: string | null;
}

/**
 * Builds what the owner sees for one server's tools.
 *
 * Pure, so the interesting decisions — lapsed approval, injected description —
 * are testable without starting a process.
 */
export function reviewTools(
  server: McpServerConfig,
  tools: readonly McpTool[],
  approvals: readonly McpApproval[]
): readonly McpToolView[] {
  return tools.map((tool) => {
    const hash = describeHash(tool.description);
    const approval = approvals.find(
      (candidate) => candidate.serverId === server.id && candidate.toolName === tool.name
    );
    const verdict = screen(tool.description, { source: `The ${tool.name} tool's description` });

    return {
      serverId: server.id,
      serverLabel: server.label,
      name: tool.name,
      description: tool.description,
      descriptionHash: hash,
      claimsReadOnly: tool.claimsReadOnly,
      approved: approval !== undefined && approval.descriptionHash === hash,
      changedSinceApproval: approval !== undefined && approval.descriptionHash !== hash,
      suspicious: verdict.requiresApproval ? verdict.summary : null
    };
  });
}

/**
 * Whether an agent may call this tool right now.
 *
 * Separate from `reviewTools` and deliberately re-derived rather than reading a
 * boolean off a view: the screen and the gate must not be able to disagree, and
 * the way they usually do is by one of them trusting the other's cached answer.
 */
export function mayCall(
  server: McpServerConfig,
  tool: McpTool,
  approvals: readonly McpApproval[]
): { readonly allowed: true } | { readonly allowed: false; readonly why: string } {
  const approval = approvals.find(
    (candidate) => candidate.serverId === server.id && candidate.toolName === tool.name
  );
  if (approval === undefined) {
    return {
      allowed: false,
      why: `${tool.name} from ${server.label} has not been approved. Open Connectors and read what it says it does.`
    };
  }
  if (approval.descriptionHash !== describeHash(tool.description)) {
    // The attack this exists for: ship something harmless, get approved, change
    // it later. Names stay stable precisely so nobody notices.
    return {
      allowed: false,
      why: `${tool.name} from ${server.label} has changed since you approved it. Read it again before it runs.`
    };
  }
  return { allowed: true };
}

/**
 * One connector, connected on demand.
 *
 * Lazy because a connector that starts at launch is a process running all day
 * for a tool nobody used, and eager connection would make an unreachable server
 * look like a broken app rather than a broken connector.
 */
export class McpConnector {
  private connection: McpConnection | null = null;
  private cachedTools: readonly McpTool[] | null = null;

  constructor(readonly config: McpServerConfig) {}

  async tools(): Promise<readonly McpTool[]> {
    if (this.cachedTools !== null) {
      return this.cachedTools;
    }
    const connection = await this.connect();
    this.cachedTools = await connection.tools();
    return this.cachedTools;
  }

  /**
   * Calls a tool, after checking it is still the tool that was approved.
   *
   * The check happens here rather than in the caller so there is exactly one
   * path to a third-party tool and it cannot be bypassed by a new caller.
   */
  async call(
    name: string,
    args: Readonly<Record<string, unknown>>,
    approvals: readonly McpApproval[]
  ): Promise<{ readonly text: string; readonly failed: boolean }> {
    // Re-read, never cached, for this one check.
    //
    // The cache is fine for drawing a screen. It is wrong here: a server that
    // changes a tool's description after the list was cached would be judged
    // against the old description — which still matches the approval — while
    // the *live* server runs whatever it is now. That is precisely the attack
    // the description pin exists to stop, arriving through the cache instead.
    this.cachedTools = null;
    const tools = await this.tools();
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      return { text: `${this.config.label} has no tool called ${name}.`, failed: true };
    }

    const verdict = mayCall(this.config, tool, approvals);
    if (!verdict.allowed) {
      diagnostics.warn("mcp", "refused an unapproved connector tool", {
        server: this.config.id,
        tool: name,
        why: verdict.why
      });
      return { text: verdict.why, failed: true };
    }

    const connection = await this.connect();
    return connection.call(name, args);
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
    // Dropped too: a reconnect must re-read the tool list, or a server that
    // changed its tools would be judged against the list from last time.
    this.cachedTools = null;
  }

  private async connect(): Promise<McpConnection> {
    if (this.connection === null) {
      this.connection = await McpConnection.open(this.config.command, this.config.args);
    }
    return this.connection;
  }
}
