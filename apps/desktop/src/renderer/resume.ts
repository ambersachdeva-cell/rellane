/**
 * Where you were, so closing the lid is not the same as losing the thread.
 *
 * ## Why this exists
 *
 * The sentence that started the whole Case design was an accident:
 * *"sorry i by mistake turned off last session."* A night's work was in flight,
 * the window went away, and nothing had been written down about **where** it had
 * got to. The Case fixed the harder half — the transcript is in the book, so the
 * work itself survives. This is the easy half that makes the hard half felt:
 * the app opens on the thing you were doing rather than on its front page.
 *
 * ## It stores a place and an id, and nothing else
 *
 * Not the transcript, not a title, not a path. The renderer gets ids and
 * sentences (`DESIGN.md` §8), and the same rule holds for what it remembers
 * about itself. Everything needed to draw the room is read back from the book
 * with that id, so a stale pointer costs one lookup that returns nothing rather
 * than a screen drawn from a cache that has drifted.
 *
 * ## Every read and write is allowed to fail
 *
 * `localStorage` throws in a private window, in a thumbnailer, and under a
 * browser told to block site data. This is a convenience; a convenience that
 * can prevent the window drawing is a bug, and *"nothing at startup may block
 * the window"* is a house rule. So every path here returns a usable answer when
 * storage is missing, unreadable, or full of something nobody wrote.
 */

/** The places worth returning to. A drawer is not one of them. */
const RESUMABLE = new Set(["desk", "cases", "book", "agents", "work", "bench", "timeline"]);

const KEY = "cadrane.resume.v1";

export interface Resume {
  /** Where the owner was. Validated on read — a place that no longer exists is dropped. */
  readonly place: string | null;
  /** The case whose room was open, if one was. */
  readonly caseId: string | null;
}

export const NOTHING: Resume = Object.freeze({ place: null, caseId: null });

/** A shape guard rather than a cast: this string was last written by an older build. */
function parse(raw: string | null): Resume {
  if (raw === null || raw.length === 0) {
    return NOTHING;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Written by something else, or truncated. Not worth a diagnostic — the
    // honest response to an unreadable note about where you were is to open the
    // front door.
    return NOTHING;
  }
  if (typeof value !== "object" || value === null) {
    return NOTHING;
  }
  const record = value as Record<string, unknown>;
  const place = typeof record["place"] === "string" ? record["place"] : null;
  const caseId = typeof record["caseId"] === "string" ? record["caseId"] : null;

  return {
    // A place removed in a later version must not strand somebody on a screen
    // that no longer exists — the rail collapse ahead will remove several.
    place: place !== null && RESUMABLE.has(place) ? place : null,
    // Bounded, because this came off disk and is about to be sent over IPC.
    caseId: caseId !== null && caseId.length > 0 && caseId.length <= 64 ? caseId : null
  };
}

/** What the app should open on, or nothing. */
export function readResume(storage: Pick<Storage, "getItem"> | null): Resume {
  if (storage === null) {
    return NOTHING;
  }
  try {
    return parse(storage.getItem(KEY));
  } catch {
    return NOTHING;
  }
}

/** Remembers where the owner is. Silent when storage refuses; it is a convenience. */
export function writeResume(
  storage: Pick<Storage, "setItem"> | null,
  next: Resume
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(KEY, JSON.stringify({ place: next.place, caseId: next.caseId }));
  } catch {
    // Full, or blocked. Losing the pointer costs one extra click; throwing here
    // would cost the window.
  }
}

/** The storage the renderer actually has, or null when it has none. */
export function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
