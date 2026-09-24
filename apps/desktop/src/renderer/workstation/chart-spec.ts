/**
 * Declarative chart specification generator and calm graphite SVG renderer.
 * Adheres to Rellane visual aesthetic: pure SVG output without DOM dependencies,
 * precise linear/band scale math with nice ticks, accessible semantic tags,
 * and integer paise currency handling.
 */

export type ChartType = "bar" | "horizontal_bar" | "line" | "area" | "scatter" | "kpi";

export interface ChartDimension {
  readonly key: string;
  readonly label?: string;
}

export interface ChartMeasure {
  readonly key: string;
  readonly label?: string;
  readonly format?: "number" | "currency_paise" | "percent";
}

export interface ChartSpec {
  readonly type: ChartType;
  readonly title: string;
  readonly subtitle?: string;
  readonly x: ChartDimension | ChartMeasure;
  readonly y: ChartMeasure | readonly ChartMeasure[];
  readonly colorScheme?: "graphite" | "emerald" | "amber" | "indigo";
  readonly width?: number;
  readonly height?: number;
}

export interface ChartRenderResult {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  readonly title: string;
}

export interface LinearScale {
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  readonly ticks: readonly number[];
  readonly step: number;
  scale(value: number): number;
  invert(coord: number): number;
}

export interface BandScale {
  readonly domain: readonly string[];
  readonly range: readonly [number, number];
  readonly bandwidth: number;
  readonly step: number;
  scale(category: string, index?: number): number;
}

