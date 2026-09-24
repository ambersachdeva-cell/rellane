/**
 * Speaking MCP, so a connector is something you install rather than something
 * we write.
 *
 * The Model Context Protocol is the one place the wider ecosystem has actually
 * standardised: a server is a process that speaks JSON-RPC over its own stdin
 * and stdout, and it advertises a list of tools with JSON Schema for each. That
 * matters here because Phase 5 is connectors, and the alternative is writing a
 * bespoke integration per service forever — Tally, a GST portal, a bank
 * statement parser, each one ours to build and ours to maintain.
 *
 * ## The security position, which is the whole design
 *
 * An MCP server is **third-party code the owner installed**. It runs as its own
 * OS process, which is real isolation, but everything it *says* is a claim:
 *
 *   - **`annotations.readOnlyHint` is a hint, not a fact.** The protocol lets a
 *     server declare its tool harmless. A hostile or merely sloppy server
 *     declares whatever it likes. So the hint is displayed to the owner and
 *     never used to decide anything.
 *   - **Descriptions reach a model.** A tool description is attacker-controlled
 *     text heading for something that calls tools, which is prompt injection
 *     with a delivery mechanism. It is screened like any other untrusted text.
 *   - **Results are data.** Wrapped as evidence before a model sees them, the
 *     same as a file's contents.
 *
 * So the trust rule is inverted from the usual client: nothing an MCP server
 * says about its own safety is believed, and the owner approves tools rather
 * than servers.
 *
 * ## Framing
 *
 * The stdio transport is newline-delimited JSON — one complete JSON-RPC message
 * per line, no Content-Length header. Servers do sometimes write logging to
 * stdout despite the spec saying not to, so a line that is not JSON is skipped
 * rather than treated as a protocol failure.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { diagnostics } from "../foundations/diagnostics.js";

/** What this client tells a server it is. */
export const CLIENT_INFO = { name: "Rellane", version: "0.2.3" } as const;

/**
 * The protocol revision this client implements.
 *
 * Sent verbatim in `initialize`. A server that speaks something else says so in
 * its reply and the mismatch is reported rather than papered over — a client
 * that pretends to agree produces failures three calls later that look like bugs
 * in the server.
 */
export const PROTOCOL_VERSION = "2025-06-18";

/** A server takes this long to answer one call before it is considered gone. */
export const CALL_TIMEOUT_MS = 30_000;

/** Beyond this, a result is truncated rather than handed whole to a model. */
export const MAX_RESULT_CHARS = 60_000;

export class McpError extends Error {}

/** One tool a server advertises. Every field here is the server's claim. */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /**
   * The server's own claim that this tool only reads.
   *
   * Recorded and shown; never trusted. It exists so the owner can see what the
   * server asserts, and so a server asserting "read only" on something called
   * `delete_all` is visibly lying.
   */
  readonly claimsReadOnly: boolean;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * A live connection to one MCP server.
 *
 * Deliberately not a pool or a manager: one server, one process, and closing it
 * is the caller's job. Lifetime is easier to reason about than a cache, and a
 * connector that leaks a process is a connector that keeps reading somebody's
 * files after they revoked it.
 */
