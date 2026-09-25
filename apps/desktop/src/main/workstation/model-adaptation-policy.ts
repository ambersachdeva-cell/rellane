/** Reviewed model adaptation can change future advice weights, never a selected model or dispatch. */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { WorkstationProviderIdSchema, type WorkstationProvider } from "@cadrane/contracts";
import {
  MAX_CATALOG_CANDIDATES,
  adviseSoloModelChoice,
  type ModelCandidate,
  type ProjectPreferences
} from "./model-choice-advisor.js";
import { readModelOutcomeEvidenceSnapshot } from "./model-outcome-evidence-store.js";
import {
  ModelIdSchema,
  ProjectIdSchema,
  WeightSchema,
  appendPreferenceHistory,
  establishPreferenceHistoryHead,
  getProjectModelPreferences,
  serializeProjectPreferences,
  type StoredProjectModelPreferences
} from "./model-project-preferences-store.js";

export const MODEL_ADAPTATION_MIN_ATTEMPTS = 10;
export const MODEL_ADAPTATION_PROPOSAL_TTL_MS = 10 * 60 * 1000;
export const MAX_MODEL_ADAPTATION_PROPOSALS_PER_PROJECT = 200;

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const DeltaSchema = z.strictObject({
  kind: z.literal("model_weight"),
  providerId: WorkstationProviderIdSchema,
  modelId: ModelIdSchema,
  from: WeightSchema,
  to: WeightSchema
});
const MessagesSchema = z.array(z.string().min(1).max(500)).min(1).max(10);

export type ModelAdaptationDelta = z.infer<typeof DeltaSchema>;

export interface ModelCatalogIdentity {
  readonly entries: readonly {
    readonly providerId: z.infer<typeof WorkstationProviderIdSchema>;
    readonly state: "detected" | "unavailable" | "blocked";
    readonly modelIds: readonly string[];
  }[];
  readonly json: string;
  readonly sha256: string;
}

