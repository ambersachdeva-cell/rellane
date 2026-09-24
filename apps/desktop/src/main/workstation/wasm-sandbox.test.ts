import { describe, expect, it } from "vitest";
import { evaluateFormula, runInSandbox, transformTabularData } from "./wasm-sandbox.js";

describe("wasm-sandbox", () => {
  describe("basic transformations", () => {
    it("evaluates arithmetic and string operations", () => {
      const mathResult = runInSandbox("Math.max(10, 20) + 4");
      expect(mathResult.success).toBe(true);
      expect(mathResult.result).toBe(24);
      expect(mathResult.timedOut).toBe(false);

      const strResult = runInSandbox("'  hello world  '.trim().toUpperCase()");
      expect(strResult.success).toBe(true);
      expect(strResult.result).toBe("HELLO WORLD");
    });

    it("evaluates code with input variables", () => {
      const res = runInSandbox("a * b + c", { a: 6, b: 7, c: 2 });
      expect(res.success).toBe(true);
      expect(res.result).toBe(44);
    });

    it("captures console log output", () => {
      const res = runInSandbox("console.log('first'); console.log('second'); 99");
      expect(res.success).toBe(true);
      expect(res.result).toBe(99);
      expect(res.outputText).toBe("first\nsecond\n");
    });
  });

  describe("formula evaluations", () => {
    it("evaluates SUM, AVERAGE, IF, and ROUND", () => {
      const sumRes = evaluateFormula("=SUM(1, 2, 3)");
      expect(sumRes.success).toBe(true);
      expect(sumRes.result).toBe(6);

      const avgRes = evaluateFormula("=AVERAGE(10, 20)");
      expect(avgRes.success).toBe(true);
      expect(avgRes.result).toBe(15);

      const ifHigh = evaluateFormula("=IF(x > 5, 'high', 'low')", { variables: { x: 10 } });
      expect(ifHigh.success).toBe(true);
      expect(ifHigh.result).toBe("high");

      const ifLow = evaluateFormula("=IF(x > 5, 'high', 'low')", { variables: { x: 2 } });
      expect(ifLow.success).toBe(true);
      expect(ifLow.result).toBe("low");

      const roundRes = evaluateFormula("=ROUND(v, 2)", { variables: { v: 3.14159 } });
      expect(roundRes.success).toBe(true);
      expect(roundRes.result).toBe(3.14);
    });

    it("evaluates table lookups using VLOOKUP", () => {
      const ctx = { 
        variables: {},
        tables: { rates: [["standard", 1.2], ["express", 1.8]] },
      };
      const res = evaluateFormula("=VLOOKUP('express', rates, 2)", ctx);
      expect(res.success).toBe(true);
      expect(res.result).toBe(1.8);
    });
  });

  describe("data transformation", () => {
    const records = [
      { id: 1, name: "Alpha", price: 100, qty: 2 },
      { id: 2, name: "Beta", price: 200, qty: 3 },
    ] as const;

    it("maps over records using array expression", () => {
      const res = transformTabularData(records, "records.map(r => ({ ...r, total: r.price * r.qty }))");
      expect(res.success).toBe(true);
      expect(res.records).toEqual([
        { id: 1, name: "Alpha", price: 100, qty: 2, total: 200 },
        { id: 2, name: "Beta", price: 200, qty: 3, total: 600 },
      ]);
    });

    it("maps over records using arrow function", () => {
      const res = transformTabularData(records, "r => ({ ...r, available: true })");
      expect(res.success).toBe(true);
      expect(res.records).toEqual([
        { id: 1, name: "Alpha", price: 100, qty: 2, available: true },
        { id: 2, name: "Beta", price: 200, qty: 3, available: true },
      ]);
    });

    it("does not mutate original input records", () => {
      const original = [{ id: 1, count: 5 }];
      transformTabularData(original, "records.map(r => { r.count = 999; return r; })");
      expect(original[0]?.count).toBe(5);
    });
  });

  describe("infinite loop protection", () => {
    it("terminates infinite loop within timeoutMs and returns timedOut: true", () => {
      const res = runInSandbox("while (true) {}", undefined, { timeoutMs: 50 });
      expect(res.success).toBe(false);
      expect(res.timedOut).toBe(true);
      expect(res.error).toBe("Execution timed out");
      expect(res.result).toBeUndefined();
    });

    it("terminates infinite loop in tabular transform safely", () => {
      const res = transformTabularData([{ id: 1 }], "while (true) {}", { timeoutMs: 50 });
      expect(res.success).toBe(false);
      expect(res.error).toContain("timed out");
      expect(res.records).toBeUndefined();
    });
  });

  describe("sandbox security", () => {
    it("fails safely when attempting to access process or require", () => {
      const pRes = runInSandbox("process.exit(1)");
      expect(pRes.success).toBe(false);
      expect(pRes.error).toBeDefined();

      const rRes = runInSandbox("require('node:fs')");
      expect(rRes.success).toBe(false);
      expect(rRes.error).toBeDefined();
    });

    it("prevents prototype breakout via constructor chain", () => {
      const res1 = runInSandbox("this.constructor.constructor('return process')()");
      expect(res1.success).toBe(false);

      const res2 = runInSandbox("({}).constructor.constructor('return process')()");
      expect(res2.success).toBe(false);
    });

    it("prevents prototype pollution from reaching host", () => {
      runInSandbox("Object.prototype.polluted = true;");
      expect((Object.prototype as unknown as Record<string, unknown>)["polluted"]).toBeUndefined();
    });

    it("blocks code generation via eval and Function", () => {
      const evalRes = runInSandbox("eval('1 + 1')");
      expect(evalRes.success).toBe(false);

      const fnRes = runInSandbox("Function('return 1')()");
      expect(fnRes.success).toBe(false);
    });

    /**
     * Importing this module once froze the host's own Date, Math, JSON and four
     * other intrinsics, process-wide, because `Object.freeze(Date)` freezes the
     * shared Date rather than making a frozen copy. It reached production code
     * through the agent loop and it broke every test in this repo that needed a
     * controllable clock. The typechecker cannot see it, so this does.
     */
    it("leaves the host's own globals alone", () => {
      for (const intrinsic of [Date, Math, JSON, Number, String, Array, Boolean, RegExp]) {
        expect(Object.isFrozen(intrinsic)).toBe(false);
      }
      expect(Object.getOwnPropertyDescriptor(Date, "now")?.writable).toBe(true);
      runInSandbox("1 + 1");
      expect(Object.getOwnPropertyDescriptor(Date, "now")?.writable).toBe(true);
    });

    it("still gives sandboxed code its own working Date, Math and JSON", () => {
      const result = runInSandbox(
        "typeof Date.now() === 'number' && Math.max(1, 2) === 2 && JSON.parse('[1]')[0] === 1"
      );
      expect(result.success).toBe(true);
      expect(result.result).toBe(true);
    });
  });
});
