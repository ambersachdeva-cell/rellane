import * as React from "react";
import { computeBandScale, computeLinearScale } from "./chart-spec.js";

export interface ChartViewProps {
  readonly columns: readonly { readonly name: string; readonly type: string }[];
  readonly rows: readonly (readonly string[])[];
  readonly title: string;
  readonly onCopySummary: (summary: string) => void;
}

interface PlottedPoint {
  readonly category: string;
  readonly value: number;
  readonly formattedValue: string;
}

function parseCellNumber(val: string | null | undefined): number | null {
  if (val === null || val === undefined) {
    return null;
  }
  const trimmed = val.trim();
  if (trimmed === "" || trimmed === "—" || trimmed === "-") {
    return null;
  }

  // Accounting brackets represent negative values in business records.
  const parenMatch = /^\((.*)\)$/.exec(trimmed);
  const inner = parenMatch ? parenMatch[1]! : trimmed;

  // Strip currency symbols, thousand separators and unit markings before numeric evaluation.
  const cleaned = inner
    .replace(/[\$£€₹¥]/g, "")
    .replace(/\s+/g, "")
    .replace(/,/g, "")
    .replace(/%/g, "");

  if (cleaned === "" || cleaned === "-" || cleaned === "+") {
    return null;
  }

  const parsed = Number(cleaned);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return parenMatch ? -parsed : parsed;
}

function detectCurrency(sampleValues: readonly string[]): string | null {
  for (let i = 0; i < sampleValues.length; i++) {
    const val = sampleValues[i];
    if (val !== undefined) {
      if (val.includes("£")) return "£";
      if (val.includes("₹")) return "₹";
      if (val.includes("$")) return "$";
      if (val.includes("€")) return "€";
      if (val.includes("¥")) return "¥";
    }
  }
  return null;
}

function formatTickValue(val: number, currency: string | null, isPaise: boolean): string {
  const adjustedVal = isPaise ? val / 100 : val;
  const prefix = isPaise ? "₹" : (currency ?? "");
  const abs = Math.abs(adjustedVal);
  const sign = adjustedVal < 0 ? "-" : "";

  if (abs >= 1_000_000) {
    const num = abs / 1_000_000;
    const formatted = num % 1 === 0 ? num.toFixed(0) : num.toFixed(1);
    return `${sign}${prefix}${formatted}M`;
  }
  if (abs >= 1_000) {
    const num = abs / 1_000;
    const formatted = num % 1 === 0 ? num.toFixed(0) : num.toFixed(1);
    return `${sign}${prefix}${formatted}k`;
  }
  const formatted = abs % 1 === 0 ? abs.toFixed(0) : abs.toFixed(2);
  return `${sign}${prefix}${formatted}`;
}

