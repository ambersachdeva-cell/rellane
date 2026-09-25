import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AutomationHostReviewDescriptorSchema,
  type AutomationHostReviewDescriptor,
  LocalChatRequestSchema,
  type LocalChatRequest
} from "@cadrane/contracts";
import {
  validateCaseSources,
  type ValidatedCaseSourcesResult
} from "./graph-host-source-validator.js";

export const ALLOWED_GRAPH_HOST_RUNTIME = "cadrane-local-loopback" as const;
export const ALLOWED_GRAPH_HOST_ROUTING_MODE = "fixed" as const;
export const GRAPH_HOST_RESPONSE_PROFILE = "graph-node-v1" as const;
export const MAX_GRAPH_HOST_REVIEW_PACKET_CHARACTERS = 24_000;

export enum GraphHostReviewPacketErrorCode {
  INVALID_OPERATION_ID = "INVALID_OPERATION_ID",
  DESCRIPTOR_PARSE_FAILED = "DESCRIPTOR_PARSE_FAILED",
  INVALID_RUNTIME = "INVALID_RUNTIME",
  INVALID_ROUTING_MODE = "INVALID_ROUTING_MODE",
  NONEMPTY_FALLBACK_ROUTES = "NONEMPTY_FALLBACK_ROUTES",
  UNSUPPORTED_OPTIONS = "UNSUPPORTED_OPTIONS",
  DEPENDENCY_HASH_MISMATCH = "DEPENDENCY_HASH_MISMATCH",
  MISSING_DEPENDENCY_SOURCE = "MISSING_DEPENDENCY_SOURCE",
  DEPENDENCY_SOURCE_MISMATCH = "DEPENDENCY_SOURCE_MISMATCH",
  PACKET_SIZE_EXCEEDED = "PACKET_SIZE_EXCEEDED",
  UNSAFE_PACKET = "UNSAFE_PACKET",
  REQUEST_PARSE_FAILED = "REQUEST_PARSE_FAILED"
}

export class GraphHostReviewPacketError extends Error {
  readonly code: GraphHostReviewPacketErrorCode;
  constructor(message: string, code: GraphHostReviewPacketErrorCode, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "GraphHostReviewPacketError";
    this.code = code;
  }
}

export interface GraphHostReviewPacketResult {
  readonly request: LocalChatRequest;
  readonly descriptorSha256: string;
  readonly sourceBindingSha256: string;
  readonly requestSha256: string;
  readonly preview: string;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").toLowerCase();
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) deepFreeze(val);
  }
  return obj;
}

function formatReviewPacketPreview(
  request: LocalChatRequest,
  descriptorSha256: string,
  sourceBindingSha256: string,
  requestSha256: string
): string {
  return [
    "=== Graph Host Review Packet Preview ===",
    "--- Verification Hashes ---",
    `Descriptor SHA-256:     ${descriptorSha256}`,
    `Source Binding SHA-256: ${sourceBindingSha256}`,
    `Request SHA-256:        ${requestSha256}`,
    "--- Serialized Request (Options & Messages) ---",
    JSON.stringify(request, null, 2),
    "--- System Message Content ---",
    request.messages.find((m) => m.role === "system")?.content ?? "",
    "--- User Message Content ---",
    request.messages.find((m) => m.role === "user")?.content ?? "",
    "========================================"
  ].join("\n");
}

