/**
 * Pure scanner for LaTeX math spans in plain text.
 * Detects inline ($...$) and block ($$...$$) math expressions while strictly
 * distinguishing them from currency amounts (such as $5 or $10 and $20).
 */

export interface MathSpan {
  readonly kind: "inline" | "block";
  readonly expression: string;
  /** Offsets of the WHOLE span including its delimiters, in the input. */
  readonly start: number;
  readonly end: number;
}

export const MAX_EXPRESSION_CHARS = 2_000;

/**
 * Checks if a character position in text is escaped by an odd number of preceding backslashes.
 */
function isEscaped(text: string, index: number): boolean {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (text[i] === "\\") {
      backslashCount++;
    } else {
      break;
    }
  }
  return backslashCount % 2 === 1;
}

/**
 * Finds non-overlapping math spans in ascending start order.
 * Block delimiters ($$) take precedence over inline delimiters ($).
 */
export function findMathSpans(text: string): readonly MathSpan[] {
  if (text.length === 0 || !text.includes("$")) {
    return [];
  }

  const spans: MathSpan[] = [];
  let i = 0;

  while (i < text.length) {
    // Block delimiters take precedence over inline dollars
    if (
      text[i] === "$" &&
      i + 1 < text.length &&
      text[i + 1] === "$" &&
      !isEscaped(text, i)
    ) {
      let closeIndex = -1;
      for (let j = i + 2; j + 1 < text.length; j++) {
        if (j - (i + 2) > MAX_EXPRESSION_CHARS) {
          break;
        }
        if (text[j] === "$" && text[j + 1] === "$" && !isEscaped(text, j)) {
          closeIndex = j;
          break;
        }
      }

      if (closeIndex !== -1) {
        const expression = text.slice(i + 2, closeIndex);
        const trimmed = expression.trim();
        // Refuse empty expressions, whitespace-only, or currency-like digit strings
        if (
          expression.length > 0 &&
          expression.length <= MAX_EXPRESSION_CHARS &&
          trimmed.length > 0 &&
          !/^[\d,.]+$/.test(trimmed)
        ) {
          spans.push({
            kind: "block",
            expression,
            start: i,
            end: closeIndex + 2,
          });
          i = closeIndex + 2;
          continue;
        }
      }

      i++;
      continue;
    }

    // Inline delimiter check
    if (text[i] === "$" && !isEscaped(text, i)) {
      const nextChar = text[i + 1];
      // Require a non-space character immediately after opening dollar
      if (
        nextChar === undefined ||
        /\s/u.test(nextChar) ||
        nextChar === "$"
      ) {
        i++;
        continue;
      }

      let closeIndex = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (j - (i + 1) > MAX_EXPRESSION_CHARS) {
          break;
        }
        if (text[j] === "$" && !isEscaped(text, j)) {
          if (j + 1 < text.length && text[j + 1] === "$") {
            break;
          }
          const prevChar = text[j - 1];
          // Require a non-space character immediately before closing dollar
          if (prevChar !== undefined && !/\s/u.test(prevChar)) {
            closeIndex = j;
          }
          break;
        }
      }

      if (closeIndex !== -1) {
        const expression = text.slice(i + 1, closeIndex);
        // Refuse spans whose content is entirely digits, commas and full stops
        if (
          expression.length > 0 &&
          expression.length <= MAX_EXPRESSION_CHARS &&
          !/^[\d,.]+$/.test(expression)
        ) {
          spans.push({
            kind: "inline",
            expression,
            start: i,
            end: closeIndex + 1,
          });
          i = closeIndex + 1;
          continue;
        }
      }

      i++;
      continue;
    }

    i++;
  }

  return spans;
}
