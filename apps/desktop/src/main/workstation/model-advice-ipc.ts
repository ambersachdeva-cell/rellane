/** Trusted model advice and explicit adaptation review from the host catalog and scoped receipts. */
import type { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { WorkstationPrepareInputSchema, WorkstationProviderIdSchema, type WorkstationProvider } from "@cadrane/contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  MAX_CATALOG_CANDIDATES,
  MAX_EVIDENCE_RECORDS,
  MAX_PROMPT_LENGTH,
  adviseSoloModelChoice,
  adviseTeamModelChoice,
  type ModelCandidate
} from "./model-choice-advisor.js";
import { MAX_MODEL_OUTCOME_RECEIPTS, readModelOutcomeEvidence } from "./model-outcome-evidence-store.js";
import { acceptModelAdaptation, identifyModelCatalog, proposeModelAdaptation } from "./model-adaptation-policy.js";
import {
  ModelIdSchema,
  ProjectIdSchema,
  getProjectModelPreferences
} from "./model-project-preferences-store.js";

const Request = z.strictObject({
  projectId: ProjectIdSchema.nullable(),
  explicitChoice: z.strictObject({
    providerId: WorkstationProviderIdSchema,
    modelId: ModelIdSchema
  }).nullable().optional()
});

const TeamRequest = z.strictObject({
  projectId: ProjectIdSchema.nullable(),
  overallPrompt: z.string().min(1).max(MAX_PROMPT_LENGTH)
});

const ProposalRequest = z.strictObject({ projectId: ProjectIdSchema });
const AcceptRequest = z.strictObject({
  projectId: ProjectIdSchema,
  proposalId: z.string().uuid(),
  expectedProposalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  confirmed: z.literal(true)
});

function candidatesFromCatalog(providers: readonly WorkstationProvider[]): readonly ModelCandidate[] {
  const result: ModelCandidate[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (provider.state !== "detected") continue;
    for (const model of provider.models) {
      const modelId = WorkstationPrepareInputSchema.shape.modelId.parse(model.id);
      const key = `${provider.id}:${modelId}`;
      if (seen.has(key)) throw new Error(`Duplicate host model catalog entry: ${key}`);
      seen.add(key);
      result.push({
        providerId: provider.id,
        modelId,
        displayName: `${provider.label} · ${model.label}`,
        // The host catalog declares no capabilities or context window sizes.
        capabilities: []
      });
      if (result.length > MAX_CATALOG_CANDIDATES) {
        throw new Error("Host model catalog exceeds the bounded advice limit.");
      }
    }
  }
  return result;
}

export function installModelAdviceIpc(options: {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly book: () => DatabaseSync;
  readonly providers: () => Promise<readonly WorkstationProvider[]>;
}): void {
  async function readAdviceContext(projectId: string | null) {
    const db = options.book();
    if (projectId !== null &&
        !db.prepare("SELECT id FROM workstation_project WHERE id = ?").get(projectId)) {
      throw new Error("Advice project does not exist.");
    }
    const saved = projectId === null ? null :
      getProjectModelPreferences(db, projectId, { includeDeleted: true });
    const preferences = saved?.deletedAt === null ? saved.preferences : null;
    const providers = await options.providers();
    const candidates = candidatesFromCatalog(providers);
    // A bounded reader fails closed on overflow. No receipt or operation is
    // silently dropped to make a score appear more certain than its evidence.
    const evidence = readModelOutcomeEvidence(db, {
      projectId, maxReceipts: MAX_MODEL_OUTCOME_RECEIPTS
    });
    if (evidence.length > MAX_EVIDENCE_RECORDS) {
      throw new Error("Scoped measured operations exceed the bounded model advice limit.");
    }
    const providerCatalog = providers.map((provider) => ({
      providerId: provider.id,
      state: provider.state,
      modelIds: provider.models.map((model) => model.id)
    }));
    return { saved, preferences, candidates, evidence, providerCatalog };
  }

  ipcMain.handle(IPC_CHANNELS.workstationSoloModelAdvice, async (event, input: unknown) => {
    options.assertTrusted(event);
    const valid = Request.parse(input);
    const { saved, preferences, candidates, evidence, providerCatalog } =
      await readAdviceContext(valid.projectId);
    const advice = adviseSoloModelChoice({
      candidates,
      ...(valid.explicitChoice ? { explicitChoice: valid.explicitChoice } : {}),
      ...(preferences ? { preferences } : {}),
      evidence
    });
    return {
      projectId: valid.projectId,
      preferencesRevision: saved?.revision ?? null,
      advice,
      evidenceOperations: evidence.length,
      providerCatalog,
      readiness: "unverified" as const,
      basis: "Host-listed models and scoped observed run outcomes only. No capability, context, sign-in, quota, cost, or future-run readiness was verified. Advice never changes an explicit Solo pin or starts work."
    };
  });

  ipcMain.handle(IPC_CHANNELS.workstationTeamModelAdvice, async (event, input: unknown) => {
    options.assertTrusted(event);
    const valid = TeamRequest.parse(input);
    const { saved, preferences, candidates, evidence, providerCatalog } =
      await readAdviceContext(valid.projectId);
    const advice = adviseTeamModelChoice({
      candidates,
      overallPrompt: valid.overallPrompt,
      ...(preferences ? { preferences } : {}),
      evidence
    });
    return {
      projectId: valid.projectId,
      preferencesRevision: saved?.revision ?? null,
      advice,
      evidenceOperations: evidence.length,
      providerCatalog,
      readiness: "unverified" as const,
      basis: "Read-only role planning from host-listed models, saved project preferences, and scoped observed run outcomes. The host catalog declares no capabilities, so its roles require manual model review. No sign-in, quota, cost, output quality, or future-run readiness was verified; no work was started."
    };
  });

  ipcMain.handle(IPC_CHANNELS.workstationModelAdaptationPropose, async (event, input: unknown) => {
    options.assertTrusted(event);
    const valid = ProposalRequest.parse(input);
    const catalog = identifyModelCatalog(await options.providers());
    return proposeModelAdaptation(options.book(), valid.projectId, catalog);
  });

  ipcMain.handle(IPC_CHANNELS.workstationModelAdaptationAccept, async (event, input: unknown) => {
    options.assertTrusted(event);
    const valid = AcceptRequest.parse(input);
    // A newly observed host catalog is compared with the proposal before the
    // exact Book evidence and preference CAS are checked in one transaction.
    const catalog = identifyModelCatalog(await options.providers());
    return acceptModelAdaptation(options.book(), valid, catalog);
  });
}
