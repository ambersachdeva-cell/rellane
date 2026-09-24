/**
 * Renders structured Markdown trees as pure React elements.
 *
 * Model answers are untrusted input in an Electron renderer: no HTML strings,
 * no dangerouslySetInnerHTML, and no live links. All nodes become native React
 * elements to ensure content cannot execute scripts or initiate navigation.
 */

import { Fragment, type ReactNode } from "react";
import type { MdInline, MdNode } from "./markdown-tree.js";

export interface MarkdownViewProps {
  readonly nodes: readonly MdNode[];
  /** Rendered for a `code` node. The integrator passes a Shiki-backed one. */
  readonly renderCode?: (code: { readonly language: string | null; readonly text: string }) => ReactNode;
  /**
   * Rendered for each plain text run.
   *
   * Exists so a caller can find things inside the prose — `SourceAnswer` turns
   * `[1]` into a link to the source it names. Absent means the text is shown
   * as it is.
   */
  readonly renderText?: (text: string, key: string) => ReactNode;
}

function renderInline(node: MdInline, key: string, renderText: MarkdownViewProps["renderText"]): ReactNode {
  switch (node.kind) {
    case "text":
      // Wrap in a Fragment with a key so React can track array children without emitting superfluous DOM nodes.
      return <Fragment key={key}>{renderText ? renderText(node.text, key) : node.text}</Fragment>;
    case "strong":
      return <strong key={key}>{renderInlines(node.children, key, renderText)}</strong>;
    case "emphasis":
      return <em key={key}>{renderInlines(node.children, key, renderText)}</em>;
    case "strike":
      return <s key={key}>{renderInlines(node.children, key, renderText)}</s>;
    case "code":
      return <code key={key}>{node.text}</code>;
    case "link":
      // Links remain inert so model answers cannot navigate or execute arbitrary URLs.
      // The destination is preserved on title and aria-description for inspection without navigation.
      return (
        <span key={key} className="md__link" title={node.href} aria-description={node.href}>
          {renderInlines(node.children, key, renderText)}
        </span>
      );
    case "break":
      return <br key={key} />;
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

function renderInlines(nodes: readonly MdInline[], prefix: string, renderText: MarkdownViewProps["renderText"]): ReactNode[] {
  return nodes.map((node, index) => renderInline(node, `${prefix}-i-${index}`, renderText));
}

function renderNode(
  node: MdNode,
  key: string,
  renderCode: MarkdownViewProps["renderCode"],
  renderText: MarkdownViewProps["renderText"]
): ReactNode {
  switch (node.kind) {
    case "paragraph":
      return (
        <p key={key} className="md__p">
          {renderInlines(node.children, key, renderText)}
        </p>
      );
    case "heading": {
      const children = renderInlines(node.children, key, renderText);
      switch (node.level) {
        case 1:
          return <h1 key={key} className="md__heading">{children}</h1>;
        case 2:
          return <h2 key={key} className="md__heading">{children}</h2>;
        case 3:
          return <h3 key={key} className="md__heading">{children}</h3>;
        case 4:
          return <h4 key={key} className="md__heading">{children}</h4>;
        case 5:
          return <h5 key={key} className="md__heading">{children}</h5>;
        case 6:
          return <h6 key={key} className="md__heading">{children}</h6>;
        default: {
          const _exhaustive: never = node.level;
          return _exhaustive;
        }
      }
    }
    case "code": {
      // Fall back to plain preformatted text when no syntax highlighter is wired.
      if (renderCode !== undefined) {
        return <Fragment key={key}>{renderCode({ language: node.language, text: node.text })}</Fragment>;
      }
      return (
        <pre key={key} className="md__code">
          <code>{node.text}</code>
        </pre>
      );
    }
    case "quote":
      return (
        <blockquote key={key} className="md__quote">
          {renderNodes(node.children, key, renderCode, renderText)}
        </blockquote>
      );
    case "list": {
      const items = node.items.map((item, index) => (
        <li key={`${key}-${index}`}>
          {renderNodes(item, `${key}-${index}`, renderCode, renderText)}
        </li>
      ));
      if (node.ordered) {
        return (
          <ol key={key} start={node.start} className="md__list">
            {items}
          </ol>
        );
      }
      return (
        <ul key={key} className="md__list">
          {items}
        </ul>
      );
    }
    case "table":
      return (
        <div key={key} className="ws-table-container">
          <table className="md__table">
            <thead>
              <tr>
                {node.head.map((cell, colIndex) => {
                  const align = node.align[colIndex];
                  const cellKey = `${key}-h-${colIndex}`;
                  if (align !== null && align !== undefined) {
                    return (
                      <th key={cellKey} scope="col" style={{ textAlign: align }}>
                        {renderInlines(cell, cellKey, renderText)}
                      </th>
                    );
                  }
                  return (
                    <th key={cellKey} scope="col">
                      {renderInlines(cell, cellKey, renderText)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, rowIndex) => (
                <tr key={`${key}-r-${rowIndex}`}>
                  {row.map((cell, colIndex) => {
                    const align = node.align[colIndex];
                    const cellKey = `${key}-r-${rowIndex}-c-${colIndex}`;
                    if (align !== null && align !== undefined) {
                      return (
                        <td key={cellKey} style={{ textAlign: align }}>
                          {renderInlines(cell, cellKey, renderText)}
                        </td>
                      );
                    }
                    return (
                      <td key={cellKey}>
                        {renderInlines(cell, cellKey, renderText)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr key={key} className="md__rule" />;
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

function renderNodes(
  nodes: readonly MdNode[],
  prefix: string,
  renderCode: MarkdownViewProps["renderCode"],
  renderText: MarkdownViewProps["renderText"]
): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, `${prefix}-${index}`, renderCode, renderText));
}

export function MarkdownView({ nodes, renderCode, renderText }: MarkdownViewProps): ReactNode {
  return <div className="md">{renderNodes(nodes, "md", renderCode, renderText)}</div>;
}
