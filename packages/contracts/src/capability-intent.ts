import { z } from "zod";
import { CanonicalDurableIdSchema } from "./useful-work.js";
const Id = CanonicalDurableIdSchema; const Hash = z.string().regex(/^[a-f0-9]{64}$/); const Time = z.string().datetime({ offset: true }).refine((value) => new Date(value).toISOString() === value);
export const ApprovedCapabilityIntentSchema = z.strictObject({ schemaVersion: z.literal(1), permissionRequestId: Id, permissionDecisionId: Id, spaceId: Id, runId: Id, effectId: Id, effectRevision: z.number().int().positive().safe(), effectKind: z.enum(["export-artifact", "delete-record"]), authoritySessionId: Id, subjectBindingSha256: Hash, targetBindingSha256: Hash, parameterSha256: Hash, requestSha256: Hash, expiresAt: Time, maxUses: z.literal(1) });
export type ApprovedCapabilityIntent = z.infer<typeof ApprovedCapabilityIntentSchema>;
