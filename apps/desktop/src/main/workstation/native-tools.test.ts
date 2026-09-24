import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WorkstationCitationCheckResult } from "@cadrane/contracts";
import {
  createNativeToolSession,
  MAX_CITATION_DRAFT_BYTES,
  MAX_SESSION_CALLS,
  MAX_SOURCE_READ_CHARS_PAGE,
  MAX_SOURCES_COUNT,
  MAX_TOTAL_SOURCES_BYTES,
  NATIVE_TOOL_NAMES,
  type NativeToolCall,
  type NativeToolSessionOptions,
  type NativeToolSource
} from "./native-tools.js";
import { listHermesSkills } from "./upstream-skills.js";

function createMockCheckCitations(overrides?: Partial<WorkstationCitationCheckResult>) {
  return async (input: {
    readonly caseId: string;
    readonly draft: string;
    readonly sources: readonly {
      readonly sourceTurnId: string;
      readonly label: string;
      readonly body: string;
    }[];
  }): Promise<WorkstationCitationCheckResult> => ({
    status: "ok",
    summary: `Verified ${input.sources.length} sources against draft.`,
    disclaimer: "Citation disclaimer",
    sources: input.sources.map((s, idx) => ({
      id: idx + 1,
      sourceTurnId: s.sourceTurnId,
      label: s.label,
      uri: `urn:rellane:source:${s.sourceTurnId}`
    })),
    citedIds: input.sources.map((_, idx) => idx + 1),
    unknownReferences: [],
    missingFromSourcesBlock: [],
    unexpectedInSourcesBlock: [],
    mismatchedUrls: [],
    expectedSourcesBlock: "",
    warnings: [],
    errors: [],
    quotes: [],
    quoteCheckNote: "No quotes checked",
    ...overrides
  });
}

function createValidOptions(overrides?: Partial<NativeToolSessionOptions>): NativeToolSessionOptions {
  return {
    operationId: "op-1",
    caseId: "case-1",
    sources: [
      { id: "src-1", label: "Source 1", text: "Alpha text content for citation checking [1]." },
      { id: "src-2", label: "Source 2", text: "Beta text content for citation checking [2]." }
    ],
    isActive: () => true,
    checkCitations: createMockCheckCitations(),
    ...overrides
  };
}

describe("native-tools: seam definitions and options validation", () => {
  it("exposes exactly five bounded tool definitions with strict schemas", () => {
    const session = createNativeToolSession(createValidOptions());
    expect(session.definitions).toHaveLength(5);
    const names = session.definitions.map((d) => d.name);
    expect(names).toEqual(NATIVE_TOOL_NAMES);

    for (const def of session.definitions) {
      expect(def.inputSchema.additionalProperties).toBe(false);
      expect(def.inputSchema.type).toBe("object");
    }
  });

  it("rejects options with > 20 sources", () => {
    const sources: NativeToolSource[] = Array.from({ length: MAX_SOURCES_COUNT + 1 }, (_, i) => ({
      id: `src-${i}`,
      label: `Label ${i}`,
      text: `Text ${i}`
    }));

    expect(() =>
      createNativeToolSession(createValidOptions({ sources }))
    ).toThrow(/Exceeded maximum of 20 sources/);
  });

  it("rejects duplicate source IDs in options", () => {
    const sources: NativeToolSource[] = [
      { id: "dup-1", label: "Label 1", text: "Text 1" },
      { id: "dup-1", label: "Label 2", text: "Text 2" }
    ];

    expect(() =>
      createNativeToolSession(createValidOptions({ sources }))
    ).toThrow(/Duplicate source ID "dup-1"/);
  });

  it("rejects total source bodies exceeding 204,800 bytes", () => {
    const largeText = "x".repeat(MAX_TOTAL_SOURCES_BYTES + 10);
    const sources: NativeToolSource[] = [{ id: "large-1", label: "Large", text: largeText }];

    expect(() =>
      createNativeToolSession(createValidOptions({ sources }))
    ).toThrow(new RegExp(`exceed ${MAX_TOTAL_SOURCES_BYTES} bytes limit`));
  });

  it("clones reviewed sources so caller mutations cannot alter session scope", async () => {
    const mutableSource: { id: string; label: string; text: string } = {
      id: "src-orig",
      label: "Orig Label",
      text: "Original source text."
    };
    const sourcesList = [mutableSource];
    const session = createNativeToolSession(createValidOptions({ sources: sourcesList }));

    // Caller attempts mutations
    mutableSource.text = "Mutated text that must not leak into session.";
    sourcesList.push({ id: "injected-src", label: "Injected", text: "Injected text." });

    const call: NativeToolCall = {
      callId: "call-list-immutability",
      tool: "rellane_list_sources",
      arguments: {}
    };
    const res = await session.execute(call);
    expect(res.success).toBe(true);

    const parsed = JSON.parse(res.contentItems[0]!.text) as {
      sources: { id: string; hash: string; length: number }[];
    };
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]!.id).toBe("src-orig");
    expect(parsed.sources[0]!.length).toBe("Original source text.".length);

    const originalHash = createHash("sha256").update("Original source text.", "utf8").digest("hex");
    expect(parsed.sources[0]!.hash).toBe(originalHash);
  });
});

