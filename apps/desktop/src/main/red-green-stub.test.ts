/**
 * The stub scanner, which a broken version of once certified a vacuous test.
 *
 * These are regression tests before they are unit tests. The first
 * implementation used regular expressions, could not tell a return type's brace
 * from a body's, emitted syntax errors, and made every run look red — so the
 * gate reported a safety it was not providing. Each case below is a shape that
 * broke it or could.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error - a .mjs script with no type declarations, imported for its one pure function.
import { stub } from "../../../../scripts/red-green.mjs";

const stubbed = (source: string): string => stub(source) as string;

describe("stubbing a module so a test can be shown failing", () => {
  it("replaces a plain function body", () => {
    const out = stubbed(`export function add(a: number, b: number): number {\n  return a + b;\n}\n`);
    expect(out).toContain('throw new Error("not implemented: add")');
    expect(out).not.toContain("return a + b");
  });

  it("keeps the signature, so the module still imports", () => {
    const out = stubbed(`export function add(a: number, b: number): number {\n  return a + b;\n}\n`);
    expect(out).toContain("export function add(a: number, b: number): number");
  });

  it("handles a return type made of braces — the case that broke the regex", () => {
    const out = stubbed(
      `export function counts(db: D): { readonly open: number; readonly closed: number } {\n` +
        `  return { open: 1, closed: 2 };\n}\n`
    );
    // The return type survives intact; only the body is replaced.
    expect(out).toContain("{ readonly open: number; readonly closed: number }");
    expect(out).toContain('throw new Error("not implemented: counts")');
    expect(out).not.toContain("open: 1");
  });

  it("is not fooled by a brace inside a string or a template literal", () => {
    const out = stubbed(
      "export function q(): string {\n  return `INSERT {} VALUES ${'{'}`;\n}\n" +
        'export function r(): number {\n  return 2;\n}\n'
    );
    expect(out).toContain('throw new Error("not implemented: q")');
    expect(out).toContain('throw new Error("not implemented: r")');
    expect(out).not.toContain("INSERT {}");
  });

  it("is not fooled by a brace inside a comment", () => {
    const out = stubbed(
      `export function f(): void {\n  // a stray { in a comment\n  doThing();\n}\n` +
        `export function g(): void {\n  doOther();\n}\n`
    );
    expect(out).toContain('throw new Error("not implemented: g")');
    expect(out).not.toContain("doOther()");
  });

  it("leaves an overload declaration alone, because it has no body to replace", () => {
    const out = stubbed(
      `export function pick(a: string): string;\nexport function pick(a: number): number;\n` +
        `export function pick(a: unknown): unknown {\n  return a;\n}\n`
    );
    expect(out).toContain("export function pick(a: string): string;");
    expect(out).toContain('throw new Error("not implemented: pick")');
  });

  it("leaves types, interfaces and constants untouched", () => {
    const source =
      `export type Kind = "a" | "b";\n` +
      `export interface Row { readonly id: string }\n` +
      `export const LIMIT = 30;\n` +
      `export function use(): number {\n  return LIMIT;\n}\n`;
    const out = stubbed(source);
    expect(out).toContain('export type Kind = "a" | "b";');
    expect(out).toContain("export interface Row { readonly id: string }");
    expect(out).toContain("export const LIMIT = 30;");
    expect(out).toContain('throw new Error("not implemented: use")');
  });

  it("replaces every function in a file, not only the first", () => {
    const out = stubbed(
      `function one(): void {\n  a();\n}\nexport function two(): void {\n  b();\n}\n` +
        `export async function three(): Promise<void> {\n  await c();\n}\n`
    );
    for (const name of ["one", "two", "three"]) {
      expect(out).toContain(`not implemented: ${name}`);
    }
    expect(out).not.toContain("await c()");
  });
});
