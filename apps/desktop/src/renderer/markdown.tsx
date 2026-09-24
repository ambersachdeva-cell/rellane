/**
 * Model answers need readable structure without changing their saved text.
 * Render a limited set of Markdown constructs as React nodes; HTML, links and
 * images stay inert text. No HTML strings, network requests or active content.
 * This is a reading view, not a general Markdown engine or an export preview.
 */

import type { ReactNode } from "react";

/** A line that begins a bullet: `- `, `* `, or `1. `. */
const BULLET = /^\s*(?:([-*•])|(\d{1,9})[.)])\s+(.*)$/u;
const HEADING = /^(#{1,6})\s+(.+)$/u;
const HEADING_TAGS = ["h3", "h4", "h5"] as const;
const FENCE = /^\s{0,3}(`{3,}|~{3,})([a-zA-Z0-9_-]*)[ \t]*$/u;

/** `**bold**` and `` `code` ``, non-greedy so two pairs on a line both close. */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/gu;

/**
 * Renders one line's inline marks.
 *
 * Split-and-map rather than a replace, because the output is React elements and
 * the whole point is never to build an HTML string from model output.
 */
export function inline(text: string, keyPrefix: string, renderPlain?: (text: string, key: string) => ReactNode): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    return renderPlain ? renderPlain(part, key) : part;
  });
}

/**
 * Renders a model's answer.
 *
 * Blank lines separate paragraphs. Code fences preserve literal lines, and
 * ordered/unordered lists remain distinct. No generated content becomes HTML.
 */
export function Markdown({ text, renderPlain }: { text: string; renderPlain?: (text: string, key: string) => ReactNode }): ReactNode {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let bullets: { text: string; number: number | null }[] = [];
  let paragraph: string[] = [];
  let code: { marker: string; lines: string[] } | null = null;

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    const List = items[0]?.number === null ? "ul" : "ol";
    blocks.push(
      <List key={`list-${blocks.length}`} className="md__list">
        {items.map((item, index) => (
          <li key={index} value={item.number ?? undefined}>
            {inline(item.text, `li-${blocks.length}-${index}`, renderPlain)}
          </li>
        ))}
      </List>
    );
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join(" ");
    paragraph = [];
    blocks.push(
      <p key={`p-${blocks.length}`} className="md__p">
        {inline(joined, `p-${blocks.length}`, renderPlain)}
      </p>
    );
  };

  const flushCode = () => {
    if (code === null) return;
    blocks.push(
      <pre key={`code-${blocks.length}`} className="md__code" tabIndex={0} aria-label="Code block">
        <code>{code.lines.join("\n")}</code>
      </pre>
    );
    code = null;
  };

  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (code !== null) {
      if (fence && fence[1]![0] === code.marker[0] &&
        fence[1]!.length >= code.marker.length && !fence[2]) flushCode();
      else code.lines.push(line);
      continue;
    }
    if (fence) {
      flushBullets();
      flushParagraph();
      code = { marker: fence[1]!, lines: [] };
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushBullets();
      flushParagraph();
      const Heading = HEADING_TAGS[Math.min(heading[1]!.length, 3) - 1]!;
      blocks.push(
        <Heading key={`heading-${blocks.length}`} className="md__heading">
          {inline(heading[2]!, `heading-${blocks.length}`, renderPlain)}
        </Heading>
      );
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      flushParagraph();
      const number = bullet[2] === undefined ? null : Number(bullet[2]);
      if (bullets.length && (bullets[0]!.number === null) !== (number === null))
        flushBullets();
      bullets.push({ text: bullet[3] ?? "", number });
      continue;
    }
    if (line.trim().length === 0) {
      flushBullets();
      flushParagraph();
      continue;
    }
    flushBullets();
    paragraph.push(line.trim());
  }

  flushBullets();
  flushParagraph();
  flushCode();

  return <div className="md">{blocks}</div>;
}