describe("native-tools: rellane_list_sources", () => {
  it("lists sources with stable numeric citation identity, id, label, hash, and length", async () => {
    const session = createNativeToolSession(createValidOptions());
    const res = await session.execute({
      callId: "c1",
      tool: "rellane_list_sources",
      arguments: {}
    });
    expect(res.success).toBe(true);

    const data = JSON.parse(res.contentItems[0]!.text) as {
      sources: { citationId: number; id: string; label: string; hash: string; length: number }[];
    };
    expect(data.sources).toHaveLength(2);
    expect(data.sources[0]!.citationId).toBe(1);
    expect(data.sources[0]!.id).toBe("src-1");
    expect(data.sources[0]!.label).toBe("Source 1");
    expect(data.sources[0]!.hash).toBe(
      createHash("sha256").update("Alpha text content for citation checking [1].", "utf8").digest("hex")
    );
    expect(data.sources[1]!.citationId).toBe(2);
  });

  it("denies non-empty arguments for rellane_list_sources", async () => {
    const session = createNativeToolSession(createValidOptions());
    const res = await session.execute({
      callId: "c2",
      tool: "rellane_list_sources",
      arguments: { extraKey: "denied" }
    });
    expect(res.success).toBe(false);
    expect(res.contentItems[0]!.text).toContain("accepts only an empty object");
  });
});

