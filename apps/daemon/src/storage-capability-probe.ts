export const STORAGE_CAPABILITY_UTILITY_PROBE_MARKER =
  "switchboard-storage-capability-utility-probe-v1" as const;
const NODE_SQLITE_SPECIFIER = "node:sqlite" as const;

/** Inert package probe: the built-in module is loaded only if an explicit future gate invokes this. */
export async function inspectNodeSqliteModuleReference(): Promise<boolean> {
  const sqlite = await import(NODE_SQLITE_SPECIFIER);
  return typeof sqlite.DatabaseSync === "function";
}
