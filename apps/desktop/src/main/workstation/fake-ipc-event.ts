/**
 * A sender that is actually a sender, for tests.
 *
 * Five separate workers have now written an IPC test whose fake event was a
 * plain object, and all five died the same way: `createAgentSourceOwners` calls
 * `isDestroyed()` and subscribes to `did-start-navigation`, so the owner check
 * throws before the handler under test is ever reached. The failure points at
 * `source-owner.ts`, which is correct, and costs ten minutes each time.
 *
 * This is the smallest thing that satisfies the owner registry: a real
 * EventEmitter, a destroyed flag that can be flipped, and a frame object whose
 * identity can be changed to simulate the window navigating — which is the one
 * thing these tests actually need to vary.
 */
import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";

export interface FakeIpcEvent {
  readonly event: IpcMainInvokeEvent;
  readonly sender: EventEmitter;
  /** Retires the current owner the way a real main-frame navigation does. */
  navigate(): void;
  /** A destroyed sender is refused by the owner registry. */
  destroy(): void;
}

export function fakeIpcEvent(id = 1): FakeIpcEvent {
  let destroyed = false;
  const sender = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => destroyed
  });
  const event = { sender, senderFrame: { routingId: id } } as unknown as IpcMainInvokeEvent;
  return {
    event,
    sender,
    navigate: () => {
      sender.emit("did-start-navigation", { isMainFrame: true });
    },
    destroy: () => {
      destroyed = true;
      sender.emit("destroyed");
    }
  };
}
