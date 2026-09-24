import { performance } from "node:perf_hooks";
import vm from "node:vm";

export interface SandboxExecutionOptions {
  readonly timeoutMs?: number;
  readonly maxOutputLength?: number;
}

export interface SandboxResult {
  readonly success: boolean;
  readonly result?: unknown;
  readonly outputText?: string;
  readonly error?: string;
  readonly executionTimeMs: number;
  readonly timedOut: boolean;
}

export interface FormulaContext {
  readonly variables: Record<string, number | string | boolean>;
  readonly tables?: Record<string, readonly (readonly unknown[])[]>;
}

const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_MAX_OUTPUT_LENGTH = 65536;

/**
 * The host's own Math, JSON, Date and friends are deliberately NOT handed to the
 * sandbox, and deliberately not frozen.
 *
 * `Object.freeze(Date)` does not make a frozen copy — it freezes the one Date
 * this whole process shares, permanently, as a side effect of importing this
 * file. That made `Date.now` non-writable everywhere, which is a global
 * intrinsic mutated by an import: the exact shape of failure that starts an app
 * with no window and no useful error. It also broke every test in this repo
 * that needed a controllable clock.
 *
 * It bought nothing either. `vm.createContext` gives the sandbox its own realm
 * with its own intrinsics; passing the host's in *replaced* safe ones with
 * reachable ones, and a host constructor inside a vm context is a route back to
 * the host realm through `constructor.constructor`. Leaving them out is both
 * safer and simpler, and the context's own prototypes are frozen from inside,
 * below, where freezing affects only the sandbox.
 */

function formulaSum(...args: readonly unknown[]): number {
  let total = 0;
  const visit = (items: readonly unknown[]): void => {
    for (const item of items) {
      if (Array.isArray(item)) {
        visit(item);
      } else {
        const n = typeof item === "number" ? item : Number(item);
        if (!Number.isNaN(n)) total += n;
      }
    }
  };
  visit(args);
  return total;
}

function formulaAverage(...args: readonly unknown[]): number {
  let total = 0;
  let count = 0;
  const visit = (items: readonly unknown[]): void => {
    for (const item of items) {
      if (Array.isArray(item)) {
        visit(item);
      } else {
        const n = typeof item === "number" ? item : Number(item);
        if (!Number.isNaN(n)) {
          total += n;
          count += 1;
        }
      }
    }
  };
  visit(args);
  return count > 0 ? total / count : 0;
}

function formulaIf(condition: unknown, trueValue: unknown, falseValue: unknown = false): unknown {
  return condition ? trueValue : falseValue;
}

function formulaRound(value: unknown, decimals: unknown = 0): number {
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(num)) return 0;
  const dec = typeof decimals === "number" ? Math.trunc(decimals) : Number(decimals) || 0;
  const factor = 10 ** dec;
  return Math.round((num + Number.EPSILON) * factor) / factor;
}

function formulaIndex(table: unknown, rowIndex: unknown, colIndex: unknown = 1): unknown {
  if (!Array.isArray(table) || table.length === 0) return undefined;
  const r = Math.trunc(Number(rowIndex));
  const row = r >= 1 && r <= table.length ? table[r - 1] : table[r];
  if (!Array.isArray(row)) return row;
  const c = Math.trunc(Number(colIndex));
  return c >= 1 && c <= row.length ? row[c - 1] : row[c];
}

function formulaVLookup(lookupValue: unknown, table: unknown, colIndex: unknown, exactMatch: unknown = true): unknown {
  if (!Array.isArray(table)) return undefined;
  const c = Math.trunc(Number(colIndex));
  const isExact = Boolean(exactMatch);
  for (let i = 0; i < table.length; i++) {
    const row = table[i];
    if (!Array.isArray(row) || row.length === 0) continue;
    const matches = isExact ? row[0] === lookupValue : String(row[0]).toLowerCase() === String(lookupValue).toLowerCase();
    if (matches) {
      if (c >= 1 && c <= row.length) return row[c - 1];
      if (c >= 0 && c < row.length) return row[c];
      return undefined;
    }
  }
  return undefined;
}

