import { describe, expect, it } from "vitest";
import { PANEL_COPY, copyFor, type PanelId, type PanelCopy } from "./panel-copy.js";

const ALL_PANEL_IDS: readonly PanelId[] = [
  "sessions",
  "crew",
  "dispatch",
  "agents",
  "agent-editor",
  "files",
  "data",
  "chart",
  "search",
  "insights",
  "publish",
  "pairing",
  "knowledge",
  "connectors",
  "usage",
  "diagnostics",
];

const BANNED_PATTERNS: readonly string[] = [
  "duckdb",
  "sql",
  "typst",
  "hmac",
  "vector",
  "embedding",
  "ipc",
  "json",
  "api",
  "token",
  "llm",
  "agent loop",
  "hermes",
  "electron",
  "jsdom",
  "async",
  "cache",
  "buffer",
  "daemon",
  "socket",
  "the owner",
  "the user",
];

function extractStrings(copy: PanelCopy): readonly string[] {
  const strings = [
    copy.empty.lead,
    copy.empty.detail,
    copy.loading,
    copy.failed,
  ];
  if (copy.empty.action !== null) {
    return [...strings, copy.empty.action];
  }
  return strings;
}

describe("panel-copy", () => {
  it("defines copy for every expected panel id", () => {
    expect(Object.keys(PANEL_COPY).sort()).toEqual([...ALL_PANEL_IDS].sort());
    for (const panelId of ALL_PANEL_IDS) {
      const copy = copyFor(panelId);
      expect(copy).toBeDefined();
      expect(copy).toBe(PANEL_COPY[panelId]);
    }
  });

  it("falls back gracefully for unknown panel identifiers", () => {
    const fallback = copyFor("unknown-panel" as PanelId);
    expect(fallback).toBeDefined();
    expect(fallback.empty.lead.length).toBeGreaterThan(0);
  });

  it("enforces length limits across every panel", () => {
    for (const panelId of ALL_PANEL_IDS) {
      const copy = PANEL_COPY[panelId];
      expect(copy).toBeDefined();
      if (copy === undefined) {
        continue;
      }

      expect(copy.empty.lead.length).toBeLessThan(48);
      expect(copy.empty.detail.length).toBeLessThan(120);
      expect(copy.loading.length).toBeLessThan(40);
      expect(copy.failed.length).toBeLessThan(100);
    }
  });

  it("never contains banned implementation terms or developer jargon", () => {
    for (const panelId of ALL_PANEL_IDS) {
      const copy = PANEL_COPY[panelId];
      expect(copy).toBeDefined();
      if (copy === undefined) {
        continue;
      }

      const allStrings = extractStrings(copy);
      for (const text of allStrings) {
        const lower = text.toLowerCase();
        for (const banned of BANNED_PATTERNS) {
          expect(lower).not.toContain(banned);
        }
      }
    }
  });

  it("contains no exclamation marks, em dashes, or emoji", () => {
    const emojiRegex = /\p{Extended_Pictographic}/u;
    for (const panelId of ALL_PANEL_IDS) {
      const copy = PANEL_COPY[panelId];
      expect(copy).toBeDefined();
      if (copy === undefined) {
        continue;
      }

      const allStrings = extractStrings(copy);
      for (const text of allStrings) {
        expect(text).not.toContain("!");
        expect(text).not.toContain("—");
        expect(text).not.toContain("–");
        expect(text).not.toContain("--");
        expect(emojiRegex.test(text)).toBe(false);
      }
    }
  });

  it("ensures empty details provide guidance rather than restating the lead", () => {
    for (const panelId of ALL_PANEL_IDS) {
      const copy = PANEL_COPY[panelId];
      expect(copy).toBeDefined();
      if (copy === undefined) {
        continue;
      }

      const leadLower = copy.empty.lead.toLowerCase();
      const detailLower = copy.empty.detail.toLowerCase();

      expect(detailLower).not.toContain(leadLower);
      expect(leadLower).not.toContain(detailLower);
      expect(copy.empty.detail.trim().length).toBeGreaterThan(copy.empty.lead.trim().length);
    }
  });

  it("requires every failed state to end with a full stop and avoid interpolation", () => {
    for (const panelId of ALL_PANEL_IDS) {
      const copy = PANEL_COPY[panelId];
      expect(copy).toBeDefined();
      if (copy === undefined) {
        continue;
      }

      expect(copy.failed.endsWith(".")).toBe(true);
      expect(copy.failed).not.toContain("${");
      expect(copy.failed).not.toContain("%s");
      expect(copy.failed).not.toContain("{");
    }
  });

  it("constrains action buttons to concise labels between two and four words, or null", () => {
    for (const panelId of ALL_PANEL_IDS) {
      const copy = PANEL_COPY[panelId];
      expect(copy).toBeDefined();
      if (copy === undefined) {
        continue;
      }

      const action = copy.empty.action;
      if (action !== null) {
        const words = action.trim().split(/\s+/);
        expect(words.length).toBeGreaterThanOrEqual(2);
        expect(words.length).toBeLessThanOrEqual(4);
      }
    }
  });
});
