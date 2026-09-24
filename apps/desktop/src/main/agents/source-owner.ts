import type { WebContents, WebFrameMain } from "electron";

interface Owner { frame: WebFrameMain | null; key: object }
/** A trusted URL alone does not make a reloaded document the same owner. */
export function createAgentSourceOwners(discard: (owner: object) => void) {
  const owners = new WeakMap<WebContents, Owner>();
  return function ownerFor(sender: WebContents, frame: WebFrameMain | null): object {
    if (!frame || sender.isDestroyed()) throw new Error("This source window is no longer available.");
    let owner = owners.get(sender);
    if (!owner) {
      owner = { frame, key: {} };
      owners.set(sender, owner);
      const current = owner;
      const invalidate = () => {
        discard(current.key);
        current.key = {};
        current.frame = null;
      };
      sender.on("did-start-navigation", details => { if (details.isMainFrame) invalidate(); });
      sender.once("destroyed", invalidate);
    }
    if (owner.frame !== frame) {
      discard(owner.key);
      owner.key = {};
      owner.frame = frame;
    }
    return owner.key;
  };
}