function truncateCategory(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

const MAX_CHART_ROWS = 60;

function sampleRows<T>(items: readonly T[], maxItems: number): readonly T[] {
  if (items.length <= maxItems) {
    return items;
  }
  const result: T[] = [];
  const step = (items.length - 1) / (maxItems - 1);
  for (let i = 0; i < maxItems; i++) {
    const idx = Math.min(items.length - 1, Math.round(i * step));
    if (idx < items.length) {
      const item = items[idx];
      if (item !== undefined) {
        result.push(item);
      }
    }
  }
  return result;
}

function deriveSummary(params: {
  readonly measureName: string;
  readonly dimName: string;
  readonly rows: readonly (readonly string[])[];
  readonly dimColIdx: number | null;
  readonly measureColIdx: number;
  readonly isSampled: boolean;
  readonly sampledCount: number;
  readonly currency: string | null;
  readonly isPaise: boolean;
}): string {
  const {
    measureName,
    dimName,
    rows,
    dimColIdx,
    measureColIdx,
    isSampled,
    sampledCount,
    currency,
    isPaise,
  } = params;

  if (rows.length === 0) {
    return "Nothing to chart.";
  }

  let maxVal = -Infinity;
  let maxCat = "";
  let firstVal: number | null = null;
  let allIdentical = true;
  let validCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const val = parseCellNumber(r[measureColIdx]);
    if (val === null) continue;
    validCount++;

    const rawCat = dimColIdx !== null && r[dimColIdx] !== undefined && r[dimColIdx]!.trim() !== ""
      ? r[dimColIdx]!.trim()
      : `Row ${i + 1}`;

    if (firstVal === null) {
      firstVal = val;
    } else if (val !== firstVal) {
      allIdentical = false;
    }

    if (val > maxVal) {
      maxVal = val;
      maxCat = rawCat;
    }
  }

  if (validCount === 0) {
    return "Choose a column of numbers to chart.";
  }

  const formattedMeasure = measureName.charAt(0).toUpperCase() + measureName.slice(1);
  const formattedDim =
    dimName.length <= 3 && dimName === dimName.toUpperCase()
      ? dimName
      : dimName.toLowerCase();

  const sampleClause = isSampled
    ? ` (sampled ${sampledCount} of ${rows.length.toLocaleString("en-GB")} rows)`
    : "";

  const formatValueDisplay = (v: number): string => {
    const adjusted = isPaise ? v / 100 : v;
    const prefix = isPaise ? "₹" : (currency ?? "");
    const formattedNum = adjusted.toLocaleString("en-GB", {
      maximumFractionDigits: 2,
    });
    return `${prefix}${formattedNum}`;
  };

  if (validCount === 1) {
    const displayVal = formatValueDisplay(firstVal ?? 0);
    return `${formattedMeasure} by ${formattedDim}${sampleClause}, ${displayVal} in ${maxCat}.`;
  }

  if (allIdentical) {
    const displayVal = formatValueDisplay(firstVal ?? 0);
    return `${formattedMeasure} by ${formattedDim}${sampleClause}, all ${displayVal} across ${validCount} entries.`;
  }

  return `${formattedMeasure} by ${formattedDim}${sampleClause}, highest in ${maxCat}.`;
}

