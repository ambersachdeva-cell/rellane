/**
 * WhatsApp, as a sender this time.
 *
 * D-033 refused WhatsApp because there was no official API for a personal
 * number, so the only way to send was an unofficial library holding a live
 * session — a send path existing independently of the approval gate, on an
 * account this product could not restore if it were banned.
 *
 * The Cloud API on a dedicated business number is a different thing. It is
 * official, the number is not the owner's own, and every send is an ordinary
 * HTTPS request made at the moment it is approved. There is no session sitting
 * there able to send on its own. So the reasoning in D-033 does not carry over,
 * and the ban risk it was protecting against does not exist here.
 *
 * What does carry over is the rule underneath it: one place a message can come
 * from, and a person deciding. Sending lives here, on the Mac, with a token that
 * never leaves it. The mailbox that receives cannot send and holds no token.
 */

/** Meta's limit is 4096 characters for a text body. */
export const MAX_BODY_CHARS = 4096;

/** Held open long enough for a slow mobile network, not long enough to hang a quit. */
const REQUEST_TIMEOUT_MS = 20_000;

export interface InboundMessage {
  readonly id: string;
  readonly from: string;
  readonly name: string;
  readonly at: number;
  readonly kind: string;
  readonly text: string;
}

export type SendOutcome =
  | { readonly status: "sent"; readonly messageId: string }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Splits on the last line break before the ceiling, so a long quotation arrives
 * as whole lines rather than cut mid-figure. A message that arrives missing its
 * last line is worse than one that is refused, and a price split across two
 * bubbles is worse than either.
 */
export function splitBody(text: string): readonly string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const parts: string[] = [];
  let rest = trimmed;
  while (rest.length > MAX_BODY_CHARS) {
    const slice = rest.slice(0, MAX_BODY_CHARS);
    const breakAt = slice.lastIndexOf("\n");
    const cut = breakAt > MAX_BODY_CHARS / 2 ? breakAt : MAX_BODY_CHARS;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) {
    parts.push(rest);
  }
  return parts;
}

/**
 * A number in the form Meta accepts: digits only, country code included, no
 * plus and no spaces. Indian numbers are written a dozen ways in a contact list
 * and Meta silently fails on most of them.
 */
export function normaliseRecipient(raw: string, defaultCountryCode = "91"): string | null {
  const digits = raw.replace(/\D/gu, "");
  if (digits.length === 0) {
    return null;
  }
  // A bare ten-digit Indian mobile, which is how they are almost always stored.
  if (digits.length === 10) {
    return `${defaultCountryCode}${digits}`;
  }
  // A leading zero is a domestic dialling prefix, never part of the number.
  if (digits.length === 11 && digits.startsWith("0")) {
    return `${defaultCountryCode}${digits.slice(1)}`;
  }
  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const relay = (): void => controller.abort();
  signal?.addEventListener("abort", relay, { once: true });
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

/**
 * Sends one text message to one number.
 *
 * Only inside an open 24-hour window — Meta refuses a free-form message outside
 * one, and says so. That refusal is returned as words rather than thrown,
 * because "she has not written to you since Tuesday, so this needs an approved
 * template" is something the owner can act on.
 */
export async function sendText(input: {
  readonly token: string;
  readonly phoneNumberId: string;
  readonly to: string;
  readonly body: string;
  readonly signal?: AbortSignal;
}): Promise<SendOutcome> {
  const to = normaliseRecipient(input.to);
  if (to === null) {
    return { status: "refused", reason: `"${input.to}" is not a phone number WhatsApp can reach.` };
  }
  const parts = splitBody(input.body);
  if (parts.length === 0) {
    return { status: "refused", reason: "There is nothing to send." };
  }

  let lastId = "";
  for (const part of parts) {
    let response: Response;
    try {
      response = await withTimeout(
        (signal) =>
          fetch(`https://graph.facebook.com/v21.0/${input.phoneNumberId}/messages`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${input.token}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to,
              type: "text",
              text: { preview_url: false, body: part }
            }),
            signal
          }),
        input.signal
      );
    } catch {
      return {
        status: "refused",
        reason: "WhatsApp could not be reached. Nothing was sent."
      };
    }

    const raw = await response.text();
    if (!response.ok) {
      // Meta's error bodies are readable and specific — the window being shut,
      // the number not being on WhatsApp, the token being wrong. Passing the
      // message through beats replacing it with a status code.
      let said = `WhatsApp refused this (${response.status}).`;
      try {
        const parsed: unknown = JSON.parse(raw);
        const message = (parsed as { error?: { message?: unknown } }).error?.message;
        if (typeof message === "string" && message.trim().length > 0) {
          said = message.trim();
        }
      } catch {
        // Keep the status-code sentence.
      }
      return { status: "refused", reason: said };
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      const id = (parsed as { messages?: readonly { id?: unknown }[] }).messages?.[0]?.id;
      if (typeof id === "string") {
        lastId = id;
      }
    } catch {
      // A 200 with an unreadable body still means it went.
    }
  }

  return { status: "sent", messageId: lastId };
}

/**
 * Collects whatever the mailbox is holding.
 *
 * Outbound from this Mac, like the Telegram poll, so nothing listens here. An
 * unreachable mailbox answers with nothing rather than throwing: a customer
 * message arriving late is recoverable, a poll loop that dies is not.
 */
export async function collectInbound(input: {
  readonly mailboxUrl: string;
  readonly collectSecret: string;
  readonly signal?: AbortSignal;
}): Promise<readonly InboundMessage[]> {
  const url = new URL("/collect", input.mailboxUrl).href;
  let response: Response;
  try {
    response = await withTimeout(
      (signal) =>
        fetch(url, {
          method: "GET",
          headers: { authorization: `Bearer ${input.collectSecret}` },
          signal
        }),
      input.signal
    );
  } catch {
    return [];
  }
  if (!response.ok) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return [];
  }
  const held = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(held)) {
    return [];
  }

  const messages: InboundMessage[] = [];
  for (const item of held) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const from = typeof record["from"] === "string" ? record["from"] : "";
    const id = typeof record["id"] === "string" ? record["id"] : "";
    if (from.length === 0 || id.length === 0) {
      continue;
    }
    messages.push({
      id,
      from,
      name: typeof record["name"] === "string" ? record["name"] : "",
      at: typeof record["at"] === "number" ? record["at"] : 0,
      kind: typeof record["kind"] === "string" ? record["kind"] : "unknown",
      text: typeof record["text"] === "string" ? record["text"] : ""
    });
  }
  // Oldest first, so a conversation is read in the order it was said.
  return messages.sort((a, b) => a.at - b.at);
}
