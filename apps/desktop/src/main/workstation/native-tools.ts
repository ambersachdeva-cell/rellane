/**
 * Native tool broker for reviewed workstation sessions.
 *
 * Implements bounded native tool definitions and session handling for:
 * - rellane_list_sources
 * - rellane_read_source
 * - hermes_list_skills
 * - hermes_read_skill
 * - hermes_check_citations
 *
 * Enforces strict boundaries:
 * - Immutable cloned reviewed source snapshot (caller mutations cannot alter scope).
 * - Explicit pagination up to 16,000 characters per page for source reads.
 * - Maximum 20 sources, total bodies <= 204,800 bytes.
 * - Maximum draft <= 51,200 bytes for citation checking.
 * - Single in-flight citation check child per session.
 * - Maximum 64 tool calls per session; no duplicate/replayed call IDs.
 * - Maximum tool output size <= 65,536 UTF-8 bytes.
 * - Immediate suppression of results upon stop/dispose before and after awaits.
 * - No dynamic code execution, filesystem traversal, or arbitrary path access.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { WorkstationCitationCheckResult } from "@cadrane/contracts";
import { listHermesSkills, readHermesSkill } from "./upstream-skills.js";

/**
 * Exactly what this module consumes from the pinned skill catalogue.
 *
 * Written out rather than inferred so that a change upstream is a compile
 * error here instead of a silently different tool answer. Nothing else about
 * those modules is used, and no path they know about is ever exposed.
 */
interface BundledSkillSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

interface BundledSkillContent {
  readonly content: string;
  readonly sha256: string;
}

/** The pinned skill ids, for the review to name before anybody opts in. */
export function nativeToolSkillIds(): readonly string[] {
  const summaries: readonly BundledSkillSummary[] = listHermesSkills();
  return summaries.map((skill) => skill.id);
}

export const NATIVE_TOOL_NAMES = [
  "rellane_list_sources",
  "rellane_read_source",
  "hermes_list_skills",
  "hermes_read_skill",
  "hermes_check_citations"
] as const;

export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

export const MAX_SOURCES_COUNT = 20;
export const MAX_TOTAL_SOURCES_BYTES = 204_800;
export const MAX_SOURCE_READ_CHARS_PAGE = 16_000;
export const MAX_CITATION_DRAFT_BYTES = 51_200;
export const MAX_TOOL_OUTPUT_BYTES = 65_536;
export const MAX_SESSION_CALLS = 64;

export interface NativeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface NativeToolCall {
  readonly callId: string;
  readonly tool: string;
  readonly arguments: unknown;
}

export interface NativeToolResult {
  readonly contentItems: readonly { readonly type: "inputText"; readonly text: string }[];
  readonly success: boolean;
}

export interface NativeToolSession {
  readonly definitions: readonly NativeToolDefinition[];
  execute(call: NativeToolCall): Promise<NativeToolResult>;
  dispose(): void;
}

export interface NativeToolSource {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

export interface NativeToolSessionOptions {
  readonly operationId: string;
  readonly caseId: string;
  readonly sources: readonly NativeToolSource[];
  readonly isActive: () => boolean;
  readonly checkCitations: (input: {
    readonly caseId: string;
    readonly draft: string;
    readonly sources: readonly {
      readonly sourceTurnId: string;
      readonly label: string;
      readonly body: string;
    }[];
  }) => Promise<WorkstationCitationCheckResult>;
}

export const RELLANE_LIST_SOURCES_TOOL: NativeToolDefinition = Object.freeze({
  name: "rellane_list_sources",
  description:
    "List the immutable reviewed sources in this session with stable numeric citation identities, IDs, labels, hashes, and character lengths.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false
  })
});

export const RELLANE_READ_SOURCE_TOOL: NativeToolDefinition = Object.freeze({
  name: "rellane_read_source",
  description:
    "Read a paginated slice of text from a reviewed source by sourceId (up to 16,000 characters per page).",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      sourceId: Object.freeze({
        type: "string",
        description: "The unique identifier of the source to read."
      }),
      offset: Object.freeze({
        type: "integer",
        minimum: 0,
        description: "Starting character offset (default 0)."
      }),
      maxChars: Object.freeze({
        type: "integer",
        minimum: 1,
        maximum: 16000,
        description: "Maximum characters to return (default and maximum 16,000)."
      })
    }),
    required: Object.freeze(["sourceId"]),
    additionalProperties: false
  })
});

export const HERMES_LIST_SKILLS_TOOL: NativeToolDefinition = Object.freeze({
  name: "hermes_list_skills",
  description:
    "List available pinned Hermes skills with their names, titles, descriptions, and IDs.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false
  })
});

