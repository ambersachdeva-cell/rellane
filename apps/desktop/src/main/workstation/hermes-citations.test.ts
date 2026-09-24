import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSTATION_SOURCE_LIMIT, type WorkstationCitationSource } from "@cadrane/contracts";
import {
  CITATION_DISCLAIMER,
  TEMP_DIR_PREFIX,
  checkHermesCitations,
  parseBridgeResult,
  resolveBridgeScriptPath,
  resolveHermesScriptsDir,
  resolvePythonPath,
  verifyUpstreamHashes
} from "./hermes-citations.js";

const upstreamDir = resolveHermesScriptsDir();
const bridgePath = resolveBridgeScriptPath();
const pythonPath = resolvePythonPath();

const TURN_ONE = "00000000-0000-0000-0000-000000000001";
const TURN_TWO = "00000000-0000-0000-0000-000000000002";

const hostSources: readonly WorkstationCitationSource[] = [
  { id: 1, sourceTurnId: TURN_ONE, label: "Infrastructure memo", uri: `urn:rellane:source:${TURN_ONE}` }
];

function childOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "ok",
    summary: "All 1 numbered reference resolves to the sources you selected.",
    disclaimer: "This document has been fact-checked.",
    sources: [{ id: 9, sourceTurnId: "spoofed", label: "Spoofed", uri: "urn:rellane:source:spoofed" }],
    citedIds: [1],
    unknownReferences: [],
    missingFromSourcesBlock: [],
    unexpectedInSourcesBlock: [],
    mismatchedUrls: [],
    expectedSourcesBlock: "",
    stats: "",
    runtime: "Python 3.9.6",
    warnings: [],
    errors: [],
    quotes: [],
    quoteCheckNote: "No quoted passages were checked.",
    ...overrides
  });
}

describe("citation checker: host resolution and integrity", () => {
  it("resolves the pinned upstream scripts inside the vendored tree", () => {
    expect(upstreamDir.split(path.sep).join("/")).toContain("vendor/hermes-agent");
    expect(existsSync(path.join(upstreamDir, "sources.py"))).toBe(true);
    expect(existsSync(path.join(upstreamDir, "_hermes_home.py"))).toBe(true);
  });

  it("resolves the bridge script that ships with the desktop app", () => {
    expect(existsSync(bridgePath)).toBe(true);
    expect(bridgePath.endsWith(path.join("apps", "desktop", "scripts", "hermes-citations-bridge.py"))).toBe(true);
  });

  it("accepts the unchanged upstream scripts", async () => {
    await expect(verifyUpstreamHashes(upstreamDir)).resolves.toBeUndefined();
  });

  it("refuses scripts whose bytes no longer match the pin", async () => {
    const tampered = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-citations-tamper-"));
    try {
      await fs.copyFile(path.join(upstreamDir, "_hermes_home.py"), path.join(tampered, "_hermes_home.py"));
      const original = await fs.readFile(path.join(upstreamDir, "sources.py"), "utf8");
      await fs.writeFile(path.join(tampered, "sources.py"), `${original}\n# altered\n`, "utf8");
      await expect(verifyUpstreamHashes(tampered)).rejects.toThrow(/sources\.py hash mismatch/);
    } finally {
      await fs.rm(tampered, { recursive: true, force: true });
    }
  });

  it("reports unavailable when the named interpreter does not exist", async () => {
    const result = await checkHermesCitations({
      caseId: "case-1",
      draft: "Draft with [1].",
      sources: [{ sourceTurnId: TURN_ONE, label: "Source 1" }],
      runtimeOptions: { pythonPath: "/nonexistent/python3" }
    });
    expect(result.status).toBe("unavailable");
    expect(result.disclaimer).toBe(CITATION_DISCLAIMER);
    expect(result.summary).toContain("Python 3.9");
  });

  it("refuses more sources than the workstation allows, before any spawn", async () => {
    const tooMany = Array.from({ length: WORKSTATION_SOURCE_LIMIT + 1 }, (_value, index) => ({
      sourceTurnId: `turn-${index}`,
      label: `Source ${index}`
    }));
    await expect(
      checkHermesCitations({ caseId: "case-1", draft: "Draft", sources: tooMany })
    ).rejects.toThrow(/maximum of/);
  });
});

describe("citation checker: the child's output is data, not a verdict", () => {
  it("replaces the child's source list and disclaimer with the host's own", () => {
    const parsed = parseBridgeResult(childOutput(), hostSources);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.sources).toEqual(hostSources);
    expect(parsed.result.disclaimer).toBe(CITATION_DISCLAIMER);
    expect(parsed.result.status).toBe("ok");
  });

  it("downgrades a pass that arrives with errors", () => {
    const parsed = parseBridgeResult(childOutput({ errors: ["citation not in the ledger: [4]"] }), hostSources);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.status).toBe("mismatch");
    expect(parsed.result.summary).toContain("inconsistent");
  });

  it("downgrades a pass that cites a source nobody selected", () => {
    const parsed = parseBridgeResult(childOutput({ citedIds: [1, 7] }), hostSources);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.status).toBe("mismatch");
  });

  it("downgrades a pass that cites nothing at all", () => {
    const parsed = parseBridgeResult(childOutput({ citedIds: [] }), hostSources);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.status).toBe("mismatch");
  });

  it("rejects an unknown status, an unknown key, and output that is not JSON", () => {
    expect(parseBridgeResult(childOutput({ status: "verified" }), hostSources).ok).toBe(false);
    expect(parseBridgeResult(childOutput({ extra: true }), hostSources).ok).toBe(false);
    expect(parseBridgeResult("not json at all", hostSources).ok).toBe(false);
    expect(parseBridgeResult("", hostSources).ok).toBe(false);
  });
});

