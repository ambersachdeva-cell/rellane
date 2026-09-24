export interface TableColumnLike {
  readonly name: string;
  readonly index: number;
  readonly type: string;
}

export interface ParsedTableLike {
  readonly columns: readonly TableColumnLike[];
  readonly rows: readonly (readonly string[])[];
}

export interface Filter {
  readonly column: number;
  readonly op: "is" | "is-not" | "contains" | "gt" | "lt" | "between" | "empty" | "not-empty";
  readonly value: string;
  readonly value2?: string;
}

export interface QuerySpec {
  readonly filters: readonly Filter[];
  readonly sort?: { readonly column: number; readonly direction: "asc" | "desc" };
  readonly groupBy?: number;
  readonly aggregate?: { readonly column: number; readonly fn: "sum" | "count" | "avg" | "min" | "max" };
  readonly limit?: number;
}

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly matched: number;
  readonly total: number;
  /** Plain sentence: "18 of 240 rows, totalling ₹1,24,500." */
  readonly summary: string;
  readonly problems: readonly string[];
}

export const MAX_RESULT_ROWS = 2_000;

function isBlank(val: string | undefined): boolean {
  return val === undefined || val.trim().length === 0;
}

function isDateColumn(type: string): boolean {
  const t = type.toLowerCase();
  return t === "date" || t === "datetime" || t === "timestamp";
}

function isMoneyColumn(type: string): boolean {
  const t = type.toLowerCase();
  return t === "money" || t === "currency";
}

function isNumericColumn(type: string): boolean {
  const t = type.toLowerCase();
  return (
    t === "number" ||
    t === "numeric" ||
    t === "integer" ||
    t === "float" ||
    isMoneyColumn(type)
  );
}

function parseNumeric(val: string): number | null {
  const trimmed = val.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let negative = false;
  let s = trimmed;

  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  } else if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  } else if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1).trim();
  }

  s = s.replace(/[₹$£€,\s]/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  }

  if (s.length === 0) {
    return null;
  }

  const n = Number(s);
  if (Number.isNaN(n)) {
    return null;
  }

  return negative ? -n : n;
}

function parseDateValue(val: string): number | null {
  const trimmed = val.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const isoMatch =
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(
      trimmed
    );
  if (
    isoMatch !== null &&
    isoMatch[1] !== undefined &&
    isoMatch[2] !== undefined &&
    isoMatch[3] !== undefined
  ) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const hour = isoMatch[4] !== undefined ? Number(isoMatch[4]) : 0;
    const min = isoMatch[5] !== undefined ? Number(isoMatch[5]) : 0;
    const sec = isoMatch[6] !== undefined ? Number(isoMatch[6]) : 0;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return Date.UTC(year, month - 1, day, hour, min, sec);
    }
  }

  const dmyMatch = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(trimmed);
  if (
    dmyMatch !== null &&
    dmyMatch[1] !== undefined &&
    dmyMatch[2] !== undefined
  ) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    // Default leap year ensures standalone DD/MM dates like 29/02 evaluate safely
    let year = 2000;
    if (dmyMatch[3] !== undefined) {
      const parsedYear = Number(dmyMatch[3]);
      year =
        parsedYear < 100
          ? parsedYear < 50
            ? 2000 + parsedYear
            : 1900 + parsedYear
          : parsedYear;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return Date.UTC(year, month - 1, day);
    }
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isNaN(timestamp)) {
    return timestamp;
  }

  return null;
}

function formatIndianNumber(val: number): string {
  const isNegative = val < 0;
  const absVal = Math.abs(val);
  const rounded = Math.round(absVal * 100) / 100;
  const parts = rounded.toString().split(".");
  const intPart = parts[0] ?? "0";
  const decPart = parts.length > 1 ? parts[1] : undefined;

  let formattedInt = "";
  if (intPart.length <= 3) {
    formattedInt = intPart;
  } else {
    const lastThree = intPart.slice(-3);
    const remaining = intPart.slice(0, -3);
    const groups: string[] = [];
    let i = remaining.length;
    while (i > 0) {
      const start = Math.max(0, i - 2);
      groups.unshift(remaining.slice(start, i));
      i = start;
    }
    formattedInt = `${groups.join(",")},${lastThree}`;
  }

  const sign = isNegative ? "-" : "";
  if (decPart !== undefined && decPart.length > 0) {
    const paddedDec = decPart.length === 1 ? `${decPart}0` : decPart;
    return `${sign}${formattedInt}.${paddedDec}`;
  }
  return `${sign}${formattedInt}`;
}

