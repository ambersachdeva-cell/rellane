import * as http from "node:http";
import * as crypto from "node:crypto";
import * as net from "node:net";

export type WorkstationProviderId = "codex" | "claude" | "gemini1" | "gemini2" | "gemini3";

export interface WorkstationReviewToolSource {
  readonly label: string;
  readonly chars: number;
}

export interface WorkstationReviewTools {
  readonly enabled: boolean;
  readonly toolNames: readonly string[];
  readonly skillIds: readonly string[];
  readonly sources: readonly WorkstationReviewToolSource[];
  readonly totalSourceChars: number;
  readonly reachNote: string;
  readonly freshSessionNote: string;
}

export interface WorkstationWorkspace {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

export interface WorkstationReview {
  readonly token: string;
  readonly caseId: string;
  readonly providerId: WorkstationProviderId;
  readonly providerLabel: string;
  readonly modelId: string | null;
  readonly prompt: string;
  readonly contextPreview: string;
  readonly sourceIds: readonly string[];
  readonly sourceHash: string;
  readonly projectId?: string | null;
  readonly memoryEpoch?: number;
  readonly contextSnapshotId?: string;
  readonly workspace: WorkstationWorkspace;
  readonly expiresAt: number;
  readonly resumeSessionId: string | null;
  readonly tools?: WorkstationReviewTools;
}

export interface RemoteDispatchConfig {
  readonly port?: number; // default 0 (ephemeral) or specified
  readonly host?: string; // default "127.0.0.1"
  readonly pin?: string;  // 6-digit numeric PIN, auto-generated if absent
  readonly sessionTtlMs?: number;
  readonly maxReplayEntries?: number;
  readonly maxPairingAttempts?: number;
  readonly pairingLockoutMs?: number;
}

export interface RemoteSessionInfo {
  readonly serverUrl: string;
  readonly host: string;
  readonly port: number;
  readonly pin: string;
  readonly token: string;
  readonly pairingUri: string;
  readonly principalId: string;
}

export interface RemotePendingApproval {
  readonly id?: string;
  readonly operationId: string;
  readonly permissionId: string;
  readonly title: string;
  readonly detail: string;
  readonly revision: string;
  readonly expiresAt: number;
}

export interface RemoteWorkstationState {
  readonly activeModel?: string;
  readonly isRunning: boolean;
  readonly currentTask?: string;
  readonly pendingApprovals: readonly RemotePendingApproval[];
  readonly recentLogs: readonly string[];
  readonly operationStatus?: string;
  readonly operationId?: string;
}

export type RemoteReceiptStatus = "accepted" | "rejected" | "uncertain";

export interface RemoteCommandReceipt {
  readonly status: RemoteReceiptStatus;
  readonly detail?: string;
  readonly operationId?: string;
  readonly review?: WorkstationReview;
}

export type RemoteCommandResult = RemoteCommandReceipt;

export type RemoteCommandHandlerResult = RemoteCommandReceipt | void;

export interface RemotePrepareRequest {
  readonly requestId: string;
  readonly caseId: string;
  readonly providerId: WorkstationProviderId;
  readonly modelId: string;
  readonly prompt: string;
  readonly sourceTurnIds: readonly string[];
  readonly enableTools?: boolean;
  readonly workspaceId?: string;
}

export interface RemoteDispatchRequest {
  readonly requestId: string;
  readonly reviewToken: string;
}

export interface RemoteDecisionRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly permissionId: string;
  readonly revision: string;
  readonly allow: boolean;
}

export interface RemoteStopRequest {
  readonly requestId: string;
  readonly operationId: string;
}

export type RemoteRevocationReason = "expired" | "shutdown" | "replaced" | "client";

export interface RemotePrincipalRevocation {
  readonly principalId: string;
  readonly reason: RemoteRevocationReason;
}

export type RemotePrepareHandler = (
  request: RemotePrepareRequest,
  principalId: string
) => Promise<RemoteCommandHandlerResult> | RemoteCommandHandlerResult;

export type RemoteDispatchHandler = (
  request: RemoteDispatchRequest,
  principalId: string
) => Promise<RemoteCommandHandlerResult> | RemoteCommandHandlerResult;

export type RemoteDecisionHandler = (
  decision: RemoteDecisionRequest,
  principalId: string
) => Promise<RemoteCommandHandlerResult> | RemoteCommandHandlerResult;

export type RemoteStopHandler = (
  request: RemoteStopRequest,
  principalId: string
) => Promise<RemoteCommandHandlerResult> | RemoteCommandHandlerResult;

export type RemoteStateHandler = (
  principalId: string
) => Promise<RemoteWorkstationState> | RemoteWorkstationState;

export type RemotePrincipalRevocationHandler = (
  revocation: RemotePrincipalRevocation
) => Promise<void> | void;

export interface RemoteDispatchServer {
  readonly port: number;
  readonly host: string;
  readonly pin: string;
  start(): Promise<RemoteSessionInfo>;
  stop(): Promise<void>;
  updateState(state: Partial<RemoteWorkstationState>, principalId?: string): void;
  broadcastEvent(event: { readonly type: string; readonly data: unknown; readonly principalId?: string }): void;
  sendEvent(principalId: string, event: { readonly type: string; readonly data: unknown }): void;
  onPrepare(handler: RemotePrepareHandler): void;
  onDispatch(handler: RemoteDispatchHandler): void;
  onDecision(handler: RemoteDecisionHandler): void;
  onStop(handler: RemoteStopHandler): void;
  onState(handler: RemoteStateHandler): void;
  onRevokePrincipal(handler: RemotePrincipalRevocationHandler): void;
  /** Trusted Mac process only; never an HTTP route or a PIN capability. */
  pairedPrincipals(): readonly string[];
  prepareOneRunHandover(input: RemoteOneRunHandoverScope): RemoteOneRunHandoverReview;
  commitOneRunHandover(token: string, transfer: (scope: RemoteOneRunHandoverScope) => void): RemoteOneRunHandoverScope;
}

export interface RemoteOneRunHandoverScope {
  readonly caseId: string;
  readonly operationId: string;
  readonly oldPrincipalId: string;
  readonly newPrincipalId: string;
}
export interface RemoteOneRunHandoverReview extends RemoteOneRunHandoverScope {
  readonly token: string;
  readonly expiresAt: number;
  readonly generation: number;
}

export function computeActionRevision(input: {
  readonly operationId: string;
  readonly permissionId: string;
  readonly title: string;
  readonly detail: string;
  readonly hostUpdate?: string | number;
}): string {
  const update = input.hostUpdate !== undefined ? String(input.hostUpdate) : "0";
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([input.operationId, input.permissionId, input.title, input.detail, update]))
    .digest("hex");
}

interface TokenPayload {
  readonly exp: number;
  readonly nonce: string;
  readonly principalId: string;
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
function generateToken(secret: Buffer, ttlMs: number, principalId: string): string {
  const payload: TokenPayload = {
    exp: Date.now() + ttlMs,
    nonce: crypto.randomBytes(16).toString("hex"),
    principalId,
  };
  const payloadEncoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payloadEncoded).digest("base64url");
  return `${payloadEncoded}.${signature}`;
}

