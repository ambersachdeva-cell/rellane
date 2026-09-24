/**
 * The security properties of the handoff, exercised without starting an app.
 *
 * Two of these are about a thing not happening: a chat is never opened to
 * somebody who is not on the owner's list, and no channel that would actually
 * send is ever used. Both were previously only enforceable by reading the code.
 */
import { describe, expect, it, vi } from "vitest";
import type { Deal } from "@cadrane/contracts";
import { handoffQuotation } from "./quotation-handoff.js";
import type { Channel } from "./mark.js";

const SHOP = { name: "Sachdeva Printers" };

function deal(over: Partial<Deal> = {}): Deal {
  return {
    enquiryId: "e1",
    channel: "whatsapp",
    receivedAt: 0,
    rawText: "500 cards",
    partyId: "p1",
    partyName: "Verma Textiles",
    partyPhone: "98765 43210",
    triage: "real",
    quotation: {
      quotationId: "q1",
      state: "draft",
      gstRateBp: null,
      draftedAt: 0,
      sentAt: null,
      closedAt: null,
      closedReason: null,
      lines: [
        {
          id: "l1",
          position: 1,
          description: "500 visiting cards",
          quantity: 500,
          unit: null,
          unitPricePaise: 200,
          linePaise: 100_000
        }
      ],
      netPaise: 100_000,
      totalPaise: 100_000
    },
    ...over
  } as Deal;
}

function staging(send = vi.fn(async () => undefined)): { channel: Channel; send: typeof send } {
  return { channel: { name: "whatsapp", delivery: "stages", send } as Channel, send };
}

const ALLOWED = [{ channel: "whatsapp" as const, address: "919876543210", label: "Verma Textiles" }];

describe("who a chat may be opened to", () => {
  it("opens one for somebody on the list", async () => {
    const { channel, send } = staging();
    const result = await handoffQuotation(deal(), {
      channels: [channel],
      contacts: async () => ALLOWED,
      shop: async () => SHOP
    });

    expect(result.opened).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.said).toContain("Nothing has been sent");
  });

  it("opens nothing for somebody who is not, however the number is written", async () => {
    const { channel, send } = staging();
    for (const phone of ["98765 43210", "+91 98765 43210", "09876543210"]) {
      const result = await handoffQuotation(deal({ partyPhone: phone }), {
        channels: [channel],
        contacts: async () => [],
        shop: async () => SHOP
      });
      expect(result.opened).toBe(false);
      expect(result.canAdd).toBe(true);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("treats the same number written four ways as one recipient", async () => {
    // An allowlist that reads `+91 98765 43210` and `9876543210` as different
    // people is one that fails the first time somebody types it differently.
    const { channel } = staging();
    for (const phone of ["9876543210", "+91 98765 43210", "0 98765 43210", "00919876543210"]) {
      const result = await handoffQuotation(deal({ partyPhone: phone }), {
        channels: [channel],
        contacts: async () => ALLOWED,
        shop: async () => SHOP
      });
      expect(result.opened).toBe(true);
    }
  });

  it("refuses rather than skipping the list when the list cannot be read", async () => {
    const { channel, send } = staging();
    const result = await handoffQuotation(deal(), {
      channels: [channel],
      contacts: async () => {
        throw new Error("settings are gone");
      },
      shop: async () => SHOP
    });

    expect(result.opened).toBe(false);
    expect(result.canAdd).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("a channel that would actually send", () => {
  it("is not used, whatever it is called", async () => {
    // D-033's invariant, checked rather than assumed. `delivery` is the field
    // everything downstream reads to decide whether a message was delivered.
    const send = vi.fn(async () => undefined);
    const result = await handoffQuotation(deal(), {
      channels: [{ name: "whatsapp", delivery: "sends", send } as Channel],
      contacts: async () => ALLOWED,
      shop: async () => SHOP
    });

    expect(result.opened).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("says so when there is no WhatsApp on this Mac at all", async () => {
    const result = await handoffQuotation(deal(), {
      channels: [],
      contacts: async () => ALLOWED,
      shop: async () => SHOP
    });
    expect(result.opened).toBe(false);
  });
});

describe("whether adding this customer would help", () => {
  it("is true only when the list is the one thing in the way", async () => {
    const { channel } = staging();
    const refused = await handoffQuotation(deal(), {
      channels: [channel],
      contacts: async () => [],
      shop: async () => SHOP
    });
    expect(refused.canAdd).toBe(true);
  });

  it("is false for a number nothing can dial", async () => {
    // Adding "12345" to the list does not make it a phone number.
    const { channel } = staging();
    const result = await handoffQuotation(deal({ partyPhone: "12345" }), {
      channels: [channel],
      contacts: async () => [],
      shop: async () => SHOP
    });
    expect(result.opened).toBe(false);
    expect(result.canAdd).toBe(false);
  });

  it("is false when there is no name to put on the row", async () => {
    // A contact list row reading "919876543210" is one nobody can audit later.
    const { channel } = staging();
    const result = await handoffQuotation(deal({ partyName: null }), {
      channels: [channel],
      contacts: async () => [],
      shop: async () => SHOP
    });
    expect(result.canAdd).toBe(false);
  });

  it("is false for an empty quotation, which adding nobody fixes", async () => {
    const { channel } = staging();
    const result = await handoffQuotation(deal({ quotation: null }), {
      channels: [channel],
      contacts: async () => [],
      shop: async () => SHOP
    });
    expect(result.opened).toBe(false);
    expect(result.canAdd).toBe(false);
    expect(result.said).toContain("no lines");
  });

  it("is false when there is no number at all", async () => {
    const { channel } = staging();
    const result = await handoffQuotation(deal({ partyPhone: null }), {
      channels: [channel],
      contacts: async () => [],
      shop: async () => SHOP
    });
    expect(result.opened).toBe(false);
    expect(result.canAdd).toBe(false);
  });
});
