export type ColumnType = "integer" | "real" | "text" | "boolean" | "date";

export interface ColumnSchema {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
}

export interface ColumnStats {
  readonly name: string;
  readonly type: ColumnType;
  readonly count: number;
  readonly nullCount: number;
  readonly distinctCount: number;
  readonly min?: number | string;
  readonly max?: number | string;
  readonly mean?: number;
}

export interface QueryResult {
  readonly columns: readonly ColumnSchema[];
  readonly rows: readonly (readonly unknown[])[];
  readonly rowCount: number;
  readonly executionTimeMs: number;
  readonly error?: string;
}

export interface TabularWorkbench {
  createTableFromRecords(tableName: string, records: readonly Record<string, unknown>[]): readonly ColumnSchema[];
  createTableFromCsv(tableName: string, csvContent: string): readonly ColumnSchema[];
  listTables(): readonly string[];
  getTableSchema(tableName: string): readonly ColumnSchema[] | undefined;
  calculateStats(tableName: string): readonly ColumnStats[];
  execute(sql: string): QueryResult;
  exportToCsv(queryResultOrTableName: QueryResult | string): string;
  exportToMarkdown(queryResultOrTableName: QueryResult | string): string;
}

interface InternalTable {
  readonly name: string;
  readonly schema: readonly ColumnSchema[];
  readonly rows: readonly (readonly unknown[])[];
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const INTEGER_PATTERN = /^-?\d+$/;
const REAL_PATTERN = /^-?(?:\d+\.\d+|\d+\.|\.\d+)(?:[eE][+-]?\d+)?$|^-?\d+[eE][+-]?\d+$/;

function parseCsvRows(content: string): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;
  const len = content.length;

  while (i < len) {
    const char = content[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < len && content[i + 1] === '"') {
          currentField += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        currentField += char;
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === ",") {
        currentRow.push(currentField);
        currentField = "";
        i++;
      } else if (char === "\r") {
        if (i + 1 < len && content[i + 1] === "\n") {
          i++;
        }
        currentRow.push(currentField);
        currentField = "";
        rows.push(currentRow);
        currentRow = [];
        i++;
      } else if (char === "\n") {
        currentRow.push(currentField);
        currentField = "";
        rows.push(currentRow);
        currentRow = [];
        i++;
      } else {
        currentField += char;
        i++;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  if (rows.length > 0) {
    const lastRow = rows[rows.length - 1]!;
    if (lastRow.length === 1 && lastRow[0] === "") {
      rows.pop();
    }
  }

  return rows;
}

function inferScalarType(val: unknown): ColumnType | null {
  if (val === null || val === undefined || val === "") {
    return null;
  }
  if (typeof val === "boolean") {
    return "boolean";
  }
  if (typeof val === "number") {
    return Number.isSafeInteger(val) ? "integer" : "real";
  }
  if (val instanceof Date) {
    return "date";
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed === "") {
      return null;
    }
    const lower = trimmed.toLowerCase();
    if (lower === "true" || lower === "false") {
      return "boolean";
    }
    if (INTEGER_PATTERN.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isSafeInteger(num)) {
        return "integer";
      }
    }
    if (REAL_PATTERN.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isNaN(num)) {
        return "real";
      }
    }
    if (ISO_DATE_PATTERN.test(trimmed)) {
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) {
        return "date";
      }
    }
    return "text";
  }
  return "text";
}

function resolveColumnType(inferred: readonly (ColumnType | null)[]): ColumnType {
  const nonNull = inferred.filter((t): t is ColumnType => t !== null);
  if (nonNull.length === 0) {
    return "text";
  }
  const unique = new Set(nonNull);
  if (unique.size === 1) {
    return nonNull[0]!;
  }
  if (unique.size === 2 && unique.has("integer") && unique.has("real")) {
    return "real";
  }
  return "text";
}

function castScalarValue(val: unknown, target: ColumnType): unknown {
  if (val === null || val === undefined || val === "") {
    return null;
  }
  if (target === "integer") {
    if (typeof val === "number") return Math.trunc(val);
    if (typeof val === "string") {
      const n = parseInt(val.trim(), 10);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  }
  if (target === "real") {
    if (typeof val === "number") return val;
    if (typeof val === "string") {
      const n = parseFloat(val.trim());
      return Number.isNaN(n) ? null : n;
    }
    return null;
  }
  if (target === "boolean") {
    if (typeof val === "boolean") return val;
    if (typeof val === "string") {
      const l = val.trim().toLowerCase();
      if (l === "true") return true;
      if (l === "false") return false;
    }
    return null;
  }
  if (target === "date") {
    if (val instanceof Date) return val.toISOString();
    if (typeof val === "string") return val.trim();
    return String(val);
  }
  return typeof val === "string" ? val : String(val);
}

type TokenType = "KEYWORD" | "IDENTIFIER" | "STRING" | "NUMBER" | "SYMBOL";

interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly pos: number;
}

const SQL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "ASC", "DESC",
  "LIMIT", "OFFSET", "AND", "OR", "NOT", "IS", "NULL", "LIKE", "IN", "BETWEEN",
  "AS", "DISTINCT", "TRUE", "FALSE", "COUNT", "SUM", "AVG", "MIN", "MAX"
]);

