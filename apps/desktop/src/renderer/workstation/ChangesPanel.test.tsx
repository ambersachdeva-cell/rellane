import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ChangesPanel,
  formatLeadCount,
  computeSideBySideDiff,
  type FileChangeRow,
  type ChangesPanelProps,
} from "./ChangesPanel.js";

// Ensure dialog methods exist in jsdom
if (typeof HTMLDialogElement !== "undefined") {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  }
}

function makeProps(overrides: Partial<ChangesPanelProps> = {}): ChangesPanelProps {
  return {
    changes: [],
    folderKnown: true,
    beforeKnown: true,
    diff: null,
    now: 1_700_000_000_000,
    busy: false,
    restoring: null,
    onOpenDiff: vi.fn(),
    onRestore: vi.fn(),
    onReveal: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe("ChangesPanel", () => {
  it("shows distinct state when beforeKnown is false rather than an empty list", () => {
    const { unmount } = render(
      <ChangesPanel {...makeProps({ beforeKnown: false, changes: [] })} />,
    );

    expect(
      screen.getByText(
        "This session ran before the app started keeping snapshots, so what changed cannot be shown.",
      ),
    ).toBeDefined();
    expect(
      screen.queryByText("Nothing was changed on your Mac during this session."),
    ).toBeNull();

    unmount();

    render(
      <ChangesPanel {...makeProps({ beforeKnown: true, changes: [] })} />,
    );

    expect(
      screen.getByText("Nothing was changed on your Mac during this session."),
    ).toBeDefined();
    expect(
      screen.queryByText(
        "This session ran before the app started keeping snapshots, so what changed cannot be shown.",
      ),
    ).toBeNull();
  });

  it("shows an informative notice when folderKnown is false", () => {
    render(<ChangesPanel {...makeProps({ folderKnown: false })} />);

    expect(
      screen.getByText(
        "This piece of work has no folder, so nothing could have been changed.",
      ),
    ).toBeDefined();
  });

  it("displays whyNot explanation for rows that cannot be restored rather than a disabled button", () => {
    const lockedChange: FileChangeRow = {
      relativePath: "package-lock.json",
      kind: "changed",
      bytes: 2048,
      modifiedAt: 1_700_000_000_000,
      canRestore: false,
      whyNot: "File is managed by another process.",
    };

    render(<ChangesPanel {...makeProps({ changes: [lockedChange] })} />);

    expect(
      screen.getByText("File is managed by another process."),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Put it back" })).toBeNull();
  });

  it("requests inline confirmation naming the file before calling onRestore", () => {
    const onRestore = vi.fn();
    const restorableChange: FileChangeRow = {
      relativePath: "src/main.ts",
      kind: "changed",
      bytes: 512,
      modifiedAt: 1_700_000_000_000,
      canRestore: true,
      whyNot: null,
    };

    render(
      <ChangesPanel
        {...makeProps({
          changes: [restorableChange],
          onRestore,
        })}
      />,
    );

    const initialButton = screen.getByRole("button", { name: "Put it back" });
    fireEvent.click(initialButton);

    expect(onRestore).not.toHaveBeenCalled();
    expect(screen.getByText("Put back src/main.ts?")).toBeDefined();

    const confirmButton = screen.getByRole("button", { name: "Put it back" });
    fireEvent.click(confirmButton);

    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledWith("src/main.ts");
  });

  it("cancels inline confirmation without calling onRestore", () => {
    const onRestore = vi.fn();
    const restorableChange: FileChangeRow = {
      relativePath: "src/main.ts",
      kind: "changed",
      bytes: 512,
      modifiedAt: 1_700_000_000_000,
      canRestore: true,
      whyNot: null,
    };

    render(
      <ChangesPanel
        {...makeProps({
          changes: [restorableChange],
          onRestore,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Put it back" }));
    expect(screen.getByText("Put back src/main.ts?")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRestore).not.toHaveBeenCalled();
    expect(screen.queryByText("Put back src/main.ts?")).toBeNull();
  });

  it("displays the file being restored and banner when restoring prop is provided", () => {
    const restoringChange: FileChangeRow = {
      relativePath: "notes.txt",
      kind: "added",
      bytes: 128,
      modifiedAt: 1_700_000_000_000,
      canRestore: true,
      whyNot: null,
    };

    render(
      <ChangesPanel
        {...makeProps({
          changes: [restoringChange],
          restoring: "notes.txt",
          busy: true,
        })}
      />,
    );

    expect(screen.getByText("Restoring notes.txt...")).toBeDefined();
  });

  it("calls onOpenDiff when selecting a file row", () => {
    const onOpenDiff = vi.fn();
    const change: FileChangeRow = {
      relativePath: "docs/readme.md",
      kind: "added",
      bytes: 300,
      modifiedAt: 1_700_000_000_000,
      canRestore: true,
      whyNot: null,
    };

    render(
      <ChangesPanel
        {...makeProps({
          changes: [change],
          onOpenDiff,
        })}
      />,
    );

    fireEvent.click(screen.getByText("docs/readme.md"));
    expect(onOpenDiff).toHaveBeenCalledWith("docs/readme.md");
  });

  it("calls onReveal when reveal button is clicked", () => {
    const onReveal = vi.fn();
    const change: FileChangeRow = {
      relativePath: "docs/readme.md",
      kind: "added",
      bytes: 300,
      modifiedAt: 1_700_000_000_000,
      canRestore: true,
      whyNot: null,
    };

    render(
      <ChangesPanel
        {...makeProps({
          changes: [change],
          onReveal,
        })}
      />,
    );

    fireEvent.click(screen.getByLabelText("Show docs/readme.md in Finder"));
    expect(onReveal).toHaveBeenCalledWith("docs/readme.md");
  });

  it("marks changed lines in the side-by-side diff", () => {
    const diff = {
      relativePath: "config.json",
      before: "port: 3000\nhost: localhost",
      after: "port: 8080\nhost: localhost",
    };

    render(
      <ChangesPanel
        {...makeProps({
          changes: [
            {
              relativePath: "config.json",
              kind: "changed",
              bytes: 100,
              modifiedAt: 1_700_000_000_000,
              canRestore: true,
              whyNot: null,
            },
          ],
          diff,
        })}
      />,
    );

    expect(screen.getByText("port: 3000")).toBeDefined();
    expect(screen.getByText("port: 8080")).toBeDefined();
    expect(screen.getAllByText("host: localhost").length).toBeGreaterThanOrEqual(1);
  });
});

describe("formatLeadCount", () => {
  it("formats counts according to house phrasing and capitalization", () => {
    const c1: FileChangeRow = {
      relativePath: "a.ts",
      kind: "changed",
      bytes: 1,
      modifiedAt: 1,
      canRestore: true,
      whyNot: null,
    };
    const c2: FileChangeRow = {
      relativePath: "b.ts",
      kind: "changed",
      bytes: 1,
      modifiedAt: 1,
      canRestore: true,
      whyNot: null,
    };
    const c3: FileChangeRow = {
      relativePath: "c.ts",
      kind: "changed",
      bytes: 1,
      modifiedAt: 1,
      canRestore: true,
      whyNot: null,
    };
    const a1: FileChangeRow = {
      relativePath: "d.ts",
      kind: "added",
      bytes: 1,
      modifiedAt: 1,
      canRestore: true,
      whyNot: null,
    };
    const r1: FileChangeRow = {
      relativePath: "e.ts",
      kind: "removed",
      bytes: 1,
      modifiedAt: 1,
      canRestore: true,
      whyNot: null,
    };

    expect(formatLeadCount([c1, c2, c3, a1])).toBe("Three files changed, one added.");
    expect(formatLeadCount([a1])).toBe("One file added.");
    expect(formatLeadCount([r1])).toBe("One file removed.");
    expect(formatLeadCount([c1, r1])).toBe("One file changed, one removed.");
    expect(formatLeadCount([])).toBe("No files changed.");
  });
});

describe("computeSideBySideDiff", () => {
  it("produces line-by-line diff with correct status markers", () => {
    const rows = computeSideBySideDiff("alpha\nbeta\ngamma", "alpha\nbeta-modified\ngamma");
    expect(rows.length).toBe(3);
    expect(rows[0]?.kind).toBe("unchanged");
    expect(rows[1]?.kind).toBe("changed");
    expect(rows[1]?.before?.text).toBe("beta");
    expect(rows[1]?.after?.text).toBe("beta-modified");
    expect(rows[2]?.kind).toBe("unchanged");
  });

  it("handles empty files gracefully", () => {
    expect(computeSideBySideDiff("", "")).toEqual([]);

    const addedRows = computeSideBySideDiff("", "new line");
    expect(addedRows.length).toBe(1);
    expect(addedRows[0]?.kind).toBe("added");
    expect(addedRows[0]?.after?.text).toBe("new line");

    const removedRows = computeSideBySideDiff("old line", "");
    expect(removedRows.length).toBe(1);
    expect(removedRows[0]?.kind).toBe("removed");
    expect(removedRows[0]?.before?.text).toBe("old line");
  });
});
