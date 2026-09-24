import * as http from "node:http";
import * as crypto from "node:crypto";
import * as net from "node:net";

export interface RemoteDispatchConfig {
  readonly port?: number; // default 0 (ephemeral) or specified
  readonly host?: string; // default "127.0.0.1"
  readonly pin?: string;  // 6-digit numeric PIN, auto-generated if absent
  readonly sessionTtlMs?: number;
}

export interface RemoteSessionInfo {
  readonly serverUrl: string;
  readonly host: string;
  readonly port: number;
  readonly pin: string;
  readonly token: string;
  readonly pairingUri: string;
}

export interface RemoteWorkstationState {
  readonly activeModel?: string;
  readonly isRunning: boolean;
  readonly currentTask?: string;
  readonly pendingApprovals: readonly {
    readonly id: string;
    readonly title: string;
    readonly detail: string;
  }[];
  readonly recentLogs: readonly string[];
}

export interface RemoteDispatchServer {
  readonly port: number;
  readonly host: string;
  readonly pin: string;
  start(): Promise<RemoteSessionInfo>;
  stop(): Promise<void>;
  updateState(state: Partial<RemoteWorkstationState>): void;
  broadcastEvent(event: { readonly type: string; readonly data: unknown }): void;
  onDecision(handler: (decision: { readonly permissionId: string; readonly allow: boolean }) => void): void;
  onDispatch(handler: (request: { readonly prompt: string; readonly modelId?: string }) => void): void;
}

interface TokenPayload {
  readonly exp: number;
  readonly nonce: string;
}

// Generate a random 6-digit PIN using secure random generation
function generateNumericPin(): string {
  const value = crypto.randomInt(0, 1_000_000);
  return value.toString().padStart(6, "0");
}

// Timing-safe comparison to prevent side-channel timing attacks during PIN validation
function verifyNumericPin(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

// Stateless HMAC-SHA256 token encoding to avoid server memory accumulation across long sessions
function generateToken(secret: Buffer, ttlMs: number): string {
  const payload: TokenPayload = {
    exp: Date.now() + ttlMs,
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  const payloadEncoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payloadEncoded).digest("base64url");
  return `${payloadEncoded}.${signature}`;
}

function verifyHmacToken(token: string, secret: Buffer): boolean {
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0) {
    return false;
  }
  const payloadEncoded = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  if (payloadEncoded.length === 0 || signature.length === 0) {
    return false;
  }

  const expectedSignature = crypto.createHmac("sha256", secret).update(payloadEncoded).digest("base64url");
  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expectedSignature, "utf8");

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return false;
  }

  try {
    const jsonStr = Buffer.from(payloadEncoded, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(jsonStr);
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    const exp = record["exp"];
    if (typeof exp !== "number") {
      return false;
    }
    if (Date.now() > exp) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Extract bearer token from Authorization header or URL query parameter for Safari EventSource compatibility
function extractBearerToken(req: http.IncomingMessage, url: URL): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith("bearer ")) {
      const token = trimmed.slice(7).trim();
      if (token.length > 0) {
        return token;
      }
    }
  }

  const queryToken = url.searchParams.get("token") ?? url.searchParams.get("access_token");
  if (typeof queryToken === "string" && queryToken.length > 0) {
    return queryToken;
  }

  return undefined;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const json = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json, "utf8").toString(),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(json);
}

