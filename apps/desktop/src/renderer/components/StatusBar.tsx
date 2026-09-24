/**
 * The strip along the bottom: what is true right now, always in the same place.
 *
 * ## Why a strip rather than a panel
 *
 * These four facts used to be tiles near the top of Home, which meant they were
 * only true on Home. You would go into Agents, or the Bench, and lose sight of
 * whether anything was connected — so the answer to *"is this working?"* was
 * somewhere you had to navigate back to. State that changes under you belongs in
 * chrome, not in a page.
 *
 * ## The one that takes colour
 *
 * Bills past their date, and only when there are some. Everything else here is
 * ink, because a strip where four things are highlighted has highlighted
 * nothing (D-027). This is also the *only* money on the shell: the total
 * outstanding is a figure you go and read in Records, not one that follows you
 * around the room. A number nobody can act on is decoration, and a number you
 * cannot get away from is worse than decoration.
 *
 * Every item is a button through to the screen that measured it, which is task
 * 1.2's rule applied to chrome: a claim you cannot trace is one nobody checked.
 *
 * ## It says nothing on a first morning
 *
 * A fact that follows you around is worth its space once you have asked the
 * product for something. Before that it is four answers to questions nobody has
 * put, one of which — "Folder access none granted" — reads as a prerequisite,
 * on the one screen whose whole argument is that there is nothing to set up.
 */

import type { ActivityLog, AgentCard, BookStanding, EngineRoomStatus } from "@cadrane/contracts";
import { plural } from "../../shared/copy.js";
import { facts } from "../home-facts";
import type { Place } from "../navigation";

export function StatusBar({
  book,
  engines,
  agents,
  activity,
  folders,
  onGo,
  onOpenPalette,
  freshBook
}: {
  book: BookStanding | null;
  engines: EngineRoomStatus | null;
  agents: readonly AgentCard[] | null;
  activity: ActivityLog | null;
  folders: readonly string[];
  onGo(place: Place): void;
  onOpenPalette(): void;
  /** Nobody has put anything here yet. Null until the first read lands. */
  freshBook: boolean | null;
}) {
  const late = book?.overdue.length ?? 0;

  return (
    <footer className="status" aria-label="Status">
      {/* Four true and useless claims on somebody's first morning. "Folder
          access none granted" reads as a prerequisite to somebody who has come
          to quote a job, and the first-run screen forty pixels above is the
          product promising there is nothing to set up. The strip keeps its
          place so the window does not change height when the answer arrives. */}
      {freshBook === true ? null : facts(engines, folders, agents, activity).map((fact) => (
        <button
          key={fact.label}
          type="button"
          className={fact.wanting ? "status__item status__item--wanting" : "status__item"}
          onClick={() => onGo(fact.go)}
        >
          <span className="status__label">{fact.label}</span>
          <span className="status__value">{fact.value}</span>
        </button>
      ))}

      {late === 0 ? null : (
        <button
          type="button"
          className="status__item status__item--late"
          onClick={() => onGo("book")}
        >
          <span className="status__label">Past the date</span>
          <span className="status__value">{plural(late, "bill")}</span>
        </button>
      )}

      {/* Pushed to the right, where a hint belongs: available, not insistent. */}
      <button type="button" className="status__hint" onClick={onOpenPalette}>
        <span className="status__key">⌘K</span>
        anything
      </button>
    </footer>
  );
}
