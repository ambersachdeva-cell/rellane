import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  WatchPanel,
  validatePageAddress,
  type Watch,
  type WatchRow,
} from "./WatchPanel.js";

// JSDOM does not natively provide showModal or close on dialog elements.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal =
    HTMLDialogElement.prototype.showModal ??
    function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  HTMLDialogElement.prototype.close =
    HTMLDialogElement.prototype.close ??
    function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
}

const baseWatch: Watch = {
  id: "watch-1",
  target: {
    kind: "page",
    url: "https://supplier.example.com/prices",
    label: "supplier.example.com/prices",
  },
  cadence: "daily",
  tellMeWhen: "numbers-change",
  quietHours: false,
  lastCheckedAt: 1_700_000_000_000,
  lastChangedAt: 1_700_000_000_000,
  paused: false,
};

describe("WatchPanel component", () => {
  it("explains the idea in two sentences with a concrete example when empty", () => {
    render(
      <WatchPanel
        rows={[]}
        now={1_700_000_050_000}
        checking={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onPause={vi.fn()}
        onCheckNow={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(
      screen.getByText(/supplier's price list page every day/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/tell you when something changes/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add your first watch" })
    ).toBeInTheDocument();
  });

  it("keeps Add disabled and shows reason when the address is invalid", () => {
    render(
      <WatchPanel
        rows={[]}
        now={1_700_000_050_000}
        checking={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onPause={vi.fn()}
        onCheckNow={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    const input = screen.getByLabelText("Web page address");
    const addButton = screen.getByRole("button", { name: "Add" });

    expect(addButton).toBeDisabled();
    expect(
      screen.getByText("Enter a web address to watch.")
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "invalid-url" } });
    expect(addButton).toBeDisabled();
    expect(
      screen.getByText(/must include a domain name/i)
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "https://example.com/prices" } });
    expect(addButton).not.toBeDisabled();
    expect(
      screen.queryByRole("alert")
    ).not.toBeInTheDocument();
  });

  it("calls onAdd with the three choices upon submission", () => {
    const handleAdd = vi.fn();

    render(
      <WatchPanel
        rows={[]}
        now={1_700_000_050_000}
        checking={null}
        onAdd={handleAdd}
        onRemove={vi.fn()}
        onPause={vi.fn()}
        onCheckNow={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    const input = screen.getByLabelText("Web page address");
    const cadenceSelect = screen.getByLabelText("How often");
    const conditionSelect = screen.getByLabelText("Tell me when");
    const addButton = screen.getByRole("button", { name: "Add" });

    fireEvent.change(input, { target: { value: "https://example.com/stock" } });
    fireEvent.change(cadenceSelect, { target: { value: "hourly" } });
    fireEvent.change(conditionSelect, { target: { value: "something-new-appears" } });

    fireEvent.click(addButton);

    expect(handleAdd).toHaveBeenCalledTimes(1);
    expect(handleAdd).toHaveBeenCalledWith(
      {
        kind: "page",
        url: "https://example.com/stock",
        label: "example.com/stock",
      },
      "hourly",
      "something-new-appears"
    );
  });

  it("renders a never-fired watch as normal rather than broken", () => {
    const neverFiredRow: WatchRow = {
      watch: {
        ...baseWatch,
        lastCheckedAt: null,
        lastChangedAt: null,
      },
      lastFound: null,
      failing: false,
    };

    render(
      <WatchPanel
        rows={[neverFiredRow]}
        now={1_700_000_050_000}
        checking={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onPause={vi.fn()}
        onCheckNow={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByText("Never checked yet")).toBeInTheDocument();
    expect(screen.getByText("No changes found yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clearly shows failing state and explains what to do", () => {
    const failingRow: WatchRow = {
      watch: baseWatch,
      lastFound: "Could not read page",
      failing: true,
    };

    render(
      <WatchPanel
        rows={[failingRow]}
        now={1_700_000_050_000}
        checking={null}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onPause={vi.fn()}
        onCheckNow={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(
      screen.getByText(/check failed to run/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/select check now to retry/i)
    ).toBeInTheDocument();
  });

  it("handles check now, pause/resume, and remove actions on each row", () => {
    const handleCheckNow = vi.fn();
    const handlePause = vi.fn();
    const handleRemove = vi.fn();

    const row: WatchRow = {
      watch: baseWatch,
      lastFound: "Price reduced by 500 paise",
      failing: false,
    };

    render(
      <WatchPanel
        rows={[row]}
        now={1_700_000_050_000}
        checking={null}
        onAdd={vi.fn()}
        onRemove={handleRemove}
        onPause={handlePause}
        onCheckNow={handleCheckNow}
        onClose={vi.fn()}
        busy={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(handleCheckNow).toHaveBeenCalledWith("watch-1");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(handlePause).toHaveBeenCalledWith("watch-1", true);

    fireEvent.click(screen.getByRole("button", { name: `Remove watch for ${baseWatch.target.label}` }));
    expect(handleRemove).toHaveBeenCalledWith("watch-1");
  });
});
