/**
 * Where Rellane keeps its things, decided once and never again by accident.
 *
 * Electron derives `userData` from the `name` field in package.json — which was
 * `@switchboard/desktop` and is now `@cadrane/desktop`. Every record this product has — the book, the
 * settings, the contacts, the connector approvals, the agents the owner wrote,
 * the key their backups are encrypted with — lives under a directory named
 * after a package.
 *
 * Which means **renaming the package silently moves all of it.** The app would
 * start, find an empty directory, and behave exactly like a fresh install: no
 * error, no warning, and a first run that looks completely normal. For a
 * business's ledger that is the worst failure mode there is, and it is one
 * `git mv` away at all times.
 *
 * So the location is pinned to a name of our own choosing, and anything already
 * at the old address is moved across once.
 *
 * ## The move is safe or it does not happen
 *
 * `rename` within a volume is atomic: either the whole directory is at the new
 * address or it is still entirely at the old one. There is no state where half
 * the records moved.
 *
 * And if it fails for any reason — a different volume, a permission problem, a
 * file held open — the app **keeps using the old location** rather than starting
 * empty. A migration that cannot complete must leave the owner exactly where
 * they were, never somewhere new and blank.
 */

import { isAbsolute, join } from "node:path";
import { rename, stat } from "node:fs/promises";
import { diagnostics } from "./diagnostics.js";

/**
 * The directory name, fixed.
 *
 * Not derived from anything. That is the entire point: no rename, no scope
 * change and no packaging setting can move the owner's records again.
 *
 * **It says "Cadrane" and the product is called Rellane, and that is correct.**
 * This is an address, not a name. Somebody's book is sitting at this path on a
 * real Mac right now; changing the string here does not rename that directory,
 * it points the app at a different one that does not exist — a first run that
 * looks completely normal with the business's whole ledger gone. The product
 * was renamed on 13 September 2026 (D-113) and this line deliberately was not.
 * If it ever must change, it changes by being added to `FORMER_DIR_NAMES` and
 * migrated, never by being edited.
 */
export const HOME_DIR_NAME = "Cadrane";

/**
 * Directories this app has used before, newest first.
 *
 * **These are historical facts about what is on disk, not package references.**
 * A find-and-replace across the tree renaming `@switchboard/*` to `@cadrane/*`
 * rewrote this line and silently broke the migration — the directory sitting on
 * somebody's Mac is still called `@switchboard/desktop`, whatever the packages
 * are called now. It is spelled in pieces so the same sweep cannot touch it
 * again, and the test below asserts the assembled value.
 */
const LEGACY_SCOPE = ["@", "switchboard"].join("");
export const FORMER_DIR_NAMES: readonly string[] = [`${LEGACY_SCOPE}/desktop`];

/**
 * The one way to run against a different set of records.
 *
 * It exists because there was no way at all, and that turned out to matter. On
 * macOS Electron derives `appData` from the account's real home — not from
 * `$HOME`, which it ignores — and `index.ts` overwrites `userData` from
 * `appData` before anything reads it, so Chromium's own `--user-data-dir` is
 * ignored too. The consequence is worth stating plainly: **there was no way to
 * open this app on anything except the owner's live book.** A first-run
 * experience could not be tried without destroying the records that prove it
 * works, so plan task 4.4 had no instrument.
 *
 * An absolute path only. A relative one resolves against whatever directory the
 * app happened to be started from — a double-click, a terminal, a launch agent
 * all differ — so it would name a different place depending on how the app was
 * opened, which for a ledger is worse than not working.
 *
 * This does not weaken anything. A process that can set an environment variable
 * on this app can already read every file the app can read; the records are
 * protected by the disk and the Keychain, not by being hard to address.
 */
export const HOME_OVERRIDE_VAR = "CADRANE_HOME";

function overriddenHome(): string | null {
  const raw = process.env[HOME_OVERRIDE_VAR]?.trim();
  if (raw === undefined || raw === "") {
    return null;
  }
  if (!isAbsolute(raw)) {
    diagnostics.warn("home", "ignoring a relative records path", { [HOME_OVERRIDE_VAR]: raw });
    return null;
  }
  return raw;
}

/**
 * Whether a directory is there — distinguishing "absent" from "unreadable".
 *
 * Swallowing every `stat` error conflated the two, and the consequence landed
 * exactly where this module is supposed to protect: a legacy directory that
 * existed but could not be read (`EACCES`, `EPERM`, a disk not yet mounted) was
 * treated as absent, so the migration never fired and the app started on an
 * empty home — a normal-looking first run with the ledger still on disk,
 * untouched and unreachable.
 *
 * `"unknown"` is therefore its own answer, and the caller treats it as "do not
 * move anything and do not assume this is a fresh install".
 */
async function directoryState(path: string): Promise<"yes" | "no" | "unknown"> {
  try {
    return (await stat(path)).isDirectory() ? "yes" : "no";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "no" : "unknown";
  }
}

/**
 * Works out where the records should live, moving them if they are elsewhere.
 *
 * `appSupport` is the platform's application-support directory — passed in
 * rather than read from Electron so this is testable without a running app.
 *
 * Returns the path to use. On any failure that path is the old one, because
 * continuing to work beats a tidy layout.
 */
export async function resolveHome(appSupport: string): Promise<string> {
  const override = overriddenHome();
  if (override !== null) {
    // No migration and no legacy sweep. Somebody who named a directory meant
    // that directory, and moving records into it from elsewhere is the one thing
    // a person pointing at a scratch location does not want.
    diagnostics.warn("home", "records are at an overridden location", { home: override });
    return override;
  }

  const home = join(appSupport, HOME_DIR_NAME);

  if ((await directoryState(home)) === "yes") {
    return home;
  }

  for (const former of FORMER_DIR_NAMES) {
    const old = join(appSupport, former);
    const state = await directoryState(old);
    if (state === "no") {
      continue;
    }
    if (state === "unknown") {
      // Something is there and we cannot read it. Using it is the safe answer:
      // the app will fail loudly on a locked directory, where starting fresh
      // would fail silently and look completely normal.
      diagnostics.warn("home", "could not inspect the old records; using them anyway", {
        from: former
      });
      return old;
    }
    try {
      // Atomic within a volume: every record arrives, or none does.
      await rename(old, home);
      diagnostics.info("home", "moved the records to their permanent location", {
        from: former,
        to: HOME_DIR_NAME
      });
      return home;
    } catch (error) {
      // Staying put is the safe failure. Starting fresh would look to the owner
      // exactly like a working first run, with everything gone.
      diagnostics.warn("home", "could not move the records, continuing where they are", {
        from: former,
        error: error instanceof Error ? error.message : "unknown"
      });
      return old;
    }
  }

  // Nothing anywhere: a genuine first run.
  return home;
}
