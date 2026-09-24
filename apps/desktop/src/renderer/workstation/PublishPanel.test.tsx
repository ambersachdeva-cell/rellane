import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PublishPanel, formatBytes, type PublishPreview } from "./PublishPanel.js";

// Native dialogs in headless test environments require showModal and close stubs.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
});

describe("PublishPanel", () => {
  it("explains there is nothing saved yet when outputTitle is null and offers no format", () => {
    render(
      <PublishPanel
        outputTitle={null}
        outputWords={0}
        preview={null}
        onPreview={vi.fn()}
        onWrite={vi.fn()}
        onReveal={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByText("Nothing to publish yet")).toBeDefined();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "See what will be written" })).toBeNull();
  });

  it("does not show the write button when preview is null", () => {
    render(
      <PublishPanel
        outputTitle="Quarterly overview"
        outputWords={420}
        preview={null}
        onPreview={vi.fn()}
        onWrite={vi.fn()}
        onReveal={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(screen.queryByRole("button", { name: "Write these files" })).toBeNull();
    expect(screen.getByRole("button", { name: "See what will be written" })).toBeDefined();
  });

  it("shows files, warnings, and calls onWrite with the chosen format after preview arrives", () => {
    const onWrite = vi.fn();
    const preview: PublishPreview = {
      summary: "Two files will be written to your case folder.",
      warnings: ["Existing file will be overwritten"],
      files: [
        { relativePath: "report.html", bytes: 1250 },
        { relativePath: "report.css", bytes: 340 },
      ],
    };

    const { rerender } = render(
      <PublishPanel
        outputTitle="Quarterly overview"
        outputWords={420}
        preview={null}
        onPreview={vi.fn()}
        onWrite={onWrite}
        onReveal={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    // Format selection changes the target format before requesting preview.
    fireEvent.click(screen.getByRole("radio", { name: /a markdown file/i }));

    rerender(
      <PublishPanel
        outputTitle="Quarterly overview"
        outputWords={420}
        preview={preview}
        onPreview={vi.fn()}
        onWrite={onWrite}
        onReveal={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByText("report.html")).toBeDefined();
    expect(screen.getByText("report.css")).toBeDefined();
    expect(screen.getByText("Existing file will be overwritten")).toBeDefined();

    const writeButton = screen.getByRole("button", { name: "Write these files" });
    fireEvent.click(writeButton);

    expect(onWrite).toHaveBeenCalledWith("markdown");
  });

  it("shows destination folder and reveals it after writing", () => {
    const onReveal = vi.fn();
    const preview: PublishPreview = {
      summary: "Files written successfully.",
      warnings: [],
      files: [{ relativePath: "presentation.html", bytes: 4096 }],
      writtenTo: "/Users/amber/Documents/Cases/Output",
    };

    render(
      <PublishPanel
        outputTitle="Slide presentation"
        outputWords={210}
        preview={preview}
        onPreview={vi.fn()}
        onWrite={vi.fn()}
        onReveal={onReveal}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByText("/Users/amber/Documents/Cases/Output")).toBeDefined();
    const revealButton = screen.getByRole("button", { name: "Show me" });
    fireEvent.click(revealButton);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Back is clicked in preview", () => {
    const onClose = vi.fn();
    const preview: PublishPreview = {
      summary: "Two files will be written.",
      warnings: [],
      files: [{ relativePath: "index.html", bytes: 1024 }],
    };

    render(
      <PublishPanel
        outputTitle="Quarterly overview"
        outputWords={420}
        preview={preview}
        onPreview={vi.fn()}
        onWrite={vi.fn()}
        onReveal={vi.fn()}
        onClose={onClose}
        busy={false}
      />
    );

    const backButton = screen.getByRole("button", { name: "Back" });
    fireEvent.click(backButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables action buttons when busy is true", () => {
    render(
      <PublishPanel
        outputTitle="Quarterly overview"
        outputWords={420}
        preview={null}
        onPreview={vi.fn()}
        onWrite={vi.fn()}
        onReveal={vi.fn()}
        onClose={vi.fn()}
        busy={true}
      />
    );

    const button = screen.getByRole("button", { name: "See what will be written" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("formats byte counts into human units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(340)).toBe("340 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1048576)).toBe("1 MB");
  });
});
