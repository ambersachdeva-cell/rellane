import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChartView } from "./ChartView.js";

async function renderComponent(element: React.ReactElement): Promise<{
  readonly container: HTMLDivElement;
  readonly unmount: () => void;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("ChartView", () => {
  it("renders a bar per month with an accessible label", async () => {
    const { container, unmount } = await renderComponent(
      <ChartView
        columns={[
          { name: "Month", type: "text" },
          { name: "Sales", type: "number" },
        ]}
        rows={[
          ["Jan", "120"],
          ["Feb", "240"],
          ["March", "380"],
        ]}
        title="Quarterly Sales"
        onCopySummary={() => {}}
      />
    );

    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Sales by month, highest in March.");

    const bars = container.querySelectorAll(".ws-chart-bar");
    expect(bars.length).toBe(3);

    const summaryText = container.querySelector(".ws-chart-summary-text");
    expect(summaryText?.textContent).toBe("Sales by month, highest in March.");

    const table = container.querySelector(".ws-chart-table");
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain("March");
    expect(table?.textContent).toContain("380");

    unmount();
  });

  it("renders the plain nothing to chart message on empty rows", async () => {
    const { container, unmount } = await renderComponent(
      <ChartView
        columns={[
          { name: "Month", type: "text" },
          { name: "Sales", type: "number" },
        ]}
        rows={[]}
        title="Empty Sales"
        onCopySummary={() => {}}
      />
    );

    expect(container.querySelector("svg")).toBeNull();
    const emptyMsg = container.querySelector(".ws-chart-empty-message");
    expect(emptyMsg?.textContent).toBe("Nothing to chart.");

    unmount();
  });

  it("renders advice to choose a numeric column when data has no numbers", async () => {
    const { container, unmount } = await renderComponent(
      <ChartView
        columns={[
          { name: "Region", type: "text" },
          { name: "Status", type: "text" },
        ]}
        rows={[
          ["North", "Active"],
          ["South", "Pending"],
        ]}
        title="Status by Region"
        onCopySummary={() => {}}
      />
    );

    expect(container.querySelector("svg")).toBeNull();
    const emptyMsg = container.querySelector(".ws-chart-empty-message");
    expect(emptyMsg?.textContent).toBe("Choose a column of numbers to chart.");

    unmount();
  });

  it("renders untrusted html text as safe string without creating elements", async () => {
    const maliciousPayload = "<img src=x onerror=alert(1)>";
    const { container, unmount } = await renderComponent(
      <ChartView
        columns={[
          { name: "Category", type: "text" },
          { name: "Sales", type: "number" },
        ]}
        rows={[[maliciousPayload, "250"]]}
        title="Escaping Test"
        onCopySummary={() => {}}
      />
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(maliciousPayload);

    unmount();
  });

  it("handles currency symbols, thousand separators and negative baselines", async () => {
    const { container, unmount } = await renderComponent(
      <ChartView
        columns={[
          { name: "Quarter", type: "text" },
          { name: "Profit", type: "currency" },
        ]}
        rows={[
          ["Q1", "-£1,500.00"],
          ["Q2", "£2,500.00"],
          ["Q3", "£5,000.00"],
        ]}
        title="Profitability"
        onCopySummary={() => {}}
      />
    );

    const bars = container.querySelectorAll(".ws-chart-bar");
    expect(bars.length).toBe(3);

    const baseline = container.querySelector(".ws-chart-baseline");
    expect(baseline).not.toBeNull();

    const summaryText = container.querySelector(".ws-chart-summary-text");
    expect(summaryText?.textContent).toBe("Profit by quarter, highest in Q3.");

    unmount();
  });

  it("samples down large datasets and mentions the sample in the summary", async () => {
    const largeRows: (readonly string[])[] = [];
    for (let i = 0; i < 50000; i++) {
      largeRows.push([`Entry ${i}`, String((i % 500) + 1)]);
    }

    const { container, unmount } = await renderComponent(
      <ChartView
        columns={[
          { name: "Entry", type: "text" },
          { name: "Score", type: "number" },
        ]}
        rows={largeRows}
        title="Scale Test"
        onCopySummary={() => {}}
      />
    );

    const bars = container.querySelectorAll(".ws-chart-bar");
    expect(bars.length).toBe(60);

    const summary = container.querySelector(".ws-chart-summary-text");
    expect(summary?.textContent).toContain("sampled 60 of 50,000 rows");

    unmount();
  });

  it("calls onCopySummary with the derived summary sentence when clicked", async () => {
    const onCopy = vi.fn();
    const { container, unmount } = await renderComponent(
      <ChartView
        columns={[
          { name: "Month", type: "text" },
          { name: "Sales", type: "number" },
        ]}
        rows={[
          ["March", "500"],
        ]}
        title="March Performance"
        onCopySummary={onCopy}
      />
    );

    const button = container.querySelector(".ws-chart-copy-button") as HTMLButtonElement | null;
    expect(button).not.toBeNull();

    await act(async () => {
      button?.click();
    });

    expect(onCopy).toHaveBeenCalledWith("Sales by month, 500 in March.");
    expect(button?.textContent).toBe("Copied");

    unmount();
  });
});
