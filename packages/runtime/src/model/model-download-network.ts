import { RuntimeBoundaryError } from "../errors.js";

export interface ModelDownloadHttpResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: {
    get(name: string): string | null;
  };
  readonly body: AsyncIterable<Uint8Array> | null;
  readonly dispose?: () => Promise<void>;
}

export interface ModelDownloadHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface ModelDownloadTransport {
  request(request: ModelDownloadHttpRequest): Promise<ModelDownloadHttpResponse>;
}

export interface ModelDownloadRedirectPolicy {
  /**
   * Exact HTTPS origins that an inspected 3xx Location may target. Wildcards,
   * suffix matching, credentials, and protocol downgrades are never accepted.
   */
  readonly allowedRedirectOrigins?: readonly string[];
  readonly maximumRedirects?: number;
}

export class NodeModelDownloadTransport implements ModelDownloadTransport {
  async request(request: ModelDownloadHttpRequest): Promise<ModelDownloadHttpResponse> {
    const response = await fetch(request.url, {
      method: "GET",
      headers: request.headers,
      redirect: "manual",
      signal: request.signal
    });
    return {
      status: response.status,
      url: response.url,
      headers: response.headers,
      body: response.body as AsyncIterable<Uint8Array> | null,
      dispose: async () => {
        if (response.body !== null && !response.body.locked) {
          await response.body.cancel().catch(() => undefined);
        }
      }
    };
  }
}

export async function requestModelArtifact(
  transport: ModelDownloadTransport,
  sourceUrl: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  policy: ModelDownloadRedirectPolicy = {}
): Promise<ModelDownloadHttpResponse> {
  const source = parseSecureUrl(sourceUrl, "The pinned model URL is invalid.");
  const allowedOrigins = new Set<string>([source.origin]);
  for (const allowedOrigin of policy.allowedRedirectOrigins ?? []) {
    const parsed = parseSecureUrl(
      allowedOrigin,
      "A configured model-download redirect origin is invalid."
    );
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      throw securityBoundary(
        "A model-download redirect allowlist entry must be an exact HTTPS origin."
      );
    }
    allowedOrigins.add(parsed.origin);
  }

  const maximumRedirects = policy.maximumRedirects ?? 3;
  if (!Number.isInteger(maximumRedirects) || maximumRedirects < 0 || maximumRedirects > 5) {
    throw securityBoundary("The model-download redirect limit must be between zero and five.");
  }

  let current = source;
  for (let redirectCount = 0; ; redirectCount += 1) {
    throwIfAborted(signal);
    const response = await transport.request({
      url: current.toString(),
      headers,
      signal
    });

    if (response.url !== "" && response.url !== current.toString()) {
      await disposeModelDownloadResponse(response);
      throw securityBoundary(
        "The model-download transport followed an uninspected redirect."
      );
    }
    if (!isRedirect(response.status)) {
      return response;
    }
    try {
      if (redirectCount >= maximumRedirects) {
        throw securityBoundary("The model download exceeded its approved redirect limit.");
      }
      const location = response.headers.get("location");
      if (location === null) {
        throw securityBoundary("The model-download redirect did not include a Location header.");
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw securityBoundary("The model-download redirect URL is invalid.");
      }
      assertSecureUrl(next);
      if (!allowedOrigins.has(next.origin)) {
        throw securityBoundary(
          "The model download attempted to redirect to an unapproved origin."
        );
      }
      current = next;
    } finally {
      await disposeModelDownloadResponse(response);
    }
  }
}

export async function disposeModelDownloadResponse(
  response: ModelDownloadHttpResponse
): Promise<void> {
  await response.dispose?.().catch(() => undefined);
}

function parseSecureUrl(value: string, message: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw securityBoundary(message);
  }
  assertSecureUrl(url);
  return url;
}

function assertSecureUrl(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === "" ||
    url.port !== ""
  ) {
    throw securityBoundary(
      "Model downloads require credential-free HTTPS URLs on the default port."
    );
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 ||
    status === 307 || status === 308;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelled();
  }
}

function securityBoundary(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "SECURITY_BOUNDARY",
    message,
    retryable: false
  });
}

function cancelled(): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "CANCELLED",
    message: "The model download was cancelled.",
    retryable: true
  });
}
