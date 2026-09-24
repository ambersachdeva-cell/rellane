import { z } from "zod";
import { CreativeBriefInputSchema, type CreativeBriefInput } from "@cadrane/contracts";

const PREFIX = "rellane.workstation.creative-draft.v1.";
const schema = CreativeBriefInputSchema.extend({ prompt: z.string().max(8_000) });
export function readCreativeDraft(storage: Pick<Storage, "getItem">, caseId: string): CreativeBriefInput | null {
  const raw = storage.getItem(PREFIX + caseId);
  if (!raw || raw.length > 60_000) return null;
  try {
    const value = schema.safeParse(JSON.parse(raw));
    return value.success && value.data.caseId === caseId ? value.data : null;
  } catch { return null; }
}
export function writeCreativeDraft(storage: Pick<Storage, "setItem" | "removeItem">, draft: CreativeBriefInput): void {
  const value = schema.parse(draft);
  if (!value.prompt && !value.sourceIds.length && value.productId === "gemini") storage.removeItem(PREFIX + value.caseId);
  else storage.setItem(PREFIX + value.caseId, JSON.stringify(value));
}
