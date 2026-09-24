import { describe, expect, it, vi } from "vitest";
import { stageMessage, type StageDeps } from "./stage.js";
import type { Channel } from "./mark.js";
import type { Contact } from "../foundations/settings.js";

const FOLDERS = ["/Users/a/Downloads"];

const contacts: readonly Contact[] = [
  { channel: "whatsapp", address: "+919876543210", label: "Devgiri Traders" }
];

function deps(over: Partial<StageDeps> = {}): StageDeps {
  const opened: string[] = [];
  const channel: Channel = {
    name: "whatsapp",
    delivery: "stages",
    async send(to, text) {
      opened.push(`${to}|${text}`);
    }
  };
  return {
    channels: [channel],
    contacts: async () => contacts,
    grantedFolders: () => FOLDERS,
    storedAgents: async () => [],
    ...over
  };
}

describe("staging what an agent wrote", () => {
  it("opens the channel and says plainly that nothing was sent", async () => {
    const sent: string[] = [];
    const result = await stageMessage(
      {
        agentId: "drafts",
        channel: "whatsapp",
        address: "+919876543210",
        text: "Balance ₹9,360 on the August quote."
      },
      deps({
        channels: [
          {
            name: "whatsapp",
            delivery: "stages",
            async send(to, text) {
              sent.push(`${to}|${text}`);
            }
          }
        ]
      })
    );

    expect(result.staged).toBe(true);
    // The sentence a person reads. "Sent" would be a lie, and the whole promise
    // of this product rests on that word being accurate.
    expect(result.said).toContain("Nothing has been sent");
    expect(result.said).toContain("Devgiri Traders");
    expect(sent).toEqual(["+919876543210|Balance ₹9,360 on the August quote."]);
  });

  it("refuses a channel that sends immediately, instead of using it", async () => {
    // This test previously asserted the opposite — that a "sends" channel would
    // deliver — which encoded the bug rather than the rule. D-033 made
    // `delivery` a required field precisely so an agent's draft could never
    // reach the wire without a person pressing send, and this path called
    // `send` without ever reading it.
    const sent = vi.fn();
    const result = await stageMessage(
      { agentId: "drafts", channel: "whatsapp", address: "+919876543210", text: "hi" },
      deps({ channels: [{ name: "whatsapp", delivery: "sends", send: sent }] })
    );

    expect(result.staged).toBe(false);
    expect(result.said).toContain("Nothing was sent");
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("the three gates", () => {
  it("refuses an agent whose brief says it sends nothing", async () => {
    // The brief is the authority, not the request. A row that reads "sends
    // nothing" must not be able to send because a renderer asked it to.
    const send = vi.fn();
    const result = await stageMessage(
      { agentId: "filing-clerk", channel: "whatsapp", address: "+919876543210", text: "hi" },
      deps({ channels: [{ name: "whatsapp", delivery: "stages", send }] })
    );

    expect(result.staged).toBe(false);
    expect(result.said).toContain("sends nothing");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a recipient who is not on the list", async () => {
    const result = await stageMessage(
      { agentId: "drafts", channel: "whatsapp", address: "+919000000000", text: "hi" },
      deps()
    );

    expect(result.staged).toBe(false);
    expect(result.said).toContain("not on your whatsapp list");
  });

  it("reads the list fresh, so removing somebody takes effect at once", async () => {
    // Captured once at startup, a removal would not apply until the next
    // launch — which is exactly when a person most wants it to.
    let current: readonly Contact[] = contacts;
    const shared = deps({ contacts: async () => current });

    expect(
      (await stageMessage(
        { agentId: "drafts", channel: "whatsapp", address: "+919876543210", text: "hi" },
        shared
      )).staged
    ).toBe(true);

    current = [];

    expect(
      (await stageMessage(
        { agentId: "drafts", channel: "whatsapp", address: "+919876543210", text: "hi" },
        shared
      )).staged
    ).toBe(false);
  });

  it("passes the channel's own refusal through rather than guessing at it", async () => {
    const result = await stageMessage(
      { agentId: "drafts", channel: "whatsapp", address: "+919876543210", text: "hi" },
      deps({
        channels: [
          {
            name: "whatsapp",
            delivery: "stages",
            async send() {
              throw new Error("That message is 5,000 characters.");
            }
          }
        ]
      })
    );

    expect(result.staged).toBe(false);
    expect(result.said).toBe("That message is 5,000 characters.");
  });

  it("refuses an empty draft, and an agent that no longer exists", async () => {
    expect(
      (await stageMessage(
        { agentId: "drafts", channel: "whatsapp", address: "+919876543210", text: "   " },
        deps()
      )).said
    ).toContain("nothing to send");

    expect(
      (await stageMessage(
        { agentId: "gone", channel: "whatsapp", address: "+919876543210", text: "hi" },
        deps()
      )).said
    ).toContain("no longer exists");
  });
});
