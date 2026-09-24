import { describe, expect, it } from "vitest";
import { codexIsolatedArgs, codexMcpDeclaration } from "./codex-policy.js";

describe("native Codex connector isolation", () => {
  it("finds each server without returning configuration values", () => {
    expect(codexMcpDeclaration("[mcp_servers.computer-use]")).toBe("computer-use");
    expect(codexMcpDeclaration(" [mcp_servers.node_repl.env] # environment ")).toBe("node_repl");
    expect(codexMcpDeclaration('  token = "fixture-private-value"')).toBeNull();
    expect(codexMcpDeclaration("# [mcp_servers.comment]")).toBeNull();
  });
  it("handles quoted keys and profile declarations", () => {
    expect(codexMcpDeclaration('["mcp_servers" . "docs"]')).toBe("docs");
    expect(codexMcpDeclaration("[profiles.'personal'.mcp_servers.'docs'.env]")).toBe("docs");
  });
  it("refuses connector declarations it cannot safely override", () => {
    for (const line of ['[mcp_servers."name.with.dots"]', '[mcp_servers]',
      'mcp_servers = { remote = { url = "fixture" } }',
      '"mcp_servers".remote.enabled = true', '["mcp_servers\\u002eextra".remote]',
      '[[mcp_servers.remote]]']) {
      expect(() => codexMcpDeclaration(line)).toThrow(/isolat/i);
    }
  });
  it("disables inherited connectors and outbound features for the child only", () => {
    const args = codexIsolatedArgs(["docs", "computer-use", "docs"]);
    expect(args.filter(value => value === "mcp_servers.docs.enabled=false")).toHaveLength(1);
    expect(args).toContain("mcp_servers.computer-use.enabled=false");
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain("project_doc_max_bytes=0");
    for (const name of ["apps", "plugins", "hooks", "memories", "computer_use", "browser_use"]) {
      expect(args[args.indexOf(name) - 1]).toBe("--disable");
    }
    expect(args.some(arg => arg.includes("fixture-private-value"))).toBe(false);
  });
  it("refuses command/config injection through a server name", () => {
    for (const name of ['remote.enabled=true', 'remote\nother', '--config', '']) {
      expect(() => codexIsolatedArgs([name === '--config' ? 'remote; --config' : name])).toThrow();
    }
  });
});
