import { describe, expect, it } from "vitest";
import {
  MAX_DIAGRAM_CHARS,
  diagramType,
  isDiagramLanguage,
  whyDiagramUnsupported,
} from "./diagram-source.js";

describe("isDiagramLanguage", () => {
  it("accepts valid diagram languages regardless of case or whitespace", () => {
    expect(isDiagramLanguage("mermaid")).toBe(true);
    expect(isDiagramLanguage("MERMAID")).toBe(true);
    expect(isDiagramLanguage(" mmd ")).toBe(true);
  });

  it("rejects non-diagram languages, empty strings, null, and undefined", () => {
    expect(isDiagramLanguage("ts")).toBe(false);
    expect(isDiagramLanguage(null)).toBe(false);
    expect(isDiagramLanguage(undefined)).toBe(false);
    expect(isDiagramLanguage("")).toBe(false);
  });
});

describe("diagramType", () => {
  it("skips leading blank lines", () => {
    const source = "\n\n  \nflowchart TD\n  A --> B";
    expect(diagramType(source)).toBe("flowchart");
  });

  it("skips %% comments", () => {
    const source = "%% comment line 1\n%% comment line 2\ngraph LR\n  A --- B";
    expect(diagramType(source)).toBe("graph");
  });

  it("skips --- front matter", () => {
    const source = "---\ntitle: Process Diagram\n---\nsequenceDiagram\n  Alice->>Bob: Hello";
    expect(diagramType(source)).toBe("sequenceDiagram");
  });

  it("returns sequenceDiagram for a sequence source", () => {
    const source = "sequenceDiagram\n  Alice->>Bob: Ping";
    expect(diagramType(source)).toBe("sequenceDiagram");
  });

  it("returns null for empty or comment-only source", () => {
    expect(diagramType("")).toBe(null);
    expect(diagramType("   \n\t\n  ")).toBe(null);
    expect(diagramType("%% just a comment\n%% another comment")).toBe(null);
  });
});

describe("whyDiagramUnsupported", () => {
  it("returns null for a valid flowchart", () => {
    const source = "flowchart TD\n  Start --> Stop";
    expect(whyDiagramUnsupported("mermaid", source)).toBe(null);
  });

  it("returns a sentence for a wrong label", () => {
    const reason = whyDiagramUnsupported("ts", "flowchart TD\n  A --> B");
    expect(reason).toBe("The language is not a supported diagram format.");
  });

  it("returns a sentence for empty source", () => {
    const reason = whyDiagramUnsupported("mermaid", "");
    expect(reason).toBe("The diagram source is empty.");
    expect(whyDiagramUnsupported("mermaid", "   \n\t  ")).toBe("The diagram source is empty.");
  });

  it("returns a sentence for source over MAX_DIAGRAM_CHARS", () => {
    const longSource = "flowchart TD\n" + "A --> B\n".repeat(MAX_DIAGRAM_CHARS);
    const reason = whyDiagramUnsupported("mermaid", longSource);
    expect(reason).toBe("The diagram exceeds the maximum supported size.");
  });

  it("returns a sentence for an unknown type such as sankey-beta", () => {
    const reason = whyDiagramUnsupported("mermaid", "sankey-beta\n  A,B,10");
    expect(reason).toBe("This diagram type is not supported.");
  });

  it("ensures no returned sentence contains a '/' path or a stack trace", () => {
    const cases: readonly [string | null | undefined, string][] = [
      ["ts", "flowchart TD\n  A --> B"],
      ["mermaid", ""],
      ["mermaid", "a".repeat(MAX_DIAGRAM_CHARS + 1)],
      ["mermaid", "sankey-beta\n  A,B,10"],
      ["mermaid", "invalid/type\n  data"],
      ["mermaid", "%% only comments"],
      [null, "flowchart TD\n  A --> B"],
      [undefined, "flowchart TD\n  A --> B"],
    ];

    for (const [label, source] of cases) {
      const reason = whyDiagramUnsupported(label, source);
      if (reason !== null) {
        expect(reason).not.toContain("/");
        expect(reason).not.toContain("Error");
        expect(reason).not.toContain("at ");
        expect(reason.endsWith(".")).toBe(true);
      }
    }
  });
});
