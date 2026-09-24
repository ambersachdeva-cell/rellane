import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConnectorsPanel, type ConnectorView } from "./ConnectorsPanel.js";

// jsdom lacks native HTMLDialogElement modal implementations
beforeAll(() => {
  if (typeof HTMLDialogElement !== "undefined") {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
  }
});

describe("ConnectorsPanel", () => {
  it("renders untrusted connector name as plain text without creating DOM elements", () => {
    const xssPayload = "<img src=x onerror=alert(1)>";
    const connector: ConnectorView = {
      id: "conn-xss",
      name: xssPayload,
      summary: "Claims to parse files",
      state: "ready",
      detail: "Responding on local socket",
      toolCount: 1,
      lastReachedAt: 1000,
      licence: "MIT",
      local: true,
    };

    const { container } = render(
      <ConnectorsPanel
        connectors={[connector]}
        now={2000}
        busy={false}
        problem={null}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onRecheck={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(xssPayload)).toBeDefined();
    expect(container.querySelectorAll("img").length).toBe(0);
  });

  it("renders 'never reached' and not '0' when toolCount is null", () => {
    const connector: ConnectorView = {
      id: "conn-null-tools",
      name: "Remote Search",
      summary: "Finds items online",
      state: "unreachable",
      detail: "Connection refused on port 8080",
      toolCount: null,
      lastReachedAt: null,
      licence: null,
      local: false,
    };

    render(
      <ConnectorsPanel
        connectors={[connector]}
        now={10000}
        busy={false}
        problem={null}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onRecheck={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("never reached")).toBeDefined();
    expect(screen.queryByText(/0 tools/i)).toBeNull();
  });

  it("offers no enable action for a blocked connector and shows the observed detail", () => {
    const onEnable = vi.fn();
    const connector: ConnectorView = {
      id: "conn-blocked",
      name: "Suspicious Extension",
      summary: "Requests full disk access",
      state: "blocked",
      detail: "Blocked by integrity check: binary signature mismatch",
      toolCount: null,
      lastReachedAt: null,
      licence: null,
      local: false,
    };

    render(
      <ConnectorsPanel
        connectors={[connector]}
        now={10000}
        busy={false}
        problem={null}
        onEnable={onEnable}
        onDisable={vi.fn()}
        onRecheck={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Blocked by integrity check: binary signature mismatch")).toBeDefined();
    expect(screen.queryByRole("button", { name: /enable/i })).toBeNull();
    expect(onEnable).not.toHaveBeenCalled();
  });

  it("explains what a connector is when the list is empty", () => {
    render(
      <ConnectorsPanel
        connectors={[]}
        now={10000}
        busy={false}
        problem={null}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onRecheck={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByText("Connectors are outside tools this app can use to assist with your work.")
    ).toBeDefined();
    expect(screen.getByText("None are set up on this Mac yet.")).toBeDefined();
  });

  it("states whether each connector runs on this Mac or reaches out, and triggers actions", () => {
    const onDisable = vi.fn();
    const onRecheck = vi.fn();
    const localConnector: ConnectorView = {
      id: "conn-local",
      name: "Local Embeddings",
      summary: "Local vector generation",
      state: "ready",
      detail: "Process running with PID 4120",
      toolCount: 2,
      lastReachedAt: 9000,
      licence: "Apache-2.0",
      local: true,
    };

    const remoteConnector: ConnectorView = {
      id: "conn-remote",
      name: "Cloud Translator",
      summary: "Translates text",
      state: "off",
      detail: "Disabled by user",
      toolCount: 1,
      lastReachedAt: 5000,
      licence: "BSD-3-Clause",
      local: false,
    };

    const { rerender } = render(
      <ConnectorsPanel
        connectors={[localConnector]}
        now={10000}
        busy={false}
        problem={null}
        onEnable={vi.fn()}
        onDisable={onDisable}
        onRecheck={onRecheck}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Runs on this Mac")).toBeDefined();
    expect(screen.getByText("2 tools")).toBeDefined();

    const disableButton = screen.getByRole("button", { name: /disable/i });
    fireEvent.click(disableButton);
    expect(onDisable).toHaveBeenCalledWith("conn-local");

    const recheckButton = screen.getByRole("button", { name: /check now/i });
    fireEvent.click(recheckButton);
    expect(onRecheck).toHaveBeenCalledWith("conn-local");

    rerender(
      <ConnectorsPanel
        connectors={[remoteConnector]}
        now={10000}
        busy={false}
        problem={null}
        onEnable={vi.fn()}
        onDisable={onDisable}
        onRecheck={onRecheck}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Reaches out")).toBeDefined();
  });

  it("displays problem inline alert when problem prop is provided", () => {
    render(
      <ConnectorsPanel
        connectors={[]}
        now={10000}
        busy={false}
        problem="Connector daemon failed to start"
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onRecheck={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText("Connector daemon failed to start")).toBeDefined();
  });
});
