import { describe, expect, it } from "vitest";
import {
  DiagnosticsPanel,
  buildReportText,
  formatCheckedAt,
  isCheckStale,
  severityIconName,
  severityLabel,
  sortFindingsWorstFirst,
} from "./DiagnosticsPanel.js";
import type { Finding, SelfCheck } from "./DiagnosticsPanel.js";
import { Modal } from "./ui.js";

interface ElementLike {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

function isElementLike(value: unknown): value is ElementLike {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join("");
  }
  if (isElementLike(node)) {
    return collectText(node.props["children"]);
  }
  return "";
}

function findAllByClass(node: unknown, className: string): readonly ElementLike[] {
  const matches: ElementLike[] = [];
  function search(current: unknown): void {
    if (!current) return;
    if (Array.isArray(current)) {
      for (const item of current) {
        search(item);
      }
      return;
    }
    if (isElementLike(current)) {
      const cls = current.props["className"];
      if (typeof cls === "string" && cls.split(" ").includes(className)) {
        matches.push(current);
      }
      search(current.props["children"]);
    }
  }
  search(node);
  return matches;
}

describe("DiagnosticsPanel", () => {
  const sampleFindings: readonly Finding[] = [
    {
      id: "f-work",
      title: "Claude CLI",
      severity: "working",
      line: "Signed in and answering requests",
      fix: null,
    },
    {
      id: "f-broke",
      title: "Codex CLI",
      severity: "broken",
      line: "Process terminated with status 1",
      fix: "Run npx codex login in Terminal",
    },
    {
      id: "f-attn",
      title: "Gemini CLI",
      severity: "attention",
      line: "Subscription nearing rate limit",
      fix: "Review active requests or switch providers",
    },
    {
      id: "f-unk",
      title: "Local Runner",
      severity: "unknown",
      line: "Test was skipped during execution",
      fix: null,
    },
  ];

  const sampleCheck: SelfCheck = {
    headline: "1 of 4 checks needs attention",
    findings: sampleFindings,
    checkedAt: 1_000_000,
  };

  it("labels all four states without relying on colour alone", () => {
    expect(severityLabel("working")).toBe("Working");
    expect(severityLabel("attention")).toBe("Needs attention");
    expect(severityLabel("broken")).toBe("Not working");
    expect(severityLabel("unknown")).toBe("Not checked");

    expect(severityIconName("working")).toBe("check");
    expect(severityIconName("attention")).toBe("help");
    expect(severityIconName("broken")).toBe("close");
    expect(severityIconName("unknown")).toBe("minus");
  });

  it("sorts findings worst first: broken, attention, unknown, working", () => {
    const sorted = sortFindingsWorstFirst(sampleFindings);
    expect(sorted.length).toBe(4);
    expect(sorted[0]!.severity).toBe("broken");
    expect(sorted[1]!.severity).toBe("attention");
    expect(sorted[2]!.severity).toBe("unknown");
    expect(sorted[3]!.severity).toBe("working");
  });

  it("formats checked timestamp in plain words relative to now", () => {
    expect(formatCheckedAt(100_000, 120_000)).toBe("checked just now");
    expect(formatCheckedAt(100_000, 160_000)).toBe("checked 1 minute ago");
    expect(formatCheckedAt(100_000, 220_000)).toBe("checked 2 minutes ago");
    expect(formatCheckedAt(100_000, 100_000 + 3_600_000)).toBe("checked 1 hour ago");
    expect(formatCheckedAt(100_000, 100_000 + 7_200_000)).toBe("checked 2 hours ago");
  });

  it("flags checks older than five minutes as stale", () => {
    const base = 1_000_000;
    expect(isCheckStale(base, base + 2 * 60 * 1000)).toBe(false);
    expect(isCheckStale(base, base + 4 * 60 * 1000)).toBe(false);
    expect(isCheckStale(base, base + 5 * 60 * 1000)).toBe(true);
    expect(isCheckStale(base, base + 10 * 60 * 1000)).toBe(true);
  });

  it("builds a plain text report matching the sorted findings with state and fix", () => {
    const text = buildReportText(sampleCheck);
    const lines = text.split("\n");
    expect(lines.length).toBe(5);
    expect(lines[0]!).toBe("1 of 4 checks needs attention");
    expect(lines[1]!).toContain("[Not working]");
    expect(lines[1]!).toContain("Fix: Run npx codex login in Terminal");
    expect(lines[2]!).toContain("[Needs attention]");
    expect(lines[3]!).toContain("[Not checked]");
    expect(lines[4]!).toContain("[Working]");
  });

  it("renders initial state when check is null and offers to run check", () => {
    let runTriggered = false;
    const tree = DiagnosticsPanel({
      check: null,
      now: 1_000_000,
      running: false,
      onRun: () => {
        runTriggered = true;
      },
      onCopy: () => {},
      onClose: () => {},
    });

    expect(tree.type).toBe(Modal);
    expect(tree.props["title"]).toBe("How things are");
    expect(tree.props["eyebrow"]).toBe("Your setup");

    const leadText = collectText(findAllByClass(tree, "ws-diag-initial-lead"));
    expect(leadText).toContain("Check your AI subscriptions");

    const buttons = findAllByClass(tree, "ws-diag-button--primary");
    expect(buttons.length).toBe(1);
    const button = buttons[0]!;
    expect(collectText(button)).toContain("Run check");
    const onClick = button.props["onClick"] as (() => void) | undefined;
    onClick?.();
    expect(runTriggered).toBe(true);
  });

  it("renders running feedback when check is null and running is true", () => {
    const tree = DiagnosticsPanel({
      check: null,
      now: 1_000_000,
      running: true,
      onRun: () => {},
      onCopy: () => {},
      onClose: () => {},
    });

    const leadText = collectText(findAllByClass(tree, "ws-diag-initial-lead"));
    expect(leadText).toContain("Checking your setup now");
    const buttons = findAllByClass(tree, "ws-diag-button--primary");
    expect(buttons.length).toBe(1);
    expect(buttons[0]!.props["disabled"]).toBe(true);
    expect(collectText(buttons[0]!)).toContain("Checking...");
  });

  it("renders rows worst-first with state words, markers, and prominent fixes", () => {
    let copiedReport = "";
    const tree = DiagnosticsPanel({
      check: sampleCheck,
      now: 1_000_000 + 2 * 60 * 1000,
      running: false,
      onRun: () => {},
      onCopy: (text) => {
        copiedReport = text;
      },
      onClose: () => {},
    });

    const headline = collectText(findAllByClass(tree, "ws-diag-headline"));
    expect(headline).toBe("1 of 4 checks needs attention");

    const timestamp = collectText(findAllByClass(tree, "ws-diag-timestamp"));
    expect(timestamp).toBe("checked 2 minutes ago");

    const stateWords = findAllByClass(tree, "ws-diag-state-word").map(collectText);
    expect(stateWords.length).toBe(4);
    expect(stateWords[0]!).toBe("Not working");
    expect(stateWords[1]!).toBe("Needs attention");
    expect(stateWords[2]!).toBe("Not checked");
    expect(stateWords[3]!).toBe("Working");

    const fixes = findAllByClass(tree, "ws-diag-fix");
    expect(fixes.length).toBe(2);
    expect(collectText(fixes[0]!)).toContain("What to do");
    expect(collectText(fixes[0]!)).toContain("Run npx codex login in Terminal");

    const copyButtons = findAllByClass(tree, "ws-diag-button--secondary");
    expect(copyButtons.length).toBe(1);
    const copyClick = copyButtons[0]!.props["onClick"] as (() => void) | undefined;
    copyClick?.();
    expect(copiedReport).toBe(buildReportText(sampleCheck));
  });

  it("displays a stale warning and offers to run again when older than five minutes", () => {
    let recheckTriggered = false;
    const tree = DiagnosticsPanel({
      check: sampleCheck,
      now: 1_000_000 + 6 * 60 * 1000,
      running: false,
      onRun: () => {
        recheckTriggered = true;
      },
      onCopy: () => {},
      onClose: () => {},
    });

    const staleBoxes = findAllByClass(tree, "ws-diag-stale");
    expect(staleBoxes.length).toBe(1);
    expect(collectText(staleBoxes[0]!)).toContain("more than 5 minutes ago");

    const staleButtons = findAllByClass(tree, "ws-diag-button--stale");
    expect(staleButtons.length).toBe(1);
    const onClick = staleButtons[0]!.props["onClick"] as (() => void) | undefined;
    onClick?.();
    expect(recheckTriggered).toBe(true);
  });
});