function prepareFormulaCode(formula: string): string {
  let cleaned = formula.trim();
  if (cleaned.startsWith("=")) cleaned = cleaned.slice(1).trim();
  cleaned = cleaned.replace(/\bif\s*\(/gi, "IF(").replace(/<>/g, "!==");
  const chunks: string[] = [];
  let inQuote: "'" | '"' | null = null;
  let current = "";
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i]!;
    if (inQuote !== null) {
      current += char;
      if (char === inQuote && cleaned[i - 1] !== "\\") {
        inQuote = null;
        chunks.push(current);
        current = "";
      }
    } else if (char === '"' || char === "'") {
      if (current.length > 0) {
        chunks.push(current.replace(/(?<![<>=!])=(?![=])/g, "==="));
        current = "";
      }
      inQuote = char;
      current += char;
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    chunks.push(inQuote !== null ? current : current.replace(/(?<![<>=!])=(?![=])/g, "==="));
  }
  return chunks.join("");
}

function isTimeoutError(err: unknown): boolean {
  if (err !== null && typeof err === "object") {
    const errObj = err as { readonly code?: unknown; readonly message?: unknown };
    if (errObj.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return true;
    if (typeof errObj.message === "string") {
      const msg = errObj.message.toLowerCase();
      return msg.includes("script execution timed out") || msg.includes("timed out");
    }
  }
  return false;
}

function buildResult(
  success: boolean,
  result: unknown,
  outputText: string,
  error: string | undefined,
  executionTimeMs: number,
  timedOut: boolean
): SandboxResult {
  const roundedTime = Math.max(0, Math.round(executionTimeMs));
  const hasOutput = outputText.length > 0;
  if (success) {
    if (result !== undefined && hasOutput) {
      return { success: true, result, outputText, executionTimeMs: roundedTime, timedOut: false };
    }
    if (result !== undefined) {
      return { success: true, result, executionTimeMs: roundedTime, timedOut: false };
    }
    if (hasOutput) {
      return { success: true, outputText, executionTimeMs: roundedTime, timedOut: false };
    }
    return { success: true, executionTimeMs: roundedTime, timedOut: false };
  }
  const errorMsg = error ?? "Execution failed";
  if (hasOutput) {
    return { success: false, error: errorMsg, outputText, executionTimeMs: roundedTime, timedOut };
  }
  return { success: false, error: errorMsg, executionTimeMs: roundedTime, timedOut };
}

function createSafeContext(
  outputCollector: string[],
  maxOutputLength: number,
  inputs?: Record<string, unknown>
): vm.Context {
  // Math, JSON, Date, Number, String, Array, Boolean and RegExp are absent on
  // purpose: the context supplies its own. See the note at the top of this file.
  const sandbox = Object.create(null) as Record<string, unknown>;

  const appendOutput = (...args: readonly unknown[]): void => {
    const formatted = args.map((a) => {
      if (typeof a === "string") return a;
      if (typeof a === "number" || typeof a === "boolean" || a === null || a === undefined) return String(a);
      try { return JSON.stringify(a); } catch { return String(a); } 
    }).join(" ");
    const currentLen = outputCollector.reduce((sum, s) => sum + s.length, 0);
    if (currentLen < maxOutputLength) {
      const remaining = maxOutputLength - currentLen;
      const toAdd = formatted.length + 1 > remaining ? formatted.slice(0, remaining) + "\n" : formatted + "\n";
      outputCollector.push(toAdd);
    }
  };

  sandbox["console"] = Object.freeze({
    log: appendOutput,
    info: appendOutput,
    warn: appendOutput,
    error: appendOutput,
  });

  sandbox["SUM"] = formulaSum;
  sandbox["sum"] = formulaSum;
  sandbox["AVERAGE"] = formulaAverage;
  sandbox["average"] = formulaAverage;
  sandbox["IF"] = formulaIf;
  sandbox["ROUND"] = formulaRound;
  sandbox["round"] = formulaRound;
  sandbox["MIN"] = Math.min;
  sandbox["min"] = Math.min;
  sandbox["MAX"] = Math.max;
  sandbox["max"] = Math.max;
  sandbox["ABS"] = Math.abs;
  sandbox["abs"] = Math.abs;
  sandbox["INDEX"] = formulaIndex;
  sandbox["index"] = formulaIndex;
  sandbox["VLOOKUP"] = formulaVLookup;
  sandbox["vlookup"] = formulaVLookup;

  // Transfer inputs via serialized JSON string so context prototypes isolate all parsed objects
  if (inputs !== undefined) {
    try {
      sandbox["__rawInputs"] = JSON.stringify(inputs);
    } catch {
      throw new Error("Inputs could not be serialized into the sandbox");
    }
  }

  // Disallow string-based code generation to block eval and Function escapes
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  const initScript = `
    "use strict";
    if (typeof __rawInputs === "string") {
      const parsed = JSON.parse(__rawInputs);
      for (const key of Object.keys(parsed)) {
        if (key !== "__proto__" && key !== "constructor" && key !== "prototype") {
          globalThis[key] = parsed[key];
        }
      }
      globalThis.inputs = parsed;
      delete globalThis.__rawInputs;
    }
    delete globalThis.eval;
    delete globalThis.Function;
    delete globalThis.process;
    delete globalThis.require;
    try {
      if (typeof Object !== "undefined" && Object.prototype) Object.freeze(Object.prototype);
      if (typeof Array !== "undefined" && Array.prototype) Object.freeze(Array.prototype);
      if (typeof String !== "undefined" && String.prototype) Object.freeze(String.prototype);
      if (typeof Number !== "undefined" && Number.prototype) Object.freeze(Number.prototype);
      if (typeof Boolean !== "undefined" && Boolean.prototype) Object.freeze(Boolean.prototype);
      if (typeof Date !== "undefined" && Date.prototype) Object.freeze(Date.prototype);
      if (typeof RegExp !== "undefined" && RegExp.prototype) Object.freeze(RegExp.prototype);
      if (typeof Error !== "undefined" && Error.prototype) Object.freeze(Error.prototype);
    } catch {
      // Prototypes already immutable
    }
  `;
  vm.runInContext(initScript, context, { timeout: 500 });
  return context;
}

export function runInSandbox(
  code: string,
  inputs?: Record<string, unknown>,
  options?: SandboxExecutionOptions
): SandboxResult {
  const startTime = performance.now();
  const timeoutMs = options?.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxOutputLength = options?.maxOutputLength !== undefined && options.maxOutputLength > 0 ? options.maxOutputLength : DEFAULT_MAX_OUTPUT_LENGTH;

  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return { success: true, executionTimeMs: Math.max(0, Math.round(performance.now() - startTime)), timedOut: false };
  }

  const outputCollector: string[] = [];
  let context: vm.Context;
  try {
    context = createSafeContext(outputCollector, maxOutputLength, inputs);
  } catch (setupError) {
    const elapsed = performance.now() - startTime;
    return buildResult(false, undefined, "", setupError instanceof Error ? setupError.message : String(setupError), elapsed, false);
  }

  let result: unknown;
  try {
    result = vm.runInContext(code, context, { timeout: timeoutMs, displayErrors: true });
  } catch (err) {
    const isTimeout = isTimeoutError(err);
    if (isTimeout) {
      return buildResult(false, undefined, outputCollector.join("").slice(0, maxOutputLength), "Execution timed out", performance.now() - startTime, true);
    }
    if (err instanceof SyntaxError && err.message.includes("return statement")) {
      try {
        result = vm.runInContext(`(() => {\n${code}\n})()`, context, { timeout: timeoutMs, displayErrors: true });
      } catch (retryErr) {
        const retryTimeout = isTimeoutError(retryErr);
        const msg = retryTimeout ? "Execution timed out" : retryErr instanceof Error ? retryErr.message : String(retryErr);
        return buildResult(false, undefined, outputCollector.join("").slice(0, maxOutputLength), msg, performance.now() - startTime, retryTimeout);
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      return buildResult(false, undefined, outputCollector.join("").slice(0, maxOutputLength), msg, performance.now() - startTime, false);
    }
  }

  const elapsed = performance.now() - startTime;
  return buildResult(true, result, outputCollector.join("").slice(0, maxOutputLength), undefined, elapsed, false);
}

export function evaluateFormula(
  formula: string,
  context?: FormulaContext,
  options?: SandboxExecutionOptions
): SandboxResult {
  const trimmed = formula.trim();
  if (trimmed.length === 0) {
    return { success: true, executionTimeMs: 0, timedOut: false };
  }
  const inputs: Record<string, unknown> = {};
  if (context !== undefined) {
    if (context.variables !== undefined) {
      for (const [k, v] of Object.entries(context.variables)) inputs[k] = v;
      inputs["variables"] = context.variables;
    }
    if (context.tables !== undefined) {
      for (const [k, v] of Object.entries(context.tables)) inputs[k] = v;
      inputs["tables"] = context.tables;
    }
  }
  return runInSandbox(prepareFormulaCode(trimmed), inputs, options);
}

export function transformTabularData(
  records: readonly Record<string, unknown>[],
  transformCode: string,
  options?: SandboxExecutionOptions
): { readonly success: boolean; readonly records?: readonly Record<string, unknown>[]; readonly error?: string } {
  const trimmed = transformCode.trim();
  if (records.length === 0) {
    return { success: true, records: [] };
  }

  let safeRecords: Record<string, unknown>[];
  try {
    safeRecords = JSON.parse(JSON.stringify(records)) as Record<string, unknown>[];
  } catch {
    return { success: false, error: "Records could not be serialized" };
  }

  const directRun = runInSandbox(trimmed, { records: safeRecords }, options);
  if (directRun.timedOut) {
    return { success: false, error: directRun.error ?? "Execution timed out" };
  }
  if (directRun.success) {
    if (Array.isArray(directRun.result)) {
      const sanitized: Record<string, unknown>[] = [];
      for (const item of directRun.result) {
        sanitized.push(typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : { value: item });
      }
      return { success: true, records: sanitized };
    }
    if (typeof directRun.result === "function") {
      const mapCode = `const __fn = (${trimmed}); records.map((record, index) => __fn(record, index))`;
      const fnRun = runInSandbox(mapCode, { records: safeRecords }, options);
      if (fnRun.timedOut) return { success: false, error: fnRun.error ?? "Execution timed out" };
      if (fnRun.success && Array.isArray(fnRun.result)) {
        const sanitized: Record<string, unknown>[] = [];
        for (const item of fnRun.result) {
          sanitized.push(typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : { value: item });
        }
        return { success: true, records: sanitized };
      }
    }
  }

  const perRecordCode = trimmed.includes("return")
    ? `records.map((record, index) => { ${trimmed} })`
    : `records.map((record, index) => (${trimmed}))`;
  const mapRun = runInSandbox(perRecordCode, { records: safeRecords }, options);
  if (mapRun.timedOut) {
    return { success: false, error: mapRun.error ?? "Execution timed out" };
  }
  if (mapRun.success && Array.isArray(mapRun.result)) {
    const sanitized: Record<string, unknown>[] = [];
    for (const item of mapRun.result) {
      sanitized.push(typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : { value: item });
    }
    return { success: true, records: sanitized };
  }

  return { success: false, error: directRun.error ?? mapRun.error ?? "Transform failed to return valid records" };
}
