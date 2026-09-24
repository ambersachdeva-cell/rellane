import { describe, expect, it } from "vitest";
import { codexWorkspaceProfileArg, verifyCodexWorkspaceProfile } from "./codex-access.js";

const cwd = "/workspace/client";
function nativeReply(): Record<string, unknown> {
  return {
    cwd, runtimeWorkspaceRoots: [cwd],
    activePermissionProfile: { id: "rellane_example", extends: ":workspace" },
    approvalPolicy: "on-request", approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
  };
}

describe("the native folder boundary", () => {
  it("denies broad filesystem and temp reads while preserving platform and workspace protections", () => {
    const profile = codexWorkspaceProfileArg("rellane_" + "a".repeat(32));
    expect(profile).toContain('extends=":workspace"');
    expect(profile).toContain('":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"');
    expect(profile).toContain('network={enabled=false}');
    expect(() => codexWorkspaceProfileArg('rellane_.network.enabled=true')).toThrow("Invalid");
  });
  it("accepts the actual named profile with one exact root and user approvals", () => {
    expect(() => verifyCodexWorkspaceProfile(nativeReply(), "rellane_example", cwd)).not.toThrow();
  });
  it("does not accept a legacy write-only projection as proof of restricted reads", () => {
    const reply = nativeReply(); delete reply.activePermissionProfile;
    expect(() => verifyCodexWorkspaceProfile(reply, "rellane_example", cwd)).toThrow("Nothing was sent");
  });
  it("rejects changed root, network, temporary-directory or reviewer boundaries", () => {
    const base = nativeReply();
    const sandbox = base.sandbox as Record<string, unknown>;
    const changes: Record<string, unknown>[] = [
      { cwd: "/workspace/other" }, { runtimeWorkspaceRoots: [] }, { runtimeWorkspaceRoots: [cwd, "/private"] },
      { activePermissionProfile: { id: "someone_else", extends: ":workspace" } },
      { activePermissionProfile: { id: "rellane_example", extends: ":danger-full-access" } },
      { approvalPolicy: "never" }, { approvalsReviewer: "auto_review" },
      ...[{ networkAccess: true }, { excludeTmpdirEnvVar: false }, { excludeSlashTmp: false }, { writableRoots: ["/private"] }, { writableRoots: null }]
        .map(value => ({ sandbox: { ...sandbox, ...value } }))
    ];
    for (const change of changes)
      expect(() => verifyCodexWorkspaceProfile({ ...base, ...change }, "rellane_example", cwd)).toThrow("Nothing was sent");
  });
});