describe.skipIf(pythonPath === null)("citation checker: real runs against the pinned upstream script", () => {
  const sourcesBlock = (uuid: string, title: string) => `[1] urn:rellane:source:${uuid} — ${title}`;

  it("rejects a wrong citation, then passes once it is corrected", async () => {
    const sources = [{ sourceTurnId: TURN_ONE, label: "Infrastructure memo" }];
    const wrong = [
      "# Q3 brief",
      "The budget was approved for infrastructure [1].",
      "The contract was signed in March [99].",
      "",
      "## Sources",
      sourcesBlock(TURN_ONE, "Infrastructure memo")
    ].join("\n");

    const rejected = await checkHermesCitations({ caseId: "case-wrong", draft: wrong, sources });
    expect(rejected.status).toBe("mismatch");
    expect(rejected.unknownReferences).toContain("[99]");
    expect(rejected.errors.some((error) => error.includes("[99]"))).toBe(true);

    const corrected = await checkHermesCitations({
      caseId: "case-wrong",
      draft: wrong.replace("[99]", "[1]"),
      sources
    });
    expect(corrected.status).toBe("ok");
    expect(corrected.citedIds).toEqual([1]);
    expect(corrected.errors).toHaveLength(0);
    expect(corrected.disclaimer).toBe(CITATION_DISCLAIMER);
  });

  it("resolves the urn form the editor writes for a selected source", async () => {
    const draft = [
      "The budget was approved for infrastructure [1].",
      "",
      "## Sources",
      sourcesBlock(TURN_ONE, "Infrastructure memo")
    ].join("\n");
    const result = await checkHermesCitations({
      caseId: "case-valid",
      draft,
      sources: [{ sourceTurnId: TURN_ONE, label: "Infrastructure memo" }]
    });
    expect(result.status).toBe("ok");
    expect(result.runtime).toMatch(/^Python 3\.\d+\.\d+$/);
  });

  it("reports an uncited draft as uncited rather than as a pass", async () => {
    const result = await checkHermesCitations({
      caseId: "case-uncited",
      draft: "The team held a weekly planning meeting and agreed on the next steps.",
      sources: [{ sourceTurnId: TURN_ONE, label: "Weekly notes" }]
    });
    expect(result.status).toBe("uncited");
    expect(result.citedIds).toHaveLength(0);
    expect(result.summary).toContain("No numbered");
  });

  it("flags a Sources block that points somewhere the selection does not", async () => {
    const draft = [
      "Review the infrastructure section [1].",
      "",
      "## Sources",
      "[1] https://example.com/invented-url — Fake link"
    ].join("\n");
    const result = await checkHermesCitations({
      caseId: "case-mismatch",
      draft,
      sources: [{ sourceTurnId: TURN_ONE, label: "Infrastructure memo" }]
    });
    expect(result.status).toBe("mismatch");
    expect(result.mismatchedUrls.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.includes("does not match the ledger"))).toBe(true);
  });

  it("says plainly which reference forms it did not check", async () => {
    const draft = [
      "The budget was approved for infrastructure [1].",
      "Further detail is at https://example.com/report for anyone who wants it.",
      "",
      "## Sources",
      sourcesBlock(TURN_ONE, "Infrastructure memo")
    ].join("\n");
    const result = await checkHermesCitations({
      caseId: "case-forms",
      draft,
      sources: [{ sourceTurnId: TURN_ONE, label: "Infrastructure memo" }]
    });
    expect(result.warnings.some((warning) => warning.includes("Bare URLs"))).toBe(true);
    expect(result.disclaimer).toContain("does not judge whether any claim is true");
  });

  it("leaves no working directory behind in the system temp folder", async () => {
    const count = async () =>
      (await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith(TEMP_DIR_PREFIX)).length;
    const before = await count();
    await checkHermesCitations({
      caseId: "case-clean",
      draft: "An uncited paragraph that still runs the checker end to end.",
      sources: [{ sourceTurnId: TURN_TWO, label: "Notes" }]
    });
    expect(await count()).toBe(before);
  });

  it("matches a quoted phrase that appears verbatim in the selected source text", async () => {
    const draft = [
      'The contractor agreed to "review on Friday" [1].',
      "",
      "## Sources",
      sourcesBlock(TURN_ONE, "Infrastructure memo")
    ].join("\n");
    const result = await checkHermesCitations({
      caseId: "case-quote-match",
      draft,
      sources: [
        {
          sourceTurnId: TURN_ONE,
          label: "Infrastructure memo",
          body: "The team agreed to review on Friday before the deployment."
        }
      ]
    });
    expect(result.status).toBe("ok");
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]).toEqual({
      quote: "review on Friday",
      citation: "[1]",
      status: "matched"
    });
  });

  it("reports not_found when a quoted phrase does not appear in the selected source", async () => {
    const draft = [
      'The contractor promised "delivery by dawn" [1].',
      "",
      "## Sources",
      sourcesBlock(TURN_ONE, "Infrastructure memo")
    ].join("\n");
    const result = await checkHermesCitations({
      caseId: "case-quote-invented",
      draft,
      sources: [
        {
          sourceTurnId: TURN_ONE,
          label: "Infrastructure memo",
          body: "The team agreed to review on Friday before the deployment."
        }
      ]
    });
    expect(result.status).toBe("ok");
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]).toEqual({
      quote: "delivery by dawn",
      citation: "[1]",
      status: "not_found"
    });
  });

  it("reports source_not_selected when phrase cites an unselected source", async () => {
    const draft = [
      'The report stated "quarterly surplus" [2].',
      "",
      "## Sources",
      sourcesBlock(TURN_ONE, "Infrastructure memo")
    ].join("\n");
    const result = await checkHermesCitations({
      caseId: "case-quote-unselected",
      draft,
      sources: [
        {
          sourceTurnId: TURN_ONE,
          label: "Infrastructure memo",
          body: "The quarterly surplus was recorded elsewhere."
        }
      ]
    });
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]).toEqual({
      quote: "quarterly surplus",
      citation: "[2]",
      status: "source_not_selected"
    });
  });

  it("leaves quotes empty with an explicit note when no quotations are present", async () => {
    const draft = [
      "The budget was approved for infrastructure [1].",
      "",
      "## Sources",
      sourcesBlock(TURN_ONE, "Infrastructure memo")
    ].join("\n");
    const result = await checkHermesCitations({
      caseId: "case-no-quotes",
      draft,
      sources: [
        {
          sourceTurnId: TURN_ONE,
          label: "Infrastructure memo",
          body: "The budget was approved for infrastructure."
        }
      ]
    });
    expect(result.status).toBe("ok");
    expect(result.quotes).toEqual([]);
    expect(result.quoteCheckNote).toContain("No quoted passages");
  });

  it("ignores quotation marks inside fenced code blocks and inline code", async () => {
    const draft = [
      "Here is an inline snippet: `\"ignore me\" [1]`.",
      "```",
      '"fenced quote" [1]',
      "```",
      "",
      "## Sources",
      sourcesBlock(TURN_ONE, "Infrastructure memo")
    ].join("\n");
    const result = await checkHermesCitations({
      caseId: "case-code-quotes",
      draft,
      sources: [
        {
          sourceTurnId: TURN_ONE,
          label: "Infrastructure memo",
          body: "ignore me fenced quote"
        }
      ]
    });
    expect(result.quotes).toEqual([]);
    expect(result.quoteCheckNote).toContain("No quoted passages");
  });

  it("bounds recognized quotes to 40 and notes the truncation", async () => {
    const quoteLines = Array.from({ length: 45 }, (_value, index) => `"quote ${index}" [1]`).join("\n");
    const draft = [
      quoteLines,
      "",
      "## Sources",
      sourcesBlock(TURN_ONE, "Infrastructure memo")
    ].join("\n");
    const result = await checkHermesCitations({
      caseId: "case-max-quotes",
      draft,
      sources: [
        {
          sourceTurnId: TURN_ONE,
          label: "Infrastructure memo",
          body: Array.from({ length: 45 }, (_value, index) => `quote ${index}`).join(" ")
        }
      ]
    });
    expect(result.quotes).toHaveLength(40);
    expect(result.quoteCheckNote).toContain("40");
  });

  it("does not interpret blockquotes, mismatched delimiters or multiple citations as a checked quotation", async () => {
    const result = await checkHermesCitations({
      caseId: "case-quote-shapes",
      draft: ['A cited summary [1].', '> "review on Friday" [1]', '“review on Friday" [1]', '"review on Friday" [1][1]', '', '## Sources', sourcesBlock(TURN_ONE, "Notes")].join("\n"),
      sources: [{ sourceTurnId: TURN_ONE, label: "Notes", body: "review on Friday" }]
    });
    expect(result.quotes).toEqual([]);
    expect(result.quoteCheckNote).toContain("No quoted passages");
  });

  it("supports Unicode curly quotes and bracket UUID references", async () => {
    const draft = [
      `The plan was “review on Friday” [urn:rellane:source:${TURN_ONE}].`,
      "",
      "## Sources",
      sourcesBlock(TURN_ONE, "Infrastructure memo")
    ].join("\n");
    const result = await checkHermesCitations({
      caseId: "case-curly-uuid",
      draft,
      sources: [
        {
          sourceTurnId: TURN_ONE,
          label: "Infrastructure memo",
          body: "We will review on Friday."
        }
      ]
    });
    expect(result.status).toBe("ok");
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]!.status).toBe("matched");
    expect(result.quotes[0]!.quote).toBe("review on Friday");
  });
});