export const HERMES_READ_SKILL_TOOL: NativeToolDefinition = Object.freeze({
  name: "hermes_read_skill",
  description:
    "Read the complete, untruncated content, SHA-256 hash, and provenance of a pinned Hermes skill by skillId.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      skillId: Object.freeze({
        type: "string",
        description: "The unique ID of the pinned Hermes skill (e.g. 'hermes/document-to-action-items')."
      })
    }),
    required: Object.freeze(["skillId"]),
    additionalProperties: false
  })
});

export const HERMES_CHECK_CITATIONS_TOOL: NativeToolDefinition = Object.freeze({
  name: "hermes_check_citations",
  description:
    "Check numbered [n] citations and quotes in a draft against the reviewed sources using the pinned citation checker.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      draft: Object.freeze({
        type: "string",
        description: "Draft text containing numbered citations to verify (max 51,200 UTF-8 bytes)."
      })
    }),
    required: Object.freeze(["draft"]),
    additionalProperties: false
  })
});

export const NATIVE_TOOL_DEFINITIONS: readonly NativeToolDefinition[] = Object.freeze([
  RELLANE_LIST_SOURCES_TOOL,
  RELLANE_READ_SOURCE_TOOL,
  HERMES_LIST_SKILLS_TOOL,
  HERMES_READ_SKILL_TOOL,
  HERMES_CHECK_CITATIONS_TOOL
]);

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function makeSuccessResult(text: string): NativeToolResult {
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    return makeFailureResult(`Tool output exceeded maximum limit of ${MAX_TOOL_OUTPUT_BYTES} UTF-8 bytes.`);
  }
  return {
    success: true,
    contentItems: [{ type: "inputText", text }]
  };
}

function makeFailureResult(errorMessage: string): NativeToolResult {
  const boundedMessage =
    Buffer.byteLength(errorMessage, "utf8") > MAX_TOOL_OUTPUT_BYTES
      ? errorMessage.slice(0, 1000)
      : errorMessage;
  return {
    success: false,
    contentItems: [{ type: "inputText", text: boundedMessage }]
  };
}

