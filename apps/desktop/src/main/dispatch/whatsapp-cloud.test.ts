import { describe, expect, it, vi, afterEach } from "vitest";
import {
  collectInbound,
  MAX_BODY_CHARS,
  normaliseRecipient,
  sendText,
  splitBody
} from "./whatsapp-cloud.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normaliseRecipient", () => {
  it("accepts the ways an Indian mobile is actually stored in a contact list", () => {
    for (const written of ["9876543210", "+91 98765 43210", "+919876543210", "098765 43210"]) {
      expect(normaliseRecipient(written)).toBe("919876543210");
    }
  });

  it("refuses what WhatsApp cannot reach rather than sending into nothing", () => {
    expect(normaliseRecipient("")).toBeNull();
    expect(normaliseRecipient("not a number")).toBeNull();
    expect(normaliseRecipient("123")).toBeNull();
    expect(normaliseRecipient("9".repeat(20))).toBeNull();
  });
});

describe("splitBody", () => {
  it("leaves an ordinary message whole", () => {
    expect(splitBody("Your quotation is ready.")).toEqual(["Your quotation is ready."]);
  });

  /**
   * The case this exists for: a long quotation must not arrive with a price cut
   * across two bubbles.
   */
  it("breaks a long message on a line ending, not mid-figure", () => {
    const line = "Item 7 — supply and fit, Rs 12,400\n";
    const parts = splitBody(line.repeat(200));

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
      expect(part.endsWith("Rs 12,400")).toBe(true);
    }
  });

  it("has nothing to send for an empty message", () => {
    expect(splitBody("   \n  ")).toEqual([]);
  });
});

describe("sendText", () => {
  it("sends to the normalised number and reports the id", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await sendText({
      token: "t".repeat(60),
      phoneNumberId: "1234567890123",
      to: "+91 98765 43210",
      body: "Your quotation is ready."
    });

    expect(outcome).toEqual({ status: "sent", messageId: "wamid.ABC" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.to).toBe("919876543210");
    expect(body.text.body).toBe("Your quotation is ready.");
  });

  /**
   * Meta's refusals say something the owner can act on — the 24-hour window
   * being shut is the common one. Replacing that with a status code would throw
   * away the only useful part.
   */
  it("passes Meta's own words back rather than a status code", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ error: { message: "Message failed to send because more than 24 hours have passed since the customer last replied." } }),
        { status: 400 }
      )
    );

    const outcome = await sendText({
      token: "t".repeat(60),
      phoneNumberId: "1234567890123",
      to: "919876543210",
      body: "Following up on that invoice."
    });

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toContain("24 hours");
  });

  it("refuses a bad number before it reaches the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await sendText({
      token: "t".repeat(60),
      phoneNumberId: "1234567890123",
      to: "hello",
      body: "Anything"
    });

    expect(outcome.status).toBe("refused");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says nothing was sent when WhatsApp cannot be reached", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("offline"); });

    const outcome = await sendText({
      token: "t".repeat(60),
      phoneNumberId: "1234567890123",
      to: "919876543210",
      body: "Anything"
    });

    expect(outcome).toEqual({
      status: "refused",
      reason: "WhatsApp could not be reached. Nothing was sent."
    });
  });
});

describe("collectInbound", () => {
  it("reads the mailbox oldest first, so a conversation is in order", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          messages: [
            { id: "b", from: "919876543210", name: "Rakesh", at: 2000, kind: "text", text: "second" },
            { id: "a", from: "919876543210", name: "Rakesh", at: 1000, kind: "text", text: "first" }
          ]
        }),
        { status: 200 }
      )
    );

    const messages = await collectInbound({
      mailboxUrl: "https://mailbox.example.workers.dev",
      collectSecret: "s".repeat(32)
    });

    expect(messages.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("sends the collect secret, and only to the collect path", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ messages: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await collectInbound({
      mailboxUrl: "https://mailbox.example.workers.dev",
      collectSecret: "abc123"
    });

    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://mailbox.example.workers.dev/collect");
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ authorization: "Bearer abc123" });
  });

  /**
   * A mailbox that cannot be reached is a customer message arriving late. A poll
   * loop that throws is one that never arrives at all.
   */
  it("answers with nothing rather than throwing when the mailbox is unreachable", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
    await expect(
      collectInbound({ mailboxUrl: "https://mailbox.example.workers.dev", collectSecret: "s" })
    ).resolves.toEqual([]);
  });

  it("drops a held record that is missing who it came from", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ messages: [{ id: "a", at: 1 }, { from: "91987", at: 2 }] }), { status: 200 })
    );

    await expect(
      collectInbound({ mailboxUrl: "https://m.example.workers.dev", collectSecret: "s" })
    ).resolves.toEqual([]);
  });
});
