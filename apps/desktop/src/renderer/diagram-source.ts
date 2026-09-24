export const SUPPORTED_DIAGRAMS: readonly string[] = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "mindmap",
  "timeline",
  "gitGraph",
  "quadrantChart",
] as const;

export const MAX_DIAGRAM_CHARS = 20_000;

/** Is this fence label a diagram this app will draw? */
export function isDiagramLanguage(label: string | null | undefined): boolean {
  if (typeof label !== "string") {
    return false;
  }
  const trimmed = label.trim().toLowerCase();
  return trimmed === "mermaid" || trimmed === "mmd";
}

/** The first word of the source, which is the diagram type mermaid dispatches on. */
export function diagramType(source: string): string | null {
  if (typeof source !== "string" || source.length === 0) {
    return null;
  }
  const cleanSource = source.replace(/^\uFEFF/, "");
  const lines = cleanSource.split(/\r?\n/);
  let inFrontMatter = false;
  let frontMatterSeen = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (inFrontMatter) {
      if (trimmed === "---" || trimmed.startsWith("---")) {
        inFrontMatter = false;
        frontMatterSeen = true;
      }
      continue;
    }
    if (trimmed.startsWith("%%")) {
      continue;
    }
    if (!frontMatterSeen && (trimmed === "---" || trimmed.startsWith("---"))) {
      inFrontMatter = true;
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    const firstToken = tokens[0];
    if (firstToken !== undefined && firstToken.length > 0) {
      return firstToken;
    }
  }

  return null;
}

/** Cheap structural refusal BEFORE mermaid is even loaded. */
export function whyDiagramUnsupported(
  label: string | null | undefined,
  source: string
): string | null {
  if (!isDiagramLanguage(label)) {
    return "The language is not a supported diagram format.";
  }
  if (typeof source !== "string" || source.trim().length === 0) {
    return "The diagram source is empty.";
  }
  if (source.length > MAX_DIAGRAM_CHARS) {
    return "The diagram exceeds the maximum supported size.";
  }
  const type = diagramType(source);
  if (type === null || !SUPPORTED_DIAGRAMS.includes(type)) {
    return "This diagram type is not supported.";
  }
  return null;
}
