import { describe, expect, it } from "vitest";
import { planDeliveryPack, MAX_PACK_BYTES } from "./delivery-pack.js";

describe("planDeliveryPack", () => {
  it("excludes internal sources with a reason and leaves them out of items", () => {
    const plan = planDeliveryPack({
      workTitle: "Financial Audit",
      clientName: "Acme Holdings",
      at: Date.parse("2026-09-15T10:00:00Z"),
      outputs: [
        { id: "out-1", title: "Audit Report", body: "Complete findings", revision: 1 }
      ],
      sources: [
        { id: "src-private", label: "Private Working Notes", bytes: 1024, internal: true },
        { id: "src-public", label: "Signed Engagement Letter", bytes: 2048, internal: false }
      ],
      images: [],
      recordMarkdown: "# Record of engagement"
    });

    expect(plan.excluded).toContainEqual({
      title: "Private Working Notes",
      reason: expect.stringContaining("Internal source")
    });
    expect(plan.items.some((item) => item.sourceId === "src-private")).toBe(false);
    expect(plan.items.some((item) => item.title === "Private Working Notes")).toBe(false);
    expect(plan.items.some((item) => item.sourceId === "src-public")).toBe(true);
  });

  it("includes only the latest revision of an output and records excluded drafts", () => {
    const plan = planDeliveryPack({
      workTitle: "Contract Agreement",
      clientName: "Northstar",
      at: Date.parse("2026-09-15T10:00:00Z"),
      outputs: [
        { id: "doc-1", title: "Terms", body: "Draft 1", revision: 1 },
        { id: "doc-1", title: "Terms", body: "Draft 2", revision: 2 },
        { id: "doc-1", title: "Terms", body: "Final Agreed Terms", revision: 3 }
      ],
      sources: [],
      images: [],
      recordMarkdown: "# Negotiation log"
    });

    const outputItems = plan.items.filter((item) => item.kind === "output");
    expect(outputItems).toHaveLength(1);
    expect(outputItems[0]!.bytes).toBe(new TextEncoder().encode("Final Agreed Terms").byteLength);
    const excludedDrafts = plan.excluded.filter((e) => e.title === "Terms");
    expect(excludedDrafts).toHaveLength(2);
  });

  it("disambiguates colliding titles with distinct relative paths", () => {
    const plan = planDeliveryPack({
      workTitle: "Case Synthesis",
      clientName: "Client",
      at: Date.parse("2026-09-15T10:00:00Z"),
      outputs: [
        { id: "out-1", title: "Summary", body: "Output one", revision: 1 },
        { id: "out-2", title: "Summary", body: "Output two", revision: 1 }
      ],
      sources: [
        { id: "src-1", label: "Summary", bytes: 400, internal: false }
      ],
      images: [
        { id: "img-1", label: "Summary", bytes: 800 }
      ],
      recordMarkdown: "# Session record"
    });

    const summaryItems = plan.items.filter((item) => item.title === "Summary");
    expect(summaryItems).toHaveLength(4);
    const paths = summaryItems.map((item) => item.relativePath);
    expect(new Set(paths).size).toBe(4);
  });

  it("sanitises folder names by stripping leading dots, slashes, and illegal characters", () => {
    const plan = planDeliveryPack({
      workTitle: "./../confidential/project-brief",
      clientName: ".acme/corp",
      at: Date.parse("2026-09-15T10:00:00Z"),
      outputs: [{ id: "out-1", title: "Brief", body: "Content", revision: 1 }],
      sources: [],
      images: [],
      recordMarkdown: "# Plan"
    });

    expect(plan.folderName).not.toMatch(/^\./);
    expect(plan.folderName).not.toContain("/");
    expect(plan.folderName).not.toContain("\\");
    expect(plan.folderName).toMatch(/^[A-Za-z0-9 -]+$/);
    expect(plan.folderName.length).toBeLessThanOrEqual(80);
  });

  it("warns when total pack size exceeds MAX_PACK_BYTES", () => {
    const plan = planDeliveryPack({
      workTitle: "Large Asset Archive",
      clientName: "Client",
      at: Date.parse("2026-09-15T10:00:00Z"),
      outputs: [{ id: "out-1", title: "Index", body: "Index text", revision: 1 }],
      sources: [
        { id: "src-huge", label: "Big Dataset", bytes: MAX_PACK_BYTES + 500, internal: false }
      ],
      images: [],
      recordMarkdown: "# Index notes"
    });

    expect(plan.totalBytes).toBeGreaterThan(MAX_PACK_BYTES);
    expect(plan.warnings).toContainEqual(expect.stringContaining("200 MB"));
  });

  it("warns when no outputs are present in the pack", () => {
    const plan = planDeliveryPack({
      workTitle: "Empty Pack",
      clientName: "Client",
      at: Date.parse("2026-09-15T10:00:00Z"),
      outputs: [],
      sources: [{ id: "src-1", label: "Source", bytes: 50, internal: false }],
      images: [],
      recordMarkdown: "# Empty"
    });

    expect(plan.warnings).toContainEqual(expect.stringContaining("No outputs"));
  });

  it("warns when every provided source is marked internal and excluded", () => {
    const plan = planDeliveryPack({
      workTitle: "Internal Research Pack",
      clientName: "Client",
      at: Date.parse("2026-09-15T10:00:00Z"),
      outputs: [{ id: "out-1", title: "Deliverable", body: "Text", revision: 1 }],
      sources: [
        { id: "src-1", label: "Notes 1", bytes: 100, internal: true },
        { id: "src-2", label: "Notes 2", bytes: 200, internal: true }
      ],
      images: [],
      recordMarkdown: "# Notes"
    });

    expect(plan.warnings).toContainEqual(
      expect.stringContaining("Every source was marked internal")
    );
  });

  it("ensures the generated readme never mentions AI model identifiers", () => {
    const plan = planDeliveryPack({
      workTitle: "Brand Discovery",
      clientName: "Highland Ltd",
      at: Date.parse("2026-09-15T10:00:00Z"),
      outputs: [{ id: "out-1", title: "Brand Guide", body: "Typography and tone", revision: 1 }],
      sources: [{ id: "src-1", label: "Interview Transcripts", bytes: 1500, internal: false }],
      images: [{ id: "img-1", label: "Moodboard", bytes: 3000 }],
      recordMarkdown: "# Discovery log"
    });

    expect(plan.readme).not.toMatch(/\b(?:codex|claude|gemini|qwen|gpt|model|llm)\b/i);
    expect(plan.readme).toContain("Brand Discovery");
    expect(plan.readme).toContain("2026-09-15");
  });
});
