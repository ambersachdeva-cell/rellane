import { EventEmitter } from "node:events";
import type { WebContents, WebFrameMain } from "electron";
import { expect, it, vi } from "vitest";
import { createAgentSourceOwners } from "./source-owner.js";

it("binds previews to the actual window and frame, and invalidates on navigation or destruction", () => {
  const events = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const sender = events as unknown as WebContents;
  const frame = {} as WebFrameMain;
  const discard = vi.fn();
  const ownerFor = createAgentSourceOwners(discard);
  const first = ownerFor(sender, frame);
  expect(ownerFor(sender, frame)).toBe(first);
  events.emit("did-start-navigation", { isMainFrame: false });
  expect(ownerFor(sender, frame)).toBe(first);
  events.emit("did-start-navigation", { isMainFrame: true });
  expect(discard).toHaveBeenCalledWith(first);
  const second = ownerFor(sender, frame);
  expect(second).not.toBe(first);
  const third = ownerFor(sender, {} as WebFrameMain);
  expect(third).not.toBe(second); expect(discard).toHaveBeenCalledWith(second);
  expect(events.listenerCount("did-start-navigation")).toBe(1);
  events.emit("destroyed");
  expect(discard).toHaveBeenCalledWith(third);
  expect(() => ownerFor(sender, null)).toThrow("no longer available");
});
