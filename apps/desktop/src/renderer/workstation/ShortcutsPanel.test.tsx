import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { Modal } from "./ui.js";
import {
  ShortcutsPanel,
  type ShortcutRow,
} from "./ShortcutsPanel.js";

// Walk the element tree to gather text without relying on DOM dialog polyfills.
function extractText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || typeof node !== "object") {
    return "";
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join("");
  }
  if ("props" in node && typeof node.props === "object" && node.props !== null) {
    const props = node.props as { readonly children?: unknown };
    return extractText(props.children);
  }
  return "";
}

// Find elements matching a specific tag or component type across the element tree.
function findByType(node: unknown, targetType: unknown): readonly ReactElement[] {
  if (!node || typeof node !== "object") {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((child) => findByType(child, targetType));
  }
  const results: ReactElement[] = [];
  if ("type" in node && (node as ReactElement).type === targetType) {
    results.push(node as ReactElement);
  }
  if ("props" in node && typeof node.props === "object" && node.props !== null) {
    const props = node.props as { readonly children?: unknown };
    results.push(...findByType(props.children, targetType));
  }
  return results;
}

describe("ShortcutsPanel", () => {
  it("renders a calm sentence when the shortcut list is empty", () => {
    const tree = ShortcutsPanel({ rows: [], onClose: () => {} });
    const content = extractText(tree);
    expect(content).toContain("No keyboard shortcuts are available.");
    expect(findByType(tree, "kbd")).toHaveLength(0);
    expect(findByType(tree, "h3")).toHaveLength(0);
  });

  it("renders key combinations with each key as a separate kbd element", () => {
    const rows: readonly ShortcutRow[] = [
      {
        id: "search",
        keys: "⌘ K",
        label: "Search cases",
        group: "Navigation",
      },
    ];

    const tree = ShortcutsPanel({ rows, onClose: () => {} });
    const kbdElements = findByType(tree, "kbd");

    expect(kbdElements.length).toBe(2);
    expect(extractText(kbdElements[0]!)).toBe("⌘");
    expect(extractText(kbdElements[1]!)).toBe("K");

    const labelElements = findByType(tree, "span").filter((el) => {
      const props = el.props as { readonly className?: string };
      return props.className === "ws-keys-label";
    });
    expect(labelElements.length).toBe(1);
    expect(extractText(labelElements[0]!)).toBe("Search cases");
  });

  it("preserves group order according to first appearance without sorting", () => {
    const rows: readonly ShortcutRow[] = [
      { id: "1", keys: "⌘ B", label: "Sidebar", group: "Workspace" },
      { id: "2", keys: "⌘ N", label: "New case", group: "Cases" },
      { id: "3", keys: "⌘ F", label: "Find", group: "Navigation" },
      { id: "4", keys: "⌘ W", label: "Close", group: "Workspace" },
    ];

    const tree = ShortcutsPanel({ rows, onClose: () => {} });
    const headings = findByType(tree, "h3");
    const headingTexts = headings.map(extractText);

    expect(headingTexts).toEqual(["Workspace", "Cases", "Navigation"]);
  });

  it("groups all rows under their corresponding group headings in original order", () => {
    const rows: readonly ShortcutRow[] = [
      { id: "1", keys: "⌘ 1", label: "First tab", group: "View" },
      { id: "2", keys: "⌘ 2", label: "Second tab", group: "View" },
      { id: "3", keys: "⌘ ,", label: "Preferences", group: "Settings" },
    ];

    const tree = ShortcutsPanel({ rows, onClose: () => {} });
    const listItems = findByType(tree, "li");

    expect(listItems.length).toBe(3);
    const itemTexts = listItems.map(extractText);
    expect(itemTexts[0]!).toContain("First tab");
    expect(itemTexts[1]!).toContain("Second tab");
    expect(itemTexts[2]!).toContain("Preferences");
  });

  it("renders into Modal with correct title, eyebrow, and close handler", () => {
    let closed = false;
    const handleClose = () => {
      closed = true;
    };

    const tree = ShortcutsPanel({ rows: [], onClose: handleClose });

    expect(tree.type).toBe(Modal);
    const modalProps = tree.props as {
      readonly title?: string;
      readonly eyebrow?: string;
      readonly onClose?: () => void;
    };
    expect(modalProps.title).toBe("Keyboard");
    expect(modalProps.eyebrow).toBe("What you can press");
    expect(typeof modalProps.onClose).toBe("function");

    if (modalProps.onClose !== undefined) {
      modalProps.onClose();
    }
    expect(closed).toBe(true);
  });
});
