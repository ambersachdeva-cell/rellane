/** Figures should come from selected records, with exact decimal arithmetic and
 * row evidence. CSV cells are inert text; neither formulas nor SQL are executed. */
import type { CaseDataQuery, CaseDataReview } from "@cadrane/contracts";

export interface DataTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export function parseDataTable(text: string): DataTable {
  if (text.length > 50_000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text))
    throw new Error("Use a CSV with at most 50,000 characters and no control characters.");
  const input = text.replace(/^\uFEFF/u, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  const addCell = () => {
    if (cell.length > 2_000) throw new Error("A CSV cell exceeds 2,000 characters.");
    row.push(cell);
    if (row.length > 32) throw new Error("Choose a CSV with at most 32 columns.");
    cell = "";
    closedQuote = false;
  };
  const addRow = () => {
    addCell();
    rows.push(row);
    if (rows.length > 2_001) throw new Error("Choose a CSV with at most 2,000 data rows.");
    row = [];
  };
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { cell += '"'; i += 1; }
        else { quoted = false; closedQuote = true; }
      } else cell += char;
    } else if (char === ",") addCell();
    else if (char === "\n" || char === "\r") {
      addRow();
      if (char === "\r" && input[i + 1] === "\n") i += 1;
    } else if (char === '"' && cell === "" && !closedQuote) quoted = true;
    else if (char === '"' || closedQuote)
      throw new Error("The CSV has a misplaced quote. Export a comma-separated UTF-8 CSV again.");
    else cell += char;
  }
  if (quoted) throw new Error("The CSV ends inside a quoted cell. Export the complete file again.");
  if (cell.length || row.length || closedQuote) addRow();
  const columns = rows.shift()?.map(value => value.trim()) ?? [];
  if (!columns.length || columns.some(value => !value || value.length > 120))
    throw new Error("Give every CSV column a name of 1–120 characters in the first row.");
  if (new Set(columns.map(value => value.toLocaleLowerCase("en-IN"))).size !== columns.length)
    throw new Error("Give each CSV column a different name.");
  if (!rows.length) throw new Error("This CSV has a header but no data rows.");
  const irregular = rows.findIndex(value => value.length !== columns.length);
  if (irregular >= 0)
    throw new Error(`Data row ${irregular + 1} has a different number of cells from the header.`);
  return { columns, rows };
}

function exactValue(value: string, unit: "number" | "INR", row: number): bigint | null {
  let text = value.trim();
  if (!text) return null;
  if (unit === "INR") text = text.replace(/^(?:₹|INR\s+|Rs\.?\s+)/iu, "").trim();
  const scale = unit === "INR" ? 2 : 6;
  const match = /^([+-]?)([0-9,]+)(?:\.([0-9]+))?$/u.exec(text);
  if (!match || (match[3]?.length ?? 0) > scale)
    throw new Error(`Data row ${row} has an invalid ${unit === "INR" ? "rupee amount (at most two decimal places)" : "number (at most six decimal places)"}. Correct the source or filter that row out.`);
  const whole = match[2]!;
  if (whole.includes(",") && !/^(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})$/u.test(whole))
    throw new Error(`Data row ${row} has ambiguous comma grouping. Use Indian or international digit grouping.`);
  const digits = whole.replace(/,/gu, "");
  if (digits.length > 15) throw new Error(`Data row ${row} exceeds the supported numeric range.`);
  const magnitude = BigInt(digits) * 10n ** BigInt(scale) + BigInt((match[3] ?? "").padEnd(scale, "0"));
  return match[1] === "-" ? -magnitude : magnitude;
}

function decimal(value: bigint, unit: "number" | "INR"): string {
  const places = unit === "INR" ? 2 : 6;
  const magnitude = (value < 0n ? -value : value).toString().padStart(places + 1, "0");
  const fraction = magnitude.slice(-places);
  const raw = `${value < 0n ? "-" : ""}${magnitude.slice(0, -places)}.${fraction}`;
  return unit === "INR" ? raw : raw.replace(/\.?0+$/u, "");
}

export function calculateDataReview(table: DataTable, query: CaseDataQuery): Omit<CaseDataReview, "evidence"> {
  const checked = [query.valueColumn, query.groupColumn, query.filter?.column ?? null];
  if (checked.some(index => index !== null && (index < 0 || index >= table.columns.length)))
    throw new Error("A selected column is no longer in this source. Choose the column again.");
  if (query.operation === "total" && query.valueColumn === null)
    throw new Error("Choose the column to total.");
  let blankValues = 0;
  let total = 0n;
  const groups = new Map<string, { count: number; known: number; value: bigint; rowNumbers: number[] }>();
  const matched: { row: number; cells: readonly string[] }[] = [];
  table.rows.forEach((cells, index) => {
    if (query.filter && cells[query.filter.column]!.trim() !== query.filter.equals.trim()) return;
    const rowNumber = index + 1;
    matched.push({ row: rowNumber, cells });
    const label = query.groupColumn === null ? "All matching records" : cells[query.groupColumn]!.trim();
    let group = groups.get(label);
    if (!group) {
      if (groups.size >= 25) throw new Error("This breakdown has more than 25 groups. Filter the data or choose another grouping column.");
      group = { count: 0, known: 0, value: 0n, rowNumbers: [] };
      groups.set(label, group);
    }
    group.count += 1;
    group.rowNumbers.push(rowNumber);
    if (query.operation === "total") {
      const value = exactValue(cells[query.valueColumn!]!, query.unit, rowNumber);
      if (value === null) blankValues += 1;
      else { total += value; group.value += value; group.known += 1; }
    }
  });
  return {
    sourceTurnId: query.sourceTurnId,
    columns: table.columns,
    sourceRows: table.rows.length,
    matchedRows: matched.length,
    blankValues,
    total: query.operation === "total" && (matched.length === 0 || blankValues < matched.length) ? decimal(total, query.unit) : null,
    groups: [...groups].map(([label, group]) => ({
      label, count: group.count,
      total: query.operation === "total" && group.known > 0 ? decimal(group.value, query.unit) : null,
      rowNumbers: group.rowNumbers
    })),
    previewRows: matched.slice(0, 12)
  };
}
