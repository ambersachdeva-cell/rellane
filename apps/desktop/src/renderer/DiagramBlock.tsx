import { useEffect, useState, type ReactNode } from "react";
import { whyDiagramUnsupported } from "./diagram-source.js";

let diagramRenderCounter = 0;

export interface DiagramBlockProps {
  readonly source: string;
}

/**
 * Renders a Mermaid diagram lazily when valid, or falls back to plain monospace text.
 * The source is always visible first and remains visible if drawing fails.
 */

/**
 * The app's own colours, so a diagram belongs to the window around it.
 *
 * Read from the live CSS custom properties rather than duplicated, so changing
 * the theme changes the diagrams too and there is one palette, not two.
 */
function readDiagramPalette(): Record<string, string> {
  // The palette lives on `.ws-root`, not on the document element: reading the
  // root returned empty for every variable, so every fallback fired and the
  // diagram was drawn in colours that belong to no theme.
  const scope = document.querySelector(".ws-root") ?? document.documentElement;
  const styles = getComputedStyle(scope);
  const read = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value === "" ? fallback : value;
  };
  const paper = read("--ws-paper", "#ffffff");
  const ink = read("--ws-ink", "#202633");
  const line = read("--ws-line", "#e3e6ee");
  const blue = read("--ws-blue", "#485beb");
  const ground = read("--ws-ground", "#f6f7fb");
  const muted = read("--ws-muted", "#6b7488");
  return {
    background: paper,
    primaryColor: ground,
    primaryTextColor: ink,
    primaryBorderColor: line,
    secondaryColor: paper,
    tertiaryColor: paper,
    lineColor: muted,
    textColor: ink,
    mainBkg: ground,
    nodeBorder: line,
    clusterBkg: paper,
    clusterBorder: line,
    edgeLabelBackground: paper,
    actorBkg: ground,
    actorBorder: line,
    actorTextColor: ink,
    signalColor: muted,
    signalTextColor: ink,
    labelBoxBkgColor: ground,
    labelBoxBorderColor: line,
    labelTextColor: ink,
    noteBkgColor: paper,
    noteBorderColor: line,
    noteTextColor: ink,
    activationBkgColor: blue,
    titleColor: ink
  };
}

export function DiagramBlock({ source }: DiagramBlockProps): ReactNode {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSvg(null);

    // Avoid loading the 61 MB parser when structural inspection already proves refusal.
    const unsupportedReason = whyDiagramUnsupported("mermaid", source);
    if (unsupportedReason !== null) {
      return;
    }

    async function renderDiagram(): Promise<void> {
      const renderId = `mermaid-render-${++diagramRenderCounter}`;
      try {
        const mermaidModule = await import("mermaid");
        const mermaid = mermaidModule.default ?? mermaidModule;

        mermaid.initialize({
          startOnLoad: false,
          // Load-bearing: stops a model's diagram carrying click handlers or
          // raw HTML labels.
          securityLevel: "strict",
          // "neutral" rendered as black boxes with unreadable text in this app.
          // The palette is stated explicitly instead of hoping a named theme
          // happens to suit, and it is read from the app's own CSS variables so
          // a diagram matches the window it is drawn in, light or dark.
          theme: "base",
          themeVariables: readDiagramPalette(),
          fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        });

        const result = await mermaid.render(renderId, source);

        // Stale render guard: if source changed or component unmounted, discard.
        if (!active) {
          return;
        }

        setSvg(result.svg);
      } catch {
        // Clean up any stray DOM nodes mermaid might leave on parse failure.
        if (typeof document !== "undefined") {
          const el = document.getElementById(renderId);
          if (el) {
            el.remove();
          }
          const dEl = document.getElementById(`d${renderId}`);
          if (dEl) {
            dEl.remove();
          }
        }
        if (active) {
          setSvg(null);
        }
      }
    }

    void renderDiagram();

    return () => {
      active = false;
    };
  }, [source]);

  if (svg !== null) {
    return (
      <div
        className="md__diagram"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  return (
    <pre className="md__code" tabIndex={0} aria-label="Code block">
      <code>{source}</code>
    </pre>
  );
}
