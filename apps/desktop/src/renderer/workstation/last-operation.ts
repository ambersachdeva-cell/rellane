import type { CaseTurnView } from "@cadrane/contracts";

/**
 * The last session this piece of work ran, from the receipts already in the room.
 *
 * `status` only holds a session this app started since it was opened, so asking
 * it alone meant "what changed?" answered "nothing has run yet" for every piece
 * of work he came back to later — which is most of them, and exactly when the
 * question is worth asking. The receipts are turns like any other, so the
 * answer was already on screen; it just had to be read.
 */
export function lastOperationIn(turns: readonly CaseTurnView[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined || turn.kind !== "receipt") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(turn.body);
      if (typeof parsed !== "object" || parsed === null) continue;
      const snapshot = (parsed as { readonly snapshot?: unknown }).snapshot;
      if (typeof snapshot !== "object" || snapshot === null) continue;
      const operationId = (snapshot as { readonly operationId?: unknown }).operationId;
      if (typeof operationId === "string" && operationId.length > 0) {
        return operationId;
      }
    } catch {
      // A receipt this build cannot read is skipped, not treated as the answer.
    }
  }
  return null;
}

