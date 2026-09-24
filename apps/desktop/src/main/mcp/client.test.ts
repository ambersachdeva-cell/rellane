import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpConnection, McpError, PROTOCOL_VERSION } from "./client.js";

/**
 * The client against a real server process.
 *
 * `fake-server.mjs` is a separate process speaking actual newline-delimited
 * JSON-RPC over a pipe, not an in-memory mock. A mock proves the client agrees
 * with the mock; this proves it agrees with bytes coming out of stdout, which is
 * the part that actually breaks.
 */

const SERVER = fileURLToPath(new URL("./fake-server.mjs", import.meta.url));

let open: McpConnection[] = [];

async function connect(): Promise<McpConnection> {
  const connection = await McpConnection.open(process.execPath, [SERVER]);
  open.push(connection);
  return connection;
}

afterEach(() => {
  for (const connection of open) {
    connection.close();
  }
  open = [];
});

describe("the handshake", () => {
  it("completes even though the server logs plain text to stdout first", async () => {
    // The spec forbids this and real servers do it anyway. A client that treats
    // a stray log line as a protocol error breaks on working software.
    const connection = await connect();

    expect((await connection.tools()).length).toBeGreaterThan(0);
  });

  it("sends the protocol revision it actually implements", () => {
    // Claiming a revision we do not implement produces failures three calls
    // later that look like bugs in somebody else's server.
    expect(PROTOCOL_VERSION).toBe("2025-06-18");
  });

  it("reports a command that is not there, rather than hanging", async () => {
    await expect(McpConnection.open("/nonexistent/mcp-server")).rejects.toThrow(McpError);
  });
});

describe("what a server says about itself", () => {
  it("records the read-only hint without believing it", async () => {
    // The server claims readOnlyHint on a tool called delete_everything. The
    // client's job is to carry the claim, not to act on it — that decision
    // belongs to the owner, who can see that the claim is a lie.
    const tools = await (await connect()).tools();
    const destructive = tools.find((tool) => tool.name === "delete_everything");

    expect(destructive).toBeDefined();
    expect(destructive?.claimsReadOnly).toBe(true);
    // Nothing in the tool shape grants permission. There is no `risk`, no
    // `allowed`, no `safe` — the client cannot express trust here at all.
    expect(Object.keys(destructive ?? {}).sort()).toEqual([
      "claimsReadOnly",
      "description",
      "inputSchema",
      "name"
    ]);
  });

  it("carries the schema through so arguments can be validated later", async () => {
    const tools = await (await connect()).tools();
    const read = tools.find((tool) => tool.name === "read_ledger");

    expect(read?.inputSchema).toMatchObject({ type: "object", required: ["id"] });
  });
});

describe("calling a tool", () => {
  it("returns the text a server produced", async () => {
    const result = await (await connect()).call("read_ledger", { id: "42" });

    expect(result.failed).toBe(false);
    expect(result.text).toContain("Devgiri Traders, balance ₹9,360.");
  });

  it("names non-text content rather than dropping it silently", async () => {
    // A model cannot use an image, and a caller should not have to guess why
    // the result looked shorter than it was.
    const result = await (await connect()).call("read_ledger", { id: "42" });

    expect(result.text).toContain("[image content, not shown]");
  });

  it("passes a tool's own failure back instead of throwing", async () => {
    // The model can often fix a bad argument. Throwing would end a run that
    // still had steps left and money already spent.
    const result = await (await connect()).call("reports_failure", {});

    expect(result.failed).toBe(true);
    expect(result.text).toContain("No entry with that id.");
  });

  it("turns a protocol-level error into the server's own words", async () => {
    await expect((await connect()).call("explodes", {})).rejects.toThrow(/the ledger is locked/u);
  });

  it("keeps concurrent calls apart", async () => {
    // Responses arrive interleaved on one pipe. Matching them by id is the
    // whole correctness argument for this transport.
    const connection = await connect();
    const [a, b] = await Promise.all([
      connection.call("read_ledger", { id: "AAA" }),
      connection.call("read_ledger", { id: "BBB" })
    ]);

    expect(a.text).toContain("AAA");
    expect(b.text).toContain("BBB");
  });
});

describe("when a server misbehaves", () => {
  it("refuses further calls once the process is gone, rather than hanging", async () => {
    const connection = await connect();
    connection.close();

    await expect(connection.call("read_ledger", { id: "1" })).rejects.toThrow(/not running/u);
  });

  it("fails everything in flight when the server dies mid-call", async () => {
    // Otherwise an agent waits out its whole budget on a promise nobody will
    // ever settle.
    const connection = await connect();
    const inFlight = connection.call("never_answers", {});
    connection.close();

    await expect(inFlight).rejects.toThrow(McpError);
  });
});