function formatRupees(val: number): string {
  const isNegative = val < 0;
  const formatted = formatIndianNumber(Math.abs(val));
  return isNegative ? `-₹${formatted}` : `₹${formatted}`;
}

function matchesFilter(
  cell: string | undefined,
  filter: Filter,
  colType: string
): boolean {
  const cellIsBlank = isBlank(cell);

  if (cellIsBlank) {
    return filter.op === "empty";
  }

  if (filter.op === "empty") {
    return false;
  }

  if (filter.op === "not-empty") {
    return true;
  }

  const safeCell = cell ?? "";

  if (filter.op === "contains") {
    const normalizedCell = safeCell
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    const normalizedTarget = filter.value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    return normalizedCell.includes(normalizedTarget);
  }

  if (isNumericColumn(colType)) {
    const cellNum = parseNumeric(safeCell);
    const filterNum = parseNumeric(filter.value);
    if (cellNum === null || filterNum === null) {
      return false;
    }

    switch (filter.op) {
      case "is":
        return cellNum === filterNum;
      case "is-not":
        return cellNum !== filterNum;
      case "gt":
        return cellNum > filterNum;
      case "lt":
        return cellNum < filterNum;
      case "between": {
        const filterNum2 =
          filter.value2 !== undefined
            ? parseNumeric(filter.value2)
            : filterNum;
        if (filterNum2 === null) {
          return false;
        }
        const low = Math.min(filterNum, filterNum2);
        const high = Math.max(filterNum, filterNum2);
        return cellNum >= low && cellNum <= high;
      }
    }
  }

  if (isDateColumn(colType)) {
    const cellDate = parseDateValue(safeCell);
    const filterDate = parseDateValue(filter.value);
    if (cellDate === null || filterDate === null) {
      return false;
    }

    switch (filter.op) {
      case "is":
        return cellDate === filterDate;
      case "is-not":
        return cellDate !== filterDate;
      case "gt":
        return cellDate > filterDate;
      case "lt":
        return cellDate < filterDate;
      case "between": {
        const filterDate2 =
          filter.value2 !== undefined
            ? parseDateValue(filter.value2)
            : filterDate;
        if (filterDate2 === null) {
          return false;
        }
        const low = Math.min(filterDate, filterDate2);
        const high = Math.max(filterDate, filterDate2);
        return cellDate >= low && cellDate <= high;
      }
    }
  }

  const cellLower = safeCell.toLowerCase();
  const filterLower = filter.value.toLowerCase();

  switch (filter.op) {
    case "is":
      return cellLower === filterLower;
    case "is-not":
      return cellLower !== filterLower;
    case "gt":
      return cellLower > filterLower;
    case "lt":
      return cellLower < filterLower;
    case "between": {
      const filterLower2 =
        filter.value2 !== undefined ? filter.value2.toLowerCase() : filterLower;
      const low = filterLower < filterLower2 ? filterLower : filterLower2;
      const high = filterLower < filterLower2 ? filterLower2 : filterLower;
      return cellLower >= low && cellLower <= high;
    }
  }
}

