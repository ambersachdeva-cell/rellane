/** File snapshots are references, so they must not appear as model answers. */
import type { CaseTurnView } from "@cadrane/contracts";
export const CASE_SOURCE_SEAT_PREFIX = "Source · ";
export const CASE_DATA_SEAT_PREFIX = `${CASE_SOURCE_SEAT_PREFIX}CSV · `;
export function isCaseDataSource(turn: Pick<CaseTurnView, "seat" | "kind">): boolean {
  return turn.kind === "verbatim" && turn.seat.startsWith(CASE_DATA_SEAT_PREFIX);
}
export function isCaseReference(
  turn: Pick<CaseTurnView, "seat" | "kind">,
): boolean {
  return (
    turn.kind === "verbatim" &&
    (turn.seat === "owner" || turn.seat.startsWith(CASE_SOURCE_SEAT_PREFIX))
  );
}
