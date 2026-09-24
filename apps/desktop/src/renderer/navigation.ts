/**
 * Where a person can be, and what the rail is allowed to say about it.
 *
 * This lived inside `App.tsx` and every navigation component imported its type
 * back out of the 1,900-line component that renders them — a cycle that made
 * the shell impossible to reason about in pieces. The destinations are data;
 * they belong beside the rail, not inside the screen.
 */
import type {
  ActivityLog,
  AgentCard,
  EngineRoomStatus
} from "@cadrane/contracts";

/**
 * The places a person can be. Not modes, not drawers — destinations, so the
 * answer to "where am I" is always a word in the sidebar.
 *
 * Only `today` and `deals` are on the rail (see `ProductNavigation`). The rest
 * remain addressable — through a Deal, through settings, or through the command
 * palette — because de-promoting a destination should not delete a screen.
 *
 * `deals` and `cases` are different places and were briefly the same one. The
 * rail said Deals and opened the workroom list, so a print shop owner looking
 * for what they had quoted was offered a brand-campaign starter. Cases are
 * still real and still reached — from a Today row, and from the palette — they
 * are simply not what the second word on the rail means.
 */
export type Place =
  | "today"
  | "deals"
  | "desk"
  | "cases"
  | "book"
  | "agents"
  | "connectors"
  | "models"
  | "timeline"
  | "memory"
  | "engines"
  | "settings";

/**
 * The number beside a place, or nothing.
 *
 * Only where a count means something a person would act on. A number that is
 * always the same teaches nothing and adds noise to a column that should be
 * scannable — so Timeline shows entries, AI connections has no ambiguous ratio, and
 * Home shows nothing at all because "1 home" is not information.
 */
export function placeCount(
  place: Place,
  agents: readonly AgentCard[] | null,
  engines: EngineRoomStatus | null,
  activity: ActivityLog | null
): string {
  switch (place) {
    case "agents":
      return agents === null ? "" : String(agents.filter((agent) => !agent.inert).length);
    case "engines":
      return "";
    case "timeline":
      return activity === null || !activity.trustworthy || activity.entries.length === 0
        ? ""
        : String(activity.entries.length);
    default:
      return "";
  }
}
