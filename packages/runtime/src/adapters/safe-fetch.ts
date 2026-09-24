import { RuntimeBoundaryError, RuntimeHttpError } from "../errors.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ALLOWED_PORTS = new Set([
  "11434",
  "1234",
  "12340", "12341", "12342", "12343", "12344",
  "12345", "12346", "12347", "12348", "12349"
]);
const LOOPBACK_BEARER_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function assertAllowedLoopbackUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new RuntimeBoundaryError({
      code: "SECURITY_BOUNDARY",
      message: "The local runtime URL is invalid.",
      retryable: false
    }, { cause: error });
  }

  if (
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    !ALLOWED_PORTS.has(parsed.port) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new RuntimeBoundaryError({
      code: "SECURITY_BOUNDARY",
      message: "Only fixed, credential-free loopback runtime endpoints are allowed.",
      retryable: false
    });
  }

  return parsed;
}

export interface JsonRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Process-local bearer used only by Rellane's bundled fixed-loopback runtime. */
  loopbackBearer?: string;
}

export type JsonRequester = (url: string, options?: JsonRequestOptions) => Promise<unknown>;

export const requestJson: JsonRequester = async (rawUrl, options = {}) => {
  const url = assertAllowedLoopbackUrl(rawUrl);
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 5_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  if (
    options.loopbackBearer !== undefined &&
    !LOOPBACK_BEARER_PATTERN.test(options.loopbackBearer)
  ) {
    throw new RuntimeBoundaryError({
      code: "SECURITY_BOUNDARY",
      message: "The bundled local runtime credential is invalid.",
      retryable: false
    });
  }

  let response: Response;
  try {
    const requestInit: RequestInit = {
      method: options.method ?? "GET",
      redirect: "error",
      signal
    };
    if (options.loopbackBearer !== undefined) {
      requestInit.headers = {
        authorization: `Bearer ${options.loopbackBearer}`
      };
    }
    if (options.body !== undefined) {
      requestInit.body = JSON.stringify(options.body);
      requestInit.headers = {
        ...requestInit.headers,
        "content-type": "application/json"
      };
    }
    response = await fetch(url, requestInit);
  } catch (error) {
    if (signal.aborted) {
      const timedOut = timeoutSignal.aborted && !options.signal?.aborted;
      throw new RuntimeBoundaryError({
        code: timedOut ? "TIMEOUT" : "CANCELLED",
        message: timedOut
          ? "The local runtime did not respond in time."
          : "The local runtime operation was cancelled.",
        retryable: true
      }, { cause: error });
    }
    throw new RuntimeBoundaryError({
      code: "RUNTIME_UNAVAILABLE",
      message: "The local runtime is not reachable on its fixed loopback endpoint.",
      retryable: true
    }, { cause: error });
  }

  const limit = options.maxResponseBytes ?? 2_000_000;
  const announcedLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(announcedLength) && announcedLength > limit) {
    throw new RuntimeBoundaryError({
      code: "RUNTIME_RESPONSE_INVALID",
      message: "The local runtime response exceeded the safety limit.",
      retryable: false
    });
  }

  const bytes = await readBodyWithinLimit(response, limit);
  if (!response.ok) {
    throw new RuntimeHttpError(response.status);
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new RuntimeBoundaryError({
      code: "RUNTIME_RESPONSE_INVALID",
      message: "The local runtime returned invalid JSON.",
      retryable: false
    }, { cause: error });
  }
};

async function readBodyWithinLimit(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;

  while (true) {
    const item = await reader.read();
    if (item.done) {
      break;
    }
    byteCount += item.value.byteLength;
    if (byteCount > limit) {
      await reader.cancel();
      throw new RuntimeBoundaryError({
        code: "RUNTIME_RESPONSE_INVALID",
        message: "The local runtime response exceeded the safety limit.",
        retryable: false
      });
    }
    chunks.push(item.value);
  }

  const output = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
