import { describe, expect, it } from "vitest";
import { extractWorkstationArtifacts } from "./artifacts.js";

describe("extractWorkstationArtifacts", () => {
  describe("code fence extraction", () => {
    it("extracts complete fenced code with specified language", () => {
      const text = [
        "Here is the database schema helper:",
        "```typescript",
        "export function initSchema(db: DatabaseSync): void {",
        "  db.exec('CREATE TABLE test (id TEXT PRIMARY KEY)');",
        "}",
        "```"
      ].join("\n");

      const artifacts = extractWorkstationArtifacts(text);
      const codeArtifact = artifacts.find((a) => a.kind === "code");
      expect(codeArtifact).toBeDefined();
      expect(codeArtifact?.language).toBe("typescript");
      expect(codeArtifact?.kind).toBe("code");
      expect(codeArtifact?.body).toBe(
        [
          "export function initSchema(db: DatabaseSync): void {",
          "  db.exec('CREATE TABLE test (id TEXT PRIMARY KEY)');",
          "}"
        ].join("\n")
      );
    });

    it("extracts title from preceding heading or info string", () => {
      const text = [
        "### src/main/worker.ts",
        "```typescript",
        "export const workerVersion = 2;",
        "```",
        "",
        "```python title=\"process_data.py\"",
        "def process():",
        "    return 1",
        "```"
      ].join("\n");

      const artifacts = extractWorkstationArtifacts(text);
      const code = artifacts.filter((a) => a.kind === "code");
      expect(code).toHaveLength(2);
      expect(code[0]?.title).toBe("src/main/worker.ts");
      expect(code[0]?.language).toBe("typescript");
      expect(code[1]?.title).toBe("process_data.py");
      expect(code[1]?.language).toBe("python");
    });

    it("rejects incomplete unclosed code fences", () => {
      const text = [
        "Here is a completed function:",
        "```python",
        "def complete():",
        "    return True",
        "```",
        "",
        "And here is an interrupted output that was cut off:",
        "```typescript",
        "export function interrupted() {",
        "  const x = 1;"
      ].join("\n");

      const artifacts = extractWorkstationArtifacts(text);
      const codeArtifacts = artifacts.filter((a) => a.kind === "code");

      expect(codeArtifacts).toHaveLength(1);
      expect(codeArtifacts[0]?.language).toBe("python");
      expect(codeArtifacts[0]?.body).toBe("def complete():\n    return True");
    });

    it("preserves exact verbatim formatting within code fences", () => {
      const codeBody = "  line1\n\tline2\n    line3\n\n\n  finalLine";
      const text = `\`\`\`sh\n${codeBody}\n\`\`\``;

      const artifacts = extractWorkstationArtifacts(text);
      const codeArtifact = artifacts.find((a) => a.kind === "code");
      expect(codeArtifact?.body).toBe(codeBody);
    });
  });

  describe("markdown table extraction", () => {
    it("extracts valid markdown table with headers and data rows", () => {
      const text = [
        "## Performance Metrics",
        "| Metric | Budget | Actual | Status |",
        "| :--- | :---: | ---: | :--- |",
        "| Latency | 50ms | 18ms | Pass |",
        "| Throughput | 1000 rps | 2400 rps | Pass |",
        "",
        "Table shows all criteria passed."
      ].join("\n");

      const artifacts = extractWorkstationArtifacts(text);
      const tableArtifact = artifacts.find((a) => a.kind === "table");
      expect(tableArtifact).toBeDefined();
      expect(tableArtifact?.title).toBe("Performance Metrics");
      expect(tableArtifact?.kind).toBe("table");
      expect(tableArtifact?.language).toBeNull();
      expect(tableArtifact?.body).toContain("| Metric | Budget | Actual | Status |");
      expect(tableArtifact?.body).toContain("| Latency | 50ms | 18ms | Pass |");
    });

    it("ignores markdown tables that are inside code fences", () => {
      const text = [
        "```markdown",
        "| Col1 | Col2 |",
        "| --- | --- |",
        "| Val1 | Val2 |",
        "```"
      ].join("\n");

      const artifacts = extractWorkstationArtifacts(text);
      const tables = artifacts.filter((a) => a.kind === "table");
      expect(tables).toHaveLength(0);
      const code = artifacts.filter((a) => a.kind === "code");
      expect(code).toHaveLength(1);
    });

    it("rejects malformed or incomplete table syntax", () => {
      const singleRow = "| Only header | No delimiter |";
      expect(extractWorkstationArtifacts(singleRow)).toEqual([]);

      const noData = "| Col1 | Col2 |\n| --- | --- |";
      expect(extractWorkstationArtifacts(noData)).toEqual([]);
    });
  });

  describe("structured document extraction", () => {
    it("extracts a structured document while preserving full context and preamble", () => {
      const text = [
        "Note: Based on client discovery call of Sept 12.",
        "",
        "# Client Proposal: Cloud Modernization",
        "",
        "## Executive Summary",
        "This proposal details the phased migration strategy.",
        "",
        "## Deliverables",
        "- Discovery audit",
        "- VPC infrastructure",
        "- Zero-downtime cutover"
      ].join("\n");

      const artifacts = extractWorkstationArtifacts(text);
      expect(artifacts).toHaveLength(1);
      const doc = artifacts[0]!;
      expect(doc.kind).toBe("document");
      expect(doc.title).toBe("Client Proposal: Cloud Modernization");
      expect(doc.language).toBe("markdown");
      expect(doc.body).toContain("Note: Based on client discovery call of Sept 12.");
      expect(doc.body).toContain("Zero-downtime cutover");
    });

    it("does not extract trivial conversation or greetings as documents", () => {
      expect(extractWorkstationArtifacts("")).toEqual([]);
      expect(extractWorkstationArtifacts("   \n\t  ")).toEqual([]);
      expect(extractWorkstationArtifacts("Hello! How can I assist you today?")).toEqual([]);
      expect(extractWorkstationArtifacts("I have completed the task.")).toEqual([]);
    });
  });

  describe("multi-candidate extraction", () => {
    it("extracts document, code, and table candidates from a full native answer", () => {
      const answer = [
        "# Research Brief: Distributed Consensus",
        "",
        "## Executive Summary",
        "This brief evaluates Raft vs Paxos for local cluster coordination.",
        "",
        "## Comparison Table",
        "| Algorithm | Complexity | Leader Model |",
        "| --- | --- | --- |",
        "| Raft | Understandable | Strong Leader |",
        "| Multi-Paxos | High | Symmetric |",
        "",
        "## Implementation Stub",
        "```typescript title=\"raft-node.ts\"",
        "export class RaftNode {",
        "  private currentTerm = 0;",
        "}",
        "```",
        "",
        "## Review Checklist",
        "- Verify heartbeat timeouts are configurable."
      ].join("\n");

      const candidates = extractWorkstationArtifacts(answer);
      expect(candidates.length).toBe(3);

      const doc = candidates.find((c) => c.kind === "document");
      const table = candidates.find((c) => c.kind === "table");
      const code = candidates.find((c) => c.kind === "code");

      expect(doc).toBeDefined();
      expect(doc?.title).toBe("Research Brief: Distributed Consensus");

      expect(table).toBeDefined();
      expect(table?.title).toBe("Comparison Table");

      expect(code).toBeDefined();
      expect(code?.title).toBe("raft-node.ts");
      expect(code?.language).toBe("typescript");
    });
  });

  describe("safety and bounds", () => {
    it("enforces maximum body limit of 50,000 characters", () => {
      const hugeBody = "a".repeat(60_000);
      const text = `\`\`\`typescript\n${hugeBody}\n\`\`\``;

      const artifacts = extractWorkstationArtifacts(text);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.body.length).toBe(50_000);
    });

    it("bounds excessively long titles", () => {
      const longTitle = "x".repeat(200);
      const text = `# ${longTitle}\n\n## Section 1\nContent paragraph with details.`;

      const artifacts = extractWorkstationArtifacts(text);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.title.length).toBeLessThanOrEqual(120);
      expect(artifacts[0]?.title).toContain("...");
    });
  });
});