function tokenize(sql: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const char = sql[i]!;
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === "-" && i + 1 < len && sql[i + 1] === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n" && sql[i] !== "\r") {
        i++;
      }
      continue;
    }
    if (char === "/" && i + 1 < len && sql[i + 1] === "*") {
      i += 2;
      while (i < len && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }
    if (char === "'") {
      const start = i;
      i++;
      let str = "";
      while (i < len) {
        if (sql[i] === "'") {
          if (i + 1 < len && sql[i + 1] === "'") {
            str += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          str += sql[i]!;
          i++;
        }
      }
      tokens.push({ type: "STRING", value: str, pos: start });
      continue;
    }
    if (char === '"' || char === "`" || char === "[") {
      const closing = char === "[" ? "]" : char;
      const start = i;
      i++;
      let ident = "";
      while (i < len && sql[i] !== closing) {
        ident += sql[i]!;
        i++;
      }
      if (i < len) i++;
      tokens.push({ type: "IDENTIFIER", value: ident, pos: start });
      continue;
    }
    if (/\d/.test(char) || (char === "." && i + 1 < len && /\d/.test(sql[i + 1]!))) {
      const start = i;
      let numStr = "";
      while (i < len && /[\d.eE+-]/.test(sql[i]!)) {
        const curr = sql[i]!;
        if ((curr === "+" || curr === "-") && i > start) {
          const prev = sql[i - 1]!;
          if (prev !== "e" && prev !== "E") {
            break;
          }
        }
        numStr += curr;
        i++;
      }
      tokens.push({ type: "NUMBER", value: numStr, pos: start });
      continue;
    }
    if (i + 1 < len) {
      const two = char + sql[i + 1]!;
      if (two === "!=" || two === "<>" || two === "<=" || two === ">=") {
        tokens.push({ type: "SYMBOL", value: two, pos: i });
        i += 2;
        continue;
      }
    }
    if (/[(),.*=<>+/%-;]/.test(char)) {
      tokens.push({ type: "SYMBOL", value: char, pos: i });
      i++;
      continue;
    }
    if (/[a-zA-Z_]/.test(char)) {
      const start = i;
      let word = "";
      while (i < len && /[a-zA-Z0-9_]/.test(sql[i]!)) {
        word += sql[i]!;
        i++;
      }
      const upper = word.toUpperCase();
      if (SQL_KEYWORDS.has(upper)) {
        tokens.push({ type: "KEYWORD", value: upper, pos: start });
      } else {
        tokens.push({ type: "IDENTIFIER", value: word, pos: start });
      }
      continue;
    }
    i++;
  }

  return tokens;
}

type AggregateFunc = "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";

type Expr =
  | { readonly kind: "star" }
  | { readonly kind: "table_star"; readonly table: string }
  | { readonly kind: "column"; readonly column: string; readonly table?: string }
  | { readonly kind: "literal"; readonly value: unknown; readonly rawType: ColumnType }
  | { readonly kind: "aggregate"; readonly func: AggregateFunc; readonly distinct: boolean; readonly arg: Expr }
  | { readonly kind: "unary"; readonly op: "NOT" | "-"; readonly expr: Expr }
  | { readonly kind: "binary"; readonly op: string; readonly left: Expr; readonly right: Expr }
  | { readonly kind: "is_null"; readonly expr: Expr; readonly not: boolean }
  | { readonly kind: "like"; readonly expr: Expr; readonly pattern: Expr; readonly not: boolean }
  | { readonly kind: "in"; readonly expr: Expr; readonly list: readonly Expr[]; readonly not: boolean }
  | { readonly kind: "between"; readonly expr: Expr; readonly low: Expr; readonly high: Expr; readonly not: boolean };

interface SelectItem {
  readonly expr: Expr;
  readonly alias?: string;
}

interface OrderItem {
  readonly expr: Expr;
  readonly direction: "ASC" | "DESC";
}

interface ParsedQuery {
  readonly distinct: boolean;
  readonly select: readonly SelectItem[];
  readonly from?: { readonly table: string; readonly alias?: string };
  readonly where?: Expr;
  readonly groupBy?: readonly Expr[];
  readonly having?: Expr;
  readonly orderBy?: readonly OrderItem[];
  readonly limit?: number;
  readonly offset?: number;
}

