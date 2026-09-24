import { URL } from "node:url";

export interface WebReadResult {
  readonly status: "read";
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly fetchedAt: number;
}

export type WebReadOutcome =
  | WebReadResult
  | { readonly status: "refused"; readonly reason: string };

export const MAX_PAGE_BYTES = 2_097_152;
export const MAX_TEXT_CHARS = 120_000;
export const FETCH_TIMEOUT_MS = 20_000;

const USER_AGENT = "Rellane/1.0";
const MAX_REDIRECTS = 3;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  pound: "£",
  euro: "€",
  deg: "°"
};

function isBinaryMime(mime: string): boolean {
  if (mime.length === 0) return false;
  if (
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime.startsWith("font/")
  ) {
    return true;
  }
  const binarySet = new Set([
    "application/pdf",
    "application/zip",
    "application/gzip",
    "application/x-tar",
    "application/x-bzip2",
    "application/octet-stream",
    "application/wasm"
  ]);
  return binarySet.has(mime);
}

function isTextualMime(mime: string): boolean {
  if (mime.length === 0 || mime.startsWith("text/")) return true;
  return (
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/xhtml+xml" ||
    mime === "application/javascript" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

function decodeHtmlEntities(raw: string): string {
  return raw.replace(/&([a-zA-Z0-9]+|#\d+|#[xX][0-9a-fA-F]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (!Number.isNaN(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      if (!Number.isNaN(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

function collapseWhitespace(raw: string): string {
  const lines = raw.split("\n").map((line) => line.replace(/[^\S\n]+/g, " ").trim());
  const result: string[] = [];
  let blankCount = 0;
  for (const line of lines) {
    if (line.length === 0) {
      blankCount++;
      if (blankCount === 1 && result.length > 0) {
        result.push("");
      }
    } else {
      blankCount = 0;
      result.push(line);
    }
  }
  return result.join("\n").trim();
}

function extractHtml(
  html: string,
  fallbackHost: string
): { readonly title: string; readonly text: string } {
  let title = "";
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch.length > 1 && titleMatch[1] !== undefined) {
    const candidate = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (candidate.length > 0) title = candidate;
  }

  if (title.length === 0) {
    const headingMatch = html.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i);
    if (headingMatch && headingMatch.length > 1 && headingMatch[1] !== undefined) {
      const candidate = decodeHtmlEntities(headingMatch[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      if (candidate.length > 0) title = candidate;
    }
  }

  if (title.length === 0) title = fallbackHost;

  // Drop head and chrome so navigation, scripts and ads do not enter research notes.
  let cleaned = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");
  const droppedTags = ["script", "style", "nav", "header", "footer", "aside", "form", "noscript"];
  for (const tag of droppedTags) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    while (re.test(cleaned)) {
      cleaned = cleaned.replace(re, " ");
    }
  }
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, " ");

  // Normalise line breaks to spaces so wrapped markup prose flows together.
  cleaned = cleaned.replace(/\r\n/g, " ").replace(/[\r\n]/g, " ");

  // Block elements introduce structural line breaks to preserve prose flow.
  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<\/(?:h[1-6]|p|div|section|article|blockquote)>/gi, "\n\n");
  cleaned = cleaned.replace(/<\/li>/gi, "\n");
  cleaned = cleaned.replace(/<\/(?:td|th)>/gi, " ");
  cleaned = cleaned.replace(/<\/tr>/gi, "\n");

  cleaned = cleaned.replace(/<[^>]+>/g, " ");
  cleaned = decodeHtmlEntities(cleaned);
  const text = collapseWhitespace(cleaned);

  return { title, text };
}

export function whyUrlRefused(raw: string): string | null {
  if (raw.length > 2000) {
    return "Web addresses cannot be longer than 2,000 characters.";
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "This web address is not valid.";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Only web addresses starting with http:// or https:// can be read.";
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return "Web addresses containing usernames or passwords cannot be used.";
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0) {
    return "This web address does not include a host.";
  }

  // Local names and mDNS addresses must never reach the host or neighbouring devices.
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "local" ||
    hostname.endsWith(".local")
  ) {
    return "Web addresses pointing to your local network are not allowed.";
  }

  // Block IPv6 loopback, link-local and unique local allocations to protect the owner's network.
  const isBracketed = hostname.startsWith("[") && hostname.endsWith("]");
  const rawIp6 = isBracketed ? hostname.slice(1, -1) : hostname;
  if (isBracketed || rawIp6.includes(":")) {
    const norm = rawIp6.toLowerCase();
    if (
      norm === "::1" ||
      norm === "::" ||
      norm === "0:0:0:0:0:0:0:1" ||
      norm.startsWith("fe8") ||
      norm.startsWith("fe9") ||
      norm.startsWith("fea") ||
      norm.startsWith("feb") ||
      norm.startsWith("fc") ||
      norm.startsWith("fd") ||
      norm.startsWith("::ffff:")
    ) {
      return "Web addresses pointing to your local network are not allowed.";
    }
    return "Web addresses cannot use an IP address directly.";
  }

  // IPv4 dotted-quad detection protecting private, loopback and link-local ranges.
  const parts = hostname.split(".");
  if (
    parts.length === 4 &&
    parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
  ) {
    const o0 = Number(parts[0]!);
    const o1 = Number(parts[1]!);

    if (o0 === 127 || o0 === 0) {
      return "Web addresses pointing to your local network are not allowed.";
    }
    if (o0 === 10) {
      return "Web addresses pointing to your local network are not allowed.";
    }
    if (o0 === 172 && o1 >= 16 && o1 <= 31) {
      return "Web addresses pointing to your local network are not allowed.";
    }
    if (o0 === 192 && o1 === 168) {
      return "Web addresses pointing to your local network are not allowed.";
    }
    if (o0 === 169 && o1 === 254) {
      return "Web addresses pointing to your local network are not allowed.";
    }

    return "Web addresses cannot use an IP address directly.";
  }

  return null;
}

/**
 * The page as it arrived, past every guard, or why it was refused.
 *
 * Split out of readWebPage so that a caller who needs the markup — to follow
 * the links in it, say — goes through the same address validation, the same
 * per-hop redirect checks, the same byte cap and the same binary refusal. The
 * alternative was a second fetch function beside this one, which would have
 * meant two places to keep the private-network refusal correct.
 */
type SourceOutcome =
  | {
      readonly status: "read";
      readonly source: string;
      readonly finalUrl: string;
      readonly mime: string;
      readonly bytes: number;
      readonly truncated: boolean;
    }
  | { readonly status: "refused"; readonly reason: string };

export async function readPageSource(raw: string, signal?: AbortSignal): Promise<SourceOutcome> {
  return fetchPageSource(raw, signal);
}

async function fetchPageSource(raw: string, signal?: AbortSignal): Promise<SourceOutcome> {
  const initialRefusal = whyUrlRefused(raw);
  if (initialRefusal !== null) {
    return { status: "refused", reason: initialRefusal };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  /**
   * Stop has to reach the socket. Taking the caller's signal and never
   * listening to it would leave a research run that he stopped still pulling
   * pages down in the background, which is the opposite of what the button says.
   */
  const abortForCaller = (): void => {
    controller.abort();
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      return { status: "refused", reason: "The page read was stopped." };
    }
    signal.addEventListener("abort", abortForCaller, { once: true });
  }

  try {
    let currentUrl = raw;
    let redirectCount = 0;

    while (true) {
      let response: Response;
      try {
        // Omitting credentials ensures cookies and identity are never broadcast.
        response = await fetch(currentUrl, {
          method: "GET",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html, text/plain;q=0.9, text/*;q=0.8, */*;q=0.1"
          },
          redirect: "manual",
          credentials: "omit",
          signal: controller.signal
        });
      } catch {
        if (controller.signal.aborted) {
          return {
            status: "refused",
            reason:
              signal?.aborted === true
                ? "The page read was stopped."
                : "The request timed out while reading the web page."
          };
        }
        return {
          status: "refused",
          reason: "The web page could not be reached."
        };
      }

      const isRedirect =
        response.status === 301 ||
        response.status === 302 ||
        response.status === 303 ||
        response.status === 307 ||
        response.status === 308;

      if (isRedirect) {
        if (response.body) {
          await response.body.cancel().catch(() => {});
        }

        if (redirectCount >= MAX_REDIRECTS) {
          return {
            status: "refused",
            reason: "The web address redirected too many times."
          };
        }

        const location = response.headers.get("location");
        if (!location) {
          return {
            status: "refused",
            reason: "The web address returned a redirect without a destination."
          };
        }

        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).href;
        } catch {
          return {
            status: "refused",
            reason: "The redirect address is not a valid web address."
          };
        }

        // Each redirect target is validated so public hops cannot bounce into private subnets.
        const hopRefusal = whyUrlRefused(nextUrl);
        if (hopRefusal !== null) {
          return { status: "refused", reason: hopRefusal };
        }

        currentUrl = nextUrl;
        redirectCount++;
        continue;
      }

      if (!response.ok) {
        if (response.body) {
          await response.body.cancel().catch(() => {});
        }
        return {
          status: "refused",
          reason: `The web server responded with status ${response.status}.`
        };
      }

      // Stop reading immediately once the byte limit is hit to conserve memory and bandwidth.
      let totalBytes = 0;
      let truncated = false;
      const chunks: Uint8Array[] = [];

      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              if (totalBytes + value.byteLength >= MAX_PAGE_BYTES) {
                const remaining = MAX_PAGE_BYTES - totalBytes;
                if (remaining > 0) {
                  chunks.push(value.subarray(0, remaining));
                  totalBytes += remaining;
                }
                truncated = true;
                await reader.cancel().catch(() => {});
                break;
              }
              chunks.push(value);
              totalBytes += value.byteLength;
            }
          }
        } catch {
          // If the network stream fails prematurely, keep the received bytes.
        }
      } else if (typeof response.arrayBuffer === "function") {
        const ab = await response.arrayBuffer();
        const arr = new Uint8Array(ab);
        if (arr.byteLength > MAX_PAGE_BYTES) {
          chunks.push(arr.subarray(0, MAX_PAGE_BYTES));
          totalBytes = MAX_PAGE_BYTES;
          truncated = true;
        } else {
          chunks.push(arr);
          totalBytes = arr.byteLength;
        }
      }

      const combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const contentTypeHeader = response.headers.get("content-type") ?? "";
      const mime = contentTypeHeader.split(";")[0]?.trim().toLowerCase() ?? "";

      if (isBinaryMime(mime)) {
        return {
          status: "refused",
          reason: "This web page returned binary content, which cannot be read as text."
        };
      }

      const probeLength = Math.min(combined.byteLength, 1024);
      for (let i = 0; i < probeLength; i++) {
        if (combined[i] === 0) {
          return {
            status: "refused",
            reason: "This web page returned binary content, which cannot be read as text."
          };
        }
      }

      if (!isTextualMime(mime)) {
        return {
          status: "refused",
          reason: "This web page returned content that cannot be read as text."
        };
      }

      let charset = "utf-8";
      const charsetMatch = contentTypeHeader.match(/charset=([a-zA-Z0-9_-]+)/i);
      if (charsetMatch && charsetMatch.length > 1 && charsetMatch[1] !== undefined) {
        try {
          new TextDecoder(charsetMatch[1]);
          charset = charsetMatch[1];
        } catch {
          charset = "utf-8";
        }
      }

      const decoder = new TextDecoder(charset, { fatal: false });
      const rawText = decoder.decode(combined);

      return {
        status: "read",
        source: rawText,
        finalUrl: currentUrl,
        mime,
        bytes: totalBytes,
        truncated
      };
    }
  } finally {
    clearTimeout(timeoutId);
    if (signal !== undefined) {
      signal.removeEventListener("abort", abortForCaller);
    }
  }
}

export async function readWebPage(raw: string, now: number): Promise<WebReadOutcome> {
  const fetched = await fetchPageSource(raw);
  if (fetched.status === "refused") {
    return fetched;
  }

  const { source: rawText, finalUrl: currentUrl, mime, bytes: totalBytes } = fetched;
  let truncated = fetched.truncated;

  {
    {
      const parsedFinalUrl = new URL(currentUrl);
      const fallbackHost = parsedFinalUrl.host;

      let title: string;
      let text: string;

      const isHtml =
        mime === "text/html" ||
        mime === "application/xhtml+xml" ||
        (mime === "" && /<html\b/i.test(rawText));

      if (isHtml) {
        const extracted = extractHtml(rawText, fallbackHost);
        title = extracted.title;
        text = extracted.text;
      } else {
        title = fallbackHost;
        text = collapseWhitespace(rawText);
      }

      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS);
        truncated = true;
      }

      return {
        status: "read",
        url: currentUrl,
        title,
        text,
        bytes: totalBytes,
        truncated,
        fetchedAt: now
      };
    }
  }
}
