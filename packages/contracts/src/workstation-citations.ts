import { z } from "zod";
import { WORKSTATION_SOURCE_LIMIT } from "./workstation.js";

export const WORKSTATION_CITATION_DRAFT_LIMIT = 51_200;
export const WORKSTATION_CITATION_SOURCES_TEXT_LIMIT = 204_800;

export const WorkstationCheckCitationsInputSchema = z.strictObject({
  caseId: z.string().trim().min(1).max(64),
  draft: z.string().max(WORKSTATION_CITATION_DRAFT_LIMIT),
  sourceTurnIds: z
    .array(z.string().uuid())
    .max(WORKSTATION_SOURCE_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length, "Select each source once.")
});

export type WorkstationCheckCitationsInput = z.infer<typeof WorkstationCheckCitationsInputSchema>;

export interface WorkstationCitationSource {
  readonly id: number;
  readonly sourceTurnId: string;
  readonly label: string;
  readonly uri: string;
}

export type WorkstationCitationStatus = "ok" | "mismatch" | "uncited" | "unavailable";

export type WorkstationQuoteStatus = "matched" | "not_found" | "source_not_selected";

export interface WorkstationQuoteCheck {
  readonly quote: string;
  readonly citation: string;
  readonly status: WorkstationQuoteStatus;
}

export interface WorkstationCitationCheckResult {
  readonly status: WorkstationCitationStatus;
  readonly summary: string;
  /** Always set by the host, never by the checker process. */
  readonly disclaimer: string;
  readonly sources: readonly WorkstationCitationSource[];
  readonly citedIds: readonly number[];
  readonly unknownReferences: readonly string[];
  readonly missingFromSourcesBlock: readonly number[];
  readonly unexpectedInSourcesBlock: readonly number[];
  readonly mismatchedUrls: readonly string[];
  readonly expectedSourcesBlock: string;
  readonly stats?: string;
  /** The interpreter that actually ran the check, reported rather than assumed. */
  readonly runtime?: string;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly quotes: readonly WorkstationQuoteCheck[];
  readonly quoteCheckNote: string;
}

/**
 * The shape the host will accept from the checker process. Strict on purpose:
 * an unknown key or a wrong type is a failed check, not something the renderer
 * has to interpret.
 */
export const WorkstationCitationCheckResultSchema = z.strictObject({
  status: z.enum(["ok", "mismatch", "uncited", "unavailable"]),
  summary: z.string().max(2_000),
  disclaimer: z.string().max(2_000),
  sources: z
    .array(
      z.strictObject({
        id: z.number().int().positive().max(1_000),
        sourceTurnId: z.string().max(128),
        label: z.string().max(400),
        uri: z.string().max(600)
      })
    )
    .max(WORKSTATION_SOURCE_LIMIT),
  citedIds: z.array(z.number().int()).max(500),
  unknownReferences: z.array(z.string().max(200)).max(200),
  missingFromSourcesBlock: z.array(z.number().int()).max(500),
  unexpectedInSourcesBlock: z.array(z.number().int()).max(500),
  mismatchedUrls: z.array(z.string().max(600)).max(200),
  expectedSourcesBlock: z.string().max(20_000),
  stats: z.string().max(2_000).optional(),
  runtime: z.string().max(100).optional(),
  warnings: z.array(z.string().max(1_000)).max(200),
  errors: z.array(z.string().max(1_000)).max(200),
  quotes: z
    .array(
      z.strictObject({
        quote: z.string().max(1_000),
        citation: z.string().max(128),
        status: z.enum(["matched", "not_found", "source_not_selected"])
      })
    )
    .max(40),
  quoteCheckNote: z.string().max(1_000)
});

export interface WorkstationCitationBridge {
  checkCitations(input: WorkstationCheckCitationsInput): Promise<WorkstationCitationCheckResult>;
}
