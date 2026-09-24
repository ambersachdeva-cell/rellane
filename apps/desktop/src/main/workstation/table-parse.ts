export type CellType = "text" | "number" | "money" | "date" | "boolean" | "empty";

export interface Column {
  readonly name: string;
  readonly index: number;
  readonly type: CellType;
  readonly blanks: number;
}

export interface ParsedTable {
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly delimiter: string;
  readonly problems: readonly string[];
}

export const MAX_ROWS = 50_000;
export const MAX_COLUMNS = 200;

const INDIAN_LAKH_PATTERN =
  /^[+-]?\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?$/;
const WESTERN_THOUSANDS_PATTERN =
  /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const PARENTHESES_INDIAN =
  /^\(\s*[+-]?\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?\s*\)$/;
const PARENTHESES_WESTERN =
  /^\(\s*[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*\)$/;

const CURRENCY_PREFIX_PATTERN =
  /^\(?\s*[-+]?\s*(?:[₹$£€¥]|INR|Rs\.?|USD|GBP|EUR)\s*[-+]?\s*(?:\d{1,2}(?:,\d{2})+,\d{3}|\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*\)?$/i;
const CURRENCY_SUFFIX_PATTERN =
  /^\(?\s*[-+]?\s*(?:\d{1,2}(?:,\d{2})+,\d{3}|\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*[-+]?\s*(?:[₹$£€¥]|INR|Rs\.?|USD|GBP|EUR)\s*\)?$/i;

const BRITISH_DATE_PATTERN =
  /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const ISO_DATE_PATTERN =
  /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

interface RawParsedResult {
  readonly rows: string[][];
  readonly rowLines: number[];
  readonly unclosedQuoteLine: number | null;
}

function parseRawRows(
  text: string,
  delimiter: string,
  maxRows?: number
): RawParsedResult {
  const rows: string[][] = [];
  const rowLines: number[] = [];
  const len = text.length;

  let line = 1;
  let rowStartLine = 1;
  let inQuotes = false;
  let currentCell = "";
  let currentRow: string[] = [];
  let fieldStarted = false;
  let unclosedQuoteLine: number | null = null;

  for (let i = 0; i < len; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && text[i + 1] === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (ch === "\r") {
        currentCell += "\r";
        if (i + 1 < len && text[i + 1] === "\n") {
          currentCell += "\n";
          i++;
        }
        line++;
      } else if (ch === "\n") {
        currentCell += "\n";
        line++;
      } else {
        currentCell += ch;
      }
    } else {
      if (ch === '"') {
        if (!fieldStarted || currentCell.length === 0) {
          inQuotes = true;
          fieldStarted = true;
        } else {
          currentCell += '"';
        }
      } else if (ch === delimiter) {
        currentRow.push(currentCell);
        currentCell = "";
        fieldStarted = false;
      } else if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && i + 1 < len && text[i + 1] === "\n") {
          i++;
        }
        line++;
        currentRow.push(currentCell);
        currentCell = "";
        fieldStarted = false;

        rows.push(currentRow);
        rowLines.push(rowStartLine);
        currentRow = [];
        rowStartLine = line;

        if (maxRows !== undefined && rows.length >= maxRows) {
          return { rows, rowLines, unclosedQuoteLine: null };
        }
      } else {
        currentCell += ch;
        fieldStarted = true;
      }
    }
  }

  if (inQuotes) {
    unclosedQuoteLine = rowStartLine;
  }

  if (currentRow.length > 0 || fieldStarted || currentCell.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
    rowLines.push(rowStartLine);
  }

  return { rows, rowLines, unclosedQuoteLine };
}

export function detectDelimiter(sample: string): string {
  if (sample.length === 0) {
    return ",";
  }

  const CANDIDATES = [",", ";", "\t", "|"] as const;
  let bestDelimiter: string = ",";
  let bestScore = -1;

  for (let cIdx = 0; cIdx < CANDIDATES.length; cIdx++) {
    const delimiter = CANDIDATES[cIdx]!;
    const parsed = parseRawRows(sample, delimiter, 30);
    const rows = parsed.rows.filter(
      (r) => r.length > 1 || (r.length === 1 && r[0] !== "")
    );
    if (rows.length === 0) {
      continue;
    }

    const counts: number[] = [];
    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx]!;
      counts.push(row.length);
    }

    let hasSplit = false;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i]! > 1) {
        hasSplit = true;
        break;
      }
    }
    if (!hasSplit) {
      continue;
    }

    const freq = new Map<number, number>();
    for (let i = 0; i < counts.length; i++) {
      const count = counts[i]!;
      freq.set(count, (freq.get(count) ?? 0) + 1);
    }

    let modeCount = 0;
    let modeFreq = 0;
    for (const [count, f] of freq.entries()) {
      if (count > 1 && (f > modeFreq || (f === modeFreq && count > modeCount))) {
        modeCount = count;
        modeFreq = f;
      }
    }

    if (modeCount <= 1) {
      continue;
    }

    const n = counts.length;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += counts[i]!;
    }
    const mean = sum / n;

    let varianceSum = 0;
    for (let i = 0; i < n; i++) {
      const diff = counts[i]! - mean;
      varianceSum += diff * diff;
    }
    const stdDev = Math.sqrt(varianceSum / n);

    // Consistency of column count across rows outweighs raw punctuation frequency
    const consistencyRatio = modeFreq / n;
    const score = consistencyRatio * 100 - stdDev * 10 + Math.min(modeCount, 20);

    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delimiter;
    }
  }

  return bestDelimiter;
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function isDate(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const bMatch = BRITISH_DATE_PATTERN.exec(trimmed);
  if (bMatch) {
    const day = Number(bMatch[1]);
    const month = Number(bMatch[2]);
    const year = Number(bMatch[3]);
    return isValidDate(year, month, day);
  }

  const isoMatch = ISO_DATE_PATTERN.exec(trimmed);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    return isValidDate(year, month, day);
  }

  return false;
}

