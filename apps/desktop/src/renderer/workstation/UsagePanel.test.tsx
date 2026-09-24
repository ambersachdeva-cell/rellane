import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UsagePanel, type UsageView } from "./UsagePanel.js";

const sampleView: UsageView = {
  window: "month",
  headline: "You have asked Codex 14 times this month.",
  totalAsked: 20,
  quietest: "Gemini (Profile 3)",
  note: "Usage reflects requests recorded on this Mac. Quota limits and reset times are managed directly by each provider.",
  subscriptions: [
    {
      providerId: "codex",
      label: "Codex",
      asked: 14,
      finished: 12,
      stopped: 1,
      failed: 1,
      totalMs: 45000,
      longest: "18 sec",
      lastUsed: "2 hours ago",
      busiestDay: "Tuesday",
      models: [
        { id: "code-davinci-002", asked: 10 },
        { id: "gpt-4o", asked: 4 },
      ],
    },
    {
      providerId: "claude",
      label: "Claude",
      asked: 6,
      finished: 6,
      stopped: 0,
      failed: 0,
      totalMs: 22000,
      longest: "8 sec",
      lastUsed: "Yesterday",
      busiestDay: "Monday",
      models: [{ id: "claude-3-7-sonnet", asked: 6 }],
    },
    {
      providerId: "gemini-1",
      label: "Gemini (Profile 1)",
      asked: 0,
      finished: 0,
      stopped: 0,
      failed: 0,
      totalMs: 0,
      longest: "none",
      lastUsed: "never",
      busiestDay: null,
      models: [],
    },
    {
      providerId: "gemini-2",
      label: "Gemini (Profile 2)",
      asked: 0,
      finished: 0,
      stopped: 0,
      failed: 0,
      totalMs: 0,
      longest: "none",
      lastUsed: "never",
      busiestDay: null,
      models: [],
    },
    {
      providerId: "gemini-3",
      label: "Gemini (Profile 3)",
      asked: 0,
      finished: 0,
      stopped: 0,
      failed: 0,
      totalMs: 0,
      longest: "none",
      lastUsed: "never",
      busiestDay: null,
      models: [],
    },
  ],
};

describe("UsagePanel", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    if (typeof HTMLDialogElement !== "undefined") {
      HTMLDialogElement.prototype.showModal = HTMLDialogElement.prototype.showModal ?? (() => {});
      HTMLDialogElement.prototype.close = HTMLDialogElement.prototype.close ?? (() => {});
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root && container) {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
    container = null;
    root = null;
  });

  it("says still counting when view is null", async () => {
    await act(async () => {
      root?.render(
        <UsagePanel
          view={null}
          window="today"
          onWindow={vi.fn()}
          onClose={vi.fn()}
          busy={false}
        />
      );
    });

    expect(container?.textContent).toContain("Still counting");
    expect(container?.querySelectorAll(".ws-usage-tab").length).toBe(3);
  });

  it("renders five subscriptions with three at zero showing not yet", async () => {
    await act(async () => {
      root?.render(
        <UsagePanel
          view={sampleView}
          window="month"
          onWindow={vi.fn()}
          onClose={vi.fn()}
          busy={false}
        />
      );
    });

    const rows = container?.querySelectorAll(".ws-usage-row");
    expect(rows?.length).toBe(5);

    const zeroRows = container?.querySelectorAll(".ws-usage-row--zero");
    expect(zeroRows?.length).toBe(3);

    const counts = Array.from(container?.querySelectorAll(".ws-usage-row-count") ?? []).map(
      (el) => el.textContent
    );
    expect(counts).toEqual(["14", "6", "not yet", "not yet", "not yet"]);

    const fills = container?.querySelectorAll<HTMLDivElement>(".ws-usage-bar-fill");
    expect(fills?.[0]?.style.width).toBe("70%");
    expect(fills?.[1]?.style.width).toBe("30%");
    expect(fills?.[2]?.style.width).toBe("0%");
  });

  it("renders the note in full at the bottom", async () => {
    await act(async () => {
      root?.render(
        <UsagePanel
          view={sampleView}
          window="month"
          onWindow={vi.fn()}
          onClose={vi.fn()}
          busy={false}
        />
      );
    });

    const note = container?.querySelector(".ws-usage-note");
    expect(note?.textContent).toBe(sampleView.note);
  });

  it("calls onWindow with the requested window when a tab is clicked", async () => {
    const onWindow = vi.fn();
    await act(async () => {
      root?.render(
        <UsagePanel
          view={sampleView}
          window="today"
          onWindow={onWindow}
          onClose={vi.fn()}
          busy={false}
        />
      );
    });

    const tabs = container?.querySelectorAll<HTMLButtonElement>(".ws-usage-tab");
    expect(tabs?.length).toBe(3);

    const weekTab = tabs?.[1];
    expect(weekTab?.textContent).toBe("This week");

    await act(async () => {
      weekTab?.click();
    });

    expect(onWindow).toHaveBeenCalledWith("week");
  });

  it("renders quietest subscription calmly when present and omits when null", async () => {
    await act(async () => {
      root?.render(
        <UsagePanel
          view={sampleView}
          window="month"
          onWindow={vi.fn()}
          onClose={vi.fn()}
          busy={false}
        />
      );
    });

    const quietest = container?.querySelector(".ws-usage-quietest");
    expect(quietest?.textContent).toBe("You have barely used Gemini (Profile 3) this month.");

    const viewWithoutQuietest: UsageView = {
      ...sampleView,
      quietest: null,
    };

    await act(async () => {
      root?.render(
        <UsagePanel
          view={viewWithoutQuietest}
          window="month"
          onWindow={vi.fn()}
          onClose={vi.fn()}
          busy={false}
        />
      );
    });

    expect(container?.querySelector(".ws-usage-quietest")).toBeNull();
  });

  it("renders disclosure details including models and run statistics", async () => {
    await act(async () => {
      root?.render(
        <UsagePanel
          view={sampleView}
          window="month"
          onWindow={vi.fn()}
          onClose={vi.fn()}
          busy={false}
        />
      );
    });

    const codexRow = container?.querySelector(".ws-usage-row");
    expect(codexRow?.textContent).toContain("Finished");
    expect(codexRow?.textContent).toContain("12");
    expect(codexRow?.textContent).toContain("Longest run");
    expect(codexRow?.textContent).toContain("18 sec");
    expect(codexRow?.textContent).toContain("code-davinci-002");
    expect(codexRow?.textContent).toContain("10");
  });

  it("handles zero totalAsked safely without invalid bar width", async () => {
    const zeroView: UsageView = {
      ...sampleView,
      totalAsked: 0,
      subscriptions: sampleView.subscriptions.map((s) => ({
        ...s,
        asked: 0,
      })),
    };

    await act(async () => {
      root?.render(
        <UsagePanel
          view={zeroView}
          window="month"
          onWindow={vi.fn()}
          onClose={vi.fn()}
          busy={false}
        />
      );
    });

    const fills = container?.querySelectorAll<HTMLDivElement>(".ws-usage-bar-fill");
    expect(fills?.length).toBe(5);
    fills?.forEach((fill) => {
      expect(fill.style.width).toBe("0%");
    });
  });
});