function parseQuery(tokens: readonly Token[]): ParsedQuery {
  let pos = 0;

  const peek = (): Token | undefined => (pos < tokens.length ? tokens[pos] : undefined);
  const matchKeyword = (kw: string): boolean => {
    const t = peek();
    if (t !== undefined && t.type === "KEYWORD" && t.value === kw) {
      pos++;
      return true;
    }
    return false;
  };
  const matchSymbol = (sym: string): boolean => {
    const t = peek();
    if (t !== undefined && t.type === "SYMBOL" && t.value === sym) {
      pos++;
      return true;
    }
    return false;
  };
  const expectKeyword = (kw: string): void => {
    if (!matchKeyword(kw)) {
      throw new Error(`Expected keyword ${kw}`);
    }
  };
  const expectSymbol = (sym: string): void => {
    if (!matchSymbol(sym)) {
      throw new Error(`Expected symbol ${sym}`);
    }
  };

  const parsePrimary = (): Expr => {
    if (matchSymbol("(")) {
      const expr = parseExpr();
      expectSymbol(")");
      return expr;
    }
    const curr = peek();
    if (curr === undefined) {
      throw new Error("Unexpected end of input");
    }
    if (curr.type === "KEYWORD" && ["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(curr.value)) {
      if (pos + 1 < tokens.length && tokens[pos + 1]!.value === "(") {
        pos += 2;
        const func = curr.value as AggregateFunc;
        if (func === "COUNT" && matchSymbol("*")) {
          expectSymbol(")");
          return { kind: "aggregate", func: "COUNT", distinct: false, arg: { kind: "star" } };
        }
        const distinct = matchKeyword("DISTINCT");
        const arg = parseExpr();
        expectSymbol(")");
        return { kind: "aggregate", func, distinct, arg };
      }
    }
    if (matchKeyword("NULL")) {
      return { kind: "literal", value: null, rawType: "text" };
    }
    if (matchKeyword("TRUE")) {
      return { kind: "literal", value: true, rawType: "boolean" };
    }
    if (matchKeyword("FALSE")) {
      return { kind: "literal", value: false, rawType: "boolean" };
    }
    if (curr.type === "STRING") {
      pos++;
      return { kind: "literal", value: curr.value, rawType: "text" };
    }
    if (curr.type === "NUMBER") {
      pos++;
      const num = Number(curr.value);
      return { kind: "literal", value: num, rawType: Number.isInteger(num) ? "integer" : "real" };
    }
    if (matchSymbol("*")) {
      return { kind: "star" };
    }
    if (curr.type === "IDENTIFIER" || curr.type === "KEYWORD") {
      pos++;
      const name = curr.value;
      if (matchSymbol(".")) {
        if (matchSymbol("*")) {
          return { kind: "table_star", table: name };
        }
        const colToken = peek();
        if (colToken !== undefined && (colToken.type === "IDENTIFIER" || colToken.type === "KEYWORD")) {
          pos++;
          return { kind: "column", table: name, column: colToken.value };
        }
      }
      return { kind: "column", column: name };
    }
    throw new Error(`Unexpected token at position ${curr.pos}: ${curr.value}`);
  };

  const parseUnary = (): Expr => {
    const sym = peek();
    if (sym !== undefined && sym.type === "SYMBOL" && sym.value === "-") {
      pos++;
      return { kind: "unary", op: "-", expr: parseUnary() };
    }
    if (sym !== undefined && sym.type === "SYMBOL" && sym.value === "+") {
      pos++;
      return parseUnary();
    }
    return parsePrimary();
  };

  const parseMultiplication = (): Expr => {
    let left = parseUnary();
    while (true) {
      const sym = peek();
      if (sym !== undefined && sym.type === "SYMBOL" && (sym.value === "*" || sym.value === "/" || sym.value === "%")) {
        pos++;
        const right = parseUnary();
        left = { kind: "binary", op: sym.value, left, right };
      } else {
        break;
      }
    }
    return left;
  };

  const parseAddition = (): Expr => {
    let left = parseMultiplication();
    while (true) {
      const sym = peek();
      if (sym !== undefined && sym.type === "SYMBOL" && (sym.value === "+" || sym.value === "-")) {
        pos++;
        const right = parseMultiplication();
        left = { kind: "binary", op: sym.value, left, right };
      } else {
        break;
      }
    }
    return left;
  };

  const parseComparison = (): Expr => {
    const left = parseAddition();
    if (matchKeyword("IS")) {
      const not = matchKeyword("NOT");
      expectKeyword("NULL");
      return { kind: "is_null", expr: left, not };
    }
    const notToken = matchKeyword("NOT");
    if (matchKeyword("LIKE")) {
      const pattern = parseAddition();
      return { kind: "like", expr: left, pattern, not: notToken };
    }
    if (matchKeyword("IN")) {
      expectSymbol("(");
      const list: Expr[] = [];
      if (!matchSymbol(")")) {
        do {
          list.push(parseExpr());
        } while (matchSymbol(","));
        expectSymbol(")");
      }
      return { kind: "in", expr: left, list, not: notToken };
    }
    if (matchKeyword("BETWEEN")) {
      const low = parseAddition();
      expectKeyword("AND");
      const high = parseAddition();
      return { kind: "between", expr: left, low, high, not: notToken };
    }
    const sym = peek();
    if (sym !== undefined && sym.type === "SYMBOL" && ["=", "!=", "<>", "<", "<=", ">", ">="].includes(sym.value)) {
      pos++;
      const right = parseAddition();
      return { kind: "binary", op: sym.value === "<>" ? "!=" : sym.value, left, right };
    }
    return left;
  };

  const parseNot = (): Expr => {
    if (matchKeyword("NOT")) {
      return { kind: "unary", op: "NOT", expr: parseNot() };
    }
    return parseComparison();
  };

  const parseAnd = (): Expr => {
    let left = parseNot();
    while (matchKeyword("AND")) {
      const right = parseNot();
      left = { kind: "binary", op: "AND", left, right };
    }
    return left;
  };

  const parseOr = (): Expr => {
    let left = parseAnd();
    while (matchKeyword("OR")) {
      const right = parseAnd();
      left = { kind: "binary", op: "OR", left, right };
    }
    return left;
  };

  const parseExpr = (): Expr => parseOr();

  expectKeyword("SELECT");
  const distinct = matchKeyword("DISTINCT");
  const selectItems: SelectItem[] = [];

  do {
    const expr = parseExpr();
    let alias: string | undefined;
    if (matchKeyword("AS")) {
      const aliasTok = peek();
      if (aliasTok !== undefined && (aliasTok.type === "IDENTIFIER" || aliasTok.type === "STRING" || aliasTok.type === "KEYWORD")) {
        pos++;
        alias = aliasTok.value;
      }
    } else {
      const next = peek();
      if (next !== undefined && (next.type === "IDENTIFIER" || next.type === "STRING") && next.value !== "FROM" && next.value !== "WHERE") {
        pos++;
        alias = next.value;
      }
    }
    if (alias !== undefined) {
      selectItems.push({ expr, alias });
    } else {
      selectItems.push({ expr });
    }
  } while (matchSymbol(","));

  let fromClause: { readonly table: string; readonly alias?: string } | undefined;
  if (matchKeyword("FROM")) {
    const tableTok = peek();
    if (tableTok === undefined) {
      throw new Error("Expected table name after FROM");
    }
    pos++;
    const tableName = tableTok.value;
    let tableAlias: string | undefined;
    if (matchKeyword("AS")) {
      const aTok = peek();
      if (aTok !== undefined) {
        pos++;
        tableAlias = aTok.value;
      }
    } else {
      const next = peek();
      if (next !== undefined && (next.type === "IDENTIFIER" || next.type === "STRING") && !SQL_KEYWORDS.has(next.value)) {
        pos++;
        tableAlias = next.value;
      }
    }
    if (tableAlias !== undefined) {
      fromClause = { table: tableName, alias: tableAlias };
    } else {
      fromClause = { table: tableName };
    }
  }

  let whereClause: Expr | undefined;
  if (matchKeyword("WHERE")) {
    whereClause = parseExpr();
  }

  let groupByClause: Expr[] | undefined;
  if (matchKeyword("GROUP")) {
    expectKeyword("BY");
    groupByClause = [];
    do {
      groupByClause.push(parseExpr());
    } while (matchSymbol(","));
  }

  let havingClause: Expr | undefined;
  if (matchKeyword("HAVING")) {
    havingClause = parseExpr();
  }

  let orderByClause: OrderItem[] | undefined;
  if (matchKeyword("ORDER")) {
    expectKeyword("BY");
    orderByClause = [];
    do {
      const expr = parseExpr();
      let direction: "ASC" | "DESC" = "ASC";
      if (matchKeyword("DESC")) {
        direction = "DESC";
      } else {
        matchKeyword("ASC");
      }
      orderByClause.push({ expr, direction });
    } while (matchSymbol(","));
  }

  let limitVal: number | undefined;
  let offsetVal: number | undefined;
  if (matchKeyword("LIMIT")) {
    const numTok = peek();
    if (numTok !== undefined && numTok.type === "NUMBER") {
      pos++;
      const first = parseInt(numTok.value, 10);
      if (matchSymbol(",")) {
        const secondTok = peek();
        if (secondTok !== undefined && secondTok.type === "NUMBER") {
          pos++;
          offsetVal = first;
          limitVal = parseInt(secondTok.value, 10);
        }
      } else {
        limitVal = first;
        if (matchKeyword("OFFSET")) {
          const offTok = peek();
          if (offTok !== undefined && offTok.type === "NUMBER") {
            pos++;
            offsetVal = parseInt(offTok.value, 10);
          }
        }
      }
    }
  }

  matchSymbol(";");

  const parsed: { -readonly [K in keyof ParsedQuery]?: ParsedQuery[K] } = {
    distinct,
    select: selectItems
  };
  if (fromClause !== undefined) parsed.from = fromClause;
  if (whereClause !== undefined) parsed.where = whereClause;
  if (groupByClause !== undefined) parsed.groupBy = groupByClause;
  if (havingClause !== undefined) parsed.having = havingClause;
  if (orderByClause !== undefined) parsed.orderBy = orderByClause;
  if (limitVal !== undefined) parsed.limit = limitVal;
  if (offsetVal !== undefined) parsed.offset = offsetVal;

  return parsed as ParsedQuery;
}

interface RowContext {
  getValue(column: string, table?: string): unknown;
}

function makeRowContext(values: readonly unknown[], schema: readonly ColumnSchema[], tableAlias?: string, tableName?: string): RowContext {
  return {
    getValue(colName: string, reqTable?: string): unknown {
      if (reqTable !== undefined) {
        const lowerReq = reqTable.toLowerCase();
        const aliasMatch = tableAlias !== undefined && tableAlias.toLowerCase() === lowerReq;
        const nameMatch = tableName !== undefined && tableName.toLowerCase() === lowerReq;
        if (!aliasMatch && !nameMatch) {
          return null;
        }
      }
      const lowerCol = colName.toLowerCase();
      for (let i = 0; i < schema.length; i++) {
        if (schema[i]!.name.toLowerCase() === lowerCol) {
          return i < values.length ? values[i]! : null;
        }
      }
      return null;
    }
  };
}

function toBoolean(val: unknown): boolean {
  if (val === null || val === undefined) return false;
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") {
    const l = val.trim().toLowerCase();
    return l === "true" || l === "1";
  }
  return false;
}

function toNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return Number.isNaN(val) ? null : val;
  if (typeof val === "string") {
    const n = Number(val);
    return Number.isNaN(n) ? null : n;
  }
  if (typeof val === "boolean") return val ? 1 : 0;
  return null;
}

function sqlEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "string") return a === Number(b);
  if (typeof a === "string" && typeof b === "number") return Number(a) === b;
  if (typeof a === "boolean" && typeof b === "string") return String(a).toLowerCase() === b.toLowerCase();
  if (typeof a === "string" && typeof b === "boolean") return a.toLowerCase() === String(b).toLowerCase();
  return false;
}

function sqlCompare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  const numA = toNumber(a);
  const numB = toNumber(b);
  if (numA !== null && numB !== null) {
    return numA - numB;
  }
  return String(a).localeCompare(String(b));
}

function evaluateBinaryOp(op: string, left: unknown, right: unknown): unknown {
  if (op === "=") {
    if (left === null || left === undefined || right === null || right === undefined) return false;
    return sqlEquals(left, right);
  }
  if (op === "!=") {
    if (left === null || left === undefined || right === null || right === undefined) return false;
    return !sqlEquals(left, right);
  }
  if (op === "<") {
    if (left === null || left === undefined || right === null || right === undefined) return false;
    return sqlCompare(left, right) < 0;
  }
  if (op === "<=") {
    if (left === null || left === undefined || right === null || right === undefined) return false;
    return sqlCompare(left, right) <= 0;
  }
  if (op === ">") {
    if (left === null || left === undefined || right === null || right === undefined) return false;
    return sqlCompare(left, right) > 0;
  }
  if (op === ">=") {
    if (left === null || left === undefined || right === null || right === undefined) return false;
    return sqlCompare(left, right) >= 0;
  }
  const nLeft = toNumber(left);
  const nRight = toNumber(right);
  if (nLeft === null || nRight === null) return null;
  if (op === "+") return nLeft + nRight;
  if (op === "-") return nLeft - nRight;
  if (op === "*") return nLeft * nRight;
  if (op === "/") return nRight === 0 ? null : nLeft / nRight;
  if (op === "%") return nRight === 0 ? null : nLeft % nRight;
  return null;
}

