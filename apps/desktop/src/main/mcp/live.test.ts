import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpConnection } from "./client.js";

/**
 * The client against a real third-party MCP server.
 *
 * Skipped unless MCP_LIVE=1, because it downloads a package.
 *
 * `client.test.ts` runs against a server written alongside the client, which
 * proves they agree with each other and nothing more. This runs against
 * `@modelcontextprotocol/server-filesystem` — software written by someone else,
 * to the spec, with no knowledge of this implementation. It is the only test
 * here that can find a place where the client agrees with its own assumptions
 * rather than with the protocol.
 */
describe("MCP against a real server", () => {
  let folder: string;
  let connection: McpConnection | null = null;

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "cadrane-mcp-live-"));
    await writeFile(join(folder, "quote.txt"), "Devgiri Traders — balance ₹9,360.");
  }, 60_000);

  afterAll(async () => {
    connection?.close();
    await rm(folder, { recursive: true, force: true });
  });

  it.runIf(process.env["MCP_LIVE"] === "1")(
    "handshakes, lists tools, and reads a file through somebody else's server",
    async () => {
      connection = await McpConnection.open("npx", [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        folder
      ]);

      const tools = await connection.tools();
      // eslint-disable-next-line no-console
      console.log(`\n${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}\n`);

      expect(tools.length).toBeGreaterThan(0);
      expect(tools.map((tool) => tool.name)).toContain("read_text_file");

      const result = await connection.call("read_text_file", {
        path: join(folder, "quote.txt")
      });

      expect(result.failed).toBe(false);
      expect(result.text).toContain("₹9,360");
    },
    180_000
  );
});