export function cellDate(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const bMatch = BRITISH_DATE_PATTERN.exec(trimmed);
  if (bMatch) {
    const day = Number(bMatch[1]);
    const month = Number(bMatch[2]);
    const year = Number(bMatch[3]);
    const hours = bMatch[4] !== undefined ? Number(bMatch[4]) : 0;
    const minutes = bMatch[5] !== undefined ? Number(bMatch[5]) : 0;
    const seconds = bMatch[6] !== undefined ? Number(bMatch[6]) : 0;
    if (!isValidDate(year, month, day)) {
      return null;
    }
    // Local date components prevent day-boundary shifts across timezones
    return new Date(year, month - 1, day, hours, minutes, seconds);
  }

  const isoMatch = ISO_DATE_PATTERN.exec(trimmed);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const hours = isoMatch[4] !== undefined ? Number(isoMatch[4]) : 0;
    const minutes = isoMatch[5] !== undefined ? Number(isoMatch[5]) : 0;
    const seconds = isoMatch[6] !== undefined ? Number(isoMatch[6]) : 0;
    if (!isValidDate(year, month, day)) {
      return null;
    }
    return new Date(year, month - 1, day, hours, minutes, seconds);
  }

  return null;
}

export const parseDate = cellDate;

function isBoolean(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return (
    lower === "true" ||
    lower === "false" ||
    lower === "yes" ||
    lower === "no"
  );
}

function isMoney(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return (
    INDIAN_LAKH_PATTERN.test(trimmed) ||
    WESTERN_THOUSANDS_PATTERN.test(trimmed) ||
    PARENTHESES_INDIAN.test(trimmed) ||
    PARENTHESES_WESTERN.test(trimmed) ||
    CURRENCY_PREFIX_PATTERN.test(trimmed) ||
    CURRENCY_SUFFIX_PATTERN.test(trimmed)
  );
}

function isNumber(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed);
}

function getCellType(value: string): CellType {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "empty";
  }
  if (isBoolean(trimmed)) {
    return "boolean";
  }
  if (isDate(trimmed)) {
    return "date";
  }
  if (isMoney(trimmed)) {
    return "money";
  }
  if (isNumber(trimmed)) {
    return "number";
  }
  return "text";
}

// Money is stored as integer paise in persistence to prevent binary floating-point rounding errors;
// this function returns a float strictly for arithmetic display in the interface.
export function cellNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const isParenNegative = /^\(.*\)$/.test(trimmed);
  let inner = isParenNegative ? trimmed.slice(1, -1).trim() : trimmed;

  let isExplicitNegative = false;
  if (inner.startsWith("-")) {
    isExplicitNegative = true;
    inner = inner.slice(1).trim();
  } else if (inner.startsWith("+")) {
    inner = inner.slice(1).trim();
  }

  const withoutCurrency = inner
    .replace(/[₹$£€¥]/g, "")
    .replace(/\b(?:INR|Rs\.?|USD|GBP|EUR|CAD|AUD|CHF)\b/gi, "")
    .trim();

  let isNegative = isParenNegative || isExplicitNegative;
  let numericText = withoutCurrency;
  if (numericText.startsWith("-")) {
    isNegative = true;
    numericText = numericText.slice(1).trim();
  }

  const isSeparatedMoney =
    INDIAN_LAKH_PATTERN.test(numericText) ||
    WESTERN_THOUSANDS_PATTERN.test(numericText);
  const isPlainNumber = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(numericText);

  if (!isSeparatedMoney && !isPlainNumber) {
    return null;
  }

  const rawNumber = Number(numericText.replace(/,/g, ""));
  if (Number.isNaN(rawNumber)) {
    return null;
  }

  return isNegative ? -Math.abs(rawNumber) : rawNumber;
}