// Bounded stream reader preventing denial of service from excessive payload size
async function readJsonBody(req: http.IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let bytes = 0;
    const chunks: Buffer[] = [];

    const onData = (chunk: Buffer): void => {
      if (finished) {
        return;
      }
      bytes += chunk.length;
      if (bytes > maxBytes) {
        finished = true;
        req.destroy();
        reject(new Error("PAYLOAD_TOO_LARGE"));
      } else {
        chunks.push(chunk);
      }
    };

    const onEnd = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(parsed);
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    };

    const onError = (err: Error): void => {
      if (finished) {
        return;
      }
      finished = true;
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

class RemoteDispatchServerImpl implements RemoteDispatchServer {
  private readonly configuredPort: number;
  private assignedPort: number;
  readonly host: string;
  readonly pin: string;
  private readonly sessionTtlMs: number;
  private readonly serverSecret: Buffer;

  private server: http.Server | null = null;
  private isRunningServer = false;
  private sessionInfo: RemoteSessionInfo | null = null;

  // Track sockets and SSE responses explicitly so server shutdown does not hang waiting for keep-alive connections
  private readonly sockets: Set<net.Socket> = new Set();
  private readonly sseClients: Set<http.ServerResponse> = new Set();

  private readonly decisionHandlers: ((decision: { readonly permissionId: string; readonly allow: boolean }) => void)[] = [];
  private readonly dispatchHandlers: ((request: { readonly prompt: string; readonly modelId?: string }) => void)[] = [];

  private currentState: RemoteWorkstationState = {
    isRunning: false,
    pendingApprovals: [],
    recentLogs: [],
  };

  constructor(config?: RemoteDispatchConfig) {
    this.configuredPort = config?.port !== undefined ? config.port : 0;
    this.assignedPort = this.configuredPort;
    this.host = config?.host !== undefined ? config.host : "127.0.0.1";
    this.pin = config?.pin !== undefined ? config.pin : generateNumericPin();
    this.sessionTtlMs = config?.sessionTtlMs !== undefined ? config.sessionTtlMs : 86_400_000;
    this.serverSecret = crypto.randomBytes(32);
  }

  get port(): number {
    return this.assignedPort;
  }

  async start(): Promise<RemoteSessionInfo> {
    if (this.isRunningServer && this.sessionInfo !== null) {
      return this.sessionInfo;
    }

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(() => {
          if (!res.headersSent) {
            sendJson(res, 500, {
              error: "Internal Server Error",
              detail: "An unexpected condition occurred on the workstation.",
            });
          }
        });
      });

      server.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.on("close", () => {
          this.sockets.delete(socket);
        });
      });

      const onError = (err: Error): void => {
        server.removeListener("error", onError);
        reject(err);
      };
      server.once("error", onError);

      server.listen(this.configuredPort, this.host, () => {
        server.removeListener("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Unable to determine listening address"));
          return;
        }

        this.assignedPort = address.port;
        this.server = server;
        this.isRunningServer = true;

        const serverUrl = `http://${this.host}:${this.assignedPort}`;
        const token = generateToken(this.serverSecret, this.sessionTtlMs);
        const pairingUri = `${serverUrl}/pair?pin=${this.pin}&token=${token}`;

        this.sessionInfo = {
          serverUrl,
          host: this.host,
          port: this.assignedPort,
          pin: this.pin,
          token,
          pairingUri,
        };

        resolve(this.sessionInfo);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server === null || !this.isRunningServer) {
      return;
    }
    this.isRunningServer = false;

    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // Ignored during shutdown
      }
    }
    this.sseClients.clear();

    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        // Ignored during shutdown
      }
    }
    this.sockets.clear();

    const activeServer = this.server;
    this.server = null;
    this.sessionInfo = null;

    await new Promise<void>((resolve, reject) => {
      activeServer.close((err) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
            resolve();
          } else {
            reject(err);
          }
        } else {
          resolve();
        }
      });
    });
  }

  updateState(state: Partial<RemoteWorkstationState>): void {
    const isRunning = state.isRunning !== undefined ? state.isRunning : this.currentState.isRunning;
    const pendingApprovals = state.pendingApprovals !== undefined ? state.pendingApprovals : this.currentState.pendingApprovals;
    const recentLogs = state.recentLogs !== undefined ? state.recentLogs : this.currentState.recentLogs;

    const hasActiveModel = "activeModel" in state;
    const activeModel = hasActiveModel ? state.activeModel : this.currentState.activeModel;

    const hasCurrentTask = "currentTask" in state;
    const currentTask = hasCurrentTask ? state.currentTask : this.currentState.currentTask;

    const nextState: RemoteWorkstationState = {
      isRunning,
      pendingApprovals,
      recentLogs,
      ...(typeof activeModel === "string" ? { activeModel } : {}),
      ...(typeof currentTask === "string" ? { currentTask } : {}),
    };

    this.currentState = nextState;
  }

  broadcastEvent(event: { readonly type: string; readonly data: unknown }): void {
    let serializedData: string;
    if (typeof event.data === "string") {
      serializedData = event.data;
    } else {
      serializedData = JSON.stringify(event.data ?? null);
    }

    const lines = serializedData.split(/\r?\n/);
    const dataLines = lines.map((l) => `data: ${l}`).join("\n");
    const message = `event: ${event.type}\n${dataLines}\n\n`;

    for (const client of this.sseClients) {
      try {
        client.write(message);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  onDecision(handler: (decision: { readonly permissionId: string; readonly allow: boolean }) => void): void {
    this.decisionHandlers.push(handler);
  }

  onDispatch(handler: (request: { readonly prompt: string; readonly modelId?: string }) => void): void {
    this.dispatchHandlers.push(handler);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    const hostHeader = typeof req.headers.host === "string" ? req.headers.host : `${this.host}:${this.assignedPort}`;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url ?? "/", `http://${hostHeader}`);
    } catch {
      sendJson(res, 400, {
        error: "Bad Request",
        detail: "The request URL was malformed.",
      });
      return;
    }

    const pathname = parsedUrl.pathname;
    const method = req.method ?? "GET";

    if (pathname === "/api/health") {
      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      sendJson(res, 200, {
        status: "ok",
        service: "rellane-remote-dispatch",
      });
      return;
    }

    if (pathname === "/api/pair") {
      if (method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
          sendJson(res, 413, {
            error: "Payload Too Large",
            detail: "The request body exceeds the maximum permitted size of 1 MB.",
          });
          return;
        }
        sendJson(res, 400, {
          error: "Bad Request",
          detail: "The request body must be valid JSON.",
        });
        return;
      }

      const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const pinVal = record["pin"];
      const suppliedPin = typeof pinVal === "string" ? pinVal : typeof pinVal === "number" ? String(pinVal) : "";

      if (suppliedPin.length === 0 || !verifyNumericPin(suppliedPin, this.pin)) {
        sendJson(res, 401, {
          error: "Unauthorized",
          detail: "The supplied PIN was incorrect.",
        });
        return;
      }

      const token = generateToken(this.serverSecret, this.sessionTtlMs);
      sendJson(res, 200, {
        token,
        expiresIn: Math.floor(this.sessionTtlMs / 1000),
      });
      return;
    }

    if (pathname.startsWith("/api/")) {
      const token = extractBearerToken(req, parsedUrl);
      if (token === undefined || !verifyHmacToken(token, this.serverSecret)) {
        sendJson(res, 401, {
          error: "Unauthorized",
          detail: "A valid bearer token is required.",
        });
        return;
      }

      if (pathname === "/api/state") {
        if (method !== "GET") {
          res.writeHead(405, { Allow: "GET" });
          res.end();
          return;
        }
        sendJson(res, 200, this.currentState);
        return;
      }

      if (pathname === "/api/decide") {
        if (method !== "POST") {
          res.writeHead(405, { Allow: "POST" });
          res.end();
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
            sendJson(res, 413, {
              error: "Payload Too Large",
              detail: "The request body exceeds the maximum permitted size of 1 MB.",
            });
            return;
          }
          sendJson(res, 400, {
            error: "Bad Request",
            detail: "The request body must be valid JSON.",
          });
          return;
        }

        const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
        const permissionId = record["permissionId"];
        const allow = record["allow"];

        if (typeof permissionId !== "string" || typeof allow !== "boolean") {
          sendJson(res, 400, {
            error: "Bad Request",
            detail: "A decision payload must include permissionId and allow.",
          });
          return;
        }

        for (const handler of this.decisionHandlers) {
          try {
            handler({ permissionId, allow });
          } catch {
            // Handlers are isolated from the HTTP response
          }
        }

        sendJson(res, 200, { status: "ok", permissionId, allow });
        return;
      }

      if (pathname === "/api/dispatch") {
        if (method !== "POST") {
          res.writeHead(405, { Allow: "POST" });
          res.end();
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
            sendJson(res, 413, {
              error: "Payload Too Large",
              detail: "The request body exceeds the maximum permitted size of 1 MB.",
            });
            return;
          }
          sendJson(res, 400, {
            error: "Bad Request",
            detail: "The request body must be valid JSON.",
          });
          return;
        }

        const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
        const prompt = record["prompt"];
        const modelId = record["modelId"];

        if (typeof prompt !== "string") {
          sendJson(res, 400, {
            error: "Bad Request",
            detail: "A dispatch payload must include a prompt string.",
          });
          return;
        }

        const requestPayload: { readonly prompt: string; readonly modelId?: string } =
          typeof modelId === "string" && modelId.length > 0
            ? { prompt, modelId }
            : { prompt };

        for (const handler of this.dispatchHandlers) {
          try {
            handler(requestPayload);
          } catch {
            // Handlers are isolated from the HTTP response
          }
        }

        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (pathname === "/api/events") {
        if (method !== "GET") {
          res.writeHead(405, { Allow: "GET" });
          res.end();
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        if (typeof res.flushHeaders === "function") {
          res.flushHeaders();
        }

        this.sseClients.add(res);

        const cleanup = (): void => {
          this.sseClients.delete(res);
        };

        req.on("close", cleanup);
        res.on("close", cleanup);
        res.on("error", cleanup);
        return;
      }

      sendJson(res, 404, {
        error: "Not Found",
        detail: "The requested resource was not found.",
      });
      return;
    }

    if (pathname === "/" || pathname === "/pair") {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rellane Remote Dispatch</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #121214; color: #ededef; margin: 0; padding: 2rem; }
.card { max-width: 440px; margin: 3rem auto; background: #1a1a1e; border: 1px solid #2e2e34; border-radius: 8px; padding: 1.5rem; }
h1 { font-size: 1.1rem; font-weight: 500; margin: 0 0 0.5rem; color: #ffffff; }
p { font-size: 0.875rem; line-height: 1.5; color: #9e9ea6; margin: 0 0 1rem; }
.badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-family: ui-monospace, monospace; background: #27272d; color: #d0d0d8; }
</style>
</head>
<body>
<div class="card">
<h1>Rellane Dispatch</h1>
<p>Your mobile continuation session is active on local Wi-Fi.</p>
<p>Status: <span class="badge">Connected</span></p>
</div>
</body>
</html>`;

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html, "utf8").toString(),
      });
      res.end(html);
      return;
    }

    sendJson(res, 404, {
      error: "Not Found",
      detail: "The requested resource was not found.",
    });
  }
}

export function createRemoteDispatchServer(config?: RemoteDispatchConfig): RemoteDispatchServer {
  return new RemoteDispatchServerImpl(config);
}
