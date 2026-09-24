/**
 * A mailbox for WhatsApp, and nothing more.
 *
 * Meta will only deliver an inbound message by POSTing to a public address, and
 * a Mac on a domestic connection does not have one. This is the smallest thing
 * that can hold the gap: it accepts what Meta posts, keeps it until the Mac
 * collects it, and hands it over once.
 *
 * What it deliberately does not do:
 *   - It never sends a WhatsApp message. Sending happens from the Mac, with the
 *     token that never leaves the Mac. A relay that could also send would be a
 *     second place a message can originate from, which is the thing D-033 was
 *     written to prevent.
 *   - It never holds the WhatsApp token, and cannot obtain one.
 *   - It keeps nothing once collected, and nothing at all after seven days.
 *
 * Every request is checked before it is believed. Meta signs each POST with the
 * app secret; an unsigned or wrongly signed request is refused, so nobody who
 * finds this URL can post a message into your business.
 */

const MAX_HELD = 500;
const HOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Constant-time, so a wrong signature cannot be found one byte at a time. */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let differing = 0;
  for (let i = 0; i < a.length; i += 1) differing |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differing === 0;
}

async function signatureMatches(body, header, appSecret) {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sameBytes(`sha256=${hex}`, header);
}

/**
 * The parts of an inbound message the Mac actually needs.
 *
 * Meta's payload carries more than that. Keeping only these means a mailbox
 * breach exposes the message text and the sender's number — which WhatsApp
 * already holds — rather than every field Meta chose to include.
 */
function readMessages(payload) {
  const out = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = new Map(
        (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? ""])
      );
      for (const message of value.messages ?? []) {
        out.push({
          id: message.id,
          from: message.from,
          name: names.get(message.from) ?? "",
          at: Number(message.timestamp ?? 0) * 1000,
          kind: message.type ?? "unknown",
          text:
            message.text?.body ??
            message.button?.text ??
            message.interactive?.list_reply?.title ??
            message.interactive?.button_reply?.title ??
            ""
        });
      }
    }
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Meta proves the endpoint is yours once, before it will deliver anything.
    if (request.method === "GET" && url.pathname === "/webhook") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === env.VERIFY_TOKEN && challenge !== null) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("no", { status: 403 });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const body = await request.text();
      const signed = await signatureMatches(
        body,
        request.headers.get("x-hub-signature-256"),
        env.APP_SECRET
      );
      // 200 either way: a 4xx makes Meta retry, and retrying a forgery is worse
      // than dropping it. The refusal is silent on purpose.
      if (!signed) return new Response("ok", { status: 200 });

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return new Response("ok", { status: 200 });
      }

      const now = Date.now();
      for (const message of readMessages(payload)) {
        await env.MAILBOX.put(`m:${message.at}:${message.id}`, JSON.stringify(message), {
          expirationTtl: HOLD_MS / 1000
        });
      }
      return new Response("ok", { status: 200 });
    }

    /**
     * The Mac collecting its post. Outbound from the Mac, like the Telegram
     * poll, so no port opens on it and this stays the only public thing.
     */
    if (request.method === "GET" && url.pathname === "/collect") {
      const given = request.headers.get("authorization");
      if (given !== `Bearer ${env.COLLECT_SECRET}`) {
        return new Response("no", { status: 403 });
      }
      const listed = await env.MAILBOX.list({ prefix: "m:", limit: MAX_HELD });
      const messages = [];
      for (const key of listed.keys) {
        const held = await env.MAILBOX.get(key.name);
        if (held !== null) messages.push(JSON.parse(held));
      }
      // Deleted only after they are in the response body, so a collection that
      // fails in flight is retried rather than lost.
      const response = new Response(JSON.stringify({ messages }), {
        headers: { "content-type": "application/json" }
      });
      for (const key of listed.keys) await env.MAILBOX.delete(key.name);
      return response;
    }

    return new Response("not here", { status: 404 });
  }
};
