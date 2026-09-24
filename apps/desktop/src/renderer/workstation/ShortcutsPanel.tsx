import type { ReactElement } from "react";
import { Modal } from "./ui.js";

/** A single keyboard shortcut entry shown in the shortcuts panel. */
export interface ShortcutRow {
  readonly id: string;
  readonly keys: string;
  readonly label: string;
  readonly group: string;
}

/** Properties for the shortcuts dialog panel. */
export interface ShortcutsPanelProps {
  readonly rows: readonly ShortcutRow[];
  readonly onClose: () => void;
}

/** Internal structure representing a group of shortcuts preserving first-seen order. */
interface ShortcutGroup {
  readonly name: string;
  readonly rows: readonly ShortcutRow[];
}

// Preserve caller-defined group sequence by registering groups in order of first appearance.
function groupShortcuts(rows: readonly ShortcutRow[]): readonly ShortcutGroup[] {
  const groupOrder: string[] = [];
  const groupMap = new Map<string, ShortcutRow[]>();

  for (const row of rows) {
    const existing = groupMap.get(row.group);
    if (existing !== undefined) {
      existing.push(row);
    } else {
      groupOrder.push(row.group);
      groupMap.set(row.group, [row]);
    }
  }

  const result: ShortcutGroup[] = [];
  for (const groupName of groupOrder) {
    const items = groupMap.get(groupName);
    if (items !== undefined) {
      result.push({
        name: groupName,
        rows: items,
      });
    }
  }

  return result;
}

// Splitting on whitespace isolates each key symbol so each keycap can be styled as a distinct kbd badge.
function splitKeys(keys: string): readonly string[] {
  const trimmed = keys.trim();
  if (trimmed.length === 0) {
    return [];
  }
  return trimmed.split(/\s+/);
}

/**
 * Compact keyboard shortcuts panel presenting active keybindings grouped by category.
 */
export function ShortcutsPanel({ rows, onClose }: ShortcutsPanelProps): ReactElement {
  return (
    <Modal title="Keyboard" eyebrow="What you can press" onClose={onClose}>
      <div className="ws-keys-panel">
        {rows.length === 0 ? (
          <p className="ws-keys-empty">No keyboard shortcuts are available.</p>
        ) : (
          <div className="ws-keys-groups ws-keys-grid">
            {groupShortcuts(rows).map((group) => (
              <section key={group.name} className="ws-keys-group">
                <h3 className="ws-keys-group-title">{group.name}</h3>
                <ul className="ws-keys-list">
                  {group.rows.map((row) => (
                    <li key={row.id} className="ws-keys-row">
                      <span className="ws-keys-combo">
                        {splitKeys(row.keys).map((key, index) => (
                          <kbd key={`${row.id}-k-${index}`} className="ws-keys-badge">
                            {key}
                          </kbd>
                        ))}
                      </span>
                      <span className="ws-keys-label">{row.label}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