export function parseTable(text: string): ParsedTable {
  const problems: string[] = [];

  if (text.length === 0 || text.trim().length === 0) {
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      delimiter: ",",
      problems: [],
    };
  }

  const delimiter = detectDelimiter(text);
  const parsed = parseRawRows(text, delimiter);
  const rawRows = parsed.rows;
  const rowLines = parsed.rowLines;

  if (parsed.unclosedQuoteLine !== null) {
    problems.push(`Line ${parsed.unclosedQuoteLine} has an unclosed quote.`);
  }

  // Empty trailing lines produced by standard editor line breaks do not represent data rows
  while (
    rawRows.length > 0 &&
    rawRows[rawRows.length - 1]!.length === 1 &&
    rawRows[rawRows.length - 1]![0] === ""
  ) {
    rawRows.pop();
    rowLines.pop();
  }

  if (rawRows.length === 0) {
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      delimiter,
      problems: [],
    };
  }

  let truncated = false;
  const firstRow = rawRows[0]!;

  let isHeader = false;
  if (firstRow.length > 0) {
    const trimmedCells = firstRow.map((c) => c.trim());
    const hasDuplicates = new Set(trimmedCells).size !== trimmedCells.length;
    const hasEmptyCell = trimmedCells.some((c) => c.length === 0);

    if (!hasDuplicates && !hasEmptyCell) {
      let textCount = 0;
      for (let i = 0; i < firstRow.length; i++) {
        if (getCellType(firstRow[i]!) === "text") {
          textCount++;
        }
      }
      if (textCount > firstRow.length / 2) {
        isHeader = true;
      }
    }
  }

  let headerNames: string[] = [];
  let dataRows: string[][] = [];
  let dataRowLines: number[] = [];

  if (isHeader) {
    headerNames = firstRow.map((c) => c.trim());
    dataRows = rawRows.slice(1);
    dataRowLines = rowLines.slice(1);
  } else {
    const colCount = Math.min(firstRow.length, MAX_COLUMNS);
    headerNames = Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`);
    dataRows = rawRows;
    dataRowLines = rowLines;

    if (colCount === 1) {
      problems.push(
        "First row does not look like a header; synthesised Column 1."
      );
    } else {
      problems.push(
        `First row does not look like a header; synthesised Column 1 to Column ${colCount}.`
      );
    }
  }

  let expectedWidth = headerNames.length;
  if (expectedWidth > MAX_COLUMNS) {
    expectedWidth = MAX_COLUMNS;
    headerNames = headerNames.slice(0, MAX_COLUMNS);
    truncated = true;
    problems.push(
      `Table exceeded maximum of ${MAX_COLUMNS} columns; extra columns were omitted.`
    );
  }

  // Preserving ragged rows with padding or trimming ensures the owner sees partial data rather than losing the file
  const normalisedRows: string[][] = [];
  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r]!;
    const line = dataRowLines[r]!;

    if (row.length < expectedWidth) {
      problems.push(
        `Line ${line} has ${row.length} fields instead of ${expectedWidth}; padded with empty cells.`
      );
      const padded = [...row];
      while (padded.length < expectedWidth) {
        padded.push("");
      }
      normalisedRows.push(padded);
    } else if (row.length > expectedWidth) {
      problems.push(
        `Line ${line} has ${row.length} fields instead of ${expectedWidth}; extra fields were trimmed.`
      );
      normalisedRows.push(row.slice(0, expectedWidth));
    } else {
      normalisedRows.push(row);
    }
  }

  let finalRows: string[][] = normalisedRows;
  if (finalRows.length > MAX_ROWS) {
    finalRows = finalRows.slice(0, MAX_ROWS);
    truncated = true;
    problems.push(
      `Table exceeded maximum of ${MAX_ROWS.toLocaleString("en-GB")} rows; remaining rows were omitted.`
    );
  }

  const columns: Column[] = [];
  for (let c = 0; c < expectedWidth; c++) {
    const colName = headerNames[c] ?? `Column ${c + 1}`;
    let blanks = 0;
    const nonBlanks: string[] = [];

    for (let r = 0; r < finalRows.length; r++) {
      const cellVal = finalRows[r]![c] ?? "";
      if (cellVal.trim().length === 0) {
        blanks++;
      } else {
        nonBlanks.push(cellVal);
      }
    }

    let colType: CellType = "text";
    if (nonBlanks.length === 0) {
      colType = "empty";
    } else if (nonBlanks.every(isBoolean)) {
      colType = "boolean";
    } else if (nonBlanks.every(isDate)) {
      colType = "date";
    } else if (
      nonBlanks.every((v) => isMoney(v) || isNumber(v)) &&
      nonBlanks.some(isMoney)
    ) {
      colType = "money";
    } else if (nonBlanks.every(isNumber)) {
      colType = "number";
    } else {
      colType = "text";
    }

    columns.push({
      name: colName,
      index: c,
      type: colType,
      blanks,
    });
  }

  return {
    columns,
    rows: finalRows,
    rowCount: finalRows.length,
    truncated,
    delimiter,
    problems,
  };
}
