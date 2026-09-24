/**
 * Renders mathematical expressions using KaTeX.
 * KaTeX is imported dynamically inside an effect to keep initial bundle size small.
 * Model output is rendered directly into the DOM with trust: false, ensuring
 * no HTML strings or active execution paths can be created.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MathViewProps {
  readonly expression: string;
  readonly display: boolean;
}

interface KatexLike {
  readonly render: (
    tex: string,
    element: HTMLElement,
    options: {
      readonly throwOnError: boolean;
      readonly displayMode: boolean;
      readonly trust: boolean;
      readonly strict: string;
    }
  ) => void;
}

/**
 * Safely extracts the render function from a dynamically imported KaTeX module
 * across both CommonJS and ECMAScript module export shapes.
 */
function getKatexRenderer(module: unknown): KatexLike | null {
  if (typeof module !== "object" || module === null) {
    return null;
  }
  if ("render" in module && typeof (module as { readonly render: unknown }).render === "function") {
    return module as KatexLike;
  }
  if (
    "default" in module &&
    typeof (module as { readonly default: unknown }).default === "object" &&
    (module as { readonly default: unknown }).default !== null
  ) {
    const def = (module as { readonly default: object }).default;
    if ("render" in def && typeof (def as { readonly render: unknown }).render === "function") {
      return def as KatexLike;
    }
  }
  return null;
}

export function MathView({ expression, display }: MathViewProps): ReactNode {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(false);

    // Import KaTeX dynamically so it stays out of the initial bundle
    import("katex")
      .then((katexModule: unknown) => {
        if (cancelled) return;
        const renderer = getKatexRenderer(katexModule);
        const element = containerRef.current;
        if (!renderer || !element) {
          setError(true);
          return;
        }

        element.replaceChildren();
        try {
          // trust: false is load-bearing; prevents active content execution
          renderer.render(expression, element, {
            throwOnError: false,
            displayMode: display,
            trust: false,
            strict: "ignore",
          });
          if (!cancelled) {
            setLoaded(true);
          }
        } catch {
          if (!cancelled) {
            setError(true);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [expression, display]);

  const Tag = display ? "div" : "span";
  const ready = loaded && !error;

  /**
   * One element carries the ref for the whole life of this component.
   *
   * Rendering a different element once katex finished swapped the node the ref
   * pointed at, so React mounted a fresh empty span and the rendered maths was
   * thrown away the instant it succeeded. The fallback is hidden rather than
   * unmounted for the same reason: what katex wrote must stay where it wrote it.
   */
  return (
    <Tag className={display ? "math-block" : "math-inline"}>
      {ready ? null : <code>{expression}</code>}
      <span ref={containerRef} {...(ready ? {} : { style: { display: "none" } })} />
    </Tag>
  );
}