export function createNativeToolSession(options: NativeToolSessionOptions): NativeToolSession {
  if (!isObject(options)) {
    throw new Error("createNativeToolSession: options must be an object.");
  }
  if (typeof options.operationId !== "string" || options.operationId.trim().length === 0) {
    throw new Error("createNativeToolSession: operationId must be a non-empty string.");
  }
  if (typeof options.caseId !== "string" || options.caseId.trim().length === 0) {
    throw new Error("createNativeToolSession: caseId must be a non-empty string.");
  }
  if (typeof options.isActive !== "function") {
    throw new Error("createNativeToolSession: isActive must be a function.");
  }
  if (typeof options.checkCitations !== "function") {
    throw new Error("createNativeToolSession: checkCitations must be a function.");
  }
  if (!Array.isArray(options.sources)) {
    throw new Error("createNativeToolSession: sources must be an array.");
  }
  if (options.sources.length > MAX_SOURCES_COUNT) {
    throw new Error(
      `createNativeToolSession: Exceeded maximum of ${MAX_SOURCES_COUNT} sources (got ${options.sources.length}).`
    );
  }

  const seenSourceIds = new Set<string>();
  let totalSourceBytes = 0;

  for (let i = 0; i < options.sources.length; i++) {
    const s = options.sources[i];
    if (!isObject(s)) {
      throw new Error(`createNativeToolSession: source at index ${i} is invalid.`);
    }
    if (typeof s.id !== "string" || s.id.trim().length === 0) {
      throw new Error(`createNativeToolSession: source at index ${i} must have a non-empty string id.`);
    }
    if (seenSourceIds.has(s.id)) {
      throw new Error(`createNativeToolSession: Duplicate source ID "${s.id}".`);
    }
    seenSourceIds.add(s.id);
    if (typeof s.label !== "string") {
      throw new Error(`createNativeToolSession: source at index ${i} must have a string label.`);
    }
    if (typeof s.text !== "string") {
      throw new Error(`createNativeToolSession: source at index ${i} must have a string text.`);
    }
    totalSourceBytes += Buffer.byteLength(s.text, "utf8");
  }

  if (totalSourceBytes > MAX_TOTAL_SOURCES_BYTES) {
    throw new Error(
      `createNativeToolSession: Selected source bodies exceed ${MAX_TOTAL_SOURCES_BYTES} bytes limit (got ${totalSourceBytes} bytes).`
    );
  }

  // Deep-clone and freeze reviewed source snapshot to ensure caller mutations cannot alter scope.
  const snapshot: readonly NativeToolSource[] = Object.freeze(
    options.sources.map((s) =>
      Object.freeze({
        id: s.id,
        label: s.label,
        text: s.text
      })
    )
  );

  let disposed = false;
  let callCount = 0;
  let isCitationCheckActive = false;
  const seenCallIds = new Set<string>();

  /**
   * Whether this scope is still allowed to answer.
   *
   * `isActive` belongs to the host and reads the book to check the case, the
   * owner and the source fingerprint, so it can throw. A throw here is not an
   * open door: anything this predicate cannot confirm is treated as closed.
   */
  const stillActive = (): boolean => {
    if (disposed) return false;
    try {
      return options.isActive() === true;
    } catch {
      return false;
    }
  };

  return {
    definitions: NATIVE_TOOL_DEFINITIONS,

    dispose(): void {
      disposed = true;
    },

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      if (!isObject(call)) {
        return makeFailureResult("Invalid tool call: call must be an object.");
      }

      if (typeof call.callId !== "string" || call.callId.trim().length === 0) {
        return makeFailureResult("Invalid tool call: callId must be a non-empty string.");
      }

      // Liveness first: a stopped session must not spend a call id or a slot of
      // the session's budget on work it is going to refuse anyway.
      if (!stillActive()) {
        return makeFailureResult("Session is closed, stopped, or inactive.");
      }

      if (seenCallIds.has(call.callId)) {
        return makeFailureResult(`Duplicate callId: "${call.callId}". Replayed call IDs are forbidden.`);
      }
      seenCallIds.add(call.callId);

      callCount += 1;
      if (callCount > MAX_SESSION_CALLS) {
        return makeFailureResult(`Session call limit of ${MAX_SESSION_CALLS} calls exceeded.`);
      }

      if (typeof call.tool !== "string" || call.tool.trim().length === 0) {
        return makeFailureResult("Invalid tool call: tool must be a non-empty string.");
      }

      if (!isObject(call.arguments)) {
        return makeFailureResult("Tool arguments must be a non-null object.");
      }

      const args = call.arguments;

      switch (call.tool) {
        case "rellane_list_sources": {
          const keys = Object.keys(args);
          if (keys.length > 0) {
            return makeFailureResult(
              `rellane_list_sources accepts only an empty object, got keys: ${keys.join(", ")}`
            );
          }

          const sourcesList = snapshot.map((source, index) => ({
            citationId: index + 1,
            id: source.id,
            label: source.label,
            hash: createHash("sha256").update(source.text, "utf8").digest("hex"),
            length: source.text.length
          }));

          return makeSuccessResult(JSON.stringify({ sources: sourcesList }));
        }

        case "rellane_read_source": {
          const keys = Object.keys(args);
          for (const k of keys) {
            if (k !== "sourceId" && k !== "offset" && k !== "maxChars") {
              return makeFailureResult(`Unexpected argument key "${k}" for rellane_read_source.`);
            }
          }

          if (!("sourceId" in args) || typeof args.sourceId !== "string" || args.sourceId.trim().length === 0) {
            return makeFailureResult("rellane_read_source requires a non-empty string sourceId.");
          }

          let offset = 0;
          if ("offset" in args) {
            if (typeof args.offset !== "number" || !Number.isInteger(args.offset) || args.offset < 0) {
              return makeFailureResult("offset must be a non-negative integer.");
            }
            offset = args.offset;
          }

          let maxChars = MAX_SOURCE_READ_CHARS_PAGE;
          if ("maxChars" in args) {
            if (
              typeof args.maxChars !== "number" ||
              !Number.isInteger(args.maxChars) ||
              args.maxChars < 1 ||
              args.maxChars > MAX_SOURCE_READ_CHARS_PAGE
            ) {
              return makeFailureResult(
                `maxChars must be an integer between 1 and ${MAX_SOURCE_READ_CHARS_PAGE}.`
              );
            }
            maxChars = args.maxChars;
          }

          const sourceIndex = snapshot.findIndex((s) => s.id === args.sourceId);
          if (sourceIndex === -1) {
            return makeFailureResult(`Source with id "${args.sourceId}" not found in reviewed sources.`);
          }

          const source = snapshot[sourceIndex]!;
          const totalChars = source.text.length;

          // A page is bounded in characters, but the ceiling above it is in
          // bytes, and JSON does not spend those bytes evenly: a control
          // character costs six. A legal 16,000-character page of pasted
          // terminal output encodes past the ceiling, and answering "too large"
          // for every page would make such a source permanently unreadable.
          // Halve until it fits and report the shorter page honestly, so the
          // caller's next offset is still right.
          const page = (take: number): string => {
            const slice = source.text.slice(offset, offset + take);
            const consumed = offset + slice.length;
            return JSON.stringify({
              sourceId: source.id,
              citationId: sourceIndex + 1,
              label: source.label,
              offset,
              length: slice.length,
              totalChars,
              hasMore: consumed < totalChars,
              nextOffset: consumed < totalChars ? consumed : null,
              text: slice
            });
          };

          let take = maxChars;
          let payload = page(take);
          while (Buffer.byteLength(payload, "utf8") > MAX_TOOL_OUTPUT_BYTES && take > 1) {
            take = Math.floor(take / 2);
            payload = page(take);
          }

          return makeSuccessResult(payload);
        }

        case "hermes_list_skills": {
          const keys = Object.keys(args);
          if (keys.length > 0) {
            return makeFailureResult(
              `hermes_list_skills accepts only an empty object, got keys: ${keys.join(", ")}`
            );
          }

          const skills = listHermesSkills().map((s) => ({
            id: s.id,
            name: s.name,
            title: s.title,
            description: s.description
          }));

          return makeSuccessResult(JSON.stringify({ skills }));
        }

        case "hermes_read_skill": {
          const keys = Object.keys(args);
          for (const k of keys) {
            if (k !== "skillId") {
              return makeFailureResult(`Unexpected argument key "${k}" for hermes_read_skill.`);
            }
          }

          if (!("skillId" in args) || typeof args.skillId !== "string" || args.skillId.trim().length === 0) {
            return makeFailureResult("hermes_read_skill requires a non-empty string skillId.");
          }

          const requestedId = args.skillId;
          const summaries: readonly BundledSkillSummary[] = listHermesSkills();
          const summary = summaries.find((skill) => skill.id === requestedId);
          if (summary === undefined) {
            // Deliberately says nothing about why: an unknown id is an unknown
            // id, whether it was a typo or an attempt at a path.
            return makeFailureResult(`Unknown Hermes skill ID: "${requestedId}".`);
          }

          let skill: BundledSkillContent;
          try {
            skill = readHermesSkill(requestedId);
          } catch {
            // The upstream reader's own message can name a bundled location.
            // The caller gets the outcome, never the layout of this Mac.
            return makeFailureResult(`That pinned skill could not be read: "${requestedId}".`);
          }

          return makeSuccessResult(
            JSON.stringify({
              skillId: summary.id,
              title: summary.title,
              description: summary.description,
              sha256: skill.sha256,
              content: skill.content
            })
          );
        }

        case "hermes_check_citations": {
          const keys = Object.keys(args);
          for (const k of keys) {
            if (k !== "draft") {
              return makeFailureResult(`Unexpected argument key "${k}" for hermes_check_citations.`);
            }
          }

          if (!("draft" in args) || typeof args.draft !== "string") {
            return makeFailureResult("hermes_check_citations requires a string draft.");
          }

          if (Buffer.byteLength(args.draft, "utf8") > MAX_CITATION_DRAFT_BYTES) {
            return makeFailureResult(
              `Draft exceeds maximum limit of ${MAX_CITATION_DRAFT_BYTES} UTF-8 bytes.`
            );
          }

          if (isCitationCheckActive) {
            return makeFailureResult(
              "Another citation check is already in progress. Only one citation check child at a time."
            );
          }

          isCitationCheckActive = true;
          try {
            if (!stillActive()) {
              return makeFailureResult("Session is closed, stopped, or inactive.");
            }

            const citationResult = await options.checkCitations({
              caseId: options.caseId,
              draft: args.draft,
              sources: snapshot.map((s) => ({
                sourceTurnId: s.id,
                label: s.label,
                body: s.text
              }))
            });

            // Suppress results if stopped during await.
            if (!stillActive()) {
              return makeFailureResult("Session was stopped during citation check. Results suppressed.");
            }

            return makeSuccessResult(JSON.stringify(citationResult));
          } catch (err) {
            if (!stillActive()) {
              return makeFailureResult("Session was stopped during citation check.");
            }
            return makeFailureResult(err instanceof Error ? err.message : String(err));
          } finally {
            isCitationCheckActive = false;
          }
        }

        default:
          return makeFailureResult(
            `Unknown tool: "${call.tool}". Available tools: ${NATIVE_TOOL_NAMES.join(", ")}.`
          );
      }
    }
  };
}
