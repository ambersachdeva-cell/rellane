import { describe, expect, it } from "vitest";
import {
  calculateNiceTicks,
  computeBandScale,
  computeLinearScale,
  inferChartSpec,
  renderChartToSvg,
  renderKpiCard,
  type ChartSpec,
} from "./chart-spec.js";

describe("Scale computation", () => {
  it("linear scale produces valid coordinate mapping and tick marks", () => {
    const scale = computeLinearScale(0, 100, [300, 50]);
    expect(scale.domain[0]).toBe(0);
    expect(scale.domain[1]).toBe(100);
    expect(scale.scale(0)).toBe(300);
    expect(scale.scale(100)).toBe(50);
    expect(scale.scale(50)).toBe(175);
    expect(scale.invert(175)).toBe(50);
    expect(scale.ticks.length).toBeGreaterThanOrEqual(4);
    expect(scale.ticks).toContain(0);
    expect(scale.ticks).toContain(100);
  });

  it("nice tick calculator produces readable interval bounds", () => {
    const ticks = calculateNiceTicks(0, 87, 5);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(100);
    expect(ticks).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("band scale divides category space evenly with padding", () => {
    const categories = ["Alpha", "Beta", "Gamma"];
    const scale = computeBandScale(categories, [50, 350], 0.2);
    expect(scale.bandwidth).toBe(80);
    expect(scale.step).toBe(100);
    expect(scale.scale("Alpha", 0)).toBe(60);
    expect(scale.scale("Beta", 1)).toBe(160);
    expect(scale.scale("Gamma", 2)).toBe(260);
  });

  it("handles zero span gracefully without division by zero", () => {
    const scale = computeLinearScale(50, 50, [200, 100]);
    expect(Number.isNaN(scale.scale(50))).toBe(false);
    expect(scale.scale(50)).toBe(150);
  });
});

describe("Chart SVG Rendering", () => {
  it("renders vertical bar charts with axis labels and ticks", () => {
    const spec: ChartSpec = {
      type: "bar",
      title: "Monthly Revenue",
      x: { key: "month", label: "Month" },
      y: { key: "revenue_paise", label: "Revenue", format: "currency_paise" },
      colorScheme: "emerald",
      width: 500,
      height: 300,
    };
    const data = [
      { month: "Jan", revenue_paise: 200000 },
      { month: "Feb", revenue_paise: 450000 },
      { month: "Mar", revenue_paise: 300000 },
    ];

    const result = renderChartToSvg(spec, data);
    expect(result.width).toBe(500);
    expect(result.height).toBe(300);
    expect(result.title).toBe("Monthly Revenue");
    expect(result.svg).toContain("<title>Monthly Revenue</title>");
    expect(result.svg).toContain("<desc>");
    expect(result.svg).toContain("Jan");
    expect(result.svg).toContain("Feb");
    expect(result.svg).toContain("Mar");
    expect(result.svg).toContain("₹");
    expect(result.svg).toContain("<rect");
  });

  it("renders horizontal bar charts with oriented axes", () => {
    const spec: ChartSpec = {
      type: "horizontal_bar",
      title: "Task Status",
      x: { key: "status", label: "Status" },
      y: { key: "count", label: "Total Tasks", format: "number" },
    };
    const data = [
      { status: "Pending", count: 14 },
      { status: "Completed", count: 42 },
      { status: "Blocked", count: 6 },
    ];

    const result = renderChartToSvg(spec, data);
    expect(result.svg).toContain("Pending");
    expect(result.svg).toContain("Completed");
    expect(result.svg).toContain("Blocked");
    expect(result.svg).toContain("stroke-dasharray=\"3,3\"");
  });

  it("renders line chart with smooth polyline/path points", () => {
    const spec: ChartSpec = {
      type: "line",
      title: "Throughput Trend",
      x: { key: "hour", label: "Hour" },
      y: { key: "ops", label: "Operations", format: "number" },
      colorScheme: "indigo",
    };
    const data = [
      { hour: "08:00", ops: 120 },
      { hour: "09:00", ops: 240 },
      { hour: "10:00", ops: 310 },
      { hour: "11:00", ops: 290 },
    ];

    const result = renderChartToSvg(spec, data);
    expect(result.svg).toContain("<path d=\"M");
    expect(result.svg).toContain(" C ");
    expect(result.svg).toContain("<circle");
    expect(result.svg).toContain("#6366f1");
  });

  it("renders area chart with gradient definitions", () => {
    const spec: ChartSpec = {
      type: "area",
      title: "Memory Usage",
      x: { key: "step", label: "Step" },
      y: { key: "mb", label: "Megabytes" },
      colorScheme: "graphite",
    };
    const data = [
      { step: 1, mb: 100 },
      { step: 2, mb: 160 },
      { step: 3, mb: 140 },
    ];

    const result = renderChartToSvg(spec, data);
    expect(result.svg).toContain("<linearGradient");
    expect(result.svg).toContain("<path");
  });

  it("renders scatter chart with mapped point coordinates", () => {
    const spec: ChartSpec = {
      type: "scatter",
      title: "Response vs Payload",
      x: { key: "payload_kb", label: "Payload (KB)" },
      y: { key: "latency_ms", label: "Latency (ms)" },
    };
    const data = [
      { payload_kb: 10, latency_ms: 25 },
      { payload_kb: 50, latency_ms: 70 },
      { payload_kb: 100, latency_ms: 120 },
    ];

    const result = renderChartToSvg(spec, data);
    expect(result.svg).toContain("<circle");
  });

  it("handles empty datasets without crashing", () => {
    const spec: ChartSpec = {
      type: "bar",
      title: "Empty Metric",
      x: { key: "category" },
      y: { key: "val" },
    };
    const result = renderChartToSvg(spec, []);
    expect(result.title).toBe("Empty Metric");
    expect(result.svg).toContain("No data to display");
    expect(result.svg).toContain("</svg>");
  });
});

describe("KPI card rendering", () => {
  it("renders KPI card with sparkline and delta badge", () => {
    const sparkline = [100, 120, 115, 140, 180];
    const svg = renderKpiCard("Active Sessions", 180, "vs yesterday", sparkline);
    expect(svg).toContain("ACTIVE SESSIONS");
    expect(svg).toContain("180");
    expect(svg).toContain("+80.0%");
    expect(svg).toContain("vs yesterday");
    expect(svg).toContain("<path d=\"M");
  });

  it("renders KPI card without sparkline cleanly", () => {
    const svg = renderKpiCard("Storage Used", "4.2 GB", "Within quota");
    expect(svg).toContain("STORAGE USED");
    expect(svg).toContain("4.2 GB");
    expect(svg).toContain("Within quota");
    expect(svg).not.toContain("<path");
  });
});

describe("Auto-infer chart specification", () => {
  it("infers bar chart from categorical and numerical datasets", () => {
    const data = [
      { department: "Engineering", spend_paise: 8500000 },
      { department: "Design", spend_paise: 3200000 },
      { department: "Operations", spend_paise: 4100000 },
    ];
    const spec = inferChartSpec(data);
    expect(spec.type).toBe("bar");
    expect(spec.x.key).toBe("department");
    const measure = spec.y as { key: string; format?: string };
    expect(measure.key).toBe("spend_paise");
    expect(measure.format).toBe("currency_paise");
  });

  it("infers line chart from temporal datasets", () => {
    const data = [
      { date: "2026-03-01", users: 50 },
      { date: "2026-03-02", users: 85 },
      { date: "2026-03-03", users: 110 },
    ];
    const spec = inferChartSpec(data, "Daily Active Users");
    expect(spec.type).toBe("line");
    expect(spec.title).toBe("Daily Active Users");
    expect(spec.x.key).toBe("date");
  });

  it("infers scatter plot from multiple numerical columns", () => {
    const data = [
      { memory_mb: 256, cpu_pct: 12.5 },
      { memory_mb: 512, cpu_pct: 35.0 },
      { memory_mb: 1024, cpu_pct: 78.2 },
    ];
    const spec = inferChartSpec(data);
    expect(spec.type).toBe("scatter");
  });

  it("infers KPI card for single numerical summary value", () => {
    const data = [{ total_revenue_paise: 92000000 }];
    const spec = inferChartSpec(data);
    expect(spec.type).toBe("kpi");
    const measure = spec.y as { format?: string };
    expect(measure.format).toBe("currency_paise");
  });

  it("handles empty input safely", () => {
    const spec = inferChartSpec([]);
    expect(spec.type).toBe("bar");
    expect(spec.title).toBe("Data Overview");
  });
});