export interface ModelAdaptationProposal {
  readonly id: string;
  readonly projectId: string;
  readonly baseRevision: number;
  readonly catalogSha256: string;
  readonly catalog: ModelCatalogIdentity["entries"];
  readonly evidenceSha256: string;
  readonly evidenceOperations: number;
  readonly evidenceReceiptCount: number;
  readonly delta: ModelAdaptationDelta;
  readonly reasons: readonly string[];
  readonly unknowns: readonly string[];
  readonly createdAt: number;
  readonly proposalSha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireTime(at: number): void {
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error("Invalid model adaptation timestamp.");
}

export function identifyModelCatalog(providers: readonly WorkstationProvider[]): ModelCatalogIdentity {
  if (!Array.isArray(providers) || providers.length > 5) {
    throw new Error("Model adaptation catalog exceeds provider bound.");
  }
  const seen = new Set<string>();
  let totalModels = 0;
  const entries = providers.map((provider) => {
    const providerId = WorkstationProviderIdSchema.parse(provider.id);
    if (seen.has(providerId)) throw new Error("Duplicate model adaptation provider identity.");
    seen.add(providerId);
    if (provider.state !== "detected" && provider.state !== "unavailable" && provider.state !== "blocked") {
      throw new Error("Invalid model adaptation provider state.");
    }
    const modelIds = provider.models.map((model: WorkstationProvider["models"][number]) => ModelIdSchema.parse(model.id));
    if (new Set(modelIds).size !== modelIds.length) throw new Error("Duplicate model adaptation catalog model.");
    totalModels += modelIds.length;
    return { providerId, state: provider.state, modelIds: modelIds.sort() };
  }).sort((left, right) => left.providerId.localeCompare(right.providerId));
  if (totalModels > MAX_CATALOG_CANDIDATES) throw new Error("Model adaptation catalog exceeds model bound.");
  const json = JSON.stringify(entries);
  if (Buffer.byteLength(json, "utf8") > 32_768) throw new Error("Model adaptation catalog exceeds byte bound.");
  return { entries, json, sha256: sha256(json) };
}

function proposalDigest(value: Omit<ModelAdaptationProposal, "proposalSha256">): string {
  return sha256(JSON.stringify(value));
}

function candidatesFromIdentity(catalog: ModelCatalogIdentity): readonly ModelCandidate[] {
  return catalog.entries.flatMap((provider) => provider.state === "detected"
    ? provider.modelIds.map((modelId) => ({ providerId: provider.providerId, modelId, capabilities: [] }))
    : []);
}

/** Persist a proposal only when bounded observed completion supports a small, reviewable weight delta. */
export function proposeModelAdaptation(
  db: DatabaseSync,
  projectId: string,
  catalog: ModelCatalogIdentity,
  at: number = Date.now()
): ModelAdaptationProposal | null {
  const validProjectId = ProjectIdSchema.parse(projectId);
  requireTime(at);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT id FROM workstation_project WHERE id = ?").get(validProjectId)) {
      throw new Error("Model adaptation project does not exist.");
    }
    const saved = getProjectModelPreferences(db, validProjectId, { includeDeleted: true });
    if (saved?.deletedAt !== null && saved !== null) {
      throw new Error("Forgotten model policy requires an explicit owner save before adaptation.");
    }
    const evidence = readModelOutcomeEvidenceSnapshot(db, validProjectId);
    const candidates = candidatesFromIdentity(catalog);
    const advice = adviseSoloModelChoice({
      candidates,
      ...(saved ? { preferences: saved.preferences } : {}),
      evidence: evidence.outcomes
    });
    const existingWeights = saved?.preferences.modelWeights ?? {};
    const target = advice.rankedCandidates.find((ranked) => {
      const signal = ranked.reliabilitySignal;
      const scoped = saved?.preferences.providerModelWeights?.[ranked.candidate.providerId] ?? {};
      return !Object.prototype.hasOwnProperty.call(existingWeights, ranked.candidate.modelId) &&
        !Object.prototype.hasOwnProperty.call(scoped, ranked.candidate.modelId) &&
        signal.status === "measured" &&
        signal.totalAttemptedCount >= MODEL_ADAPTATION_MIN_ATTEMPTS &&
        signal.completionRatio !== null &&
        (signal.completionRatio >= 0.8 || signal.completionRatio <= 0.2);
    });
    if (!target) {
      db.exec("COMMIT");
      return null;
    }
    const proposalCount = db.prepare(
      `SELECT COUNT(*) AS count FROM workstation_project_model_adaptation_proposal WHERE project_id = ?`
    ).get(validProjectId) as { count: number };
    if (proposalCount.count >= MAX_MODEL_ADAPTATION_PROPOSALS_PER_PROJECT) {
      throw new Error("Model adaptation proposal history exceeds project bound.");
    }
    const signal = target.reliabilitySignal;
    const to = signal.completionRatio !== null && signal.completionRatio >= 0.8 ? 1.1 : 0.9;
    const delta = DeltaSchema.parse({
      kind: "model_weight", providerId: target.candidate.providerId,
      modelId: target.candidate.modelId, from: 1, to
    });
    const reasons = MessagesSchema.parse([
      `${signal.observedCompletedCount}/${signal.totalAttemptedCount} attempted operations completed for this exact listed model; proposed weight moves from 1 to ${to}.`,
      "This small change affects future unpinned advice only and requires explicit owner acceptance."
    ]);
    const unknowns = MessagesSchema.parse([
      "Observed completion does not establish output quality or correctness.",
      "Capability, sign-in, quota, cost, and future availability remain unverified."
    ]);
    const id = randomUUID();
    const proposalWithoutDigest = {
      id, projectId: validProjectId, baseRevision: saved?.revision ?? 0,
      catalogSha256: catalog.sha256, catalog: catalog.entries,
      evidenceSha256: evidence.sha256, evidenceOperations: evidence.operationCount,
      evidenceReceiptCount: evidence.receiptCount,
      delta, reasons, unknowns, createdAt: at
    };
    const proposal: ModelAdaptationProposal = {
      ...proposalWithoutDigest,
      proposalSha256: proposalDigest(proposalWithoutDigest)
    };
    db.prepare(
      `INSERT INTO workstation_project_model_adaptation_proposal
       (id, project_id, base_revision, base_deleted_at, catalog_sha256, catalog_json,
        evidence_sha256, evidence_refs_json, evidence_operations, delta_json,
        reasons_json, unknowns_json, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, validProjectId, proposal.baseRevision, catalog.sha256, catalog.json,
      evidence.sha256, JSON.stringify(evidence.receiptRefs), evidence.operationCount,
      JSON.stringify(delta), JSON.stringify(reasons), JSON.stringify(unknowns), at);
    db.exec("COMMIT");
    return proposal;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}

type ProposalRow = Record<string, unknown>;

function parseStoredProposal(row: ProposalRow, evidenceReceiptCount: number): ModelAdaptationProposal {
  const id = z.string().uuid().parse(row["id"]);
  const projectId = ProjectIdSchema.parse(row["project_id"]);
  const baseRevision = z.number().int().safe().min(0).parse(row["base_revision"]);
  const catalogSha256 = DigestSchema.parse(row["catalog_sha256"]);
  const evidenceSha256 = DigestSchema.parse(row["evidence_sha256"]);
  const evidenceOperations = z.number().int().safe().min(0).max(200).parse(row["evidence_operations"]);
  const createdAt = z.number().int().safe().positive().parse(row["created_at"]);
  if (row["base_deleted_at"] !== null || typeof row["catalog_json"] !== "string" ||
      typeof row["delta_json"] !== "string" || typeof row["reasons_json"] !== "string" ||
      typeof row["unknowns_json"] !== "string" || sha256(row["catalog_json"]) !== catalogSha256) {
    throw new Error("Corrupt model adaptation proposal.");
  }
  const catalog = z.array(z.strictObject({
    providerId: WorkstationProviderIdSchema,
    state: z.enum(["detected", "unavailable", "blocked"]),
    modelIds: z.array(ModelIdSchema).max(MAX_CATALOG_CANDIDATES)
  })).max(5).parse(JSON.parse(row["catalog_json"]));
  const delta = DeltaSchema.parse(JSON.parse(row["delta_json"]));
  const reasons = MessagesSchema.parse(JSON.parse(row["reasons_json"]));
  const unknowns = MessagesSchema.parse(JSON.parse(row["unknowns_json"]));
  const withoutDigest = {
    id, projectId, baseRevision, catalogSha256, catalog,
    evidenceSha256, evidenceOperations, evidenceReceiptCount,
    delta, reasons, unknowns, createdAt
  };
  return { ...withoutDigest, proposalSha256: proposalDigest(withoutDigest) };
}

/** One trusted owner action; a fresh catalog observation precedes an atomic Book evidence/policy CAS. */
export function acceptModelAdaptation(
  db: DatabaseSync,
  input: { readonly projectId: string; readonly proposalId: string; readonly expectedProposalSha256: string },
  catalog: ModelCatalogIdentity,
  at: number = Date.now()
): StoredProjectModelPreferences {
  const projectId = ProjectIdSchema.parse(input.projectId);
  const proposalId = z.string().uuid().parse(input.proposalId);
  const expectedDigest = DigestSchema.parse(input.expectedProposalSha256);
  requireTime(at);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(
      `SELECT * FROM workstation_project_model_adaptation_proposal
       WHERE id = ? AND project_id = ?`
    ).get(proposalId, projectId) as ProposalRow | undefined;
    if (!row) throw new Error("Model adaptation proposal is missing or was forgotten.");
    if (typeof row["evidence_refs_json"] !== "string") throw new Error("Corrupt model adaptation evidence refs.");
    const refs = JSON.parse(row["evidence_refs_json"]);
    if (!Array.isArray(refs) || refs.length > 5000) throw new Error("Corrupt model adaptation evidence refs.");
    const proposal = parseStoredProposal(row, refs.length);
    if (proposal.proposalSha256 !== expectedDigest) throw new Error("Reviewed model adaptation proposal differs from the accepted bytes.");
    if (at < proposal.createdAt || at - proposal.createdAt > MODEL_ADAPTATION_PROPOSAL_TTL_MS) {
      throw new Error("Model adaptation proposal expired; review fresh advice.");
    }
    if (catalog.sha256 !== proposal.catalogSha256 || catalog.json !== row["catalog_json"]) {
      throw new Error("Stale model adaptation proposal: host catalog changed.");
    }
    const saved = getProjectModelPreferences(db, projectId, { includeDeleted: true });
    if (saved?.deletedAt !== null && saved !== null) {
      throw new Error("Forgotten model policy cannot be revived by adaptation.");
    }
    if ((saved?.revision ?? 0) !== proposal.baseRevision) {
      throw new Error("Stale model adaptation proposal: preference revision changed.");
    }
    const evidence = readModelOutcomeEvidenceSnapshot(db, projectId);
    if (evidence.sha256 !== proposal.evidenceSha256 ||
        evidence.operationCount !== proposal.evidenceOperations ||
        JSON.stringify(evidence.receiptRefs) !== row["evidence_refs_json"]) {
      throw new Error("Stale model adaptation proposal: exact outcome receipts changed.");
    }
    const delta = proposal.delta;
    if (!catalog.entries.some((entry) => entry.providerId === delta.providerId &&
          entry.state === "detected" && entry.modelIds.includes(delta.modelId)) ||
        Object.prototype.hasOwnProperty.call(saved?.preferences.modelWeights ?? {}, delta.modelId) ||
        Object.prototype.hasOwnProperty.call(
          saved?.preferences.providerModelWeights?.[delta.providerId] ?? {}, delta.modelId
        ) ||
        delta.from !== 1 || (delta.to !== 0.9 && delta.to !== 1.1)) {
      throw new Error("Model adaptation delta no longer matches safe advice-only policy.");
    }
    const currentPreferences: ProjectPreferences = saved?.preferences ?? {};
    const preferences: ProjectPreferences = {
      ...currentPreferences, projectId,
      providerModelWeights: {
        ...(currentPreferences.providerModelWeights ?? {}),
        [delta.providerId]: {
          ...(currentPreferences.providerModelWeights?.[delta.providerId] ?? {}),
          [delta.modelId]: delta.to
        }
      }
    };
    const payloadJson = serializeProjectPreferences(preferences);
    establishPreferenceHistoryHead(db, projectId, saved?.revision ?? null);
    const revision = proposal.baseRevision + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("Model adaptation revision overflow.");
    if (saved) {
      db.prepare(
        `UPDATE workstation_project_model_preference
         SET revision = ?, payload_json = ?, updated_at = ?, deleted_at = NULL
         WHERE project_id = ?`
      ).run(revision, payloadJson, at, projectId);
    } else {
      db.prepare(
        `INSERT INTO workstation_project_model_preference
         (project_id, revision, payload_json, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, NULL)`
      ).run(projectId, revision, payloadJson, at);
    }
    appendPreferenceHistory(db, projectId, revision, "adaptive_accept", payloadJson, at, null, proposalId);
    db.exec("COMMIT");
    return { projectId, revision, preferences, updatedAt: at, deletedAt: null };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* Transaction may already be closed. */ }
    throw error;
  }
}