function compareCells(
  valA: string | undefined,
  valB: string | undefined,
  colType: string,
  direction: "asc" | "desc"
): number {
  const isBlankA = isBlank(valA);
  const isBlankB = isBlank(valB);

  if (isBlankA && isBlankB) {
    return 0;
  }
  if (isBlankA) {
    return 1;
  }
  if (isBlankB) {
    return -1;
  }

  const safeA = valA ?? "";
  const safeB = valB ?? "";
  const sign = direction === "asc" ? 1 : -1;

  if (isNumericColumn(colType)) {
    const numA = parseNumeric(safeA);
    const numB = parseNumeric(safeB);
    if (numA !== null && numB !== null) {
      if (numA !== numB) {
        return (numA - numB) * sign;
      }
      return 0;
    }
  }

  if (isDateColumn(colType)) {
    const dateA = parseDateValue(safeA);
    const dateB = parseDateValue(safeB);
    if (dateA !== null && dateB !== null) {
      if (dateA !== dateB) {
        return (dateA - dateB) * sign;
      }
      return 0;
    }
  }

  const lowerA = safeA.toLowerCase();
  const lowerB = safeB.toLowerCase();
  if (lowerA < lowerB) {
    return -1 * sign;
  }
  if (lowerA > lowerB) {
    return 1 * sign;
  }
  return 0;
}

function computeAggregate(
  rows: readonly (readonly string[])[],
  colIndex: number,
  colType: string,
  colName: string,
  fn: "sum" | "count" | "avg" | "min" | "max",
  problems: string[]
): { readonly display: string; readonly sortKey: number | string } | null {
  if (fn === "count") {
    let count = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const cell = colIndex < row.length ? row[colIndex] : undefined;
      if (!isBlank(cell)) {
        count++;
      }
    }
    return {
      display: count.toString(),
      sortKey: count,
    };
  }

  if (fn === "sum" || fn === "avg") {
    if (!isNumericColumn(colType)) {
      problems.push(
        `Cannot calculate ${fn} on non-numeric column "${colName}".`
      );
      return null;
    }

    let sumPaise = 0;
    let count = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const cell = colIndex < row.length ? row[colIndex] : undefined;
      if (cell !== undefined) {
        const n = parseNumeric(cell);
        if (n !== null) {
          sumPaise += Math.round(n * 100);
          count++;
        }
      }
    }

    if (fn === "sum") {
      const total = sumPaise / 100;
      const display = isMoneyColumn(colType)
        ? formatRupees(total)
        : formatIndianNumber(total);
      return { display, sortKey: total };
    }

    const avg = count > 0 ? sumPaise / (count * 100) : 0;
    const display = isMoneyColumn(colType)
      ? formatRupees(avg)
      : formatIndianNumber(Math.round(avg * 100) / 100);
    return { display, sortKey: avg };
  }

  if (fn === "min" || fn === "max") {
    if (isNumericColumn(colType)) {
      let resultNum: number | null = null;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const cell = colIndex < row.length ? row[colIndex] : undefined;
        if (cell !== undefined) {
          const n = parseNumeric(cell);
          if (n !== null) {
            if (resultNum === null) {
              resultNum = n;
            } else if (fn === "min" && n < resultNum) {
              resultNum = n;
            } else if (fn === "max" && n > resultNum) {
              resultNum = n;
            }
          }
        }
      }

      if (resultNum === null) {
        return { display: "", sortKey: 0 };
      }
      const display = isMoneyColumn(colType)
        ? formatRupees(resultNum)
        : formatIndianNumber(resultNum);
      return { display, sortKey: resultNum };
    }

    if (isDateColumn(colType)) {
      let resultTimestamp: number | null = null;
      let resultStr = "";
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const cell = colIndex < row.length ? row[colIndex] : undefined;
        if (cell !== undefined && !isBlank(cell)) {
          const t = parseDateValue(cell);
          if (t !== null) {
            if (resultTimestamp === null) {
              resultTimestamp = t;
              resultStr = cell;
            } else if (fn === "min" && t < resultTimestamp) {
              resultTimestamp = t;
              resultStr = cell;
            } else if (fn === "max" && t > resultTimestamp) {
              resultTimestamp = t;
              resultStr = cell;
            }
          }
        }
      }
      return {
        display: resultStr,
        sortKey: resultTimestamp ?? 0,
      };
    }

    let resultText: string | null = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const cell = colIndex < row.length ? row[colIndex] : undefined;
      if (cell !== undefined && !isBlank(cell)) {
        if (resultText === null) {
          resultText = cell;
        } else if (
          fn === "min" &&
          cell.toLowerCase() < resultText.toLowerCase()
        ) {
          resultText = cell;
        } else if (
          fn === "max" &&
          cell.toLowerCase() > resultText.toLowerCase()
        ) {
          resultText = cell;
        }
      }
    }
    const finalStr = resultText ?? "";
    return { display: finalStr, sortKey: finalStr };
  }

  return null;
}

