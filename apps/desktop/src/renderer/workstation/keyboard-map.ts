export type ShortcutId =
  | "find"
  | "new-work"
  | "send"
  | "newline"
  | "stop"
  | "agents"
  | "sessions"
  | "ask-several"
  | "files"
  | "usage"
  | "diagnostics"
  | "close"
  | "shortcuts";

export interface Shortcut {
  readonly id: ShortcutId;
  readonly keys: readonly string[]; // e.g. ["Meta", "k"] — modifiers first, in this order: Meta, Control, Alt, Shift
  readonly label: string; // what it does, 2 to 5 words, his language
  readonly group: "getting around" | "writing" | "running things";
  /** False when it should not fire while he is typing in a text box. */
  readonly whileTyping: boolean;
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "find",
    keys: ["Meta", "k"],
    label: "Find in case",
    group: "getting around",
    whileTyping: false,
  },
  {
    id: "new-work",
    keys: ["n"],
    label: "Start new work",
    group: "getting around",
    whileTyping: false,
  },
  {
    id: "send",
    keys: ["Enter"],
    label: "Send message",
    group: "writing",
    whileTyping: true,
  },
  {
    id: "newline",
    keys: ["Shift", "Enter"],
    label: "New line",
    group: "writing",
    whileTyping: true,
  },
  {
    id: "stop",
    keys: ["Meta", "."],
    label: "Stop current run",
    group: "running things",
    whileTyping: true,
  },
  {
    id: "agents",
    keys: ["a"],
    label: "Open agents",
    group: "getting around",
    whileTyping: false,
  },
  {
    id: "sessions",
    keys: ["s"],
    label: "Open sessions",
    group: "getting around",
    whileTyping: false,
  },
  {
    id: "ask-several",
    keys: ["m"],
    label: "Ask several models",
    group: "running things",
    whileTyping: false,
  },
  {
    id: "files",
    keys: ["f"],
    label: "Open files",
    group: "getting around",
    whileTyping: false,
  },
  {
    id: "usage",
    keys: ["u"],
    label: "Open usage",
    group: "getting around",
    whileTyping: false,
  },
  {
    id: "diagnostics",
    keys: ["d"],
    label: "Open diagnostics",
    group: "getting around",
    whileTyping: false,
  },
  {
    id: "close",
    keys: ["Escape"],
    label: "Close panel",
    group: "getting around",
    whileTyping: false,
  },
  {
    id: "shortcuts",
    keys: ["?"],
    label: "Show keyboard shortcuts",
    group: "getting around",
    whileTyping: false,
  },
];

const MODIFIER_NAMES = new Set(["Meta", "Control", "Alt", "Shift", "OS"]);

export function shortcutFor(
  event: {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
  },
  typing: boolean,
): ShortcutId | null {
  // A solo modifier key press never triggers a shortcut on its own.
  if (MODIFIER_NAMES.has(event.key)) {
    return null;
  }

  for (const shortcut of SHORTCUTS) {
    const hasMeta = shortcut.keys.includes("Meta");
    const hasCtrl = shortcut.keys.includes("Control");
    const hasAlt = shortcut.keys.includes("Alt");
    const hasShift = shortcut.keys.includes("Shift");

    // Exact modifier matching ensures combinations like ⌘K and ⌘⇧K do not collide.
    if (
      event.metaKey !== hasMeta ||
      event.ctrlKey !== hasCtrl ||
      event.altKey !== hasAlt
    ) {
      continue;
    }

    // Question mark on physical keyboards is typed with Shift, so accept it whether Shift is explicitly recorded or not.
    const shiftMatches =
      event.shiftKey === hasShift ||
      (event.key === "?" && shortcut.keys.includes("?") && !hasShift);

    if (!shiftMatches) {
      continue;
    }

    // Isolate the trigger key from the modifiers in the shortcut definition.
    const triggerKey = shortcut.keys.find((k) => !MODIFIER_NAMES.has(k));
    if (!triggerKey) {
      continue;
    }

    // Case-insensitive letter matching handles Shift producing capital letters without false mismatches.
    if (event.key.toLowerCase() !== triggerKey.toLowerCase()) {
      continue;
    }

    // Block shortcuts during text entry unless specifically designed for typing.
    if (typing && !shortcut.whileTyping) {
      return null;
    }

    return shortcut.id;
  }

  return null;
}

/** "⌘ K" — for showing on screen. Mac symbols, because this app is Mac only. */
export function renderKeys(shortcut: Shortcut): string {
  const parts: string[] = [];
  for (const key of shortcut.keys) {
    if (key === "Meta") {
      parts.push("⌘");
    } else if (key === "Control") {
      parts.push("⌃");
    } else if (key === "Alt") {
      parts.push("⌥");
    } else if (key === "Shift") {
      parts.push("⇧");
    } else if (key.length === 1) {
      parts.push(key.toUpperCase());
    } else {
      parts.push(key);
    }
  }
  return parts.join(" ");
}
