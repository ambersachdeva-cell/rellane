/**
 * One place that turns a model's Markdown into something readable.
 *
 * The renderer this replaces was 4.5 KB and handled six constructs. A real
 * answer came back with a table in it and the owner was shown the pipe
 * characters, because the parser could not read its own most common input. So
 * the parsing is markdown-it's now, the highlighting is shiki's, and the
 * diagrams are mermaid's — all maintained by people who do only that.
 *
 * What did NOT change is the rule the old file was right about: model output
 * never becomes an HTML string. markdown-it is used through `parse`, which
 * returns tokens; every node below becomes a real React element.
 */
import { useMemo, type ReactNode } from "react";
import { parseMarkdown } from "./markdown-tree.js";
import { MarkdownView } from "./MarkdownView.js";
import { CodeBlock } from "./CodeBlock.js";
import { DiagramBlock } from "./DiagramBlock.js";
import { isDiagramLanguage } from "./diagram-source.js";
import { findMathSpans } from "./math-spans.js";
import { MathView } from "./MathView.js";

/**
 * Splits one run of text around any maths in it.
 *
 * Composed rather than chosen: a caller that wants `[1]` to become a link still
 * gets that for the prose between the expressions. Doing one or the other would
 * mean an answer with an equation in it quietly lost its citation links.
 */
function withMath(
  text: string,
  key: string,
  renderPlain?: (text: string, key: string) => ReactNode
): ReactNode {
  const spans = findMathSpans(text);
  if (spans.length === 0) return renderPlain ? renderPlain(text, key) : text;
  const pieces: ReactNode[] = [];
  let cursor = 0;
  spans.forEach((span, index) => {
    if (span.start > cursor) {
      const before = text.slice(cursor, span.start);
      pieces.push(renderPlain ? renderPlain(before, `${key}-t${index}`) : before);
    }
    pieces.push(
      <MathView key={`${key}-m${index}`} expression={span.expression} display={span.kind === "block"} />
    );
    cursor = span.end;
  });
  if (cursor < text.length) {
    const rest = text.slice(cursor);
    pieces.push(renderPlain ? renderPlain(rest, `${key}-tail`) : rest);
  }
  return pieces;
}

export function RichText({
  text,
  renderPlain
}: {
  readonly text: string;
  /** Kept from the renderer this replaces: `SourceAnswer` makes `[1]` a link. */
  readonly renderPlain?: (text: string, key: string) => ReactNode;
}): ReactNode {
  // Parsing is the expensive half, and a streaming answer re-renders on every
  // chunk, so it is memoised on the text itself.
  const nodes = useMemo(() => parseMarkdown(text), [text]);
  return (
    <MarkdownView
      nodes={nodes}
      renderText={(part, key) => withMath(part, key, renderPlain)}
      renderCode={(code) =>
        isDiagramLanguage(code.language) ? (
          <DiagramBlock source={code.text} />
        ) : (
          <CodeBlock code={code.text} language={code.language} />
        )
      }
    />
  );
}