export function composeGraphHostReviewPacket(
  db: DatabaseSync,
  rawDescriptor: unknown,
  operationId: string
): GraphHostReviewPacketResult {
  if (typeof operationId !== "string" || operationId.trim() !== operationId || operationId.length === 0) {
    throw new GraphHostReviewPacketError("Invalid operationId", GraphHostReviewPacketErrorCode.INVALID_OPERATION_ID);
  }

  if (rawDescriptor !== null && typeof rawDescriptor === "object" && ("tools" in rawDescriptor || "toolChoice" in rawDescriptor)) {
    throw new GraphHostReviewPacketError("Tools unsupported", GraphHostReviewPacketErrorCode.UNSUPPORTED_OPTIONS);
  }

  let descriptor: AutomationHostReviewDescriptor;
  try {
    descriptor = AutomationHostReviewDescriptorSchema.parse(rawDescriptor);
  } catch (error) {
    throw new GraphHostReviewPacketError(
      `Descriptor parse failed: ${error instanceof Error ? error.message : String(error)}`,
      GraphHostReviewPacketErrorCode.DESCRIPTOR_PARSE_FAILED,
      error
    );
  }

  if (descriptor.runtimeId !== ALLOWED_GRAPH_HOST_RUNTIME) {
    throw new GraphHostReviewPacketError(`Unsupported runtime "${descriptor.runtimeId}"`, GraphHostReviewPacketErrorCode.INVALID_RUNTIME);
  }
  if (descriptor.routingMode !== ALLOWED_GRAPH_HOST_ROUTING_MODE) {
    throw new GraphHostReviewPacketError(`Unsupported routingMode "${descriptor.routingMode}"`, GraphHostReviewPacketErrorCode.INVALID_ROUTING_MODE);
  }
  if (descriptor.fallbackRoutes.length > 0) {
    throw new GraphHostReviewPacketError("fallbackRoutes must be empty", GraphHostReviewPacketErrorCode.NONEMPTY_FALLBACK_ROUTES);
  }
  if (descriptor.systemPrompt.trim().length === 0 || descriptor.instruction.trim().length === 0) {
    throw new GraphHostReviewPacketError("Prompts cannot be empty", GraphHostReviewPacketErrorCode.UNSAFE_PACKET);
  }

  const validatedCaseSources: ValidatedCaseSourcesResult = validateCaseSources(db, {
    caseId: descriptor.caseId,
    selectedTurnIds: descriptor.sourceTurnIds
  });
  if (validatedCaseSources.sources.length === 0) {
    throw new GraphHostReviewPacketError("Case sources cannot be empty", GraphHostReviewPacketErrorCode.UNSAFE_PACKET);
  }

  const roughPreCheckSize = descriptor.systemPrompt.length + descriptor.instruction.length + validatedCaseSources.totalBytes;
  if (roughPreCheckSize > MAX_GRAPH_HOST_REVIEW_PACKET_CHARACTERS) {
    throw new GraphHostReviewPacketError(`Pre-check size exceeded (${roughPreCheckSize})`, GraphHostReviewPacketErrorCode.PACKET_SIZE_EXCEEDED);
  }

  for (const dep of descriptor.dependencyOutputs) {
    if (sha256Hex(dep.output) !== dep.outputSha256.toLowerCase()) {
      throw new GraphHostReviewPacketError(`Dependency hash mismatch for "${dep.nodeId}"`, GraphHostReviewPacketErrorCode.DEPENDENCY_HASH_MISMATCH);
    }
  }

  const graphSources = validatedCaseSources.sources.filter((s) => s.sourceType === "graph_generated");
  if (graphSources.length !== descriptor.dependencyOutputs.length) {
    throw new GraphHostReviewPacketError("Graph findings count mismatch", GraphHostReviewPacketErrorCode.DEPENDENCY_SOURCE_MISMATCH);
  }

  const matchedTurnIds = new Set<string>();
  for (const dep of descriptor.dependencyOutputs) {
    const match = graphSources.find(
      (s) => !matchedTurnIds.has(s.turnId) && s.kind === "finding" &&
        s.provenance?.graphRunId === descriptor.runId && s.provenance?.nodeId === dep.nodeId &&
        s.contentSha256 === dep.outputSha256.toLowerCase() && s.body === dep.output
    );
    if (!match) {
      throw new GraphHostReviewPacketError(`Missing finding for dep "${dep.nodeId}"`, GraphHostReviewPacketErrorCode.MISSING_DEPENDENCY_SOURCE);
    }
    matchedTurnIds.add(match.turnId);
  }
  if (matchedTurnIds.size !== graphSources.length) {
    throw new GraphHostReviewPacketError("Unmatched graph sources", GraphHostReviewPacketErrorCode.DEPENDENCY_SOURCE_MISMATCH);
  }

  const userPayload = {
    graph: {
      workflowId: descriptor.workflowId, workflowRevision: descriptor.workflowRevision,
      workflowSha256: descriptor.workflowSha256, agentId: descriptor.agentId,
      agentRevision: descriptor.agentRevision, agentSha256: descriptor.agentSha256,
      runId: descriptor.runId, nodeId: descriptor.nodeId, attemptId: descriptor.attemptId,
      caseId: descriptor.caseId
    },
    provenance: descriptor.provenance,
    instruction: descriptor.instruction,
    dependencyOutputs: descriptor.dependencyOutputs.map((dep) => ({
      nodeId: dep.nodeId, title: dep.title, outputSha256: dep.outputSha256, output: dep.output
    })),
    sources: validatedCaseSources.sources.map((s) => ({
      turnId: s.turnId, seq: s.seq, seat: s.seat, kind: s.kind, sourceType: s.sourceType,
      contentSha256: s.contentSha256, text: s.body,
      ...(s.provenance !== undefined ? { provenance: s.provenance } : {})
    }))
  };

  const systemContent = descriptor.systemPrompt;
  const userContent = JSON.stringify(userPayload);
  const totalMessageChars = systemContent.length + userContent.length;
  if (totalMessageChars > MAX_GRAPH_HOST_REVIEW_PACKET_CHARACTERS) {
    throw new GraphHostReviewPacketError(`Packet size exceeded (${totalMessageChars})`, GraphHostReviewPacketErrorCode.PACKET_SIZE_EXCEEDED);
  }
  if (totalMessageChars === 0) {
    throw new GraphHostReviewPacketError("Packet messages cannot be empty", GraphHostReviewPacketErrorCode.UNSAFE_PACKET);
  }

  const rawRequest = {
    operationId, runtimeId: descriptor.runtimeId, modelId: descriptor.modelId,
    messages: [{ role: "system" as const, content: systemContent }, { role: "user" as const, content: userContent }],
    temperature: descriptor.temperature, maxTokens: descriptor.maxTokens, responseProfile: GRAPH_HOST_RESPONSE_PROFILE
  };

  let parsedRequest: LocalChatRequest;
  try {
    parsedRequest = LocalChatRequestSchema.parse(rawRequest);
  } catch (error) {
    throw new GraphHostReviewPacketError(
      `LocalChatRequest validation failed: ${error instanceof Error ? error.message : String(error)}`,
      GraphHostReviewPacketErrorCode.REQUEST_PARSE_FAILED,
      error
    );
  }

  const descriptorSha256 = sha256Hex(JSON.stringify(descriptor));
  const sourceBindingSha256 = validatedCaseSources.aggregateBinding.bindingSha256;
  const requestSha256 = sha256Hex(JSON.stringify(parsedRequest));

  return Object.freeze({
    request: deepFreeze(parsedRequest),
    descriptorSha256,
    sourceBindingSha256,
    requestSha256,
    preview: formatReviewPacketPreview(parsedRequest, descriptorSha256, sourceBindingSha256, requestSha256)
  });
}
