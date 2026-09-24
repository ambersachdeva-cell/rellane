import { describe, expect, it } from "vitest";
import { SHORTCUTS, renderKeys, shortcutFor } from "./keyboard-map.js";

describe("keyboard-map", () => {
  it("ensures no two shortcuts collide", () => {
    const seen = new Set<string>();
    for (const shortcut of SHORTCUTS) {
      const fingerprint = shortcut.keys.map((k) => k.toLowerCase()).join("+");
      expect(seen.has(fingerprint)).toBe(false);
      seen.add(fingerprint);
    }
    expect(SHORTCUTS.length).toBe(13);
  });

  it("resolves ⌘K to find and renders as ⌘ K", () => {
    const match = shortcutFor(
      {
        key: "k",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
      false,
    );
    expect(match).toBe("find");

    const findShortcut = SHORTCUTS.find((s) => s.id === "find");
    expect(findShortcut).toBeDefined();
    if (findShortcut) {
      expect(renderKeys(findShortcut)).toBe("⌘ K");
    }
  });

  it("differentiates exact modifiers such that ⌘⇧K does not trigger find", () => {
    const match = shortcutFor(
      {
        key: "k",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      },
      false,
    );
    expect(match).toBeNull();
  });

  it("matches letters case-insensitively when Shift is held", () => {
    const capitalK = shortcutFor(
      {
        key: "K",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
      false,
    );
    expect(capitalK).toBe("find");

    const newlineMatch = shortcutFor(
      {
        key: "Enter",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      },
      true,
    );
    expect(newlineMatch).toBe("newline");
  });

  it("suppresses navigation shortcuts like plain s while typing", () => {
    const typingMatch = shortcutFor(
      {
        key: "s",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
      true,
    );
    expect(typingMatch).toBeNull();

    const idleMatch = shortcutFor(
      {
        key: "s",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
      false,
    );
    expect(idleMatch).toBe("sessions");
  });

  it("allows send, newline, and stop to fire while typing", () => {
    const sendMatch = shortcutFor(
      {
        key: "Enter",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
      true,
    );
    expect(sendMatch).toBe("send");

    const newlineMatch = shortcutFor(
      {
        key: "Enter",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      },
      true,
    );
    expect(newlineMatch).toBe("newline");

    const stopMatch = shortcutFor(
      {
        key: ".",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
      true,
    );
    expect(stopMatch).toBe("stop");
  });

  it("handles messy cases safely without throwing", () => {
    const loneMeta = shortcutFor(
      {
        key: "Meta",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
      false,
    );
    expect(loneMeta).toBeNull();

    const unknownKey = shortcutFor(
      {
        key: "F24",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
      false,
    );
    expect(unknownKey).toBeNull();

    const escIdle = shortcutFor(
      {
        key: "Escape",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
      false,
    );
    expect(escIdle).toBe("close");

    const escTyping = shortcutFor(
      {
        key: "Escape",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
      true,
    );
    expect(escTyping).toBeNull();
  });

  it("renders key combinations with Mac symbols", () => {
    const stopShortcut = SHORTCUTS.find((s) => s.id === "stop");
    expect(stopShortcut).toBeDefined();
    if (stopShortcut) {
      expect(renderKeys(stopShortcut)).toBe("⌘ .");
    }

    const newlineShortcut = SHORTCUTS.find((s) => s.id === "newline");
    expect(newlineShortcut).toBeDefined();
    if (newlineShortcut) {
      expect(renderKeys(newlineShortcut)).toBe("⇧ Enter");
    }
  });
});