const PALETTES: Record<"graphite" | "emerald" | "amber" | "indigo", readonly string[]> = {
  graphite: ["#a1a1aa", "#71717a", "#e4e4e7", "#52525b", "#d4d4d8"],
  emerald: ["#10b981", "#34d399", "#059669", "#6ee7b7", "#a7f3d0"],
  amber: ["#f59e0b", "#fbbf24", "#d97706", "#fcd34d", "#fde68a"],
  indigo: ["#6366f1", "#818cf8", "#4f46e5", "#a5b4fc", "#c7d2fe"],
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function extractNumber(val: unknown): number {
  if (typeof val === "number" && !Number.isNaN(val)) {
    return val;
  }
  if (typeof val === "string") {
    const parsed = parseFloat(val);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function formatMeasureValue(
  value: number,
  format?: "number" | "currency_paise" | "percent"
): string {
  if (format === "currency_paise") {
    // Paise is converted to main currency units (100 paise = 1 INR) for human display.
    const mainUnits = value / 100;
    return `₹${mainUnits.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (format === "percent") {
    return `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
  }
  if (Math.abs(value) >= 1_000_000) {
    const rounded = value / 1_000_000;
    return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}M`;
  }
  if (Math.abs(value) >= 10_000) {
    const rounded = value / 1_000;
    return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
  }
  return value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}

function formatTick(
  value: number,
  format?: "number" | "currency_paise" | "percent"
): string {
  if (format === "currency_paise") {
    const units = value / 100;
    if (Math.abs(units) >= 1_000_000) {
      return `₹${(units / 1_000_000).toFixed(1)}M`;
    }
    if (Math.abs(units) >= 1_000) {
      return `₹${(units / 1_000).toFixed(0)}k`;
    }
    return `₹${units.toFixed(0)}`;
  }
  if (format === "percent") {
    return `${value.toFixed(0)}%`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(0)}k`;
  }
  return Number(value.toFixed(2)).toString();
}

export function calculateNiceTicks(
  min: number,
  max: number,
  targetTicks = 5
): readonly number[] {
  if (min === max) {
    if (min === 0) {
      return [0, 1, 2, 3, 4, 5];
    }
    const step = Math.pow(10, Math.floor(Math.log10(Math.abs(min))));
    return [min - step, min, min + step];
  }

  const rawMin = Math.min(min, max);
  const rawMax = Math.max(min, max);
  const span = rawMax - rawMin;

  const rawStep = span / targetTicks;
  const power = Math.floor(Math.log10(rawStep));
  const magnitude = Math.pow(10, power);
  const fraction = rawStep / magnitude;

  let niceFraction = 1;
  if (fraction < 1.5) {
    niceFraction = 1;
  } else if (fraction < 3) {
    niceFraction = 2;
  } else if (fraction < 7) {
    niceFraction = 5;
  } else {
    niceFraction = 10;
  }

  const step = niceFraction * magnitude;
  const niceMin = Math.floor(rawMin / step) * step;
  const niceMax = Math.ceil(rawMax / step) * step;

  const ticks: number[] = [];
  const stepsCount = Math.round((niceMax - niceMin) / step);
  for (let i = 0; i <= stepsCount; i++) {
    const val = Number((niceMin + i * step).toFixed(8));
    ticks.push(val);
  }

  return ticks;
}

export function computeLinearScale(
  min: number,
  max: number,
  range: readonly [number, number],
  options?: { readonly nice?: boolean; readonly targetTicks?: number }
): LinearScale {
  const targetTicks = options?.targetTicks ?? 5;
  const isNice = options?.nice ?? true;

  let domainMin = min;
  let domainMax = max;
  let ticks: readonly number[];

  if (isNice) {
    ticks = calculateNiceTicks(min, max, targetTicks);
    if (ticks.length > 0) {
      domainMin = ticks[0]!;
      domainMax = ticks[ticks.length - 1]!;
    }
  } else {
    ticks = calculateNiceTicks(min, max, targetTicks);
  }

  const dMin = domainMin;
  const dMax = domainMax;
  const rMin = range[0];
  const rMax = range[1];
  const span = dMax - dMin;
  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : 1;

  return {
    domain: [dMin, dMax],
    range: [rMin, rMax],
    ticks,
    step,
    scale(value: number): number {
      if (span === 0) {
        return (rMin + rMax) / 2;
      }
      return rMin + ((value - dMin) / span) * (rMax - rMin);
    },
    invert(coord: number): number {
      const rSpan = rMax - rMin;
      if (rSpan === 0) {
        return (dMin + dMax) / 2;
      }
      return dMin + ((coord - rMin) / rSpan) * span;
    },
  };
}

export function computeBandScale(
  domain: readonly string[],
  range: readonly [number, number],
  padding = 0.2
): BandScale {
  const count = domain.length;
  const rMin = range[0];
  const rMax = range[1];
  const totalWidth = Math.abs(rMax - rMin);
  const dir = rMax >= rMin ? 1 : -1;

  if (count === 0) {
    return {
      domain,
      range,
      bandwidth: 0,
      step: 0,
      scale: () => rMin,
    };
  }

  const step = totalWidth / count;
  const bandwidth = step * (1 - padding);
  const offset = (step * padding) / 2;

  const indexMap = new Map<string, number>();
  for (let i = 0; i < domain.length; i++) {
    const cat = domain[i]!;
    if (!indexMap.has(cat)) {
      indexMap.set(cat, i);
    }
  }

  return {
    domain,
    range,
    bandwidth,
    step,
    scale(category: string, index?: number): number {
      const idx = index !== undefined ? index : (indexMap.get(category) ?? 0);
      return rMin + dir * (idx * step + offset);
    },
  };
}

function generateSmoothPath(points: readonly (readonly [number, number])[]): string {
  if (points.length === 0) {
    return "";
  }
  const first = points[0]!;
  if (points.length === 1) {
    return `M ${first[0].toFixed(1)} ${first[1].toFixed(1)}`;
  }
  if (points.length === 2) {
    const second = points[1]!;
    return `M ${first[0].toFixed(1)} ${first[1].toFixed(1)} L ${second[0].toFixed(1)} ${second[1].toFixed(1)}`;
  }

  // Catmull-Rom spline control points produce C1 continuous curves without oscillation.
  let d = `M ${first[0].toFixed(1)} ${first[1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = i > 0 ? points[i - 1]! : points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = i < points.length - 2 ? points[i + 2]! : p2;

    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;

    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

export function renderKpiCard(
  title: string,
  value: number | string,
  subtitle?: string,
  sparklineData?: readonly number[],
  width = 320,
  height = 140
): string {
  const displayVal = typeof value === "number" ? value.toLocaleString("en-GB") : value;
  const elements: string[] = [];

  elements.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(title)}" style="background-color: #18181b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">`
  );
  elements.push(`  <title>${escapeXml(title)}: ${escapeXml(String(value))}</title>`);
  elements.push(`  <desc>${escapeXml(subtitle ?? `Key performance indicator for ${title}`)}</desc>`);
  elements.push(`  <rect width="${width}" height="${height}" rx="8" fill="#18181b" stroke="#27272a" stroke-width="1" />`);

  elements.push(
    `  <text x="20" y="32" fill="#71717a" font-size="11" font-weight="600" letter-spacing="0.05em" text-transform="uppercase">${escapeXml(title.toUpperCase())}</text>`
  );
  elements.push(
    `  <text x="20" y="74" fill="#e4e4e7" font-size="30" font-weight="700">${escapeXml(displayVal)}</text>`
  );

  let badgeWidth = 0;
  if (sparklineData !== undefined && sparklineData.length >= 2) {
    const first = sparklineData[0]!;
    const last = sparklineData[sparklineData.length - 1]!;
    const delta = last - first;
    const pct = first !== 0 ? (delta / Math.abs(first)) * 100 : 0;
    const isPositive = delta >= 0;
    const badgeText = `${isPositive ? "+" : ""}${pct.toFixed(1)}%`;
    const badgeColor = isPositive ? "#10b981" : "#f59e0b";
    const badgeBg = isPositive ? "rgba(16, 185, 129, 0.12)" : "rgba(245, 158, 11, 0.12)";

    badgeWidth = Math.max(52, badgeText.length * 8 + 12);
    elements.push(
      `  <rect x="20" y="94" width="${badgeWidth}" height="20" rx="4" fill="${badgeBg}" />`
    );
    elements.push(
      `  <text x="${20 + badgeWidth / 2}" y="108" fill="${badgeColor}" font-size="11" font-weight="600" text-anchor="middle">${badgeText}</text>`
    );
  }

  if (subtitle !== undefined) {
    const subX = badgeWidth > 0 ? 20 + badgeWidth + 8 : 20;
    const subY = badgeWidth > 0 ? 108 : 106;
    elements.push(
      `  <text x="${subX}" y="${subY}" fill="#71717a" font-size="11">${escapeXml(subtitle)}</text>`
    );
  }

  if (sparklineData !== undefined && sparklineData.length > 1) {
    const sparkW = 96;
    const sparkH = 42;
    const sparkLeft = width - 20 - sparkW;
    const sparkTop = 42;
    const sparkBottom = sparkTop + sparkH;

    let sMin = sparklineData[0]!;
    let sMax = sparklineData[0]!;
    for (let i = 1; i < sparklineData.length; i++) {
      const v = sparklineData[i]!;
      if (v < sMin) sMin = v;
      if (v > sMax) sMax = v;
    }
    const sSpan = sMax - sMin || 1;

    const points: [number, number][] = [];
    const count = sparklineData.length;
    for (let i = 0; i < count; i++) {
      const v = sparklineData[i]!;
      const px = sparkLeft + (i / (count - 1)) * sparkW;
      const py = sparkBottom - ((v - sMin) / sSpan) * sparkH;
      points.push([px, py]);
    }

    const sparkLinePath = generateSmoothPath(points);
    const lastPoint = points[points.length - 1]!;
    const firstPoint = points[0]!;
    const sparkAreaPath = `${sparkLinePath} L ${lastPoint[0].toFixed(1)} ${sparkBottom} L ${firstPoint[0].toFixed(1)} ${sparkBottom} Z`;

    const gradId = `spark-grad-${Math.abs(title.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0))}`;
    elements.push(`  <defs>`);
    elements.push(`    <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">`);
    elements.push(`      <stop offset="0%" stop-color="#a1a1aa" stop-opacity="0.25" />`);
    elements.push(`      <stop offset="100%" stop-color="#a1a1aa" stop-opacity="0.0" />`);
    elements.push(`    </linearGradient>`);
    elements.push(`  </defs>`);
    elements.push(`  <path d="${sparkAreaPath}" fill="url(#${gradId})" />`);
    elements.push(
      `  <path d="${sparkLinePath}" fill="none" stroke="#a1a1aa" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />`
    );
    elements.push(
      `  <circle cx="${lastPoint[0].toFixed(1)}" cy="${lastPoint[1].toFixed(1)}" r="2.5" fill="#e4e4e7" />`
    );
  }

  elements.push(`</svg>`);
  return elements.join("\n");
}

function formatKeyToLabel(key: string): string {
  const parts = key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean);
  return parts
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

function inferFormatFromKey(key: string): "number" | "currency_paise" | "percent" {
  const lower = key.toLowerCase();
  if (lower.includes("paise")) {
    return "currency_paise";
  }
  if (
    lower.includes("pct") ||
    lower.includes("percent") ||
    lower.includes("ratio") ||
    lower.includes("rate") ||
    lower.includes("margin")
  ) {
    return "percent";
  }
  return "number";
}

export function inferChartSpec(
  data: readonly Record<string, unknown>[],
  title?: string
): ChartSpec {
  if (data.length === 0) {
    return {
      type: "bar",
      title: title ?? "Data Overview",
      x: { key: "category", label: "Category" },
      y: { key: "value", label: "Value", format: "number" },
      colorScheme: "graphite",
      width: 600,
      height: 360,
    };
  }

  const keySet = new Set<string>();
  for (const row of data) {
    for (const k of Object.keys(row)) {
      keySet.add(k);
    }
  }
  const allKeys = Array.from(keySet);

  const numericKeys: string[] = [];
  const dateKeys: string[] = [];
  const categoricalKeys: string[] = [];

  const dateRegex = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/;
  const dateKeyKeywords = ["date", "timestamp", "time", "created_at", "updated_at", "month", "day", "year", "quarter"];

  for (const key of allKeys) {
    let numCount = 0;
    let dateCount = 0;
    let validCount = 0;
    const lowerKey = key.toLowerCase();

    for (const row of data) {
      const val = row[key];
      if (val === undefined || val === null || val === "") continue;
      validCount++;

      if (typeof val === "number") {
        numCount++;
      } else if (typeof val === "string") {
        if (!Number.isNaN(Number(val))) {
          numCount++;
        } else if (dateRegex.test(val)) {
          dateCount++;
        }
      }
    }

    if (validCount > 0 && dateCount / validCount > 0.6) {
      dateKeys.push(key);
    } else if (dateKeyKeywords.some(k => lowerKey === k || lowerKey.endsWith(`_${k}`))) {
      dateKeys.push(key);
    } else if (validCount > 0 && numCount / validCount > 0.7) {
      numericKeys.push(key);
    } else {
      categoricalKeys.push(key);
    }
  }

  let determinedType: ChartType = "bar";
  let xField: ChartDimension | ChartMeasure;
  let yField: ChartMeasure | readonly ChartMeasure[];
  let generatedTitle = title;

  if (categoricalKeys.length === 0 && dateKeys.length === 0 && numericKeys.length === 1 && data.length === 1) {
    const numKey = numericKeys[0]!;
    determinedType = "kpi";
    const label = formatKeyToLabel(numKey);
    xField = { key: numKey, label };
    yField = { key: numKey, label, format: inferFormatFromKey(numKey) };
    if (generatedTitle === undefined) {
      generatedTitle = label;
    }
  } else if (dateKeys.length > 0 && numericKeys.length > 0) {
    const dateKey = dateKeys[0]!;
    determinedType = "line";
    xField = { key: dateKey, label: formatKeyToLabel(dateKey) };
    if (numericKeys.length === 1) {
      const numKey = numericKeys[0]!;
      yField = { key: numKey, label: formatKeyToLabel(numKey), format: inferFormatFromKey(numKey) };
      if (generatedTitle === undefined) {
        generatedTitle = `${formatKeyToLabel(numKey)} over ${formatKeyToLabel(dateKey)}`;
      }
    } else {
      yField = numericKeys.map(k => ({
        key: k,
        label: formatKeyToLabel(k),
        format: inferFormatFromKey(k),
      }));
      if (generatedTitle === undefined) {
        generatedTitle = `Metrics over ${formatKeyToLabel(dateKey)}`;
      }
    }
  } else if (categoricalKeys.length > 0 && numericKeys.length > 0) {
    const catKey = categoricalKeys[0]!;
    const distinctVals = new Set(data.map(d => String(d[catKey] ?? "")));
    if (distinctVals.size > 10) {
      determinedType = "horizontal_bar";
    } else {
      determinedType = "bar";
    }
    xField = { key: catKey, label: formatKeyToLabel(catKey) };
    if (numericKeys.length === 1) {
      const numKey = numericKeys[0]!;
      yField = { key: numKey, label: formatKeyToLabel(numKey), format: inferFormatFromKey(numKey) };
      if (generatedTitle === undefined) {
        generatedTitle = `${formatKeyToLabel(numKey)} by ${formatKeyToLabel(catKey)}`;
      }
    } else {
      yField = numericKeys.map(k => ({
        key: k,
        label: formatKeyToLabel(k),
        format: inferFormatFromKey(k),
      }));
      if (generatedTitle === undefined) {
        generatedTitle = `Metrics by ${formatKeyToLabel(catKey)}`;
      }
    }
  } else if (numericKeys.length >= 2) {
    determinedType = "scatter";
    const xKey = numericKeys[0]!;
    const yKey = numericKeys[1]!;
    xField = { key: xKey, label: formatKeyToLabel(xKey), format: inferFormatFromKey(xKey) };
    yField = { key: yKey, label: formatKeyToLabel(yKey), format: inferFormatFromKey(yKey) };
    if (generatedTitle === undefined) {
      generatedTitle = `${formatKeyToLabel(yKey)} vs ${formatKeyToLabel(xKey)}`;
    }
  } else if (numericKeys.length === 1) {
    const numKey = numericKeys[0]!;
    determinedType = data.length <= 1 ? "kpi" : "line";
    xField = { key: "index", label: "Index" };
    yField = { key: numKey, label: formatKeyToLabel(numKey), format: inferFormatFromKey(numKey) };
    if (generatedTitle === undefined) {
      generatedTitle = formatKeyToLabel(numKey);
    }
  } else {
    const firstKey = allKeys[0] ?? "category";
    const secondKey = allKeys[1] ?? firstKey;
    determinedType = "bar";
    xField = { key: firstKey, label: formatKeyToLabel(firstKey) };
    yField = { key: secondKey, label: formatKeyToLabel(secondKey), format: "number" };
    if (generatedTitle === undefined) {
      generatedTitle = "Data Overview";
    }
  }

  return {
    type: determinedType,
    title: generatedTitle ?? "Data Overview",
    x: xField,
    y: yField,
    colorScheme: "graphite",
    width: 600,
    height: 360,
  };
}

export function renderChartToSvg(
  spec: ChartSpec,
  data: readonly Record<string, unknown>[]
): ChartRenderResult {
  const width = spec.width ?? 600;
  const height = spec.height ?? 360;
  const title = spec.title;
  const colorScheme = spec.colorScheme ?? "graphite";
  const palette = PALETTES[colorScheme];

  if (spec.type === "kpi") {
    const measure = Array.isArray(spec.y) ? spec.y[0] : spec.y;
    let val: number | string = "—";
    let sparkline: number[] | undefined;

    if (measure !== undefined && data.length > 0) {
      const lastRow = data[data.length - 1]!;
      const raw = lastRow[measure.key];
      if (typeof raw === "number") {
        val = formatMeasureValue(raw, measure.format);
      } else if (raw !== undefined && raw !== null) {
        val = String(raw);
      }
      const series = data
        .map(d => {
          const v = d[measure.key];
          return typeof v === "number" ? v : Number(v);
        })
        .filter(v => !Number.isNaN(v));
      if (series.length > 0) {
        sparkline = series;
      }
    }

    const kpiSvg = renderKpiCard(spec.title, val, spec.subtitle, sparkline, width, height);
    return {
      svg: kpiSvg,
      width,
      height,
      title,
    };
  }

  // No-data state displays a calm empty placeholder rather than throwing.
  if (data.length === 0) {
    const svgLines = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(title)}" style="background-color: #18181b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">`,
      `  <title>${escapeXml(title)}</title>`,
      `  <desc>No data available to display for ${escapeXml(title)}.</desc>`,
      `  <rect width="100%" height="100%" fill="#18181b" rx="6" />`,
      `  <rect width="100%" height="100%" fill="none" stroke="#27272a" stroke-width="1" rx="6" />`,
      `  <text x="24" y="28" fill="#e4e4e7" font-size="14" font-weight="600">${escapeXml(title)}</text>`,
      spec.subtitle !== undefined
        ? `  <text x="24" y="46" fill="#71717a" font-size="12">${escapeXml(spec.subtitle)}</text>`
        : "",
      `  <text x="${width / 2}" y="${height / 2}" fill="#71717a" font-size="13" text-anchor="middle">No data to display</text>`,
      `</svg>`,
    ].filter(Boolean);

    return {
      svg: svgLines.join("\n"),
      width,
      height,
      title,
    };
  }

  const rawMeasures = Array.isArray(spec.y) ? spec.y : [spec.y];
  const fallbackMeasure: ChartMeasure = { key: "value", label: "Value" };
  const measures: readonly ChartMeasure[] = rawMeasures.length > 0 ? rawMeasures : [fallbackMeasure];
  const firstMeasure = measures[0]!;

  const marginTop = spec.subtitle !== undefined ? 58 : 44;
  const marginBottom = 44;
  const isHorizontal = spec.type === "horizontal_bar";
  const marginLeft = isHorizontal ? 84 : 58;
  const marginRight = 24;

  const plotLeft = marginLeft;
  const plotRight = width - marginRight;
  const plotTop = marginTop;
  const plotBottom = height - marginBottom;
  const plotWidth = plotRight - plotLeft;

  const elements: string[] = [];
  elements.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(title)}" style="background-color: #18181b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">`
  );

  const yLabels = measures.map(m => m.label ?? m.key).join(", ");
  const xLabel = spec.x.label ?? spec.x.key;
  elements.push(`  <title>${escapeXml(title)}</title>`);
  elements.push(
    `  <desc>A ${spec.type} chart titled "${escapeXml(title)}" displaying ${escapeXml(yLabels)} across ${escapeXml(xLabel)} with ${data.length} data points.</desc>`
  );
  elements.push(`  <rect width="100%" height="100%" fill="#18181b" rx="6" />`);
  elements.push(`  <rect width="100%" height="100%" fill="none" stroke="#27272a" stroke-width="1" rx="6" />`);
  elements.push(`  <text x="${plotLeft}" y="26" fill="#e4e4e7" font-size="14" font-weight="600">${escapeXml(title)}</text>`);
  if (spec.subtitle !== undefined) {
    elements.push(`  <text x="${plotLeft}" y="44" fill="#71717a" font-size="12">${escapeXml(spec.subtitle)}</text>`);
  }

  if (measures.length > 1 && !isHorizontal) {
    let legendX = plotRight;
    const legendItems: string[] = [];
    for (let mIdx = measures.length - 1; mIdx >= 0; mIdx--) {
      const m = measures[mIdx]!;
      const col = palette[mIdx % palette.length]!;
      const label = escapeXml(m.label ?? m.key);
      const itemWidth = label.length * 7 + 22;
      legendX -= itemWidth;
      legendItems.unshift(
        `  <rect x="${legendX}" y="16" width="10" height="10" rx="2" fill="${col}" />` +
          `\n  <text x="${legendX + 14}" y="25" fill="#a1a1aa" font-size="11">${label}</text>`
      );
    }
    elements.push(...legendItems);
  }

  if (spec.type === "bar") {
    const categories = data.map(d => String(d[spec.x.key] ?? ""));
    const bandScale = computeBandScale(categories, [plotLeft, plotRight], 0.25);

    let yMin = 0;
    let yMax = 0;
    let hasVal = false;
    for (const row of data) {
      for (const m of measures) {
        const v = extractNumber(row[m.key]);
        if (!hasVal) {
          yMin = v;
          yMax = v;
          hasVal = true;
        } else {
          if (v < yMin) yMin = v;
          if (v > yMax) yMax = v;
        }
      }
    }
    if (yMin > 0) yMin = 0;
    if (yMax <= 0 && yMin === 0) yMax = 10;

    const yScale = computeLinearScale(yMin, yMax, [plotBottom, plotTop]);

    for (const tick of yScale.ticks) {
      const ty = yScale.scale(tick);
      elements.push(
        `  <line x1="${plotLeft}" y1="${ty.toFixed(1)}" x2="${plotRight}" y2="${ty.toFixed(1)}" stroke="#27272a" stroke-width="1" stroke-dasharray="3,3" />`
      );
      elements.push(
        `  <text x="${plotLeft - 8}" y="${(ty + 4).toFixed(1)}" fill="#71717a" font-size="10" text-anchor="end">${formatTick(tick, firstMeasure.format)}</text>`
      );
    }

    const baselineY = yScale.scale(0);
    elements.push(
      `  <line x1="${plotLeft}" y1="${baselineY.toFixed(1)}" x2="${plotRight}" y2="${baselineY.toFixed(1)}" stroke="#3f3f46" stroke-width="1" />`
    );

    if (measures.length === 1) {
      const m = measures[0]!;
      const col = palette[0]!;
      for (let i = 0; i < data.length; i++) {
        const row = data[i]!;
        const cat = String(row[spec.x.key] ?? "");
        const v = extractNumber(row[m.key]);
        const bx = bandScale.scale(cat, i);
        const bw = bandScale.bandwidth;
        const by = v >= 0 ? yScale.scale(v) : baselineY;
        const bh = Math.max(1, Math.abs(yScale.scale(v) - baselineY));
        elements.push(
          `  <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}" rx="3" />`
        );
      }
    } else {
      const innerBw = bandScale.bandwidth / measures.length;
      for (let i = 0; i < data.length; i++) {
        const row = data[i]!;
        const cat = String(row[spec.x.key] ?? "");
        const groupX = bandScale.scale(cat, i);
        for (let mIdx = 0; mIdx < measures.length; mIdx++) {
          const m = measures[mIdx]!;
          const col = palette[mIdx % palette.length]!;
          const v = extractNumber(row[m.key]);
          const bx = groupX + mIdx * innerBw;
          const by = v >= 0 ? yScale.scale(v) : baselineY;
          const bh = Math.max(1, Math.abs(yScale.scale(v) - baselineY));
          elements.push(
            `  <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${Math.max(1, innerBw - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}" rx="2" />`
          );
        }
      }
    }

    for (let i = 0; i < data.length; i++) {
      const row = data[i]!;
      const cat = String(row[spec.x.key] ?? "");
      const cx = bandScale.scale(cat, i) + bandScale.bandwidth / 2;
      elements.push(
        `  <text x="${cx.toFixed(1)}" y="${plotBottom + 16}" fill="#a1a1aa" font-size="11" text-anchor="middle">${escapeXml(truncateText(cat, 12))}</text>`
      );
    }

    if (spec.x.label !== undefined) {
      elements.push(
        `  <text x="${((plotLeft + plotRight) / 2).toFixed(1)}" y="${plotBottom + 34}" fill="#71717a" font-size="11" text-anchor="middle">${escapeXml(spec.x.label)}</text>`
      );
    }
  } else if (spec.type === "horizontal_bar") {
    const categories = data.map(d => String(d[spec.x.key] ?? ""));
    const bandScale = computeBandScale(categories, [plotTop, plotBottom], 0.25);

    let xMin = 0;
    let xMax = 0;
    let hasVal = false;
    for (const row of data) {
      const v = extractNumber(row[firstMeasure.key]);
      if (!hasVal) {
        xMin = v;
        xMax = v;
        hasVal = true;
      } else {
        if (v < xMin) xMin = v;
        if (v > xMax) xMax = v;
      }
    }
    if (xMin > 0) xMin = 0;
    if (xMax <= 0 && xMin === 0) xMax = 10;

    const xScale = computeLinearScale(xMin, xMax, [plotLeft, plotRight]);

    for (const tick of xScale.ticks) {
      const tx = xScale.scale(tick);
      elements.push(
        `  <line x1="${tx.toFixed(1)}" y1="${plotTop}" x2="${tx.toFixed(1)}" y2="${plotBottom}" stroke="#27272a" stroke-width="1" stroke-dasharray="3,3" />`
      );
      elements.push(
        `  <text x="${tx.toFixed(1)}" y="${plotBottom + 16}" fill="#71717a" font-size="10" text-anchor="middle">${formatTick(tick, firstMeasure.format)}</text>`
      );
    }

    const baselineX = xScale.scale(0);
    elements.push(
      `  <line x1="${baselineX.toFixed(1)}" y1="${plotTop}" x2="${baselineX.toFixed(1)}" y2="${plotBottom}" stroke="#3f3f46" stroke-width="1" />`
    );

    for (let i = 0; i < data.length; i++) {
      const row = data[i]!;
      const cat = String(row[spec.x.key] ?? "");
      const v = extractNumber(row[firstMeasure.key]);
      const by = bandScale.scale(cat, i);
      const bh = bandScale.bandwidth;
      const bx = v >= 0 ? baselineX : xScale.scale(v);
      const bw = Math.max(1, Math.abs(xScale.scale(v) - baselineX));
      elements.push(
        `  <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${palette[0]!}" rx="3" />`
      );
      elements.push(
        `  <text x="${plotLeft - 8}" y="${(by + bh / 2 + 4).toFixed(1)}" fill="#a1a1aa" font-size="11" text-anchor="end">${escapeXml(truncateText(cat, 12))}</text>`
      );
    }

    if (spec.x.label !== undefined) {
      elements.push(
        `  <text x="${((plotLeft + plotRight) / 2).toFixed(1)}" y="${plotBottom + 34}" fill="#71717a" font-size="11" text-anchor="middle">${escapeXml(spec.x.label)}</text>`
      );
    }
  } else if (spec.type === "line" || spec.type === "area") {
    let yMin = 0;
    let yMax = 0;
    let hasVal = false;
    for (const row of data) {
      for (const m of measures) {
        const v = extractNumber(row[m.key]);
        if (!hasVal) {
          yMin = v;
          yMax = v;
          hasVal = true;
        } else {
          if (v < yMin) yMin = v;
          if (v > yMax) yMax = v;
        }
      }
    }
    if (spec.type === "area" && yMin > 0) yMin = 0;
    if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    }
    const yScale = computeLinearScale(yMin, yMax, [plotBottom, plotTop]);

    const isNumericX =
      data.length > 0 &&
      data.every(d => typeof d[spec.x.key] === "number" || (!Number.isNaN(Number(d[spec.x.key])) && d[spec.x.key] !== ""));

    let numXScale: LinearScale | undefined;
    if (isNumericX) {
      let xMin = extractNumber(data[0]![spec.x.key]);
      let xMax = xMin;
      for (const row of data) {
        const v = extractNumber(row[spec.x.key]);
        if (v < xMin) xMin = v;
        if (v > xMax) xMax = v;
      }
      if (xMin === xMax) {
        xMin -= 1;
        xMax += 1;
      }
      numXScale = computeLinearScale(xMin, xMax, [plotLeft, plotRight]);
    }

    for (const tick of yScale.ticks) {
      const ty = yScale.scale(tick);
      elements.push(
        `  <line x1="${plotLeft}" y1="${ty.toFixed(1)}" x2="${plotRight}" y2="${ty.toFixed(1)}" stroke="#27272a" stroke-width="1" stroke-dasharray="3,3" />`
      );
      elements.push(
        `  <text x="${plotLeft - 8}" y="${(ty + 4).toFixed(1)}" fill="#71717a" font-size="10" text-anchor="end">${formatTick(tick, firstMeasure.format)}</text>`
      );
    }

    for (let mIdx = 0; mIdx < measures.length; mIdx++) {
      const m = measures[mIdx]!;
      const col = palette[mIdx % palette.length]!;
      const points: [number, number][] = [];
      for (let i = 0; i < data.length; i++) {
        const row = data[i]!;
        const px = numXScale !== undefined
          ? numXScale.scale(extractNumber(row[spec.x.key]))
          : (data.length > 1 ? plotLeft + (i / (data.length - 1)) * plotWidth : (plotLeft + plotRight) / 2);
        const py = yScale.scale(extractNumber(row[m.key]));
        points.push([px, py]);
      }

      const pathD = generateSmoothPath(points);
      if (spec.type === "area" && points.length > 0) {
        const gradId = `area-grad-${mIdx}`;
        elements.push(`  <defs>`);
        elements.push(`    <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">`);
        elements.push(`      <stop offset="0%" stop-color="${col}" stop-opacity="0.30" />`);
        elements.push(`      <stop offset="100%" stop-color="${col}" stop-opacity="0.02" />`);
        elements.push(`    </linearGradient>`);
        elements.push(`  </defs>`);
        const firstP = points[0]!;
        const lastP = points[points.length - 1]!;
        const areaD = `${pathD} L ${lastP[0].toFixed(1)} ${plotBottom} L ${firstP[0].toFixed(1)} ${plotBottom} Z`;
        elements.push(`  <path d="${areaD}" fill="url(#${gradId})" />`);
      }

      elements.push(
        `  <path d="${pathD}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`
      );
      for (const p of points) {
        elements.push(
          `  <circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="#18181b" stroke="${col}" stroke-width="2" />`
        );
      }
    }

    if (numXScale !== undefined) {
      for (const tick of numXScale.ticks) {
        const tx = numXScale.scale(tick);
        elements.push(
          `  <text x="${tx.toFixed(1)}" y="${plotBottom + 16}" fill="#71717a" font-size="10" text-anchor="middle">${Number(tick.toFixed(2))}</text>`
        );
      }
    } else {
      const stepCount = Math.min(data.length, 6);
      const stride = Math.max(1, Math.floor(data.length / stepCount));
      for (let i = 0; i < data.length; i += stride) {
        const row = data[i]!;
        const cat = String(row[spec.x.key] ?? "");
        const px = data.length > 1 ? plotLeft + (i / (data.length - 1)) * plotWidth : (plotLeft + plotRight) / 2;
        elements.push(
          `  <text x="${px.toFixed(1)}" y="${plotBottom + 16}" fill="#a1a1aa" font-size="11" text-anchor="middle">${escapeXml(truncateText(cat, 12))}</text>`
        );
      }
    }
  } else if (spec.type === "scatter") {
    let xMin = extractNumber(data[0]![spec.x.key]);
    let xMax = xMin;
    let yMin = extractNumber(data[0]![firstMeasure.key]);
    let yMax = yMin;
    for (const row of data) {
      const vx = extractNumber(row[spec.x.key]);
      const vy = extractNumber(row[firstMeasure.key]);
      if (vx < xMin) xMin = vx;
      if (vx > xMax) xMax = vx;
      if (vy < yMin) yMin = vy;
      if (vy > yMax) yMax = vy;
    }
    if (xMin === xMax) {
      xMin -= 1;
      xMax += 1;
    }
    if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    }
    const xScale = computeLinearScale(xMin, xMax, [plotLeft, plotRight]);
    const yScale = computeLinearScale(yMin, yMax, [plotBottom, plotTop]);

    for (const tick of yScale.ticks) {
      const ty = yScale.scale(tick);
      elements.push(
        `  <line x1="${plotLeft}" y1="${ty.toFixed(1)}" x2="${plotRight}" y2="${ty.toFixed(1)}" stroke="#27272a" stroke-width="1" stroke-dasharray="3,3" />`
      );
      elements.push(
        `  <text x="${plotLeft - 8}" y="${(ty + 4).toFixed(1)}" fill="#71717a" font-size="10" text-anchor="end">${formatTick(tick, firstMeasure.format)}</text>`
      );
    }
    for (const tick of xScale.ticks) {
      const tx = xScale.scale(tick);
      elements.push(
        `  <line x1="${tx.toFixed(1)}" y1="${plotTop}" x2="${tx.toFixed(1)}" y2="${plotBottom}" stroke="#27272a" stroke-width="1" stroke-dasharray="3,3" />`
      );
      elements.push(
        `  <text x="${tx.toFixed(1)}" y="${plotBottom + 16}" fill="#71717a" font-size="10" text-anchor="middle">${Number(tick.toFixed(2))}</text>`
      );
    }

    const col = palette[0]!;
    for (const row of data) {
      const vx = extractNumber(row[spec.x.key]);
      const vy = extractNumber(row[firstMeasure.key]);
      const cx = xScale.scale(vx);
      const cy = yScale.scale(vy);
      elements.push(
        `  <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${col}" fill-opacity="0.8" stroke="#18181b" stroke-width="1.5" />`
      );
    }
  }

  elements.push(`</svg>`);
  return {
    svg: elements.join("\n"),
    width,
    height,
    title,
  };
}