function evaluateScalarExpr(expr: Expr, ctx: RowContext): unknown {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "column":
      return ctx.getValue(expr.column, expr.table);
    case "unary": {
      const val = evaluateScalarExpr(expr.expr, ctx);
      if (expr.op === "NOT") return !toBoolean(val);
      if (expr.op === "-") {
        const n = toNumber(val);
        return n === null ? null : -n;
      }
      return val;
    }
    case "binary": {
      if (expr.op === "AND") {
        const l = evaluateScalarExpr(expr.left, ctx);
        if (!toBoolean(l)) return false;
        const r = evaluateScalarExpr(expr.right, ctx);
        return toBoolean(r);
      }
      if (expr.op === "OR") {
        const l = evaluateScalarExpr(expr.left, ctx);
        if (toBoolean(l)) return true;
        const r = evaluateScalarExpr(expr.right, ctx);
        return toBoolean(r);
      }
      const l = evaluateScalarExpr(expr.left, ctx);
      const r = evaluateScalarExpr(expr.right, ctx);
      return evaluateBinaryOp(expr.op, l, r);
    }
    case "is_null": {
      const val = evaluateScalarExpr(expr.expr, ctx);
      const isNull = val === null || val === undefined;
      return expr.not ? !isNull : isNull;
    }
    case "like": {
      const val = evaluateScalarExpr(expr.expr, ctx);
      const pat = evaluateScalarExpr(expr.pattern, ctx);
      if (val === null || val === undefined || pat === null || pat === undefined) return false;
      const regexStr = "^" + String(pat)
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%/g, ".*")
        .replace(/_/g, ".") + "$";
      const matched = new RegExp(regexStr, "i").test(String(val));
      return expr.not ? !matched : matched;
    }
    case "in": {
      const val = evaluateScalarExpr(expr.expr, ctx);
      if (val === null || val === undefined) return false;
      let matched = false;
      for (const item of expr.list) {
        if (sqlEquals(val, evaluateScalarExpr(item, ctx))) {
          matched = true;
          break;
        }
      }
      return expr.not ? !matched : matched;
    }
    case "between": {
      const val = evaluateScalarExpr(expr.expr, ctx);
      const low = evaluateScalarExpr(expr.low, ctx);
      const high = evaluateScalarExpr(expr.high, ctx);
      if (val === null || val === undefined || low === null || low === undefined || high === null || high === undefined) {
        return false;
      }
      const matched = sqlCompare(val, low) >= 0 && sqlCompare(val, high) <= 0;
      return expr.not ? !matched : matched;
    }
    default:
      return null;
  }
}

function containsAggregate(expr: Expr): boolean {
  switch (expr.kind) {
    case "aggregate":
      return true;
    case "unary":
      return containsAggregate(expr.expr);
    case "binary":
      return containsAggregate(expr.left) || containsAggregate(expr.right);
    case "is_null":
    case "like":
      return containsAggregate(expr.expr);
    case "between":
      return containsAggregate(expr.expr) || containsAggregate(expr.low) || containsAggregate(expr.high);
    case "in":
      return containsAggregate(expr.expr) || expr.list.some(containsAggregate);
    default:
      return false;
  }
}

function evaluateAggregateFunc(
  func: AggregateFunc,
  distinct: boolean,
  arg: Expr,
  rows: readonly (readonly unknown[])[],
  schema: readonly ColumnSchema[],
  tableAlias?: string,
  tableName?: string
): unknown {
  if (func === "COUNT" && arg.kind === "star") {
    return rows.length;
  }
  const gathered: unknown[] = [];
  for (let r = 0; r < rows.length; r++) {
    const ctx = makeRowContext(rows[r]!, schema, tableAlias, tableName);
    const val = evaluateScalarExpr(arg, ctx);
    if (val !== null && val !== undefined) {
      gathered.push(val);
    }
  }
  const values = distinct ? Array.from(new Set(gathered)) : gathered;
  if (func === "COUNT") {
    return values.length;
  }
  if (values.length === 0) {
    return null;
  }
  if (func === "SUM") {
    let sum = 0;
    for (const v of values) {
      const n = toNumber(v);
      if (n !== null) sum += n;
    }
    return sum;
  }
  if (func === "AVG") {
    let sum = 0;
    let count = 0;
    for (const v of values) {
      const n = toNumber(v);
      if (n !== null) {
        sum += n;
        count++;
      }
    }
    return count === 0 ? null : sum / count;
  }
  if (func === "MIN") {
    let min = values[0]!;
    for (let i = 1; i < values.length; i++) {
      if (sqlCompare(values[i]!, min) < 0) min = values[i]!;
    }
    return min;
  }
  if (func === "MAX") {
    let max = values[0]!;
    for (let i = 1; i < values.length; i++) {
      if (sqlCompare(values[i]!, max) > 0) max = values[i]!;
    }
    return max;
  }
  return null;
}

function evaluateExprWithGroup(
  expr: Expr,
  groupRows: readonly (readonly unknown[])[],
  schema: readonly ColumnSchema[],
  tableAlias?: string,
  tableName?: string
): unknown {
  switch (expr.kind) {
    case "aggregate":
      return evaluateAggregateFunc(expr.func, expr.distinct, expr.arg, groupRows, schema, tableAlias, tableName);
    case "literal":
      return expr.value;
    case "column": {
      if (groupRows.length === 0) return null;
      const ctx = makeRowContext(groupRows[0]!, schema, tableAlias, tableName);
      return ctx.getValue(expr.column, expr.table);
    }
    case "unary": {
      const val = evaluateExprWithGroup(expr.expr, groupRows, schema, tableAlias, tableName);
      if (expr.op === "NOT") return !toBoolean(val);
      if (expr.op === "-") {
        const n = toNumber(val);
        return n === null ? null : -n;
      }
      return val;
    }
    case "binary": {
      if (expr.op === "AND") {
        const l = evaluateExprWithGroup(expr.left, groupRows, schema, tableAlias, tableName);
        if (!toBoolean(l)) return false;
        const r = evaluateExprWithGroup(expr.right, groupRows, schema, tableAlias, tableName);
        return toBoolean(r);
      }
      if (expr.op === "OR") {
        const l = evaluateExprWithGroup(expr.left, groupRows, schema, tableAlias, tableName);
        if (toBoolean(l)) return true;
        const r = evaluateExprWithGroup(expr.right, groupRows, schema, tableAlias, tableName);
        return toBoolean(r);
      }
      const l = evaluateExprWithGroup(expr.left, groupRows, schema, tableAlias, tableName);
      const r = evaluateExprWithGroup(expr.right, groupRows, schema, tableAlias, tableName);
      return evaluateBinaryOp(expr.op, l, r);
    }
    default:
      return null;
  }
}