function verifyHmacToken(
  token: string,
  secret: Buffer
): { readonly valid: true; readonly payload: TokenPayload } | { readonly valid: false } {
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0) {
    return { valid: false };
  }
  const payloadEncoded = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  if (payloadEncoded.length === 0 || signature.length === 0) {
    return { valid: false };
  }

  const expectedSignature = crypto.createHmac("sha256", secret).update(payloadEncoded).digest("base64url");
  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expectedSignature, "utf8");

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false };
  }

  try {
    const jsonStr = Buffer.from(payloadEncoded, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(jsonStr);
    if (typeof parsed !== "object" || parsed === null) {
      return { valid: false };
    }
    const record = parsed as Record<string, unknown>;
    const exp = record["exp"];
    const nonce = record["nonce"];
    const principalId = record["principalId"];
    if (typeof exp !== "number" || typeof nonce !== "string" || typeof principalId !== "string") {
      return { valid: false };
    }
    if (Date.now() > exp) {
      return { valid: false };
    }
    return { valid: true, payload: { exp, nonce, principalId } };
  } catch {
    return { valid: false };
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

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function computePayloadFingerprint(pathname: string, payload: Record<string, unknown>): string {
  const sortedKeys = Object.keys(payload).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    sortedObj[k] = payload[k];
  }
  return crypto.createHash("sha256").update(`${pathname}:${JSON.stringify(sortedObj)}`).digest("hex");
}

function isValidWorkstationReview(review: unknown): review is WorkstationReview {
  if (typeof review !== "object" || review === null) {
    return false;
  }
  const r = review as Record<string, unknown>;
  if (!isNonEmptyBoundedString(r["token"], 128)) return false;
  if (!isNonEmptyBoundedString(r["caseId"], 64)) return false;
  if (
    r["providerId"] !== "codex" &&
    r["providerId"] !== "claude" &&
    r["providerId"] !== "gemini1" &&
    r["providerId"] !== "gemini2" &&
    r["providerId"] !== "gemini3"
  ) {
    return false;
  }
  if (!isNonEmptyBoundedString(r["providerLabel"], 120)) return false;
  if (r["modelId"] !== null && typeof r["modelId"] !== "string") return false;
  if (!isNonEmptyBoundedString(r["prompt"], 8000)) return false;
  if (!isNonEmptyBoundedString(r["contextPreview"], 1_048_576)) return false;
  if (!Array.isArray(r["sourceIds"]) || !r["sourceIds"].every((id) => typeof id === "string")) return false;
  if (!isNonEmptyBoundedString(r["sourceHash"], 128)) return false;
  if (typeof r["expiresAt"] !== "number" || !Number.isFinite(r["expiresAt"])) return false;
  if (r["resumeSessionId"] !== null && typeof r["resumeSessionId"] !== "string") return false;
  if (typeof r["workspace"] !== "object" || r["workspace"] === null) return false;
  const ws = r["workspace"] as Record<string, unknown>;
  if (typeof ws["id"] !== "string" || typeof ws["label"] !== "string" || typeof ws["path"] !== "string") {
    return false;
  }
  return true;
}

function isPublicServerHealthEvent(type: string): boolean {
  return type === "heartbeat" || type === "health" || type === "server_health" || type === "ping";
}

interface CachedResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

interface ReplayEntry {
  readonly fingerprint: string;
  status: "pending" | "completed" | "uncertain";
  promise?: Promise<CachedResponse>;
  response?: CachedResponse;
}

interface ActivePrincipal {
  readonly principalId: string;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
  readonly kind: "mac" | "phone";
  readonly sequence: number;
  readonly pairedAt: number;
}

interface PreparedReviewEntry {
  readonly principalId: string;
  readonly review: WorkstationReview;
  readonly expiresAt: number;
}

class RemoteDispatchServerImpl implements RemoteDispatchServer {
  private readonly configuredPort: number;
  private assignedPort: number;
  readonly host: string;
  readonly pin: string;
  private readonly sessionTtlMs: number;
  private serverSecret: Buffer;

  private server: http.Server | null = null;
  private isRunningServer = false;
  private sessionInfo: RemoteSessionInfo | null = null;

  // Track sockets and SSE responses explicitly so server shutdown does not hang waiting for keep-alive connections
  private readonly sockets: Set<net.Socket> = new Set();
  private readonly sseClients: Map<http.ServerResponse, string> = new Map();
  private readonly sseClientsByPrincipal: Map<string, Set<http.ServerResponse>> = new Map();

  private readonly prepareHandlers: RemotePrepareHandler[] = [];
  private readonly dispatchHandlers: RemoteDispatchHandler[] = [];
  private readonly decisionHandlers: RemoteDecisionHandler[] = [];
  private readonly stopHandlers: RemoteStopHandler[] = [];
  private readonly stateHandlers: RemoteStateHandler[] = [];
  private readonly revocationHandlers: RemotePrincipalRevocationHandler[] = [];

  private readonly maxReplayEntries: number;
  private readonly maxSseClients = 100;
  private readonly replayMap: Map<string, ReplayEntry> = new Map();
  private readonly maxPairingAttempts: number;
  private readonly pairingLockoutMs: number;
  private readonly pairingFailures = new Map<string, { count: number; lastAt: number; lockedUntil: number }>();
  private generation = 0;
  private nextPrincipalSequence = 0;
  private readonly handoverReviews = new Map<string, RemoteOneRunHandoverReview>();

  private readonly activePrincipals: Map<string, ActivePrincipal> = new Map();
  private readonly preparedReviews: Map<string, PreparedReviewEntry> = new Map();

  private currentState: RemoteWorkstationState = {
    isRunning: false,
    pendingApprovals: [],
    recentLogs: [],
  };
  private readonly principalStates: Map<string, RemoteWorkstationState> = new Map();

  constructor(config?: RemoteDispatchConfig) {
    this.configuredPort = config?.port !== undefined ? config.port : 0;
    this.assignedPort = this.configuredPort;
    this.host = config?.host !== undefined ? config.host : "127.0.0.1";
    this.pin = config?.pin !== undefined ? config.pin : generateNumericPin();
    this.sessionTtlMs = config?.sessionTtlMs !== undefined ? config.sessionTtlMs : 86_400_000;
    this.maxReplayEntries = config?.maxReplayEntries !== undefined ? config.maxReplayEntries : 1000;
    this.maxPairingAttempts = config?.maxPairingAttempts ?? 5;
    this.pairingLockoutMs = config?.pairingLockoutMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.maxPairingAttempts) || this.maxPairingAttempts < 1 ||
        !Number.isSafeInteger(this.pairingLockoutMs) || this.pairingLockoutMs < 1) {
      throw new Error("Pairing rate limit must use positive safe integers.");
    }
    this.serverSecret = crypto.randomBytes(32);
  }

  get port(): number {
    return this.assignedPort;
  }

  async start(): Promise<RemoteSessionInfo> {
    if (this.isRunningServer && this.sessionInfo !== null) {
      return this.sessionInfo;
    }

    this.generation++;
    this.serverSecret = crypto.randomBytes(32);
    this.replayMap.clear();
    this.pairingFailures.clear();
    this.preparedReviews.clear();
    this.activePrincipals.clear();
    this.handoverReviews.clear();
    this.principalStates.clear();

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
        const principalId = `prnc_${crypto.randomBytes(16).toString("hex")}`;
        const token = generateToken(this.serverSecret, this.sessionTtlMs, principalId);
        this.registerPrincipal(principalId, Date.now() + this.sessionTtlMs, "mac");
        const pairingUri = `${serverUrl}/pair?pin=${this.pin}`;

        this.sessionInfo = {
          serverUrl,
          host: this.host,
          port: this.assignedPort,
          pin: this.pin,
          token,
          pairingUri,
          principalId,
        };

        resolve(this.sessionInfo);
      });
    });
  }

  private registerPrincipal(principalId: string, expiresAt: number, kind: "mac" | "phone"): void {
    const ttl = Math.max(0, expiresAt - Date.now());
    const timer = setTimeout(() => {
      void this.revokePrincipal(principalId, "expired");
    }, ttl);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.activePrincipals.set(principalId, { principalId, expiresAt, timer, kind,
      sequence: ++this.nextPrincipalSequence, pairedAt: Date.now() });
  }

  pairedPrincipals(): readonly string[] {
    if (!this.isRunningServer) return [];
    return [...this.activePrincipals.values()].filter((principal) =>
      principal.kind === "phone" && principal.expiresAt > Date.now())
      .map((principal) => principal.principalId);
  }

  private assertHandoverScope(input: RemoteOneRunHandoverScope): void {
    if (!this.isRunningServer || !input.caseId || !input.operationId ||
        input.oldPrincipalId === input.newPrincipalId)
      throw new Error("The remote handover is unavailable.");
    const oldPrincipal = this.activePrincipals.get(input.oldPrincipalId);
    const newPrincipal = this.activePrincipals.get(input.newPrincipalId);
    const now = Date.now();
    if (!oldPrincipal || !newPrincipal || oldPrincipal.kind !== "phone" || newPrincipal.kind !== "phone" ||
        oldPrincipal.expiresAt <= now || newPrincipal.expiresAt <= now ||
        newPrincipal.sequence <= oldPrincipal.sequence || now - newPrincipal.pairedAt > 2 * 60_000)
      throw new Error("Choose a current old pairing and a newly paired phone.");
    for (const [key, entry] of this.replayMap)
      if ((key.startsWith(`${input.oldPrincipalId}:`) && entry.status === "pending") ||
          key.startsWith(`${input.newPrincipalId}:`))
        throw new Error("A remote command is active or the new pairing has already issued commands.");
    if ([...this.preparedReviews.values()].some((review) => review.principalId === input.newPrincipalId))
      throw new Error("The new pairing already holds a review.");
  }

  prepareOneRunHandover(input: RemoteOneRunHandoverScope): RemoteOneRunHandoverReview {
    this.assertHandoverScope(input);
    if (this.handoverReviews.size >= 8) throw new Error("Too many pending handover reviews.");
    const review: RemoteOneRunHandoverReview = Object.freeze({ ...input,
      token: crypto.randomBytes(32).toString("hex"), expiresAt: Date.now() + 60_000,
      generation: this.generation });
    this.handoverReviews.set(review.token, review);
    return review;
  }

  commitOneRunHandover(token: string, transfer: (scope: RemoteOneRunHandoverScope) => void): RemoteOneRunHandoverScope {
    const review = this.handoverReviews.get(token);
    this.handoverReviews.delete(token);
    if (!review || review.expiresAt <= Date.now() || review.generation !== this.generation)
      throw new Error("This Mac handover review expired or was already used.");
    this.assertHandoverScope(review);
    // No await between the final command check, exact Host transfer, and bearer
    // revocation. Requests still reading a body fail the post-body auth check.
    transfer(review);
    void this.revokePrincipal(review.oldPrincipalId, "replaced");
    for (const [key, pending] of this.handoverReviews)
      if (pending.oldPrincipalId === review.oldPrincipalId || pending.newPrincipalId === review.newPrincipalId)
        this.handoverReviews.delete(key);
    return review;
  }

  private async revokePrincipal(principalId: string, reason: RemoteRevocationReason): Promise<void> {
    const principal = this.activePrincipals.get(principalId);
    if (principal) {
      clearTimeout(principal.timer);
      this.activePrincipals.delete(principalId);
    }
    for (const [token, review] of this.handoverReviews)
      if (review.oldPrincipalId === principalId || review.newPrincipalId === principalId)
        this.handoverReviews.delete(token);

    // Close SSE connections for this principal
    const clients = this.sseClientsByPrincipal.get(principalId);
    if (clients) {
      for (const client of clients) {
        try {
          client.end();
        } catch {
          // ignore
        }
        this.sseClients.delete(client);
      }
      this.sseClientsByPrincipal.delete(principalId);
    }

    // Revoke pending reviews for this principal
    for (const [revToken, rev] of this.preparedReviews.entries()) {
      if (rev.principalId === principalId) {
        this.preparedReviews.delete(revToken);
      }
    }

    // Clean up replay cache entries for this principal to release bounded capacity
    const replayPrefix = `${principalId}:`;
    for (const key of Array.from(this.replayMap.keys())) {
      if (key.startsWith(replayPrefix)) {
        this.replayMap.delete(key);
      }
    }

    // Clean up per-principal state
    this.principalStates.delete(principalId);

    // Invoke revocation callbacks
    for (const handler of this.revocationHandlers) {
      try {
        await handler({ principalId, reason });
      } catch {
        // ignore
      }
    }
  }

  async stop(): Promise<void> {
    if (this.server === null || !this.isRunningServer) {
      return;
    }
    this.generation++;
    this.isRunningServer = false;

    // Revoke all active principals
    const principalIds = Array.from(this.activePrincipals.keys());
    for (const principalId of principalIds) {
      await this.revokePrincipal(principalId, "shutdown");
    }
    this.activePrincipals.clear();
    this.handoverReviews.clear();
    this.preparedReviews.clear();

    for (const client of this.sseClients.keys()) {
      try {
        client.end();
      } catch {
        // Ignored during shutdown
      }
    }
    this.sseClients.clear();
    this.sseClientsByPrincipal.clear();

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
    this.replayMap.clear();
    this.pairingFailures.clear();
    this.prepareHandlers.length = 0;
    this.dispatchHandlers.length = 0;
    this.decisionHandlers.length = 0;
    this.stopHandlers.length = 0;
    this.stateHandlers.length = 0;
    this.revocationHandlers.length = 0;
    this.currentState = { isRunning: false, pendingApprovals: [], recentLogs: [] };
    this.principalStates.clear();

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

  updateState(state: Partial<RemoteWorkstationState>, principalId?: string): void {
    const targetState = principalId !== undefined
      ? (this.principalStates.get(principalId) ?? { isRunning: false, pendingApprovals: [], recentLogs: [] })
      : this.currentState;

    const isRunning = state.isRunning !== undefined ? state.isRunning : targetState.isRunning;
    const pendingApprovals = state.pendingApprovals !== undefined ? state.pendingApprovals : targetState.pendingApprovals;
    const recentLogs = state.recentLogs !== undefined ? state.recentLogs : targetState.recentLogs;

    const hasActiveModel = "activeModel" in state;
    const activeModel = hasActiveModel ? state.activeModel : targetState.activeModel;

    const hasCurrentTask = "currentTask" in state;
    const currentTask = hasCurrentTask ? state.currentTask : targetState.currentTask;

    const hasOperationStatus = "operationStatus" in state;
    const operationStatus = hasOperationStatus ? state.operationStatus : targetState.operationStatus;

    const hasOperationId = "operationId" in state;
    const operationId = hasOperationId ? state.operationId : targetState.operationId;

    const nextState: RemoteWorkstationState = {
      isRunning,
      pendingApprovals,
      recentLogs,
      ...(typeof activeModel === "string" ? { activeModel } : {}),
      ...(typeof currentTask === "string" ? { currentTask } : {}),
      ...(typeof operationStatus === "string" ? { operationStatus } : {}),
      ...(typeof operationId === "string" ? { operationId } : {}),
    };

    if (principalId !== undefined) {
      this.principalStates.set(principalId, nextState);
    } else {
      this.currentState = nextState;
    }
  }

  sendEvent(principalId: string, event: { readonly type: string; readonly data: unknown }): void {
    if (!this.isRunningServer) {
      return;
    }
    const clients = this.sseClientsByPrincipal.get(principalId);
    if (!clients || clients.size === 0) {
      return;
    }
    const serializedData = typeof event.data === "string" ? event.data : JSON.stringify(event.data ?? null);
    const lines = serializedData.split(/\r?\n/);
    const dataLines = lines.map((l) => `data: ${l}`).join("\n");
    const message = `event: ${event.type}\n${dataLines}\n\n`;

    for (const client of clients) {
      try {
        client.write(message);
      } catch {
        clients.delete(client);
        this.sseClients.delete(client);
      }
    }
  }

  broadcastEvent(event: { readonly type: string; readonly data: unknown; readonly principalId?: string }): void {
    if (!this.isRunningServer) {
      return;
    }
    if (event.principalId !== undefined) {
      this.sendEvent(event.principalId, event);
      return;
    }

    if (typeof event.data === "object" && event.data !== null && "principalId" in event.data) {
      const pid = (event.data as Record<string, unknown>).principalId;
      if (typeof pid === "string") {
        this.sendEvent(pid, event);
        return;
      }
    }

    if (!isPublicServerHealthEvent(event.type)) {
      return;
    }

    const serializedData = typeof event.data === "string" ? event.data : JSON.stringify(event.data ?? null);
    const lines = serializedData.split(/\r?\n/);
    const dataLines = lines.map((l) => `data: ${l}`).join("\n");
    const message = `event: ${event.type}\n${dataLines}\n\n`;

    for (const [client, pid] of this.sseClients.entries()) {
      try {
        client.write(message);
      } catch {
        this.sseClients.delete(client);
        const pClients = this.sseClientsByPrincipal.get(pid);
        if (pClients) {
          pClients.delete(client);
        }
      }
    }
  }

  onPrepare(handler: RemotePrepareHandler): void {
    this.prepareHandlers.push(handler);
  }

  onDispatch(handler: RemoteDispatchHandler): void {
    this.dispatchHandlers.push(handler);
  }

  onDecision(handler: RemoteDecisionHandler): void {
    this.decisionHandlers.push(handler);
  }

  onStop(handler: RemoteStopHandler): void {
    this.stopHandlers.push(handler);
  }

  onState(handler: RemoteStateHandler): void {
    this.stateHandlers.push(handler);
  }

  onRevokePrincipal(handler: RemotePrincipalRevocationHandler): void {
    this.revocationHandlers.push(handler);
  }

  private async executeMutatingCommand<TReq>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    token: string,
    principalId: string,
    pathname: string,
    commandName: string,
    validate: (record: Record<string, unknown>) =>
      | { readonly valid: true; readonly payload: TReq; readonly requestId: string }
      | { readonly valid: false; readonly detail: string },
    handlers: readonly ((request: TReq, principalId: string) => Promise<RemoteCommandHandlerResult> | RemoteCommandHandlerResult)[],
    preExecutionCheck?: (payload: TReq, principalId: string) => RemoteCommandReceipt | null,
    postExecutionCheck?: (result: RemoteCommandHandlerResult, payload: TReq, principalId: string) => RemoteCommandReceipt | null
  ): Promise<void> {
    const capturedGeneration = this.generation;

    if (req.method !== "POST") {
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

    if (!this.isRunningServer || this.generation !== capturedGeneration) {
      sendJson(res, 503, {
        error: "Service Unavailable",
        detail: "Server was stopped or restarted during request processing.",
        status: "uncertain",
      });
      return;
    }

    const tokenCheck = verifyHmacToken(token, this.serverSecret);
    if (!tokenCheck.valid || !this.activePrincipals.has(principalId)) {
      sendJson(res, 401, {
        error: "Unauthorized",
        detail: "Token expired after reading request body.",
      });
      return;
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      sendJson(res, 400, {
        error: "Bad Request",
        detail: "The request body must be a JSON object.",
      });
      return;
    }

    const record = body as Record<string, unknown>;
    const validation = validate(record);
    if (!validation.valid) {
      sendJson(res, 400, {
        error: "Bad Request",
        detail: validation.detail,
      });
      return;
    }

    const { payload, requestId } = validation;
    const payloadFingerprint = computePayloadFingerprint(pathname, record);
    const replayKey = `${principalId}:${requestId}`;

    const existing = this.replayMap.get(replayKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== payloadFingerprint) {
        sendJson(res, 409, {
          error: "Conflict",
          detail: "Request ID already used with different payload.",
        });
        return;
      }

      if (existing.status === "completed" && existing.response !== undefined) {
        sendJson(res, existing.response.statusCode, existing.response.body);
        return;
      }

      if (existing.status === "pending" && existing.promise !== undefined) {
        const cached = await existing.promise;
        sendJson(res, cached.statusCode, cached.body);
        return;
      }

      if (existing.status === "uncertain" && existing.response !== undefined) {
        sendJson(res, existing.response.statusCode, existing.response.body);
        return;
      }
    }

    if (handlers.length === 0) {
      sendJson(res, 503, {
        error: "Service Unavailable",
        detail: `No handler registered for ${commandName}.`,
      });
      return;
    }

    if (handlers.length > 1) {
      sendJson(res, 409, {
        error: "Conflict",
        detail: `Ambiguous command handlers: multiple handlers registered for ${commandName}.`,
      });
      return;
    }

    if (this.replayMap.size >= this.maxReplayEntries) {
      sendJson(res, 503, {
        error: "Service Unavailable",
        detail: "Replay capacity exceeded.",
      });
      return;
    }

    let resolveExecution!: (value: CachedResponse) => void;
    const executionPromise = new Promise<CachedResponse>((resolve) => {
      resolveExecution = resolve;
    });

    const newEntry: ReplayEntry = {
      fingerprint: payloadFingerprint,
      status: "pending",
      promise: executionPromise,
    };
    this.replayMap.set(replayKey, newEntry);

    if (!this.isRunningServer || this.generation !== capturedGeneration) {
      this.replayMap.delete(replayKey);
      const cached: CachedResponse = {
        statusCode: 503,
        body: {
          error: "Service Unavailable",
          detail: "Server was stopped or restarted before command execution.",
          status: "uncertain",
        },
      };
      resolveExecution(cached);
      sendJson(res, cached.statusCode, cached.body);
      return;
    }

    const preTokenCheck = verifyHmacToken(token, this.serverSecret);
    if (!preTokenCheck.valid || !this.activePrincipals.has(principalId)) {
      this.replayMap.delete(replayKey);
      const cached: CachedResponse = {
        statusCode: 401,
        body: {
          error: "Unauthorized",
          detail: "Token expired before command execution.",
        },
      };
      resolveExecution(cached);
      sendJson(res, cached.statusCode, cached.body);
      return;
    }

    if (preExecutionCheck) {
      const rejection = preExecutionCheck(payload, principalId);
      if (rejection !== null) {
        const cached: CachedResponse = { statusCode: 200, body: rejection };
        newEntry.status = "completed";
        newEntry.response = cached;
        resolveExecution(cached);
        sendJson(res, cached.statusCode, cached.body);
        return;
      }
    }

    const handler = handlers[0]!;
    try {
      const result = await handler(payload, principalId);

      if (!this.isRunningServer || this.generation !== capturedGeneration) {
        const cached: CachedResponse = {
          statusCode: 503,
          body: {
            error: "Service Unavailable",
            detail: "Server stopped during handler execution.",
            status: "uncertain",
          },
        };
        resolveExecution(cached);
        return;
      }

      const postTokenCheck = verifyHmacToken(token, this.serverSecret);
      if (!postTokenCheck.valid || postTokenCheck.payload.principalId !== principalId ||
          !this.activePrincipals.has(principalId)) {
        const cached: CachedResponse = { statusCode: 401, body: {
          status: "uncertain",
          error: "Unauthorized",
          detail: "Token expired or principal was revoked during command execution. Check the workstation before retrying."
        } };
        newEntry.status = "uncertain";
        newEntry.response = cached;
        resolveExecution(cached);
        sendJson(res, cached.statusCode, cached.body);
        return;
      }

      let receipt: RemoteCommandReceipt;
      let isCompleted = false;

      if (postExecutionCheck) {
        const postReceipt = postExecutionCheck(result, payload, principalId);
        if (postReceipt !== null) {
          receipt = postReceipt;
          isCompleted = receipt.status === "accepted" || receipt.status === "rejected";
        } else {
          receipt = {
            status: "uncertain",
            detail: "Handler returned an incomplete or invalid result.",
          };
        }
      } else if (
        result !== undefined &&
        typeof result === "object" &&
        result !== null &&
        (result.status === "accepted" || result.status === "rejected" || result.status === "uncertain")
      ) {
        receipt = {
          status: result.status,
          ...(typeof result.detail === "string" ? { detail: result.detail } : {}),
          ...(typeof result.operationId === "string" ? { operationId: result.operationId } : {}),
          ...(result.review !== undefined ? { review: result.review } : {}),
        };
        isCompleted = result.status === "accepted" || result.status === "rejected";
      } else {
        receipt = {
          status: "uncertain",
          detail: "Handler returned no explicit receipt.",
        };
      }

      const cached: CachedResponse = { statusCode: 200, body: receipt };
      newEntry.status = isCompleted ? "completed" : "uncertain";
      newEntry.response = cached;
      resolveExecution(cached);
      sendJson(res, cached.statusCode, cached.body);
    } catch {
      if (!this.isRunningServer || this.generation !== capturedGeneration) {
        return;
      }
      const cached: CachedResponse = {
        statusCode: 500,
        body: {
          status: "uncertain",
          error: "Command Error",
          detail: "An unexpected error occurred while executing the command.",
        },
      };
      newEntry.status = "uncertain";
      newEntry.response = cached;
      resolveExecution(cached);
      sendJson(res, cached.statusCode, cached.body);
    }
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

      // The six-digit code is only useful if local network guessing is slow.
      // A bounded map fails closed under too many distinct addresses rather
      // than growing without limit or silently disabling the guard.
      const address = req.socket.remoteAddress ?? "unknown";
      const at = Date.now();
      for (const [key, entry] of this.pairingFailures) {
        if (at - entry.lastAt >= this.pairingLockoutMs && at >= entry.lockedUntil) {
          this.pairingFailures.delete(key);
        }
      }
      const failures = this.pairingFailures.get(address);
      if ((failures?.lockedUntil ?? 0) > at ||
          (failures === undefined && this.pairingFailures.size >= 1024)) {
        sendJson(res, 429, { error: "Too Many Requests", detail: "Pairing is temporarily limited. Try again later." });
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
        const nextCount = (failures?.count ?? 0) + 1;
        this.pairingFailures.set(address, { count: nextCount, lastAt: at,
          lockedUntil: nextCount >= this.maxPairingAttempts ? at + this.pairingLockoutMs : 0 });
        sendJson(res, 401, {
          error: "Unauthorized",
          detail: "The supplied PIN was incorrect.",
        });
        return;
      }

      this.pairingFailures.delete(address);

      const principalId = `prnc_${crypto.randomBytes(16).toString("hex")}`;
      const token = generateToken(this.serverSecret, this.sessionTtlMs, principalId);
      this.registerPrincipal(principalId, Date.now() + this.sessionTtlMs, "phone");

      sendJson(res, 200, {
        token,
        expiresIn: Math.floor(this.sessionTtlMs / 1000),
      });
      return;
    }

    if (pathname.startsWith("/api/")) {
      const token = extractBearerToken(req, parsedUrl);
      if (token === undefined) {
        sendJson(res, 401, {
          error: "Unauthorized",
          detail: "A valid bearer token is required.",
        });
        return;
      }

      const tokenCheck = verifyHmacToken(token, this.serverSecret);
      if (!tokenCheck.valid || !this.activePrincipals.has(tokenCheck.payload.principalId)) {
        sendJson(res, 401, {
          error: "Unauthorized",
          detail: "A valid bearer token is required.",
        });
        return;
      }

      const principalId = tokenCheck.payload.principalId;

      if (pathname === "/api/revoke") {
        if (method !== "POST") {
          res.writeHead(405, { Allow: "POST" });
          res.end();
          return;
        }
        await this.revokePrincipal(principalId, "client");
        sendJson(res, 200, { status: "accepted", detail: "This phone was disconnected." });
        return;
      }

      if (pathname === "/api/prepare") {
        await this.executeMutatingCommand<RemotePrepareRequest>(
          req,
          res,
          token,
          principalId,
          pathname,
          "prepare command",
          (record) => {
            const allowedKeys = new Set([
              "requestId",
              "caseId",
              "providerId",
              "modelId",
              "prompt",
              "sourceTurnIds",
              "enableTools",
              "workspaceId",
            ]);
            for (const key of Object.keys(record)) {
              if (!allowedKeys.has(key)) {
                return { valid: false, detail: `Unexpected field in prepare payload: ${key}` };
              }
            }
            const requestId = record["requestId"];
            const caseId = record["caseId"];
            const providerId = record["providerId"];
            const modelId = record["modelId"];
            const prompt = record["prompt"];
            const sourceTurnIds = record["sourceTurnIds"];
            const enableTools = record["enableTools"];
            const workspaceId = record["workspaceId"];

            if (!isNonEmptyBoundedString(requestId, 128)) {
              return { valid: false, detail: "A prepare payload must include a nonempty requestId." };
            }
            if (!isNonEmptyBoundedString(caseId, 64)) {
              return { valid: false, detail: "A prepare payload must include a nonempty caseId." };
            }
            if (
              providerId !== "codex" &&
              providerId !== "claude" &&
              providerId !== "gemini1" &&
              providerId !== "gemini2" &&
              providerId !== "gemini3"
            ) {
              return {
                valid: false,
                detail: "providerId must be one of: codex, claude, gemini1, gemini2, gemini3.",
              };
            }
            if (!isNonEmptyBoundedString(modelId, 120) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(modelId)) {
              return { valid: false, detail: "modelId must be a valid model identifier." };
            }
            if (!isNonEmptyBoundedString(prompt, 8000)) {
              return { valid: false, detail: "prompt must be a nonempty string up to 8000 characters." };
            }
            if (!Array.isArray(sourceTurnIds)) {
              return { valid: false, detail: "sourceTurnIds must be an array." };
            }
            if (sourceTurnIds.length > 20) {
              return { valid: false, detail: "sourceTurnIds must not exceed 20 entries." };
            }
            for (const id of sourceTurnIds) {
              if (typeof id !== "string" || id.trim().length === 0) {
                return { valid: false, detail: "All sourceTurnIds must be nonempty strings." };
              }
            }
            if (new Set(sourceTurnIds).size !== sourceTurnIds.length) {
              return { valid: false, detail: "sourceTurnIds must not contain duplicates." };
            }
            if (enableTools !== undefined && typeof enableTools !== "boolean") {
              return { valid: false, detail: "enableTools must be a boolean when present." };
            }
            if (workspaceId !== undefined && !isNonEmptyBoundedString(workspaceId, 128)) {
              return { valid: false, detail: "workspaceId must be a nonempty string when present." };
            }

            const prepareReq: RemotePrepareRequest = {
              requestId,
              caseId,
              providerId: providerId as WorkstationProviderId,
              modelId,
              prompt,
              sourceTurnIds: [...sourceTurnIds],
              ...(enableTools !== undefined ? { enableTools } : {}),
              ...(workspaceId !== undefined ? { workspaceId } : {}),
            };

            return {
              valid: true,
              requestId,
              payload: prepareReq,
            };
          },
          this.prepareHandlers,
          undefined,
          (result, payload, pid) => {
            if (
              result !== undefined &&
              typeof result === "object" &&
              result !== null &&
              result.status === "accepted"
            ) {
              if (!isValidWorkstationReview(result.review)) {
                return {
                  status: "uncertain",
                  detail: "Prepare handler returned accepted without a complete WorkstationReview.",
                };
              }
              const frozenReview = Object.freeze({ ...result.review });
              if (frozenReview.expiresAt <= Date.now()) {
                return { status: "rejected", detail: "Review expired before it could be shown. Prepare it again." };
              }
              const occupied = this.preparedReviews.get(frozenReview.token);
              if (occupied !== undefined && occupied.principalId !== pid) {
                return { status: "uncertain", detail: "Review token collided with another pairing. Prepare it again." };
              }
              for (const [token, entry] of this.preparedReviews) {
                if (entry.principalId === pid) this.preparedReviews.delete(token);
              }
              this.preparedReviews.set(frozenReview.token, {
                principalId: pid,
                review: frozenReview,
                expiresAt: frozenReview.expiresAt,
              });
              return {
                status: "accepted",
                review: frozenReview,
                ...(typeof result.detail === "string" ? { detail: result.detail } : {}),
              };
            }
            if (
              result !== undefined &&
              typeof result === "object" &&
              result !== null &&
              (result.status === "rejected" || result.status === "uncertain")
            ) {
              return {
                status: result.status,
                ...(typeof result.detail === "string" ? { detail: result.detail } : {}),
              };
            }
            return {
              status: "uncertain",
              detail: "Prepare handler failed to provide a valid receipt.",
            };
          }
        );
        return;
      }

      if (pathname === "/api/state") {
        if (method !== "GET") {
          res.writeHead(405, { Allow: "GET" });
          res.end();
          return;
        }

        const capturedGeneration = this.generation;

        if (this.stateHandlers.length > 1) {
          sendJson(res, 409, {
            error: "Conflict",
            detail: "Ambiguous state handlers: multiple handlers registered for state query.",
          });
          return;
        }

        if (this.stateHandlers.length === 1) {
          try {
            const state = await this.stateHandlers[0]!(principalId);

            if (!this.isRunningServer || this.generation !== capturedGeneration) {
              sendJson(res, 503, {
                error: "Service Unavailable",
                detail: "Server was stopped or restarted during state retrieval.",
              });
              return;
            }

            const postTokenCheck = verifyHmacToken(token, this.serverSecret);
            if (!postTokenCheck.valid || !this.activePrincipals.has(principalId)) {
              sendJson(res, 401, {
                error: "Unauthorized",
                detail: "Token expired or principal revoked during state retrieval.",
              });
              return;
            }

            sendJson(res, 200, state);
            return;
          } catch {
            if (!this.isRunningServer || this.generation !== capturedGeneration) {
              sendJson(res, 503, {
                error: "Service Unavailable",
                detail: "Server was stopped or restarted during state retrieval.",
              });
              return;
            }
            sendJson(res, 500, {
              error: "State Error",
              detail: "An unexpected error occurred while retrieving state.",
            });
            return;
          }
        }

        sendJson(res, 503, { error: "Service Unavailable",
          detail: "No workstation state handler is registered." });
        return;
      }

      if (pathname === "/api/decide") {
        await this.executeMutatingCommand<RemoteDecisionRequest>(
          req,
          res,
          token,
          principalId,
          pathname,
          "decision command",
          (record) => {
            const allowedKeys = new Set(["requestId", "operationId", "permissionId", "revision", "allow"]);
            for (const key of Object.keys(record)) {
              if (!allowedKeys.has(key)) {
                return { valid: false, detail: `Unexpected field in decision payload: ${key}` };
              }
            }
            const requestId = record["requestId"];
            const operationId = record["operationId"];
            const permissionId = record["permissionId"];
            const revision = record["revision"];
            const allow = record["allow"];
            if (
              !isNonEmptyBoundedString(requestId, 128) ||
              !isNonEmptyBoundedString(operationId, 256) ||
              !isNonEmptyBoundedString(permissionId, 256) ||
              !isNonEmptyBoundedString(revision, 256) ||
              typeof allow !== "boolean"
            ) {
              return {
                valid: false,
                detail:
                  "A decision payload must include nonempty requestId, operationId, permissionId, revision, and boolean allow.",
              };
            }
            return {
              valid: true,
              requestId,
              payload: { requestId, operationId, permissionId, revision, allow },
            };
          },
          this.decisionHandlers
        );
        return;
      }

      if (pathname === "/api/dispatch") {
        await this.executeMutatingCommand<RemoteDispatchRequest>(
          req,
          res,
          token,
          principalId,
          pathname,
          "dispatch command",
          (record) => {
            const allowedKeys = new Set(["requestId", "reviewToken"]);
            for (const key of Object.keys(record)) {
              if (key === "prompt" || key === "modelId") {
                return {
                  valid: false,
                  detail:
                    "Legacy dispatch with prompt/modelId is no longer supported. Prepare a review via POST /api/prepare first and dispatch with {requestId, reviewToken}.",
                };
              }
              if (!allowedKeys.has(key)) {
                return { valid: false, detail: `Unexpected field in dispatch payload: ${key}` };
              }
            }
            const requestId = record["requestId"];
            const reviewToken = record["reviewToken"];
            if (!isNonEmptyBoundedString(requestId, 128) || !isNonEmptyBoundedString(reviewToken, 128)) {
              return {
                valid: false,
                detail: "A dispatch payload must include nonempty requestId and reviewToken.",
              };
            }
            return {
              valid: true,
              requestId,
              payload: { requestId, reviewToken },
            };
          },
          this.dispatchHandlers,
          (payload, pid) => {
            const prepared = this.preparedReviews.get(payload.reviewToken);
            if (prepared === undefined) {
              return {
                status: "rejected",
                detail: "Review token not found or already used.",
              };
            }
            if (prepared.principalId !== pid) {
              return {
                status: "rejected",
                detail: "Review token not found or already used.",
              };
            }
            if (Date.now() >= prepared.expiresAt) {
              this.preparedReviews.delete(payload.reviewToken);
              return {
                status: "rejected",
                detail: "Review token has expired.",
              };
            }
            this.preparedReviews.delete(payload.reviewToken);
            return null;
          }
        );
        return;
      }

      if (pathname === "/api/stop") {
        await this.executeMutatingCommand<RemoteStopRequest>(
          req,
          res,
          token,
          principalId,
          pathname,
          "stop command",
          (record) => {
            const allowedKeys = new Set(["requestId", "operationId"]);
            for (const key of Object.keys(record)) {
              if (!allowedKeys.has(key)) {
                return { valid: false, detail: `Unexpected field in stop payload: ${key}` };
              }
            }
            const requestId = record["requestId"];
            const operationId = record["operationId"];
            if (
              !isNonEmptyBoundedString(requestId, 128) ||
              !isNonEmptyBoundedString(operationId, 256)
            ) {
              return {
                valid: false,
                detail: "A stop payload must include nonempty requestId and operationId.",
              };
            }
            return {
              valid: true,
              requestId,
              payload: { requestId, operationId },
            };
          },
          this.stopHandlers
        );
        return;
      }

      if (pathname === "/api/events") {
        if (method !== "GET") {
          res.writeHead(405, { Allow: "GET" });
          res.end();
          return;
        }

        if (this.sseClients.size >= this.maxSseClients) {
          sendJson(res, 503, {
            error: "Service Unavailable",
            detail: "Maximum concurrent event stream connections reached.",
          });
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

        this.sseClients.set(res, principalId);
        let pSet = this.sseClientsByPrincipal.get(principalId);
        if (!pSet) {
          pSet = new Set();
          this.sseClientsByPrincipal.set(principalId, pSet);
        }
        pSet.add(res);

        const cleanup = (): void => {
          this.sseClients.delete(res);
          const set = this.sseClientsByPrincipal.get(principalId);
          if (set) {
            set.delete(res);
            if (set.size === 0) {
              this.sseClientsByPrincipal.delete(principalId);
            }
          }
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
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #121214; color: #ededef; margin: 0; padding: 1rem; }
main { max-width: 640px; margin: 0 auto; }
section { background: #1a1a1e; border: 1px solid #2e2e34; border-radius: 8px; padding: 1.2rem; margin: 1rem 0; }
h1 { font-size: 1.3rem; font-weight: 600; }
h2 { font-size: 1rem; margin-top: 0; }
p, label { font-size: 0.9rem; line-height: 1.5; }
label { display: block; margin: 0.8rem 0 0.3rem; }
input, select, textarea, button { box-sizing: border-box; width: 100%; padding: 0.7rem; border-radius: 5px; border: 1px solid #52525b; font: inherit; }
input, select, textarea { color: #ededef; background: #242428; }
textarea { min-height: 5rem; }
button { color: #121214; background: #e6e6e9; font-weight: 600; margin-top: 0.8rem; }
button:disabled { opacity: 0.45; }
button.secondary { color: #ededef; background: #303036; }
pre { color: #e6e6e9; background: #101012; padding: 0.8rem; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 25rem; overflow: auto; }
.check { display: flex; gap: 0.6rem; align-items: flex-start; }
.check input { width: auto; margin-top: 0.25rem; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
<h1>Rellane on your phone</h1>
<p id="message" role="status" aria-live="polite">Pair this phone with your Mac to review work.</p>
<section id="pair-section">
<h2>Pair</h2>
<label for="pin">Six-digit code from your Mac</label>
<input id="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">
<button id="pair-button" type="button">Pair this phone</button>
</section>
<section id="work-section" hidden>
<h2>Prepare work</h2>
<p>Provider choices are checked when you Prepare; being listed here does not mean an account is connected.</p>
<label for="case-id">Case ID</label><input id="case-id" required>
<label for="provider-id">Provider</label>
<select id="provider-id"><option value="codex">Codex</option><option value="claude">Claude</option><option value="gemini1">Gemini 1</option><option value="gemini2">Gemini 2</option><option value="gemini3">Gemini 3</option></select>
<label for="model-id">Model ID</label><input id="model-id" required>
<label for="prompt">Request</label><textarea id="prompt" required></textarea>
<label for="source-ids">Source turn IDs, one per line</label><textarea id="source-ids"></textarea>
<label for="workspace-id">Workspace ID, if chosen</label><input id="workspace-id">
<label class="check"><input id="enable-tools" type="checkbox">Enable reviewed tools</label>
<button id="prepare-button" type="button">Prepare full review</button>
</section>
<section id="review-section" hidden>
<h2>Review before Start</h2>
<p>This is the full packet from your Mac. Read the exact context and scope before starting.</p>
<label>Exact context sent to the provider</label><pre id="review-context"></pre>
<label>Complete review record</label><pre id="review-details"></pre>
<label class="check"><input id="review-confirm" type="checkbox">I reviewed this packet</label>
<button id="start-button" type="button" disabled>Start this exact review</button>
</section>
<section id="state-section" hidden>
<h2>Workstation state</h2>
<pre id="state-details"></pre>
<div id="approval-list" aria-live="polite"></div>
<button id="refresh-button" class="secondary" type="button">Refresh state</button>
<button id="stop-button" type="button" disabled>Stop this session</button>
<button id="disconnect-button" class="secondary" type="button">Disconnect this phone</button>
</section>
</main>
<script>
"use strict";
const byId = (id) => document.getElementById(id);
const parameters = new URLSearchParams(location.search);
const suppliedPin = parameters.get("pin");
if (suppliedPin && /^[0-9]{6}$/.test(suppliedPin)) byId("pin").value = suppliedPin;
history.replaceState(null, "", location.pathname);
let bearer = "";
let currentReview = null;
let currentOperation = "";
let deciding = false;
let counter = 0;
const requestId = () => "phone-" + Date.now().toString(36) + "-" + (++counter).toString(36);
const message = (value) => { byId("message").textContent = value; };
function clearReview() {
  currentReview = null;
  byId("review-section").hidden = true;
  byId("review-context").textContent = "";
  byId("review-details").textContent = "";
  byId("review-confirm").checked = false;
  byId("start-button").disabled = true;
}
function clearPairing() {
  bearer = "";
  currentOperation = "";
  clearReview();
  byId("work-section").hidden = true;
  byId("state-section").hidden = true;
  byId("approval-list").replaceChildren();
  byId("pair-section").hidden = false;
}
async function api(path, payload) {
  const headers = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = "Bearer " + bearer;
  const response = await fetch(path, {
    method: payload === undefined ? "GET" : "POST",
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error("The Mac returned an unreadable response. Check it before retrying."); }
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/pair") clearPairing();
    throw new Error(result.detail || "The Mac refused this request.");
  }
  return result;
}
function showApprovals(state) {
  const list = byId("approval-list");
  list.replaceChildren();
  for (const approval of state.pendingApprovals || []) {
    if (approval.operationId !== currentOperation || Date.now() >= approval.expiresAt) continue;
    const item = document.createElement("section");
    const title = document.createElement("h2");
    title.textContent = approval.title;
    const detail = document.createElement("pre");
    detail.textContent = approval.detail;
    const revision = document.createElement("p");
    revision.textContent = "Revision: " + approval.revision;
    item.append(title, detail, revision);
    for (const allow of [false, true]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = allow ? "" : "secondary";
      button.textContent = allow ? "Allow this action" : "Deny this action";
      button.setAttribute("data-decision", allow ? "allow" : "deny");
      button.addEventListener("click", () => { void decideApproval(approval, allow); });
      item.append(button);
    }
    list.append(item);
  }
}
async function refreshState() {
  if (!bearer) return null;
  try {
    const state = await api("/api/state");
    byId("state-details").textContent = JSON.stringify(state, null, 2);
    byId("stop-button").disabled = !currentOperation ||
      state.operationId !== currentOperation || state.isRunning !== true;
    showApprovals(state);
    return state;
  } catch (error) {
    message(error instanceof Error ? error.message : "State could not be read. Check your Mac.");
    return null;
  }
}
async function decideApproval(shown, allow) {
  if (deciding || !bearer) return;
  deciding = true;
  try {
    const state = await refreshState();
    const current = state && (state.pendingApprovals || []).find((approval) =>
      approval.operationId === shown.operationId && approval.permissionId === shown.permissionId &&
      approval.revision === shown.revision && approval.expiresAt > Date.now());
    if (!current || current.operationId !== currentOperation) {
      message("That action changed or expired. Read its current details before deciding.");
      return;
    }
    const result = await api("/api/decide", { requestId: requestId(),
      operationId: current.operationId, permissionId: current.permissionId,
      revision: current.revision, allow });
    if (result.status !== "accepted")
      throw new Error(result.detail || "The decision could not be confirmed. Check your Mac.");
    message("Decision submitted. Check state for the next result.");
  } catch (error) {
    message(error instanceof Error ? error.message : "The decision could not be confirmed. Check your Mac.");
  } finally {
    await refreshState();
    deciding = false;
  }
}
byId("pair-button").addEventListener("click", async () => {
  byId("pair-button").disabled = true;
  try {
    const result = await api("/api/pair", { pin: byId("pin").value.trim() });
    if (typeof result.token !== "string") throw new Error("Pairing did not return a token.");
    bearer = result.token;
    byId("pair-section").hidden = true;
    byId("work-section").hidden = false;
    byId("state-section").hidden = false;
    message("Paired. Prepare a full review before starting work.");
    await refreshState();
  } catch (error) {
    message(error instanceof Error ? error.message : "Pairing could not be confirmed.");
  } finally { byId("pair-button").disabled = false; }
});
byId("prepare-button").addEventListener("click", async () => {
  clearReview();
  byId("prepare-button").disabled = true;
  try {
    const sourceTurnIds = byId("source-ids").value.split(String.fromCharCode(10))
      .map((id) => id.trim()).filter(Boolean);
    const workspaceId = byId("workspace-id").value.trim();
    const result = await api("/api/prepare", {
      requestId: requestId(), caseId: byId("case-id").value.trim(),
      providerId: byId("provider-id").value, modelId: byId("model-id").value.trim(),
      prompt: byId("prompt").value, sourceTurnIds,
      enableTools: byId("enable-tools").checked,
      ...(workspaceId ? { workspaceId } : {})
    });
    if (result.status !== "accepted" || !result.review)
      throw new Error(result.detail || "The review could not be prepared.");
    if (Date.now() >= result.review.expiresAt)
      throw new Error("The review expired. Prepare it again.");
    currentReview = result.review;
    byId("review-context").textContent = result.review.contextPreview;
    byId("review-details").textContent = JSON.stringify(result.review, null, 2);
    byId("review-section").hidden = false;
    message("Read the complete review, then explicitly Start it.");
  } catch (error) {
    message(error instanceof Error ? error.message : "The review could not be confirmed. Check your Mac.");
  } finally { byId("prepare-button").disabled = false; }
});
byId("review-confirm").addEventListener("change", () => {
  byId("start-button").disabled = !currentReview || !byId("review-confirm").checked;
});
byId("start-button").addEventListener("click", async () => {
  if (!currentReview || !byId("review-confirm").checked) return;
  if (Date.now() >= currentReview.expiresAt) {
    clearReview();
    message("That review expired. Prepare it again.");
    return;
  }
  const reviewToken = currentReview.token;
  clearReview();
  try {
    const result = await api("/api/dispatch", { requestId: requestId(), reviewToken });
    if (result.status !== "accepted" || typeof result.operationId !== "string")
      throw new Error(result.detail || "Start could not be confirmed. Check your Mac before retrying.");
    currentOperation = result.operationId;
    message("Start accepted. Check state for the final outcome.");
    await refreshState();
  } catch (error) {
    message(error instanceof Error ? error.message : "Start could not be confirmed. Check your Mac before retrying.");
  }
});
byId("refresh-button").addEventListener("click", refreshState);
byId("stop-button").addEventListener("click", async () => {
  if (!currentOperation || byId("stop-button").disabled) return;
  byId("stop-button").disabled = true;
  try {
    const result = await api("/api/stop", { requestId: requestId(), operationId: currentOperation });
    if (result.status !== "accepted") throw new Error(result.detail || "Stop could not be confirmed. Check your Mac.");
    message("Stop requested. Check state for the final outcome.");
    await refreshState();
  } catch (error) {
    message(error instanceof Error ? error.message : "Stop could not be confirmed. Check your Mac.");
  }
});
byId("disconnect-button").addEventListener("click", async () => {
  try {
    const result = await api("/api/revoke", {});
    if (result.status !== "accepted") throw new Error("Disconnect could not be confirmed. Check your Mac.");
    clearPairing();
    message("Disconnected. Pair again to review more work.");
  } catch (error) {
    message(error instanceof Error ? error.message : "Disconnect could not be confirmed. Check your Mac.");
  }
});
</script>
</body>
</html>`;

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html, "utf8").toString(),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end(html);
      return;
    }

    sendJson(res,
 404, {
      error: "Not Found",
      detail: "The requested resource was not found.",
    });
  }
}

export function createRemoteDispatchServer(config?: RemoteDispatchConfig): RemoteDispatchServer {
  return new RemoteDispatchServerImpl(config);
}
