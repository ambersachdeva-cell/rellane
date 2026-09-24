import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PairingPanel } from "./PairingPanel.js";

// Ensure native dialog lifecycle does not throw inside jsdom environments.
beforeAll(() => {
  if (typeof HTMLDialogElement !== "undefined") {
    HTMLDialogElement.prototype.showModal = HTMLDialogElement.prototype.showModal ?? function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = HTMLDialogElement.prototype.close ?? function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
});

describe("PairingPanel", () => {
  it("renders no PIN anywhere in the document when state is off", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const onCopyPin = vi.fn();
    const onClose = vi.fn();

    const { container } = render(
      <PairingPanel
        status={{ state: "off" }}
        now={1000}
        onStart={onStart}
        onStop={onStop}
        onCopyPin={onCopyPin}
        onClose={onClose}
        busy={false}
      />
    );

    expect(container.textContent).not.toMatch(/\b\d{6}\b/);
    expect(screen.queryByLabelText(/copy pin/i)).toBeNull();
    expect(screen.getByText("Off")).toBeDefined();

    const startButton = screen.getByRole("button", { name: "Turn on" });
    fireEvent.click(startButton);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("renders the exact url and pin passed in when listening", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const onCopyPin = vi.fn();
    const onClose = vi.fn();

    const url = "http://192.168.1.55:8765";
    const pin = "654321";

    render(
      <PairingPanel
        status={{
          state: "listening",
          url,
          pin,
          expiresAt: 1000 + 4 * 60 * 1000,
          onThisMacOnly: true,
        }}
        now={1000}
        onStart={onStart}
        onStop={onStop}
        onCopyPin={onCopyPin}
        onClose={onClose}
        busy={false}
      />
    );

    expect(screen.getByText(url)).toBeDefined();
    expect(screen.getByText("654 321")).toBeDefined();
    expect(screen.getByText("expires in 4 minutes")).toBeDefined();
    expect(screen.getByText("Ready")).toBeDefined();

    const copyButton = screen.getByRole("button", { name: "Copy PIN" });
    fireEvent.click(copyButton);
    expect(onCopyPin).toHaveBeenCalledTimes(1);

    const stopButton = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("renders as expired and not as a usable PIN when expiresAt is in the past", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const onCopyPin = vi.fn();
    const onClose = vi.fn();

    const { container } = render(
      <PairingPanel
        status={{
          state: "listening",
          url: "http://127.0.0.1:4000",
          pin: "765432",
          expiresAt: 1000,
          onThisMacOnly: true,
        }}
        now={2000}
        onStart={onStart}
        onStop={onStop}
        onCopyPin={onCopyPin}
        onClose={onClose}
        busy={false}
      />
    );

    expect(screen.getAllByText(/expired/i).length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("765 432");
    expect(container.textContent).not.toContain("765432");
    expect(screen.queryByRole("button", { name: /copy pin/i })).toBeNull();

    const startAgainButton = screen.getByRole("button", { name: "Start again" });
    fireEvent.click(startAgainButton);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("shows Wi-Fi warning only when onThisMacOnly is false", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const onCopyPin = vi.fn();
    const onClose = vi.fn();

    const wifiSentence =
      "Any device on your Wi-Fi can reach it, so stop it when you are done.";
    const macSentence = "Only this Mac can reach it.";

    const { rerender } = render(
      <PairingPanel
        status={{
          state: "listening",
          url: "http://192.168.1.15:4000",
          pin: "123456",
          expiresAt: 50000,
          onThisMacOnly: false,
        }}
        now={1000}
        onStart={onStart}
        onStop={onStop}
        onCopyPin={onCopyPin}
        onClose={onClose}
        busy={false}
      />
    );

    expect(screen.getByText(wifiSentence)).toBeDefined();
    expect(screen.queryByText(macSentence)).toBeNull();

    rerender(
      <PairingPanel
        status={{
          state: "listening",
          url: "http://127.0.0.1:4000",
          pin: "123456",
          expiresAt: 50000,
          onThisMacOnly: true,
        }}
        now={1000}
        onStart={onStart}
        onStop={onStop}
        onCopyPin={onCopyPin}
        onClose={onClose}
        busy={false}
      />
    );

    expect(screen.queryByText(wifiSentence)).toBeNull();
    expect(screen.getByText(macSentence)).toBeDefined();
  });

  it("renders failed state with reason and offers to try again", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const onCopyPin = vi.fn();
    const onClose = vi.fn();

    const reason = "Address is already in use by another application.";

    render(
      <PairingPanel
        status={{
          state: "failed",
          reason,
        }}
        now={1000}
        onStart={onStart}
        onStop={onStop}
        onCopyPin={onCopyPin}
        onClose={onClose}
        busy={false}
      />
    );

    expect(screen.getByText(reason)).toBeDefined();
    expect(screen.getByText("Failed")).toBeDefined();

    const tryAgainButton = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(tryAgainButton);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("disables actionable controls when busy is true", () => {
    render(
      <PairingPanel
        status={{
          state: "listening",
          url: "http://127.0.0.1:4000",
          pin: "888999",
          expiresAt: 50000,
          onThisMacOnly: true,
        }}
        now={1000}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCopyPin={vi.fn()}
        onClose={vi.fn()}
        busy={true}
      />
    );

    const copyButton = screen.getByRole("button", { name: "Copy PIN" });
    expect(copyButton.hasAttribute("disabled")).toBe(true);

    const stopButton = screen.getByRole("button", { name: "Stop" });
    expect(stopButton.hasAttribute("disabled")).toBe(true);
  });
});