function deriveColumnName(expr: Expr, alias?: string): string {
  if (alias !== undefined) return alias;
  if (expr.kind === "column") return expr.column;
  if (expr.kind === "aggregate") {
    const argName = expr.arg.kind === "star" ? "*" : deriveColumnName(expr.arg);
    return `${expr.func}(${expr.distinct ? "DISTINCT " : ""}${argName})`;
  }
  if (expr.kind === "literal") return String(expr.value);
  return "expr";
}

export function createTabularWorkbench(): TabularWorkbench {
  const tables = new Map<string, InternalTable>();

  const findTable = (tableName: string): InternalTable | undefined => {
    const direct = tables.get(tableName);
    if (direct !== undefined) return direct;
    const lower = tableName.toLowerCase();
    for (const [k, tbl] of tables) {
      if (k.toLowerCase() === lower) return tbl;
    }
    return undefined;
  };

  return {
    createTableFromRecords(tableName: string, records: readonly Record<string, unknown>[]): readonly ColumnSchema[] {
      if (records.length === 0) {
        const emptySchema: readonly ColumnSchema[] = [];
        tables.set(tableName, { name: tableName, schema: emptySchema, rows: [] });
        return emptySchema;
      }
      const columnNames: string[] = [];
      const seenColumns = new Set<string>();
      for (let r = 0; r < records.length; r++) {
        const rec = records[r]!;
        for (const key of Object.keys(rec)) {
          if (!seenColumns.has(key)) {
            seenColumns.add(key);
            columnNames.push(key);
          }
        }
      }
      const schemas: ColumnSchema[] = [];
      for (let c = 0; c < columnNames.length; c++) {
        const colName = columnNames[c]!;
        const inferred: (ColumnType | null)[] = [];
        let hasNull = false;
        for (let r = 0; r < records.length; r++) {
          const val = records[r]![colName];
          if (val === undefined || val === null) {
            hasNull = true;
            inferred.push(null);
          } else {
            inferred.push(inferScalarType(val));
          }
        }
        const colType = resolveColumnType(inferred);
        schemas.push({ name: colName, type: colType, nullable: hasNull });
      }
      const storedRows: (readonly unknown[])[] = [];
      for (let r = 0; r < records.length; r++) {
        const rec = records[r]!;
        const rowCells: unknown[] = [];
        for (let c = 0; c < schemas.length; c++) {
          const schema = schemas[c]!;
          rowCells.push(castScalarValue(rec[schema.name], schema.type));
        }
        storedRows.push(rowCells);
      }
      tables.set(tableName, { name: tableName, schema: schemas, rows: storedRows });
      return schemas;
    },

    createTableFromCsv(tableName: string, csvContent: string): readonly ColumnSchema[] {
      const rawRows = parseCsvRows(csvContent);
      if (rawRows.length === 0) {
        const emptySchema: readonly ColumnSchema[] = [];
        tables.set(tableName, { name: tableName, schema: emptySchema, rows: [] });
        return emptySchema;
      }
      const headers = rawRows[0]!;
      const dataRows = rawRows.slice(1);
      const schemas: ColumnSchema[] = [];

      for (let colIdx = 0; colIdx < headers.length; colIdx++) {
        const rawHeader = headers[colIdx]!.trim();
        const colName = rawHeader.length > 0 ? rawHeader : `column_${colIdx + 1}`;
        const inferred: (ColumnType | null)[] = [];
        let hasNull = dataRows.length === 0;

        for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
          const row = dataRows[rowIdx]!;
          const val = colIdx < row.length ? row[colIdx]! : "";
          if (val === "") {
            hasNull = true;
            inferred.push(null);
          } else {
            const t = inferScalarType(val);
            if (t === null) hasNull = true;
            inferred.push(t);
          }
        }
        schemas.push({
          name: colName,
          type: resolveColumnType(inferred),
          nullable: hasNull
        });
      }

      const storedRows: (readonly unknown[])[] = [];
      for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
        const row = dataRows[rowIdx]!;
        const cells: unknown[] = [];
        for (let colIdx = 0; colIdx < schemas.length; colIdx++) {
          const schema = schemas[colIdx]!;
          const rawVal = colIdx < row.length ? row[colIdx]! : "";
          cells.push(castScalarValue(rawVal, schema.type));
        }
        storedRows.push(cells);
      }

      tables.set(tableName, { name: tableName, schema: schemas, rows: storedRows });
      return schemas;
    },

    listTables(): readonly string[] {
      return Array.from(tables.keys());
    },

    getTableSchema(tableName: string): readonly ColumnSchema[] | undefined {
      const tbl = findTable(tableName);
      return tbl !== undefined ? tbl.schema : undefined;
    },

    calculateStats(tableName: string): readonly ColumnStats[] {
      const tbl = findTable(tableName);
      if (tbl === undefined) return [];
      const statsList: ColumnStats[] = [];
      const total = tbl.rows.length;

      for (let c = 0; c < tbl.schema.length; c++) {
        const col = tbl.schema[c]!;
        let nullCount = 0;
        const nonNull: unknown[] = [];

        for (let r = 0; r < total; r++) {
          const row = tbl.rows[r]!;
          const val = c < row.length ? row[c]! : null;
          if (val === null || val === undefined) {
            nullCount++;
          } else {
            nonNull.push(val);
          }
        }

        const distinctCount = new Set(nonNull).size;
        let minVal: number | string | undefined;
        let maxVal: number | string | undefined;
        let meanVal: number | undefined;

        if (col.type === "integer" || col.type === "real") {
          const nums: number[] = [];
          let sum = 0;
          for (let i = 0; i < nonNull.length; i++) {
            const n = toNumber(nonNull[i]!);
            if (n !== null) {
              nums.push(n);
              sum += n;
            }
          }
          if (nums.length > 0) {
            let minN = nums[0]!;
            let maxN = nums[0]!;
            for (let i = 1; i < nums.length; i++) {
              const n = nums[i]!;
              if (n < minN) minN = n;
              if (n > maxN) maxN = n;
            }
            minVal = minN;
            maxVal = maxN;
            meanVal = sum / nums.length;
          }
        } else if (col.type === "text" || col.type === "date") {
          const strings = nonNull.map(String);
          if (strings.length > 0) {
            let minS = strings[0]!;
            let maxS = strings[0]!;
            for (let i = 1; i < strings.length; i++) {
              const s = strings[i]!;
              if (s.localeCompare(minS) < 0) minS = s;
              if (s.localeCompare(maxS) > 0) maxS = s;
            }
            minVal = minS;
            maxVal = maxS;
          }
        }

        const statObj: { -readonly [K in keyof ColumnStats]?: ColumnStats[K] } = {
          name: col.name,
          type: col.type,
          count: total,
          nullCount,
          distinctCount
        };
        if (minVal !== undefined) statObj.min = minVal;
        if (maxVal !== undefined) statObj.max = maxVal;
        if (meanVal !== undefined) statObj.mean = meanVal;
        statsList.push(statObj as ColumnStats);
      }
      return statsList;
    },

    execute(sql: string): QueryResult {
      const startTime = performance.now();
      try {
        const tokens = tokenize(sql);
        if (tokens.length === 0) {
          return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
        }
        const query = parseQuery(tokens);
        let sourceTable: InternalTable | undefined;
        if (query.from !== undefined) {
          sourceTable = findTable(query.from.table);
          if (sourceTable === undefined) {
            const ms = Math.max(0, Math.round((performance.now() - startTime) * 100) / 100);
            return {
              columns: [],
              rows: [],
              rowCount: 0,
              executionTimeMs: ms,
              error: `Table "${query.from.table}" not found`
            };
          }
        }

        const schema = sourceTable !== undefined ? sourceTable.schema : [];
        const allRows = sourceTable !== undefined ? sourceTable.rows : [[]];
        const tableAlias = query.from?.alias;
        const tableName = query.from?.table;

        const filteredRows: (readonly unknown[])[] = [];
        for (let r = 0; r < allRows.length; r++) {
          const row = allRows[r]!;
          if (query.where !== undefined) {
            const ctx = makeRowContext(row, schema, tableAlias, tableName);
            if (toBoolean(evaluateScalarExpr(query.where, ctx))) {
              filteredRows.push(row);
            }
          } else {
            filteredRows.push(row);
          }
        }

        const expandedSelect: SelectItem[] = [];
        for (let i = 0; i < query.select.length; i++) {
          const item = query.select[i]!;
          if (item.expr.kind === "star" || item.expr.kind === "table_star") {
            for (let c = 0; c < schema.length; c++) {
              const col = schema[c]!;
              expandedSelect.push({ expr: { kind: "column", column: col.name } });
            }
          } else {
            expandedSelect.push(item);
          }
        }

        const isAggregate = query.groupBy !== undefined || expandedSelect.some(s => containsAggregate(s.expr));
        let outputRows: (readonly unknown[])[] = [];

        if (!isAggregate) {
          for (let r = 0; r < filteredRows.length; r++) {
            const row = filteredRows[r]!;
            const ctx = makeRowContext(row, schema, tableAlias, tableName);
            const projected: unknown[] = [];
            for (let i = 0; i < expandedSelect.length; i++) {
              projected.push(evaluateScalarExpr(expandedSelect[i]!.expr, ctx));
            }
            outputRows.push(projected);
          }
        } else {
          const groups: (readonly (readonly unknown[])[])[] = [];
          if (query.groupBy !== undefined && query.groupBy.length > 0) {
            const groupMap = new Map<string, (readonly unknown[])[]>();
            for (let r = 0; r < filteredRows.length; r++) {
              const row = filteredRows[r]!;
              const ctx = makeRowContext(row, schema, tableAlias, tableName);
              const key = query.groupBy.map(g => JSON.stringify(evaluateScalarExpr(g, ctx))).join("|");
              let grp = groupMap.get(key);
              if (grp === undefined) {
                grp = [];
                groupMap.set(key, grp);
                groups.push(grp);
              }
              grp.push(row);
            }
          } else {
            groups.push(filteredRows);
          }

          for (let g = 0; g < groups.length; g++) {
            const grpRows = groups[g]!;
            if (query.having !== undefined) {
              const havingVal = evaluateExprWithGroup(query.having, grpRows, schema, tableAlias, tableName);
              if (!toBoolean(havingVal)) continue;
            }
            const projected: unknown[] = [];
            for (let i = 0; i < expandedSelect.length; i++) {
              projected.push(evaluateExprWithGroup(expandedSelect[i]!.expr, grpRows, schema, tableAlias, tableName));
            }
            outputRows.push(projected);
          }
        }

        const resultColumns: ColumnSchema[] = [];
        for (let i = 0; i < expandedSelect.length; i++) {
          const item = expandedSelect[i]!;
          const colName = deriveColumnName(item.expr, item.alias);
          let inferredType: ColumnType = "text";
          let nullable = false;

          if (item.expr.kind === "aggregate") {
            if (item.expr.func === "COUNT") {
              inferredType = "integer";
            } else if (item.expr.func === "AVG") {
              inferredType = "real";
              nullable = true;
            } else {
              inferredType = "real";
              nullable = true;
            }
          } else if (item.expr.kind === "column") {
            const lower = item.expr.column.toLowerCase();
            const foundCol = schema.find(s => s.name.toLowerCase() === lower);
            if (foundCol !== undefined) {
              inferredType = foundCol.type;
              nullable = foundCol.nullable;
            }
          } else {
            const types = outputRows.map(row => (i < row.length ? inferScalarType(row[i]) : null));
            inferredType = resolveColumnType(types);
            nullable = outputRows.some(row => i < row.length && row[i] === null);
          }
          resultColumns.push({ name: colName, type: inferredType, nullable });
        }

        if (query.distinct) {
          const seen = new Set<string>();
          const deduped: (readonly unknown[])[] = [];
          for (let r = 0; r < outputRows.length; r++) {
            const row = outputRows[r]!;
            const key = JSON.stringify(row);
            if (!seen.has(key)) {
              seen.add(key);
              deduped.push(row);
            }
          }
          outputRows = deduped;
        }

        if (query.orderBy !== undefined && query.orderBy.length > 0) {
          const orders = query.orderBy;
          outputRows.sort((a, b) => {
            for (let i = 0; i < orders.length; i++) {
              const ord = orders[i]!;
              let valA: unknown = null;
              let valB: unknown = null;
              if (ord.expr.kind === "literal" && typeof ord.expr.value === "number") {
                const colIdx = Math.trunc(ord.expr.value) - 1;
                valA = colIdx >= 0 && colIdx < a.length ? a[colIdx] : null;
                valB = colIdx >= 0 && colIdx < b.length ? b[colIdx] : null;
              } else if (ord.expr.kind === "column") {
                const lower = ord.expr.column.toLowerCase();
                let colIdx = -1;
                for (let c = 0; c < resultColumns.length; c++) {
                  if (resultColumns[c]!.name.toLowerCase() === lower) {
                    colIdx = c;
                    break;
                  }
                }
                if (colIdx !== -1) {
                  valA = colIdx < a.length ? a[colIdx] : null;
                  valB = colIdx < b.length ? b[colIdx] : null;
                }
              }
              if (valA === valB) continue;
              if (valA === null || valA === undefined) return ord.direction === "ASC" ? -1 : 1;
              if (valB === null || valB === undefined) return ord.direction === "ASC" ? 1 : -1;
              const cmp = sqlCompare(valA, valB);
              if (cmp !== 0) {
                return ord.direction === "ASC" ? cmp : -cmp;
              }
            }
            return 0;
          });
        }

        if (query.offset !== undefined && query.offset > 0) {
          outputRows = outputRows.slice(query.offset);
        }
        if (query.limit !== undefined && query.limit >= 0) {
          outputRows = outputRows.slice(0, query.limit);
        }

        const executionTimeMs = Math.max(0, Math.round((performance.now() - startTime) * 100) / 100);
        return {
          columns: resultColumns,
          rows: outputRows,
          rowCount: outputRows.length,
          executionTimeMs
        };
      } catch (err) {
        const executionTimeMs = Math.max(0, Math.round((performance.now() - startTime) * 100) / 100);
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          executionTimeMs,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    },

    exportToCsv(queryResultOrTableName: QueryResult | string): string {
      let columns: readonly ColumnSchema[];
      let rows: readonly (readonly unknown[])[];

      if (typeof queryResultOrTableName === "string") {
        const tbl = findTable(queryResultOrTableName);
        if (tbl === undefined) return "";
        columns = tbl.schema;
        rows = tbl.rows;
      } else {
        columns = queryResultOrTableName.columns;
        rows = queryResultOrTableName.rows;
      }
      if (columns.length === 0) return "";

      const formatCell = (val: unknown): string => {
        if (val === null || val === undefined) return "";
        const str = typeof val === "string" ? val : String(val);
        if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const header = columns.map(c => formatCell(c.name)).join(",");
      const data = rows.map(r => {
        const cells: string[] = [];
        for (let i = 0; i < columns.length; i++) {
          cells.push(formatCell(i < r.length ? r[i] : null));
        }
        return cells.join(",");
      });
      return [header, ...data].join("\n");
    },

    exportToMarkdown(queryResultOrTableName: QueryResult | string): string {
      let columns: readonly ColumnSchema[];
      let rows: readonly (readonly unknown[])[];

      if (typeof queryResultOrTableName === "string") {
        const tbl = findTable(queryResultOrTableName);
        if (tbl === undefined) return "";
        columns = tbl.schema;
        rows = tbl.rows;
      } else {
        columns = queryResultOrTableName.columns;
        rows = queryResultOrTableName.rows;
      }
      if (columns.length === 0) return "";

      const formatCell = (val: unknown): string => {
        if (val === null || val === undefined) return "NULL";
        const str = typeof val === "string" ? val : String(val);
        return str.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
      };

      const header = "| " + columns.map(c => formatCell(c.name)).join(" | ") + " |";
      const divider = "| " + columns.map(() => "---").join(" | ") + " |";
      const data = rows.map(r => {
        const cells: string[] = [];
        for (let i = 0; i < columns.length; i++) {
          cells.push(formatCell(i < r.length ? r[i] : null));
        }
        return "| " + cells.join(" | ") + " |";
      });
      return [header, divider, ...data].join("\n");
    }
  };
}