export function ChartView(props: ChartViewProps): React.JSX.Element {
  const { columns, rows, title, onCopySummary } = props;
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Return early when no tabular data has been provided.
  if (columns.length === 0 || rows.length === 0) {
    return (
      <div className="ws-chart-empty">
        <p className="ws-chart-empty-message">Nothing to chart.</p>
      </div>
    );
  }

  // Scan columns to find measure candidates and dimension candidates.
  const sampleSlice = rows.slice(0, 100);
  const numericIndices: number[] = [];
  const dimensionIndices: number[] = [];

  for (let c = 0; c < columns.length; c++) {
    const col = columns[c]!;
    const nameLower = col.name.toLowerCase();
    const typeLower = col.type.toLowerCase();

    const sampleCells = sampleSlice
      .map(r => r[c])
      .filter((v): v is string => v !== undefined && v.trim() !== "");

    let numCount = 0;
    for (let i = 0; i < sampleCells.length; i++) {
      const cell = sampleCells[i];
      if (cell !== undefined && parseCellNumber(cell) !== null) {
        numCount++;
      }
    }

    const isExplicitNumericType =
      typeLower.includes("int") ||
      typeLower.includes("num") ||
      typeLower.includes("float") ||
      typeLower.includes("double") ||
      typeLower.includes("paise");

    const isNumericByValues =
      sampleCells.length > 0 && numCount / sampleCells.length >= 0.7;

    const isYearOrDateName =
      nameLower === "year" ||
      nameLower === "yr" ||
      nameLower === "date" ||
      nameLower === "month" ||
      nameLower === "day";

    if ((isExplicitNumericType || isNumericByValues) && !isYearOrDateName) {
      numericIndices.push(c);
    } else {
      dimensionIndices.push(c);
    }
  }

  // If no column contains numeric values, guide the user plainly without rendering empty axes.
  if (numericIndices.length === 0) {
    return (
      <div className="ws-chart-empty">
        <p className="ws-chart-empty-message">Choose a column of numbers to chart.</p>
      </div>
    );
  }

  const measureColIdx = numericIndices[0]!;
  const dimColIdx = dimensionIndices.length > 0 ? dimensionIndices[0]! : (numericIndices.length > 1 ? numericIndices[1]! : null);

  const measureCol = columns[measureColIdx]!;
  const dimCol = dimColIdx !== null ? columns[dimColIdx]! : null;

  const measureName = measureCol.name;
  const dimName = dimCol !== null ? dimCol.name : "Entry";

  const sampleMeasureCells = sampleSlice
    .map(r => r[measureColIdx])
    .filter((v): v is string => v !== undefined);
  const detectedCurrency = detectCurrency(sampleMeasureCells);
  const isPaise =
    measureCol.name.toLowerCase().includes("paise") ||
    measureCol.type.toLowerCase().includes("paise");

  const isSampled = rows.length > MAX_CHART_ROWS;
  const activeRows = isSampled ? sampleRows(rows, MAX_CHART_ROWS) : rows;

  const summarySentence = deriveSummary({
    measureName,
    dimName,
    rows,
    dimColIdx,
    measureColIdx,
    isSampled,
    sampledCount: activeRows.length,
    currency: detectedCurrency,
    isPaise,
  });

  const handleCopy = () => {
    onCopySummary(summarySentence);
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      void navigator.clipboard.writeText(summarySentence).catch(() => {});
    }
    setCopied(true);
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  const plottedPoints: PlottedPoint[] = [];
  for (let i = 0; i < activeRows.length; i++) {
    const row = activeRows[i];
    if (!row) continue;
    const rawVal = parseCellNumber(row[measureColIdx]);
    const val = rawVal !== null ? rawVal : 0;
    const rawCat = dimColIdx !== null && row[dimColIdx] !== undefined && row[dimColIdx]!.trim() !== ""
      ? row[dimColIdx]!.trim()
      : `Row ${i + 1}`;

    const adjusted = isPaise ? val / 100 : val;
    const prefix = isPaise ? "₹" : (detectedCurrency ?? "");
    const formattedValue = `${prefix}${adjusted.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;

    plottedPoints.push({
      category: rawCat,
      value: val,
      formattedValue,
    });
  }

  if (plottedPoints.length === 0) {
    return (
      <div className="ws-chart-empty">
        <p className="ws-chart-empty-message">Choose a column of numbers to chart.</p>
      </div>
    );
  }

  const width = 600;
  const height = 360;
  const marginLeft = 60;
  const marginRight = 24;
  const marginTop = 30;
  const marginBottom = 64;

  const plotLeft = marginLeft;
  const plotRight = width - marginRight;
  const plotTop = marginTop;
  const plotBottom = height - marginBottom;

  const categories = plottedPoints.map(p => p.category);
  const bandScale = computeBandScale(categories, [plotLeft, plotRight], 0.25);

  let minVal = 0;
  let maxVal = 0;
  let hasSetVal = false;
  for (let i = 0; i < plottedPoints.length; i++) {
    const p = plottedPoints[i]!;
    if (!hasSetVal) {
      minVal = p.value;
      maxVal = p.value;
      hasSetVal = true;
    } else {
      if (p.value < minVal) minVal = p.value;
      if (p.value > maxVal) maxVal = p.value;
    }
  }

  // Pin zero baseline so bars rise or fall from a natural zero reference.
  if (minVal > 0) minVal = 0;
  if (maxVal < 0) maxVal = 0;
  if (minVal === 0 && maxVal === 0) maxVal = 10;

  const yScale = computeLinearScale(minVal, maxVal, [plotBottom, plotTop]);
  const baselineY = yScale.scale(0);

  const labelCount = plottedPoints.length;
  const labelStride = labelCount > 24 ? Math.ceil(labelCount / 12) : 1;
  const shouldRotate = labelCount > 4 || plottedPoints.some(p => p.category.length > 8);

  return (
    <div className="ws-chart-container">
      <div className="ws-chart-header">
        {title !== "" ? <h3 className="ws-chart-title">{title}</h3> : null}
        <div className="ws-chart-summary-bar">
          <p className="ws-chart-summary-text">{summarySentence}</p>
          <button
            type="button"
            className="ws-chart-copy-button"
            onClick={handleCopy}
            aria-label="Copy chart summary"
          >
            {copied ? "Copied" : "Copy summary"}
          </button>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={summarySentence}
        className="ws-chart-svg"
      >
        <title>{summarySentence}</title>
        <desc>{summarySentence}</desc>

        {yScale.ticks.map(tick => {
          const ty = yScale.scale(tick);
          return (
            <g key={`tick-${tick}`}>
              <line
                x1={plotLeft}
                y1={ty}
                x2={plotRight}
                y2={ty}
                stroke="var(--ws-line)"
                strokeWidth="1"
                strokeDasharray="3,3"
                className="ws-chart-grid-line"
              />
              <text
                x={plotLeft - 8}
                y={ty + 4}
                fill="var(--ws-muted)"
                fontSize="10"
                textAnchor="end"
                className="ws-chart-tick-label"
              >
                {formatTickValue(tick, detectedCurrency, isPaise)}
              </text>
            </g>
          );
        })}

        <line
          x1={plotLeft}
          y1={baselineY}
          x2={plotRight}
          y2={baselineY}
          stroke="var(--ws-muted)"
          strokeWidth="1.5"
          className="ws-chart-baseline"
        />

        {plottedPoints.map((point, i) => {
          const bx = bandScale.scale(point.category, i);
          const bw = Math.max(1, bandScale.bandwidth);
          const vy = yScale.scale(point.value);
          const by = point.value >= 0 ? vy : baselineY;
          const bh = Math.max(1, Math.abs(vy - baselineY));

          return (
            <rect
              key={`bar-${i}`}
              x={bx}
              y={by}
              width={bw}
              height={bh}
              fill="var(--ws-blue)"
              rx="3"
              className="ws-chart-bar"
            />
          );
        })}

        {plottedPoints.map((point, i) => {
          if (i % labelStride !== 0) {
            return null;
          }
          const cx = bandScale.scale(point.category, i) + bandScale.bandwidth / 2;
          const labelY = plotBottom + 16;
          const displayLabel = truncateCategory(point.category, labelCount > 10 ? 12 : 18);

          return (
            <text
              key={`cat-label-${i}`}
              x={cx}
              y={labelY}
              fill="var(--ws-muted)"
              fontSize="11"
              textAnchor={shouldRotate ? "end" : "middle"}
              {...(shouldRotate ? { transform: `rotate(-35, ${cx}, ${labelY})` } : {})}
              className="ws-chart-axis-label"
            >
              {displayLabel}
            </text>
          );
        })}

        {dimCol !== null ? (
          <text
            x={(plotLeft + plotRight) / 2}
            y={height - 8}
            fill="var(--ws-muted)"
            fontSize="11"
            textAnchor="middle"
            className="ws-chart-x-label"
          >
            {dimCol.name}
          </text>
        ) : null}
      </svg>

      <div className="ws-chart-sr-only">
        <table className="ws-chart-table">
          <caption className="ws-chart-table-caption">
            {title !== "" ? `${title}: ` : ""}
            {summarySentence}
          </caption>
          <thead>
            <tr>
              <th scope="col">{dimName}</th>
              <th scope="col">{measureName}</th>
            </tr>
          </thead>
          <tbody>
            {plottedPoints.map((point, i) => (
              <tr key={`sr-row-${i}`}>
                <td>{point.category}</td>
                <td>{point.formattedValue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
