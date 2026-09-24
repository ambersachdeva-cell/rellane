/** A native session must prove its selected folder boundary before receiving any work. */
import path from "node:path";

export function codexWorkspaceProfileArg(profileId: string): string {
  if (!/^rellane_[a-f0-9]{32}$/u.test(profileId)) throw new Error("Invalid native permission profile identifier.");
  // A child-scoped CLI definition survives both thread creation and later turn loading.
  // This is passed as one argv entry, never through a shell or a saved user config.
  return `permissions.${profileId}={extends=":workspace",filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"},network={enabled=false}}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The legacy sandbox projection cannot prove reads; the named profile and roots must match. */
export function verifyCodexWorkspaceProfile(response: Record<string, unknown>, profileId: string, cwd: string): void {
  const profile = record(response["activePermissionProfile"]);
  const sandbox = record(response["sandbox"]);
  const roots = response["runtimeWorkspaceRoots"];
  const writableRoots = sandbox?.["writableRoots"];
  const samePath = (value: unknown) => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === path.resolve(cwd);
  if (profile?.["id"] !== profileId || profile["extends"] !== ":workspace"
    || !samePath(response["cwd"])
    || !Array.isArray(roots) || roots.length !== 1 || !samePath(roots[0])
    || response["approvalPolicy"] !== "on-request" || response["approvalsReviewer"] !== "user"
    || sandbox?.["type"] !== "workspaceWrite" || sandbox["networkAccess"] !== false
    || sandbox["excludeTmpdirEnvVar"] !== true || sandbox["excludeSlashTmp"] !== true
    || !Array.isArray(writableRoots) || writableRoots.length > 1 || !writableRoots.every(samePath)) {
    throw new Error("Codex could not confirm the selected folder's read and write limits. Nothing was sent. Update the native Codex app before trying this connection again.");
  }
}
