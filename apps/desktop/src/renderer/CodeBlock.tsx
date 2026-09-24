/**
 * Asynchronous code block component with dual-theme Shiki syntax highlighting.
 *
 * Renders plain monospace text immediately so streaming answers remain readable
 * while language grammars load lazily in the background. Upgrades to tokenised
 * elements with inline light and dark colours once Shiki completes.
 */

import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  MAX_CODE_CHARS,
  MAX_CODE_LINES,
  resolveCodeLanguage,
  themeColours,
} from "./code-theme.js";

export interface CodeBlockProps {
  readonly code: string;
  readonly language: string | null;
}

/**
 * What this component uses from one of shiki's tokens.
 *
 * `htmlStyle` really is `string | Record<string, string>` upstream — shiki can
 * hand back a CSS string instead of a map — so it is declared that way here and
 * narrowed where it is read. Declaring it as only the map compiled until shiki's
 * own types were checked against it, which is exactly the seam worth pinning.
 */
interface ShikiToken {
  readonly content: string;
  readonly htmlStyle?: string | Readonly<Record<string, string>> | undefined;
}

interface HighlightedCode {
  readonly code: string;
  readonly lang: string;
  readonly lines: readonly (readonly ShikiToken[])[];
}

interface TokenStyle extends React.CSSProperties {
  readonly color?: string;
  readonly "--shiki-dark"?: string;
}

/**
 * Counts newline characters to guard against highlighting excessively large code blocks
 * without allocating an array of lines.
 */
function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      count++;
    }
  }
  return count;
}

/**
 * Builds token inline styles containing light colour and dark CSS custom property.
 * Returns null if neither theme provides a colour, avoiding superfluous style props.
 */
function buildTokenStyle(
  htmlStyle: Readonly<Record<string, string>> | undefined
): TokenStyle | null {
  const colours = themeColours(htmlStyle);
  if (colours.light === null && colours.dark === null) {
    return null;
  }
  return {
    ...(colours.light !== null ? { color: colours.light } : {}),
    ...(colours.dark !== null ? { "--shiki-dark": colours.dark } : {}),
  };
}


/**
 * One highlighter for the window, built on shiki's JavaScript regex engine.
 *
 * shiki's default path tokenises with oniguruma compiled to WebAssembly, and
 * that `.wasm` does not load from `file://` in a packaged Electron renderer —
 * the import rejected, the component caught it, and every block rendered as
 * plain text with no error anywhere. The JavaScript engine needs no WASM and
 * produces the same tokens; it is slightly slower, which is invisible next to a
 * code block that was never coloured at all.
 *
 * Built once and languages are added as they appear, so opening an answer with
 * five TypeScript blocks compiles that grammar once rather than five times.
 */
let highlighterPromise: Promise<ShikiHighlighter> | null = null;
const loadedLanguages = new Set<string>();

interface ShikiHighlighter {
  readonly codeToTokens: (
    code: string,
    options: { readonly lang: string; readonly themes: { readonly light: string; readonly dark: string } }
  ) => { readonly tokens: readonly (readonly ShikiToken[])[] };
  readonly loadLanguage: (lang: string) => Promise<void>;
}

async function highlighterFor(language: string): Promise<ShikiHighlighter> {
  if (highlighterPromise === null) {
    highlighterPromise = (async () => {
      const [core, engine] = await Promise.all([import("shiki"), import("shiki/engine/javascript")]);
      const created = await core.createHighlighter({
        langs: [],
        themes: ["github-light", "github-dark"],
        engine: engine.createJavaScriptRegexEngine()
      });
      return created as unknown as ShikiHighlighter;
    })();
  }
  const highlighter = await highlighterPromise;
  if (!loadedLanguages.has(language)) {
    await highlighter.loadLanguage(language);
    loadedLanguages.add(language);
  }
  return highlighter;
}

export function CodeBlock({ code, language }: CodeBlockProps): ReactNode {
  const [highlighted, setHighlighted] = useState<HighlightedCode | null>(null);

  useEffect(() => {
    const lang = resolveCodeLanguage(language);
    // Discard highlighting for unsupported languages or oversized inputs
    if (
      lang === null ||
      code.length > MAX_CODE_CHARS ||
      countLines(code) > MAX_CODE_LINES
    ) {
      setHighlighted(null);
      return;
    }

    const resolved: string = lang;
    let cancelled = false;

    async function highlight(): Promise<void> {
      try {
        const highlighter = await highlighterFor(resolved);
        if (cancelled) {
          return;
        }
        const out = highlighter.codeToTokens(code, {
          lang: resolved,
          themes: { light: "github-light", dark: "github-dark" }
        });
        if (cancelled) {
          return;
        }
        setHighlighted({ code, lang: resolved, lines: out.tokens });
      } catch {
        // Silent fallback preserves code readability if grammar loading fails
        if (!cancelled) {
          setHighlighted(null);
        }
      }
    }

    void highlight();

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const resolvedLang = resolveCodeLanguage(language);
  const canHighlight =
    resolvedLang !== null &&
    code.length <= MAX_CODE_CHARS &&
    countLines(code) <= MAX_CODE_LINES;

  const tokens =
    canHighlight &&
    highlighted !== null &&
    highlighted.code === code &&
    highlighted.lang === resolvedLang
      ? highlighted.lines
      : null;

  return (
    <pre className="md__code" tabIndex={0} aria-label="Code block">
      <code>
        {tokens !== null
          ? tokens.map((lineTokens, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineTokens.map((token, tokenIndex) => {
                  // shiki may hand back a CSS string instead of a map. There is
                  // no dual-theme information in that form, so it renders plain
                  // rather than being parsed into one.
                  const style = buildTokenStyle(
                    typeof token.htmlStyle === "string" ? undefined : token.htmlStyle
                  );
                  if (style !== null) {
                    return (
                      <span key={tokenIndex} style={style}>
                        {token.content}
                      </span>
                    );
                  }
                  return <span key={tokenIndex}>{token.content}</span>;
                })}
                {lineIndex < tokens.length - 1 ? "\n" : null}
              </Fragment>
            ))
          : code}
      </code>
    </pre>
  );
}
