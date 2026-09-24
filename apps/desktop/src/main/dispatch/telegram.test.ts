import { describe, expect, it, vi } from "vitest";
import {
  backoffMs,
  MAX_MESSAGE_CHARS,
  splitMessage,
  TelegramClient,
  telegramChannel,
  TelegramConflict,
  TelegramError
} from "./telegram.js";

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function update(id: number, text: string, chatId = 42) {
  return {
    update_id: id,
    message: {
      message_id: id * 10,
      text,
      chat: { id: chatId },
      from: { username: "amber" }
    }
  };
}

/** Captures the request bodies so offset advancement can be asserted. */
function recorder(responses: unknown[]) {
  const bodies: Record<string, unknown>[] = [];
  let call = 0;
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return reply(next);
  });
  return { fetcher: fetcher as unknown as typeof fetch, bodies };
}

describe("offset is how updates get acknowledged", () => {
  it("omits offset on the very first poll", async () => {
    const { fetcher, bodies } = recorder([{ ok: true, result: [] }]);
    await new TelegramClient({ token: "t", fetch: fetcher }).poll();
    expect(bodies[0]).not.toHaveProperty("offset");
  });

  it("advances to highest update id plus one", async () => {
    // Telegram: "Must be greater by one than the highest among the identifiers
    // of previously received updates."
    const { fetcher, bodies } = recorder([
      { ok: true, result: [update(100, "a"), update(101, "b")] },
      { ok: true, result: [] }
    ]);
    const client = new TelegramClient({ token: "t", fetch: fetcher });
    await client.poll();
    await client.poll();
    expect(bodies[1]?.["offset"]).toBe(102);
  });

  it("does not move the offset when nothing arrived", async () => {
    const { fetcher, bodies } = recorder([
      { ok: true, result: [update(100, "a")] },
      { ok: true, result: [] },
      { ok: true, result: [] }
    ]);
    const client = new TelegramClient({ token: "t", fetch: fetcher });
    await client.poll();
    await client.poll();
    await client.poll();
    expect(bodies[1]?.["offset"]).toBe(101);
    expect(bodies[2]?.["offset"]).toBe(101);
  });

  it("still advances past updates that carry no text", async () => {
    // A sticker or a join event has no text but must not be requested forever.
    const { fetcher, bodies } = recorder([
      { ok: true, result: [{ update_id: 500 }] },
      { ok: true, result: [] }
    ]);
    const client = new TelegramClient({ token: "t", fetch: fetcher });
    expect(await client.poll()).toHaveLength(0);
    await client.poll();
    expect(bodies[1]?.["offset"]).toBe(501);
  });

  it("reads out the parts a dispatcher needs", async () => {
    const { fetcher } = recorder([{ ok: true, result: [update(7, "organise my downloads", 99)] }]);
    const [message] = await new TelegramClient({ token: "t", fetch: fetcher }).poll();
    expect(message).toMatchObject({ chatId: 99, from: "amber", text: "organise my downloads" });
  });
});

describe("failures are told apart", () => {
  it("names a second poller rather than retrying into it", async () => {
    const { fetcher } = recorder([
      { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates" }
    ]);
    await expect(new TelegramClient({ token: "t", fetch: fetcher }).poll()).rejects.toBeInstanceOf(
      TelegramConflict
    );
  });

  it("carries retry_after off a 429", async () => {
    const { fetcher } = recorder([
      { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 6 } }
    ]);
    await expect(
      new TelegramClient({ token: "t", fetch: fetcher }).send(1, "hi")
    ).rejects.toMatchObject({ code: 429, retryAfter: 6 });
  });

  it("says plainly when the token is wrong", async () => {
    const { fetcher } = recorder([{ ok: false, error_code: 401, description: "Unauthorized" }]);
    await expect(new TelegramClient({ token: "bad", fetch: fetcher }).whoAmI()).rejects.toMatchObject(
      { code: 401 }
    );
  });
});

describe("backoff", () => {
  it("honours the wait Telegram asked for, exactly", () => {
    expect(backoffMs(new TelegramError(429, "slow down", 6), 0)).toBe(6_000);
  });

  it("waits a long time on a conflict, because retrying prolongs the fight", () => {
    expect(backoffMs(new TelegramConflict("two pollers"), 1)).toBe(60_000);
  });

  it("backs off exponentially otherwise and stops at a minute", () => {
    expect(backoffMs(new Error("network"), 0)).toBe(1_000);
    expect(backoffMs(new Error("network"), 3)).toBe(8_000);
    expect(backoffMs(new Error("network"), 99)).toBe(60_000);
  });
});

describe("splitting long replies", () => {
  it("leaves a short message alone", () => {
    expect(splitMessage("short")).toEqual(["short"]);
  });

  it("splits on line boundaries rather than mid-word", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `Filed invoice_${i}.pdf to Documents`);
    const parts = splitMessage(lines.join("\n"));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
      expect(part.startsWith("Filed")).toBe(true);
    }
  });

  it("hard-cuts a single line that is itself too long", () => {
    const parts = splitMessage("x".repeat(MAX_MESSAGE_CHARS * 2 + 10));
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.length <= MAX_MESSAGE_CHARS)).toBe(true);
  });

  it("loses nothing", () => {
    const original = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    expect(splitMessage(original).join("\n")).toBe(original);
  });
});


describe("telegram as a Mark channel", () => {
  /** A client whose every call succeeds, recording what was posted. */
  function sendingClient() {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return reply({ ok: true, result: {} });
    });
    const client = new TelegramClient({ token: "t", fetch: fetch as unknown as typeof globalThis.fetch });
    return { client, posted };
  }

  it("says it sends, unlike the channels that only stage", () => {
    // WhatsApp and email hand a composed message to a person to tap send on
    // (D-033). This one genuinely leaves the Mac, and the interface has to say
    // so or the queue cannot tell the owner what actually happened.
    const { client } = sendingClient();
    const channel = telegramChannel(client);
    expect(channel.name).toBe("telegram");
    expect(channel.delivery).toBe("sends");
  });

  it("splits a long reply rather than losing its end", async () => {
    // Telegram refuses anything past 4,096 characters. A status reply whose
    // last line vanishes is worse than two messages.
    const { client, posted } = sendingClient();
    await telegramChannel(client).send("42", "x".repeat(MAX_MESSAGE_CHARS + 500));
    expect(posted).toHaveLength(2);
    expect(String(posted[0]?.["text"]).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    const rejoined = posted.map((body) => String(body["text"])).join("").length;
    expect(rejoined).toBe(MAX_MESSAGE_CHARS + 500);
  });

  it("sends a short reply as one message, to the chat it was given", async () => {
    const { client, posted } = sendingClient();
    await telegramChannel(client).send("42", "Three enquiries, none answered.");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.["chat_id"]).toBe(42);
    expect(posted[0]?.["text"]).toBe("Three enquiries, none answered.");
  });

  it("refuses a chat id that is not a number instead of posting into NaN", async () => {
    const { client, posted } = sendingClient();
    await expect(telegramChannel(client).send("not-a-chat", "hello")).rejects.toThrow(
      /not a Telegram chat id/
    );
    expect(posted).toHaveLength(0);
  });
});
