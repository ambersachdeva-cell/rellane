/** A saved brief for a product the person operates in their own browser. */
import { z } from "zod";
import { WorkstationCaseIdSchema } from "./workstation-projects.js";

export const CreativeProductIdSchema = z.enum(["gemini", "chatgpt", "ai-studio"]);
export type CreativeProductId = z.infer<typeof CreativeProductIdSchema>;
export interface CreativeHandoff {
  readonly id: string;
  readonly caseId: string;
  readonly productId: CreativeProductId;
  readonly prompt: string;
  readonly packet: string;
  readonly sha256: string;
  readonly sourceIds: readonly string[];
  readonly createdAt: number;
  /** Opening a website is not proof of generation or submission. */
  readonly openedAt: number | null;
  /** An explicitly associated imported image, not verified generator attribution. */
  readonly imageId: string | null;
}
export const CreativeBriefInputSchema = z.strictObject({
  caseId: WorkstationCaseIdSchema,
  productId: CreativeProductIdSchema,
  prompt: z.string().trim().min(1).max(8_000),
  sourceIds: z.array(z.uuid()).max(20).refine(ids => new Set(ids).size === ids.length, "Select each source once.")
});
export type CreativeBriefInput = z.infer<typeof CreativeBriefInputSchema>;
export const CreativeHandoffRequestSchema = z.strictObject({ caseId: WorkstationCaseIdSchema, id: z.uuid() });
export const CreativeHandoffImageInputSchema = CreativeHandoffRequestSchema.extend({ imageId: z.uuid() });
export interface CreativeHandoffBridge {
  creativeBriefs(input: { readonly caseId: string }): Promise<readonly CreativeHandoff[]>;
  saveCreativeBrief(input: CreativeBriefInput): Promise<CreativeHandoff>;
  copyCreativeBrief(input: { readonly caseId: string; readonly id: string }): Promise<void>;
  openCreativeProduct(input: { readonly caseId: string; readonly id: string }): Promise<CreativeHandoff>;
  linkCreativeImage(input: { readonly caseId: string; readonly id: string; readonly imageId: string }): Promise<CreativeHandoff>;
}
