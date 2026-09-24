/**
 * The connectors screen, and the one path an agent takes to a third-party tool.
 *
 * Holds the live connections, because starting a process per question would make
 * opening the screen cost five `npx` invocations. Connections are opened on
 * demand and dropped when a connector is removed, so nothing runs that the owner
 * has not installed and nothing keeps running after they change their mind.
 *
 * Every refusal here is a sentence rather than an exception. A connector that
 * will not start is the normal case — `npx` is not on the PATH, the folder moved,
 * the package was renamed upstream — and the owner needs to read what happened,
 * not see a red toast with a stack trace behind it.
 */

import type { McpApprovalSetting, McpServerSetting } from "../foundations/settings.js";
import { CATALOGUE, noticesFor, type CatalogueEntry } from "./catalogue.js";
import { McpConnector, reviewTools, type McpToolView } from "./registry.js";
import { diagnostics } from "../foundations/diagnostics.js";

/** One installed connector, as the screen shows it. */
export interface ConnectorView {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  /** Null while it has not been reached yet. */
  readonly tools: readonly McpToolView[] | null;
  /** Set when it could not be started, in the owner's words. */
  readonly problem: string | null;
}

export interface ConnectorsSnapshot {
  readonly installed: readonly ConnectorView[];
  /** What can be installed, with licences already checked. */
  readonly available: readonly CatalogueEntry[];
  /** The attribution owed, generated from what is actually installed. */
  readonly notices: string;
}

const live = new Map<string, McpConnector>();

function sameConfig(a: McpServerSetting, b: McpServerSetting): boolean {
  return (
    a.command === b.command &&
    a.label === b.label &&
    a.args.length === b.args.length &&
    a.args.every((arg, index) => arg === b.args[index])
  );
}

function connectorFor(setting: McpServerSetting): McpConnector {
  const existing = live.get(setting.id);
  // Rebuilt when the command or arguments change, because an existing
  // connection is to the old command — and silently keeping it would mean an
  // edit that appears to apply and does not.
  if (existing !== undefined && sameConfig(existing.config, setting)) {
    return existing;
  }
  existing?.close();
  const made = new McpConnector(setting);
  live.set(setting.id, made);
  return made;
}

/** Closes a connector's process. Called when one is removed. */
export function dropConnector(id: string): void {
  live.get(id)?.close();
  live.delete(id);
}

/** Closes everything. Called on quit. */
export function dropAllConnectors(): void {
  for (const connector of live.values()) {
    connector.close();
  }
  live.clear();
}

/**
 * Everything the connectors screen needs.
 *
 * Reaches every installed connector in parallel: they are separate processes and
 * a slow one should not hold up a screen listing four others.
 */
export async function readConnectors(
  installed: readonly McpServerSetting[],
  approvals: readonly McpApprovalSetting[]
): Promise<ConnectorsSnapshot> {
  const views = await Promise.all(
    installed.map(async (setting): Promise<ConnectorView> => {
      try {
        const tools = await connectorFor(setting).tools();
        return {
          id: setting.id,
          label: setting.label,
          command: [setting.command, ...setting.args].join(" "),
          tools: reviewTools(setting, tools, approvals),
          problem: null
        };
      } catch (error) {
        diagnostics.warn("mcp", "a connector would not start", {
          connector: setting.id,
          error: error instanceof Error ? error.message : "unknown"
        });
        return {
          id: setting.id,
          label: setting.label,
          command: [setting.command, ...setting.args].join(" "),
          tools: null,
          problem: `${setting.label} would not start. ${
            error instanceof Error ? error.message : "It gave no reason."
          }`
        };
      }
    })
  );

  return {
    installed: views,
    // Already-installed entries are dropped from the list, so the screen offers
    // what can be added rather than what exists.
    available: CATALOGUE.filter(
      (entry) => !installed.some((setting) => setting.id === entry.id)
    ),
    notices: noticesFor(installed.map((setting) => setting.id))
  };
}

/**
 * Calls a connector tool on an agent's behalf.
 *
 * The approval check lives inside `McpConnector.call`, not here, so there is
 * exactly one path to a third-party tool and a future caller cannot skip it.
 */
export async function callConnectorTool(
  installed: readonly McpServerSetting[],
  approvals: readonly McpApprovalSetting[],
  serverId: string,
  toolName: string,
  args: Readonly<Record<string, unknown>>
): Promise<{ readonly text: string; readonly failed: boolean }> {
  const setting = installed.find((candidate) => candidate.id === serverId);
  if (setting === undefined) {
    return { text: `There is no connector called ${serverId}.`, failed: true };
  }
  try {
    return await connectorFor(setting).call(toolName, args, approvals);
  } catch (error) {
    return {
      text: error instanceof Error ? error.message : "That connector failed.",
      failed: true
    };
  }
}