describe("native-tools: rellane_read_source", () => {
  it("reads source text with explicit pagination", async () => {
    const session = createNativeToolSession(createValidOptions());
    const res = await session.execute({
      callId: "c3",
      tool: "rellane_read_source",
      arguments: { sourceId: "src-1", offset: 0, maxChars: 5 }
    });
    expect(res.success).toBe(true);

    const parsed = JSON.parse(res.contentItems[0]!.text) as {
      sourceId: string;
      citationId: number;
      offset: number;
      length: number;
      totalChars: number;
      hasMore: boolean;
      nextOffset: number | null;
      text: string;
    };
    expect(parsed.sourceId).toBe("src-1");
    expect(parsed.citationId).toBe(1);
    expect(parsed.offset).toBe(0);
    expect(parsed.length).toBe(5);
    expect(parsed.text).toBe("Alpha");
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextOffset).toBe(5);
  });

  it("denies pagination with maxChars > 16,000", async () => {
    const session = createNativeToolSession(createValidOptions());
    const res = await session.execute({
      callId: "c4",
      tool: "rellane_read_source",
      arguments: { sourceId: "src-1", maxChars: MAX_SOURCE_READ_CHARS_PAGE + 1 }
    });
    expect(res.success).toBe(false);
    expect(res.contentItems[0]!.text).toContain(`maxChars must be an integer between 1 and ${MAX_SOURCE_READ_CHARS_PAGE}`);
  });

  it("denies negative offset or non-existent sourceId", async () => {
    const session = createNativeToolSession(createValidOptions());
    const resNegative = await session.execute({
      callId: "c5",
      tool: "rellane_read_source",
      arguments: { sourceId: "src-1", offset: -1 }
    });
    expect(resNegative.success).toBe(false);
    expect(resNegative.contentItems[0]!.text).toContain("offset must be a non-negative integer");

    const resMissing = await session.execute({
      callId: "c6",
      tool: "rellane_read_source",
      arguments: { sourceId: "src-nonexistent" }
    });
    expect(resMissing.success).toBe(false);
    expect(resMissing.contentItems[0]!.text).toContain('Source with id "src-nonexistent" not found');
  });

  it("denies unexpected argument keys for rellane_read_source", async () => {
    const session = createNativeToolSession(createValidOptions());
    const res = await session.execute({
      callId: "c7",
      tool: "rellane_read_source",
      arguments: { sourceId: "src-1", unexpectedPath: "/tmp/foo" }
    });
    expect(res.success).toBe(false);
    expect(res.contentItems[0]!.text).toContain('Unexpected argument key "unexpectedPath"');
  });
});

