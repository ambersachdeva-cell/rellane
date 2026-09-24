import { describe, expect, it } from "vitest";
import { findMathSpans, MAX_EXPRESSION_CHARS } from "./math-spans.js";

describe("findMathSpans", () => {
  it("protects currency and does not treat lone dollars as maths", () => {
    // Currency mentions must never be interpreted as maths
    expect(findMathSpans("The cost was $5 and then $10.")).toEqual([]);
    expect(findMathSpans("costs $10 and $20")).toEqual([]);
    expect(findMathSpans("It costs $5.")).toEqual([]);
  });

  it("finds inline maths spans with correct expression and delimiter offsets", () => {
    const spans = findMathSpans("$x^2$");
    expect(spans).toHaveLength(1);
    if (spans.length === 1) {
      expect(spans[0]!).toEqual({
        kind: "inline",
        expression: "x^2",
        start: 0,
        end: 5,
      });
    }
  });

  it("finds block maths spans with double dollar delimiters", () => {
    const text = "$$\\sum_{i=1}^{n} i$$";
    const spans = findMathSpans(text);
    expect(spans).toHaveLength(1);
    if (spans.length === 1) {
      expect(spans[0]!).toEqual({
        kind: "block",
        expression: "\\sum_{i=1}^{n} i",
        start: 0,
        end: text.length,
      });
    }
  });

  it("finds both inline and block spans in order without overlapping", () => {
    const text = "Evaluate $x^2$ before solving $$\\sum_{i=1}^{n} i$$ completely.";
    const spans = findMathSpans(text);
    expect(spans).toHaveLength(2);
    if (spans.length === 2) {
      expect(spans[0]!).toEqual({
        kind: "inline",
        expression: "x^2",
        start: 9,
        end: 14,
      });
      expect(spans[1]!).toEqual({
        kind: "block",
        expression: "\\sum_{i=1}^{n} i",
        start: 30,
        // Half-open: the closing "$$" sits at 48 and 49, so the span ends at 50.
        end: 50,
      });
      // Stated as the property too, so the next person does not have to count.
      expect(text.slice(spans[1]!.start, spans[1]!.end)).toBe("$$\\sum_{i=1}^{n} i$$");
      expect(spans[0]!.end).toBeLessThanOrEqual(spans[1]!.start);
    }
  });

  it("ignores unterminated delimiters and escaped dollars", () => {
    // Unterminated single and block delimiters must be ignored
    expect(findMathSpans("This $x^2 is not closed")).toEqual([]);
    expect(findMathSpans("This $$\\sum_{i=1}^{n} is not closed")).toEqual([]);

    // Escaped dollars are literal text rather than delimiters
    expect(findMathSpans("This \\$x^2$ has an escaped opening dollar")).toEqual([]);
    expect(findMathSpans("This $x^2\\$ has an escaped closing dollar")).toEqual([]);
    expect(findMathSpans("Escaped currency \\$5 and \\$10")).toEqual([]);

    // Even numbers of backslashes escape the backslash itself, leaving dollar active
    const evenEscaped = findMathSpans("\\\\$x^2$");
    expect(evenEscaped).toHaveLength(1);
    if (evenEscaped.length === 1) {
      expect(evenEscaped[0]!).toEqual({
        kind: "inline",
        expression: "x^2",
        start: 2,
        end: 7,
      });
    }
  });

  it("ignores expressions longer than MAX_EXPRESSION_CHARS", () => {
    const tooLong = "a".repeat(MAX_EXPRESSION_CHARS + 1);
    expect(findMathSpans(`$${tooLong}$`)).toEqual([]);
    expect(findMathSpans(`$$${tooLong}$$`)).toEqual([]);

    const exactLimit = "a".repeat(MAX_EXPRESSION_CHARS);
    const validSpan = findMathSpans(`$${exactLimit}$`);
    expect(validSpan).toHaveLength(1);
    if (validSpan.length === 1) {
      expect(validSpan[0]!.expression).toBe(exactLimit);
    }
  });

  it("refuses spans whose expression consists solely of digits, commas and full stops", () => {
    // Currency amounts enclosed in dollars must not become maths
    expect(findMathSpans("$1,234.56$")).toEqual([]);
    expect(findMathSpans("$100$")).toEqual([]);
    expect(findMathSpans("$0.99$")).toEqual([]);
    expect(findMathSpans("$1,000,000$")).toEqual([]);
    expect(findMathSpans("$$1,234.56$$")).toEqual([]);
  });

  it("safely handles empty input, whitespace, lone backslashes, and strings of only dollars", () => {
    expect(findMathSpans("")).toEqual([]);
    expect(findMathSpans("   \n\t  ")).toEqual([]);
    expect(findMathSpans("$")).toEqual([]);
    expect(findMathSpans("$$")).toEqual([]);
    expect(findMathSpans("$$$")).toEqual([]);
    expect(findMathSpans("$$$$")).toEqual([]);
    expect(findMathSpans("$$$$$")).toEqual([]);
    expect(findMathSpans("$$$$$$")).toEqual([]);
    expect(findMathSpans("\\")).toEqual([]);
    expect(findMathSpans("\\\\\\")).toEqual([]);
  });

  it("requires non-space characters immediately after opening and before closing inline dollar", () => {
    expect(findMathSpans("$ x$")).toEqual([]);
    expect(findMathSpans("$x $")).toEqual([]);
    expect(findMathSpans("$ x $")).toEqual([]);
  });
});