export class McpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;

    createInterface({ input: child.stdout }).on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || !trimmed.startsWith("{")) {
        // Servers do log to stdout despite the spec. Skipping is correct;
        // treating it as a protocol error would break working servers.
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return;
      }
      this.receive(message);
    });

    // A server's stderr is where its own errors go. Kept, because "the
    // connector did nothing" is unactionable and "it could not find its config
    // file" is a fix.
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim().length > 0) {
        diagnostics.warn("mcp", "server wrote to stderr", { line: line.slice(0, 300) });
      }
    });

    child.on("exit", (code) => {
      this.closed = true;
      this.failAll(new McpError(`The connector stopped${code === null ? "" : ` (exit ${code})`}.`));
    });
    child.on("error", (error: Error) => {
      this.closed = true;
      this.failAll(new McpError(error.message));
    });
  }

  /**
   * Starts a server and completes the handshake.
   *
   * Returns only once the server has answered `initialize`, so a caller that
   * gets a connection has one that actually works rather than a process that
   * may be about to exit.
   */
  static async open(
    command: string,
    args: readonly string[] = [],
    env: Readonly<Record<string, string>> = {}
  ): Promise<McpConnection> {
    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      // The owner's environment is not inherited wholesale: a connector has no
      // business reading whatever tokens happen to be exported in a shell.
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env }
    });

    const connection = new McpConnection(child);

    // A failed or timed-out handshake used to leave the child running for the
    // life of the app. A connector that will not start is the *normal* case —
    // wrong path, missing package, no network — so the leak was on the common
    // path, and it accumulated one orphan per attempt.
    let hello: { protocolVersion?: string; serverInfo?: { name?: string } };
    try {
      hello = (await connection.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO
      })) as typeof hello;
    } catch (error) {
      connection.close();
      throw error;
    }

    if (typeof hello.protocolVersion === "string" && hello.protocolVersion !== PROTOCOL_VERSION) {
      diagnostics.info("mcp", "server speaks a different protocol revision", {
        ours: PROTOCOL_VERSION,
        theirs: hello.protocolVersion,
        server: hello.serverInfo?.name ?? "unnamed"
      });
    }

    connection.notify("notifications/initialized", {});
    return connection;
  }

  /** Every tool the server advertises. Each field is the server's claim. */
  async tools(): Promise<readonly McpTool[]> {
    const result = (await this.request("tools/list", {})) as { tools?: unknown };
    if (!Array.isArray(result.tools)) {
      return [];
    }
    return result.tools.flatMap((entry): McpTool[] => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }
      const tool = entry as Record<string, unknown>;
      if (typeof tool["name"] !== "string" || tool["name"].length === 0) {
        return [];
      }
      const annotations = (tool["annotations"] ?? {}) as Record<string, unknown>;
      return [
        {
          name: tool["name"],
          description: typeof tool["description"] === "string" ? tool["description"] : "",
          inputSchema:
            typeof tool["inputSchema"] === "object" && tool["inputSchema"] !== null
              ? (tool["inputSchema"] as Record<string, unknown>)
              : {},
          // Read, recorded, and never acted on. See the header.
          claimsReadOnly: annotations["readOnlyHint"] === true
        }
      ];
    });
  }

  /**
   * Calls one tool and returns its output as text.
   *
   * A tool that reports its own failure (`isError`) is a refusal to pass on to
   * the model, not an exception: the model can often correct a bad argument, and
   * throwing would end a run that had further steps to take.
   */
  async call(
    name: string,
    args: Readonly<Record<string, unknown>>
  ): Promise<{ readonly text: string; readonly failed: boolean }> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: unknown;
      isError?: unknown;
    };

    const parts = Array.isArray(result.content) ? result.content : [];
    const text = parts
      .map((part) => {
        if (typeof part !== "object" || part === null) {
          return "";
        }
        const item = part as Record<string, unknown>;
        // Text is carried through. Anything else is *named* rather than
        // rendered, because a model cannot use an image and a caller should
        // not have to guess why the result looked empty.
        return typeof item["text"] === "string"
          ? item["text"]
          : `[${typeof item["type"] === "string" ? item["type"] : "unknown"} content, not shown]`;
      })
      .filter((part) => part.length > 0)
      .join("\n");

    return { text: text.slice(0, MAX_RESULT_CHARS), failed: result.isError === true };
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.child.kill();
      // Settled here rather than left to the `exit` handler. A child that
      // ignores the signal never exits, and every pending call would then hang
      // for its full thirty seconds — spending an agent's budget waiting on a
      // process that has already been abandoned.
      this.failAll(new McpError("The connector was stopped."));
    }
  }

  private request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new McpError("The connector is not running."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // Every call is bounded. A server that never answers must not hold an
      // agent's step budget open until its wall clock runs out.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`The connector did not answer ${method} within 30 seconds.`));
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Readonly<Record<string, unknown>>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: Readonly<Record<string, unknown>>): void {
    // Writing to a dead child raises EPIPE on the stream. Unhandled, that is an
    // uncaught error event, and an uncaught error event in the main process
    // takes the whole app down — a third-party connector crashing must never be
    // able to close the owner's window.
    // A write callback does not stop `stdin` emitting `'error'`, and an
    // unhandled `'error'` on a stream takes the whole process down. Writing to a
    // server that has just died throws EPIPE, so a third-party connector
    // crashing could take Rellane with it — the opposite of the isolation the
    // MCP layer exists to provide.
    this.child.stdin.on("error", () => undefined);
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error !== null && error !== undefined) {
        diagnostics.warn("mcp", "could not write to a connector", { error: error.message });
      }
    });
  }

  private receive(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const envelope = message as Record<string, unknown>;

    // A server request, not a reply to ours. MCP servers may call *us* —
    // `ping`, `roots/list`, `sampling/createMessage` — and those carry an id
    // too. Matching on the id alone resolved whichever of our calls happened to
    // share that number with somebody else's question.
    if (typeof envelope["method"] === "string") {
      // A string id counts. JSON-RPC allows either, and treating only numbers as
    // requests left a server that used strings waiting for a reply that was
    // never going to come — which is exactly the hang the branch below was
    // written to prevent.
    if (typeof envelope["id"] === "number" || typeof envelope["id"] === "string") {
        // Answered rather than ignored: an unanswered request leaves a
        // well-behaved server waiting, and some will not proceed until it is.
        this.write({
          jsonrpc: "2.0",
          id: envelope["id"],
          error: { code: -32601, message: "Rellane does not implement that." }
        });
      }
      return;
    }

    if (typeof envelope["id"] !== "number") {
      // A notification or a request from the server. Nothing is subscribed to
      // yet, and answering a request we do not implement would be worse than
      // silence.
      return;
    }
    const waiting = this.pending.get(envelope["id"]);
    if (waiting === undefined) {
      return;
    }
    this.pending.delete(envelope["id"]);
    clearTimeout(waiting.timer);

    const failure = envelope["error"];
    if (typeof failure === "object" && failure !== null) {
      const detail = failure as Record<string, unknown>;
      waiting.reject(
        new McpError(
          typeof detail["message"] === "string" ? detail["message"] : "The connector refused."
        )
      );
      return;
    }
    waiting.resolve(envelope["result"] ?? {});
  }

  private failAll(error: Error): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }
}