export function runQuery(table: ParsedTableLike, spec: QuerySpec): QueryResult {
  const problems: string[] = [];
  const validFilters: Filter[] = [];

  for (let i = 0; i < spec.filters.length; i++) {
    const filter = spec.filters[i]!;
    if (filter.column < 0 || filter.column >= table.columns.length) {
      problems.push(`Column ${filter.column} does not exist and was skipped.`);
      continue;
    }
    validFilters.push(filter);
  }

  const matchedRows: (readonly string[])[] = [];
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]!;
    let matches = true;
    for (let f = 0; f < validFilters.length; f++) {
      const filter = validFilters[f]!;
      const col = table.columns[filter.column]!;
      const cell = filter.column < row.length ? row[filter.column] : undefined;
      if (!matchesFilter(cell, filter, col.type)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      matchedRows.push(row);
    }
  }

  const matchedCount = matchedRows.length;
  const totalCount = table.rows.length;
  const countPhrase = `${matchedCount} of ${totalCount} ${totalCount === 1 ? "row" : "rows"}`;

  let summary = `${countPhrase}.`;
  if (spec.aggregate !== undefined) {
    if (
      spec.aggregate.column < 0 ||
      spec.aggregate.column >= table.columns.length
    ) {
      problems.push(
        `Aggregate column ${spec.aggregate.column} does not exist and was skipped.`
      );
    } else {
      const aggCol = table.columns[spec.aggregate.column]!;
      const overallAgg = computeAggregate(
        matchedRows,
        spec.aggregate.column,
        aggCol.type,
        aggCol.name,
        spec.aggregate.fn,
        problems
      );
      if (overallAgg !== null) {
        let aggregatePhrase = "";
        switch (spec.aggregate.fn) {
          case "sum":
            aggregatePhrase = `, totalling ${overallAgg.display}`;
            break;
          case "avg":
            aggregatePhrase = `, averaging ${overallAgg.display}`;
            break;
          case "min":
            aggregatePhrase = `, minimum ${overallAgg.display}`;
            break;
          case "max":
            aggregatePhrase = `, maximum ${overallAgg.display}`;
            break;
          case "count":
            aggregatePhrase = `, count: ${overallAgg.display}`;
            break;
        }
        summary = `${countPhrase}${aggregatePhrase}.`;
      }
    }
  }

  let resultColumns: readonly string[] = [];
  let resultRows: (readonly string[])[] = [];

  if (spec.groupBy !== undefined) {
    if (spec.groupBy < 0 || spec.groupBy >= table.columns.length) {
      problems.push(
        `Group column ${spec.groupBy} does not exist and was skipped.`
      );
      resultColumns = table.columns.map((c) => c.name);
      resultRows = [...matchedRows];
    } else {
      const groupCol = table.columns[spec.groupBy]!;
      const groupIndex = spec.groupBy;

      if (
        spec.aggregate !== undefined &&
        spec.aggregate.column >= 0 &&
        spec.aggregate.column < table.columns.length
      ) {
        const aggCol = table.columns[spec.aggregate.column]!;
        const aggIndex = spec.aggregate.column;
        const aggFn = spec.aggregate.fn;

        const groupMap = new Map<string, (readonly string[])[]>();
        for (let i = 0; i < matchedRows.length; i++) {
          const row = matchedRows[i]!;
          const key = (groupIndex < row.length ? row[groupIndex] : "") ?? "";
          const existing = groupMap.get(key);
          if (existing !== undefined) {
            existing.push(row);
          } else {
            groupMap.set(key, [row]);
          }
        }

        interface GroupEntry {
          readonly row: readonly string[];
          readonly groupKey: string;
          readonly sortKey: number | string;
        }

        const groupedEntries: GroupEntry[] = [];
        const perGroupProblems: string[] = [];
        for (const [groupKey, rowsInGroup] of groupMap.entries()) {
          const groupAgg = computeAggregate(
            rowsInGroup,
            aggIndex,
            aggCol.type,
            aggCol.name,
            aggFn,
            perGroupProblems
          );
          const display = groupAgg?.display ?? "";
          const sortKey = groupAgg?.sortKey ?? 0;
          groupedEntries.push({
            row: [groupKey, display],
            groupKey,
            sortKey,
          });
        }

        if (spec.sort !== undefined) {
          const sortCol = spec.sort.column;
          const sortDir = spec.sort.direction;
          if (sortCol === 0) {
            groupedEntries.sort((a, b) =>
              compareCells(a.groupKey, b.groupKey, groupCol.type, sortDir)
            );
          } else if (sortCol === 1) {
            groupedEntries.sort((a, b) => {
              if (
                typeof a.sortKey === "number" &&
                typeof b.sortKey === "number"
              ) {
                return (a.sortKey - b.sortKey) * (sortDir === "asc" ? 1 : -1);
              }
              return (
                String(a.sortKey).localeCompare(String(b.sortKey)) *
                (sortDir === "asc" ? 1 : -1)
              );
            });
          } else {
            problems.push(
              `Sort column ${sortCol} does not exist and was skipped.`
            );
          }
        } else {
          groupedEntries.sort((a, b) => {
            if (
              typeof a.sortKey === "number" &&
              typeof b.sortKey === "number"
            ) {
              return b.sortKey - a.sortKey;
            }
            return String(b.sortKey).localeCompare(String(a.sortKey));
          });
        }

        resultColumns = [groupCol.name, aggCol.name];
        resultRows = groupedEntries.map((e) => e.row);
      } else {
        const distinctMap = new Map<string, boolean>();
        const distinctKeys: string[] = [];
        for (let i = 0; i < matchedRows.length; i++) {
          const row = matchedRows[i]!;
          const key = (groupIndex < row.length ? row[groupIndex] : "") ?? "";
          if (!distinctMap.has(key)) {
            distinctMap.set(key, true);
            distinctKeys.push(key);
          }
        }

        // Captured before the closure: TypeScript cannot carry the narrowing
        // into a callback, and `spec.sort` is optional.
        const groupSort = spec.sort;
        if (groupSort !== undefined && groupSort.column === 0) {
          distinctKeys.sort((a, b) =>
            compareCells(a, b, groupCol.type, groupSort.direction)
          );
        }

        resultColumns = [groupCol.name];
        resultRows = distinctKeys.map((k) => [k]);
      }
    }
  } else {
    resultColumns = table.columns.map((c) => c.name);
    resultRows = [...matchedRows];

    if (spec.sort !== undefined) {
      if (
        spec.sort.column < 0 ||
        spec.sort.column >= table.columns.length
      ) {
        problems.push(
          `Sort column ${spec.sort.column} does not exist and was skipped.`
        );
      } else {
        const sortColIndex = spec.sort.column;
        const sortCol = table.columns[sortColIndex]!;
        const sortDir = spec.sort.direction;
        resultRows.sort((a, b) => {
          const valA = sortColIndex < a.length ? a[sortColIndex] : undefined;
          const valB = sortColIndex < b.length ? b[sortColIndex] : undefined;
          return compareCells(valA, valB, sortCol.type, sortDir);
        });
      }
    }
  }

  if (resultRows.length > MAX_RESULT_ROWS) {
    problems.push("Results capped at 2,000 rows.");
    resultRows = resultRows.slice(0, MAX_RESULT_ROWS);
  }

  if (
    spec.limit !== undefined &&
    spec.limit >= 0 &&
    resultRows.length > spec.limit
  ) {
    resultRows = resultRows.slice(0, spec.limit);
  }

  return {
    columns: resultColumns,
    rows: resultRows,
    matched: matchedCount,
    total: totalCount,
    summary,
    problems,
  };
}