describe("native-tools: hermes_list_skills and hermes_read_skill", () => {
  it("lists pinned Hermes skills with strict empty object", async () => {
    const session = createNativeToolSession(createValidOptions());
    const res = await session.execute({
      callId: "c8",
      tool: "hermes_list_skills",
      arguments: {}
    });
    expect(res.success).toBe(true);

    const data = JSON.parse(res.contentItems[0]!.text) as { skills: { id: string; name: string }[] };
    const bundled = listHermesSkills();
    expect(data.skills).toHaveLength(bundled.length);
    expect(data.skills.map((s) => s.id)).toEqual(bundled.map((s) => s.id));
  });

  it("denies extra keys for hermes_list_skills", async () => {
    const session = createNativeToolSession(createValidOptions());
    const res = await session.execute({
      callId: "c9",
      tool: "hermes_list_skills",
      arguments: { category: "all" }
    });
    expect(res.success).toBe(false);
    expect(res.contentItems[0]!.text).toContain("accepts only an empty object");
  });

  it("reads a pinned skill whole, proved by hashing what came back", async () => {
    const first = listHermesSkills()[0]!;
    const session = createNativeToolSession(createValidOptions());
    const res = await session.execute({
      callId: "c10",
      tool: "hermes_read_skill",
      arguments: { skillId: first.id }
    });
    expect(res.success).toBe(true);

    const data = JSON.parse(res.contentItems[0]!.text) as {
      skillId: string;
      title: string;
      content: string;
      sha256: string;
    };
    expect(data.skillId).toBe(first.id);
    expect(data.title).toBe(first.title);
    expect(data.content.length).toBeGreaterThan(0);
    // The claim is untruncated bytes, so hash what was actually returned rather
    // than comparing against a constant nobody can check from here.
    expect(createHash("sha256").update(data.content, "utf8").digest("hex")).toBe(data.sha256);
  });

  it("says nothing about this Mac when a skill id is unknown or shaped like a path", async () => {
    const session = createNativeToolSession(createValidOptions());
    const resUnknown = await session.execute({
      callId: "c11",
      tool: "hermes_read_skill",
      arguments: { skillId: "hermes/unknown-skill" }
    });
    expect(resUnknown.success).toBe(false);
    expect(resUnknown.contentItems[0]!.text).toContain("Unknown Hermes skill ID");

    const resTraversal = await session.execute({
      callId: "c12",
      tool: "hermes_read_skill",
      arguments: { skillId: "../secret" }
    });
    expect(resTraversal.success).toBe(false);
    // An unknown id is an unknown id. Both answers are the same sentence with
    // the caller's own string echoed back, and nothing else: no bundled file
    // name, no directory this app was installed into, no content.
    for (const refused of [resUnknown, resTraversal]) {
      const text = refused.contentItems[0]!.text;
      expect(text).not.toContain("SKILL.md");
      expect(text).not.toContain("vendor");
      expect(text).not.toContain(".app/");
      expect(text).not.toMatch(/(^|\s)\//);
      expect(text).not.toContain("Available skills");
    }
    expect(resUnknown.contentItems[0]!.text).toBe(
      'Unknown Hermes skill ID: "hermes/unknown-skill".'
    );
    expect(resTraversal.contentItems[0]!.text).toBe('Unknown Hermes skill ID: "../secret".');
  });

  it("treats an isActive() that throws as a closed session", async () => {
    const session = createNativeToolSession(
      createValidOptions({
        isActive: () => {
          throw new Error("the book is gone");
        }
      })
    );
    const res = await session.execute({
      callId: "c13",
      tool: "hermes_list_skills",
      arguments: {}
    });
    expect(res.success).toBe(false);
    expect(res.contentItems[0]!.text).toContain("closed, stopped, or inactive");
  });

  it("checks liveness before spending the call budget", async () => {
    let live = false;
    const session = createNativeToolSession(
      createValidOptions({ isActive: () => live })
    );
    for (let i = 0; i < MAX_SESSION_CALLS + 5; i += 1) {
      const refused = await session.execute({
        callId: `dead-${i}`,
        tool: "hermes_list_skills",
        arguments: {}
      });
      expect(refused.success).toBe(false);
      expect(refused.contentItems[0]!.text).toContain("closed, stopped, or inactive");
    }
    // None of those spent a slot, so the session still answers once it is live.
    live = true;
    const res = await session.execute({
      callId: "alive-1",
      tool: "hermes_list_skills",
      arguments: {}
    });
    expect(res.success).toBe(true);
  });

  it("shortens a page that will not fit rather than making the source unreadable", async () => {
    // Pasted terminal output carries control characters, and JSON spends six
    // bytes on each one. A legal 16,000-character page of it encodes to about
    // 96,000 bytes — past the ceiling — so the page must shrink, not fail.
    const noisy = String.fromCharCode(0x07).repeat(MAX_SOURCE_READ_CHARS_PAGE * 2);
    const session = createNativeToolSession(
      createValidOptions({ sources: [{ id: "wide-1", label: "Captured output", text: noisy }] })
    );
    const res = await session.execute({
      callId: "c14",
      tool: "rellane_read_source",
      arguments: { sourceId: "wide-1" }
    });
    expect(res.success).toBe(true);
    const page = JSON.parse(res.contentItems[0]!.text) as {
      offset: number;
      length: number;
      totalChars: number;
      hasMore: boolean;
      nextOffset: number | null;
      text: string;
    };
    expect(page.length).toBeGreaterThan(0);
    expect(page.length).toBeLessThan(MAX_SOURCE_READ_CHARS_PAGE);
    expect(page.text).toHaveLength(page.length);
    expect(page.hasMore).toBe(true);
    // The shorter page is still described honestly, so the next read continues
    // exactly where this one stopped.
    expect(page.nextOffset).toBe(page.offset + page.length);
    expect(page.totalChars).toBe(noisy.length);
    expect(Buffer.byteLength(res.contentItems[0]!.text, "utf8")).toBeLessThanOrEqual(65_536);

    const next = await session.execute({
      callId: "c15",
      tool: "rellane_read_source",
      arguments: { sourceId: "wide-1", offset: page.nextOffset! }
    });
    expect(next.success).toBe(true);
    const second = JSON.parse(next.contentItems[0]!.text) as { offset: number; length: number };
    expect(second.offset).toBe(page.nextOffset);
    expect(second.length).toBeGreaterThan(0);
  });
});

describe("native-tools: hermes_check_citations", () => {
  it("forwards draft and reviewed sources to injected citation checker", async () => {
    let forwardedInput: unknown = null;
    const customChecker = async (input: {
      readonly caseId: string;
      readonly draft: string;
      readonly sources: readonly {
        readonly sourceTurnId: string;
        readonly label: string;
        readonly body: string;
      }[];
    }): Promise<WorkstationCitationCheckResult> => {
      forwardedInput = input;
      return {
        status: "ok",
        summary: "Checked 2 sources",
        disclaimer: "Disclaimer",
        sources: input.sources.map((s, idx) => ({
          id: idx + 1,
          sourceTurnId: s.sourceTurnId,
          label: s.label,
          uri: `urn:rellane:source:${s.sourceTurnId}`
        })),
        citedIds: [1],
        unknownReferences: [],
        missingFromSourcesBlock: [],
        unexpectedInSourcesBlock: [],
        mismatchedUrls: [],
        expectedSourcesBlock: "",
        warnings: [],
        errors: [],
        quotes: [],
        quoteCheckNote: ""
      };
    };

    const session = createNativeToolSession(createValidOptions({ checkCitations: customChecker }));
    const res = await session.execute({
      callId: "c13",
      tool: "hermes_check_citations",
      arguments: { draft: "Draft text with [1]." }
    });
    expect(res.success).toBe(true);
    expect(forwardedInput).toEqual({
      caseId: "case-1",
      draft: "Draft text with [1].",
      sources: [
        { sourceTurnId: "src-1", label: "Source 1", body: "Alpha text content for citation checking [1]." },
        { sourceTurnId: "src-2", label: "Source 2", body: "Beta text content for citation checking [2]." }
      ]
    });
  });

  it("denies draft exceeding 51,200 UTF-8 bytes", async () => {
    const session = createNativeToolSession(createValidOptions());
    const oversizedDraft = "x".repeat(MAX_CITATION_DRAFT_BYTES + 10);
    const res = await session.execute({
      callId: "c14",
      tool: "hermes_check_citations",
      arguments: { draft: oversizedDraft }
    });
    expect(res.success).toBe(false);
    expect(res.contentItems[0]!.text).toContain("Draft exceeds maximum limit of 51200 UTF-8 bytes");
  });

  it("enforces single in-flight citation check concurrency", async () => {
    let resolveFirstCheck: ((value: WorkstationCitationCheckResult) => void) | null = null;
    const slowChecker = async (): Promise<WorkstationCitationCheckResult> =>
      new Promise((resolve) => {
        resolveFirstCheck = resolve;
      });

    const session = createNativeToolSession(createValidOptions({ checkCitations: slowChecker }));

    const firstPromise = session.execute({
      callId: "c15-first",
      tool: "hermes_check_citations",
      arguments: { draft: "Draft first" }
    });

    // Second call starts while first is in flight
    const secondRes = await session.execute({
      callId: "c15-second",
      tool: "hermes_check_citations",
      arguments: { draft: "Draft second" }
    });
    expect(secondRes.success).toBe(false);
    expect(secondRes.contentItems[0]!.text).toContain("Only one citation check child at a time");

    // Complete the first call
    expect(resolveFirstCheck).not.toBeNull();
    resolveFirstCheck!({
      status: "ok",
      summary: "Completed first check",
      disclaimer: "",
      sources: [],
      citedIds: [],
      unknownReferences: [],
      missingFromSourcesBlock: [],
      unexpectedInSourcesBlock: [],
      mismatchedUrls: [],
      expectedSourcesBlock: "",
      warnings: [],
      errors: [],
      quotes: [],
      quoteCheckNote: ""
    });

    const firstRes = await firstPromise;
    expect(firstRes.success).toBe(true);
  });
});

describe("native-tools: lifecycle, stop, and disposal", () => {
  it("refuses new calls after dispose() is called", async () => {
    const session = createNativeToolSession(createValidOptions());
    session.dispose();

    const res = await session.execute({
      callId: "c16",
      tool: "rellane_list_sources",
      arguments: {}
    });
    expect(res.success).toBe(false);
    expect(res.contentItems[0]!.text).toContain("Session is closed, stopped, or inactive");
  });

  it("refuses calls when isActive() returns false", async () => {
    let active = true;
    const session = createNativeToolSession(createValidOptions({ isActive: () => active }));

    const resBefore = await session.execute({
      callId: "c17-before",
      tool: "rellane_list_sources",
      arguments: {}
    });
    expect(resBefore.success).toBe(true);

    active = false;
    const resAfter = await session.execute({
      callId: "c17-after",
      tool: "rellane_list_sources",
      arguments: {}
    });
    expect(resAfter.success).toBe(false);
    expect(resAfter.contentItems[0]!.text).toContain("Session is closed, stopped, or inactive");
  });

  it("suppresses citation check result if stopped or disposed while in-flight", async () => {
    let active = true;
    let resolveCheck: ((value: WorkstationCitationCheckResult) => void) | null = null;
    const pendingChecker = async (): Promise<WorkstationCitationCheckResult> =>
      new Promise((resolve) => {
        resolveCheck = resolve;
      });

    const session = createNativeToolSession(
      createValidOptions({ isActive: () => active, checkCitations: pendingChecker })
    );

    const callPromise = session.execute({
      callId: "c18",
      tool: "hermes_check_citations",
      arguments: { draft: "In-flight citation check" }
    });

    // Session stops while checker is awaiting
    active = false;

    resolveCheck!({
      status: "ok",
      summary: "Completed after stop",
      disclaimer: "",
      sources: [],
      citedIds: [],
      unknownReferences: [],
      missingFromSourcesBlock: [],
      unexpectedInSourcesBlock: [],
      mismatchedUrls: [],
      expectedSourcesBlock: "",
      warnings: [],
      errors: [],
      quotes: [],
      quoteCheckNote: ""
    });

    const res = await callPromise;
    expect(res.success).toBe(false);
    expect(res.contentItems[0]!.text).toContain("Results suppressed");
  });
});

describe("native-tools: call ID uniqueness, bounds, and unknown tools", () => {
  it("rejects replayed / duplicate callIds", async () => {
    const session = createNativeToolSession(createValidOptions());
    const firstRes = await session.execute({
      callId: "dup-call-1",
      tool: "rellane_list_sources",
      arguments: {}
    });
    expect(firstRes.success).toBe(true);

    const secondRes = await session.execute({
      callId: "dup-call-1",
      tool: "rellane_list_sources",
      arguments: {}
    });
    expect(secondRes.success).toBe(false);
    expect(secondRes.contentItems[0]!.text).toContain('Duplicate callId: "dup-call-1"');
  });

  it("rejects unknown tool requests including credential refresh or remote execution", async () => {
    const session = createNativeToolSession(createValidOptions());
    const resUnknown = await session.execute({
      callId: "c19",
      tool: "credential_refresh",
      arguments: {}
    });
    expect(resUnknown.success).toBe(false);
    expect(resUnknown.contentItems[0]!.text).toContain('Unknown tool: "credential_refresh"');
  });

  it("strictly enforces maximum 64 calls per session", async () => {
    const session = createNativeToolSession(createValidOptions());

    for (let i = 1; i <= MAX_SESSION_CALLS; i++) {
      const res = await session.execute({
        callId: `session-call-${i}`,
        tool: "rellane_list_sources",
        arguments: {}
      });
      expect(res.success).toBe(true);
    }

    const excessRes = await session.execute({
      callId: `session-call-${MAX_SESSION_CALLS + 1}`,
      tool: "rellane_list_sources",
      arguments: {}
    });
    expect(excessRes.success).toBe(false);
    expect(excessRes.contentItems[0]!.text).toContain("Session call limit of 64 calls exceeded");
  });
});
