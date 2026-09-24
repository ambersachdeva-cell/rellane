import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  ResearchPanel,
  type ResearchPanelProps,
  type ResearchRunView,
} from "./ResearchPanel.js";

function collectText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || typeof node !== "object") {
    return "";
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join(" ");
  }
  if ("props" in node) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    return collectText(el.props?.children);
  }
  return "";
}

function findElements(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, unknown>>) => boolean
): ReactElement<Record<string, unknown>>[] {
  const matches: ReactElement<Record<string, unknown>>[] = [];
  function search(current: ReactNode) {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const item of current) search(item);
      return;
    }
    if ("props" in current) {
      const el = current as ReactElement<Record<string, unknown>>;
      if (predicate(el)) {
        matches.push(el);
      }
      search(el.props?.children as ReactNode);
    }
  }
  search(node);
  return matches;
}

function makeProps(overrides: Partial<ResearchPanelProps> = {}): ResearchPanelProps {
  return {
    view: null,
    sources: [],
    unanswered: [],
    now: 1726410000000,
    onStop: () => {},
    onKeep: () => {},
    onOpenSource: () => {},
    onClose: () => {},
    busy: false,
    ...overrides,
  };
}

describe("ResearchPanel", () => {
  it("renders getting started state when view is null without failing", () => {
    const tree = ResearchPanel(makeProps({ view: null }));
    const text = collectText(tree);
    expect(text).toContain("Getting started");
  });

  it("marks the live step visibly with appropriate classes and badges", () => {
    const view: ResearchRunView = {
      id: "run-1",
      question: "What are the current UK tax bands?",
      status: "Reading HMRC guidance",
      steps: [
        { id: "s1", title: "Search HMRC portal", live: false },
        { id: "s2", title: "Reading income tax rates", live: true },
      ],
      answer: null,
      canStop: true,
    };

    const tree = ResearchPanel(makeProps({ view }));
    const liveSteps = findElements(tree, (el) => {
      const className = String(el.props?.["className"] ?? "");
      return className.includes("ws-research-step--live");
    });
    expect(liveSteps.length).toBe(1);
    expect(liveSteps[0]!.props["aria-current"]).toBe("step");

    const text = collectText(tree);
    expect(text).toContain("Live");
    expect(text).toContain("Search HMRC portal");
    expect(text).toContain("Reading income tax rates");
  });

  it("renders sources including those with zero notes observed", () => {
    const sources = [
      { label: "HMRC Manual", url: "https://gov.uk/hmrc", notes: 4 },
      { label: "Companies House", url: "https://gov.uk/companies-house", notes: 0 },
    ];

    const tree = ResearchPanel(makeProps({ sources }));
    const text = collectText(tree);
    expect(text).toContain("HMRC Manual");
    expect(text).toContain("4 notes");
    expect(text).toContain("Companies House");
    expect(text).toContain("0 notes");
  });

  it("renders every unanswered entry and does not hide the section", () => {
    const unanswered = [
      "Dividend allowance for non-residents",
      "Scottish rate thresholds for 2027",
    ];
    const tree = ResearchPanel(makeProps({ unanswered }));
    const text = collectText(tree);
    expect(text).toContain("Could not answer");
    expect(text).toContain("Dividend allowance for non-residents");
    expect(text).toContain("Scottish rate thresholds for 2027");
  });

  it("renders empty placeholder when unanswered list is empty", () => {
    const tree = ResearchPanel(makeProps({ unanswered: [] }));
    const text = collectText(tree);
    expect(text).toContain("Could not answer");
    expect(text).toContain("Nothing left unanswered");
  });

  it("enables Stop button strictly when canStop is true and guards calls", () => {
    let stopCalls = 0;
    const onStop = () => {
      stopCalls += 1;
    };

    // When view is null, canStop is false
    const nullTree = ResearchPanel(makeProps({ view: null, onStop }));
    const [nullStop] = findElements(nullTree, (el) => {
      const className = String(el.props?.["className"] ?? "");
      return className.includes("ws-research-button--stop");
    });
    expect(nullStop).toBeDefined();
    expect(nullStop!.props["disabled"]).toBe(true);
    (nullStop!.props["onClick"] as () => void)();
    expect(stopCalls).toBe(0);

    // When view has canStop = false
    const disabledView: ResearchRunView = {
      question: "Q",
      status: "S",
      steps: [],
      answer: null,
      canStop: false,
    };
    const disabledTree = ResearchPanel(makeProps({ view: disabledView, onStop }));
    const [disabledStop] = findElements(disabledTree, (el) => {
      const className = String(el.props?.["className"] ?? "");
      return className.includes("ws-research-button--stop");
    });
    expect(disabledStop!.props["disabled"]).toBe(true);
    (disabledStop!.props["onClick"] as () => void)();
    expect(stopCalls).toBe(0);

    // When view has canStop = true
    const activeView: ResearchRunView = {
      question: "Q",
      status: "S",
      steps: [],
      answer: null,
      canStop: true,
    };
    const activeTree = ResearchPanel(makeProps({ view: activeView, onStop }));
    const [activeStop] = findElements(activeTree, (el) => {
      const className = String(el.props?.["className"] ?? "");
      return className.includes("ws-research-button--stop");
    });
    expect(activeStop!.props["disabled"]).toBe(false);
    (activeStop!.props["onClick"] as () => void)();
    expect(stopCalls).toBe(1);
  });

  it("sanitises raw URLs in step titles using source labels and domain words", () => {
    const sources = [
      { label: "HMRC Rates", url: "https://gov.uk/rates", notes: 2 },
    ];
    const view: ResearchRunView = {
      question: "Tax query",
      status: "Working",
      steps: [
        { id: "s1", title: "Reading https://gov.uk/rates", live: false },
        { id: "s2", title: "https://example.com/unmapped/page", live: false },
      ],
      answer: null,
      canStop: true,
    };

    const tree = ResearchPanel(makeProps({ view, sources }));
    const text = collectText(tree);
    expect(text).toContain("Reading HMRC Rates");
    expect(text).toContain("example.com (unmapped / page)");
    expect(text).not.toContain("https://gov.uk/rates");
    expect(text).not.toContain("https://example.com/unmapped/page");
  });

  it("triggers onOpenSource with url on button click without self-navigating", () => {
    let opened = "";
    const sources = [
      { label: "Gov UK", url: "https://gov.uk/guidance", notes: 1 },
    ];
    const tree = ResearchPanel(
      makeProps({
        sources,
        onOpenSource: (url) => {
          opened = url;
        },
      })
    );

    const [sourceBtn] = findElements(tree, (el) => {
      const className = String(el.props?.["className"] ?? "");
      return className.includes("ws-research-source-button");
    });
    expect(sourceBtn).toBeDefined();
    expect(sourceBtn!.type).toBe("button");
    (sourceBtn!.props["onClick"] as () => void)();
    expect(opened).toBe("https://gov.uk/guidance");
  });

  it("displays the answer and allows keeping it when answer arrives", () => {
    let kept = false;
    const view: ResearchRunView = {
      question: "What is VAT?",
      status: "Finished",
      steps: [],
      answer: "VAT is value added tax charged on taxable supplies.",
      canStop: false,
    };

    const tree = ResearchPanel(
      makeProps({
        view,
        onKeep: () => {
          kept = true;
        },
      })
    );

    const text = collectText(tree);
    expect(text).toContain("VAT is value added tax charged on taxable supplies.");

    const [keepBtn] = findElements(tree, (el) => {
      const className = String(el.props?.["className"] ?? "");
      return className.includes("ws-research-button--keep");
    });
    expect(keepBtn).toBeDefined();
    (keepBtn!.props["onClick"] as () => void)();
    expect(kept).toBe(true);
  });
});
