/** Keep the opening intention once, while preserving every later repeated request. */
import type { CaseTurnView, WorkstationSnapshot, WorkstationProviderId } from "@cadrane/contracts";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";

export function conversationTurns(turns: readonly CaseTurnView[], question?: string): readonly CaseTurnView[] {
  const visible = turns.filter(turn => turn.kind === "verbatim" && !turn.seat.startsWith(CASE_SOURCE_SEAT_PREFIX));
  const [opening, request] = visible;
  // Cases record their opening question before a provider is chosen. The native
  // host separately records the actual send. Keep both in the book and source
  // picker, but show only the sent copy when those first two entries match.
  if (opening?.seq === 1 && opening.seat === "owner" && request?.seat === "owner"
    && opening.body.trim() === question?.trim() && opening.body.trim() === request.body.trim()) return visible.slice(1);
  return visible;
}

/** Recover the last used AI from work already saved, without restoring any tool authority. */
export function previousWorkModel(turns: readonly CaseTurnView[], native: WorkstationSnapshot | null):
  { readonly providerId: WorkstationProviderId | "local"; readonly modelId: string } | null {
  const local = turns.filter(turn => turn.kind === "verbatim" && turn.seat.startsWith("Local · ")).at(-1);
  if (local && (!native || local.at > native.updatedAt)) {
    const modelId = local.seat.slice("Local · ".length);
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(modelId)) return { providerId: "local", modelId };
  }
  return native ? { providerId: native.providerId, modelId: native.modelId ?? "" } : null;
}
