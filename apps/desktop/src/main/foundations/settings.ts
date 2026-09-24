/**
 * Settings, window state, and schema migration.
 *
 * Unglamorous and load-bearing. The failure this file exists to prevent is the
 * one that costs a user everything: the app auto-updates overnight, the new
 * version cannot read the old settings, and it crashes on launch forever.
 *
 * So: every read is defensive, every unknown value falls back to a safe
 * default rather than throwing, and a file that cannot be understood is kept
 * rather than deleted. Losing someone's configuration because we could not
 * parse it is not our call to make.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Bumped only when a migration is written for it. */
export const SETTINGS_VERSION = 1;

export interface WindowState {
  readonly width: number;
  readonly height: number;
  readonly x: number | null;
  readonly y: number | null;
  readonly maximised: boolean;
}

export interface Consent {
  /** Crash reports. On by default: it is the only way a crash reaches us. */
  readonly crashReports: boolean;
  /** Anonymous counts of which skills run. Off until asked. */
  readonly usageCounts: boolean;
  /**
   * Keeping corrections to improve accuracy. Off, always, until explicitly
   * granted — this is the one that touches the content of someone's work.
   */
  readonly improveFromCorrections: boolean;
  /**
   * Whether the owner has been told what macOS is about to ask, and why.
   *
   * Recorded so it is said **once**. An explanation repeated before every grant
   * becomes a dialog people dismiss without reading, which is the same as not
   * having explained anything — and the point of a pre-flight is that the OS
   * prompt is never the first anybody hears of it.
   */
  readonly foldersExplained: boolean;
}

/**
 * Someone this Mac may contact, and may take instructions from.
 *
 * One list for both directions (D-035): on a personal Mac the people you will
 * message and the people who may ask you for things are the same people, and two
 * lists would drift until one of them was wrong in the permissive direction.
 */
export interface Contact {
  readonly channel: "telegram" | "whatsapp" | "email";
  readonly address: string;
  readonly label: string;
}

/** A connector the owner installed, and the tools they have read and approved. */
export interface McpServerSetting {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface McpApprovalSetting {
  readonly serverId: string;
  readonly toolName: string;
  /** Pins the approval to what was approved. A changed description lapses it. */
  readonly descriptionHash: string;
}

/**
 * A brief the owner wrote, as stored.
 *
 * Deliberately loose: it is JSON on disk, hand-editable and restorable from an
 * old backup, so it is rebuilt through `newBrief()` on the way out rather than
 * trusted as written (see `agents/roster.ts`).
 */
export interface StoredAgent {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly instructions?: string;
  readonly folders?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly tier?: string;
  readonly maxSteps?: number;
  readonly maxMinutes?: number;
  readonly outbound?: string;
}

/**
 * The backup schedule, and what actually happened last time.
 *
 * `lastSucceededAt` is written only after an archive has been restored into a
 * temp copy and opened. A timestamp recorded on "the file was written" would be
 * the exact lie this feature exists to avoid.
 */
export interface BackupSettings {
  readonly cadence: "off" | "daily" | "weekly";
  readonly destination: string | null;
  readonly lastSucceededAt: string | null;
  readonly lastProblem: string | null;
}

export interface Settings {
  readonly version: number;
  readonly theme: "system" | "light" | "dark";
  readonly overlayHotkey: string;
  readonly pasteHotkey: string;
  readonly grantedRoots: readonly string[];
  /**
   * Granted folders the owner has paused.
   *
   * Not a revoke: the grant, the watch history and the folder itself all stay.
   * What stops is Rellane *looking* — nothing from a paused folder is captured,
   * and nothing from it reaches a model, by context or by tool. Kept separate
   * from `grantedRoots` so that turning it back on does not mean walking through
   * the Finder picker again, which is the reason people leave things switched on
   * that they would rather not.
   */
  readonly pausedRoots: readonly string[];
  /**
   * How the owner signs a reminder, and where a payment should go.
   *
   * Their own UPI id and their own trading name. Money never passes through
   * Rellane — a customer paying a reminder pays the owner directly, exactly as
   * they would if they had typed the id themselves.
   */
  readonly trading: { readonly name: string; readonly upiId: string };
  /** Empty means this Mac contacts nobody and obeys nobody. That is the default. */
  readonly contacts: readonly Contact[];
  /** Installed connectors. Empty means no third-party code runs at all. */
  readonly connectors: readonly McpServerSetting[];
  /** Per-tool approvals. A tool absent from here cannot be called (D-039). */
  readonly approvals: readonly McpApprovalSetting[];
  /** Agents the owner wrote. The three that ship are not stored here. */
  readonly agents: readonly StoredAgent[];
  readonly backup: BackupSettings;
  readonly window: WindowState;
  readonly consent: Consent;
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  version: SETTINGS_VERSION,
  theme: "system" as const,
  overlayHotkey: "Alt+Space",
  pasteHotkey: "Alt+V",
  grantedRoots: Object.freeze([]),
  pausedRoots: Object.freeze([]),
  trading: Object.freeze({ name: "", upiId: "" }),
  contacts: Object.freeze([]),
  connectors: Object.freeze([]),
  approvals: Object.freeze([]),
  agents: Object.freeze([]),
  // Off until the owner picks somewhere. Choosing where to write their business
  // records is not a decision to make on their behalf.
  backup: Object.freeze({
    cadence: "off" as const,
    destination: null,
    lastSucceededAt: null,
    lastProblem: null
  }),
  window: Object.freeze({ width: 1180, height: 820, x: null, y: null, maximised: false }),
  consent: Object.freeze({
    crashReports: true,
    usageCounts: false,
    improveFromCorrections: false,
    foldersExplained: false
  })
});

/** A window smaller than this is unusable; larger than this is a corrupt value. */
const MIN_DIMENSION = 480;
const MAX_DIMENSION = 20_000;

/**
 * Reads the backup block, failing to "off" rather than to a schedule.
 *
 * An unreadable value must not become a working schedule pointed somewhere
 * nobody chose — and it must not become a *claimed* last-success either, which
 * would tell the owner their data is safe on the strength of a corrupt file.
 */
function readBackup(raw: unknown): Settings["backup"] {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_SETTINGS.backup;
  }
  const input = raw as Record<string, unknown>;
  const cadence = input["cadence"];
  const destination = input["destination"];
  const last = input["lastSucceededAt"];
  const problem = input["lastProblem"];

  return {
    cadence: cadence === "daily" || cadence === "weekly" ? cadence : "off",
    destination:
      typeof destination === "string" && destination.startsWith("/") ? destination : null,
    lastSucceededAt: typeof last === "string" && last.length > 0 ? last : null,
    lastProblem: typeof problem === "string" && problem.length > 0 ? problem : null
  };
}

function clamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_DIMENSION && value <= MAX_DIMENSION
    ? Math.round(value)
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Coerces whatever is on disk into valid settings.
 *
 * Field by field rather than whole-object, so one bad value costs one field
 * instead of the entire file. A window position from a monitor that is no
 * longer attached is the common real case.
 */
/** A bounded string, or empty. Never a partially-understood value. */
function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * The two fields a renderer is not allowed to decide.
 *
 * `coerce` keeps the settings file loadable; it was never an authority on who
 * may read what, and it does not claim to be — any string beginning with "/" is
 * a well-formed granted root as far as it is concerned. That was enough to make
 * `settingsWrite` a privilege escalation: a compromised renderer wrote
 * `grantedRoots: ["/"]`, the store accepted the shape, and on the next launch
 * the startup restore called `skillHost.grant` on every entry in the file. A
 * folder nobody picked became a folder Rellane may read, and it survived a
 * restart — which is worse than an in-session escape, because it outlives the
 * compromise that created it.
 *
 * **Which folders are granted is decided by the OS picker and held by
 * `skillHost`.** Both lists are taken from what is already on disk and whatever
 * arrived is discarded — a floor rather than a check, so there is no value a
 * renderer can send that moves them. Pausing and revoking still work: both are
 * main-process paths that go through `update`, and neither passes through here.
 */
export function withHeldGrants(incoming: unknown, authority: Settings): unknown {
  return {
    ...(typeof incoming === "object" && incoming !== null ? incoming : {}),
    grantedRoots: authority.grantedRoots,
    pausedRoots: authority.pausedRoots
  };
}

export function coerce(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_SETTINGS;
  }
  const input = raw as Record<string, unknown>;
  const window = (input["window"] ?? {}) as Record<string, unknown>;
  const consent = (input["consent"] ?? {}) as Record<string, unknown>;
  const theme = input["theme"];
  const roots = input["grantedRoots"];
  const paused = input["pausedRoots"];

  return {
    version: SETTINGS_VERSION,
    theme: theme === "light" || theme === "dark" ? theme : "system",
    overlayHotkey:
      typeof input["overlayHotkey"] === "string" && input["overlayHotkey"].length > 0
        ? input["overlayHotkey"]
        : DEFAULT_SETTINGS.overlayHotkey,
    pasteHotkey:
      typeof input["pasteHotkey"] === "string" && input["pasteHotkey"].length > 0
        ? input["pasteHotkey"]
        : DEFAULT_SETTINGS.pasteHotkey,
    grantedRoots: Array.isArray(roots)
      ? roots.filter((root): root is string => typeof root === "string" && root.startsWith("/"))
      : [],
    // A malformed entry here fails *safe* in the same direction as everything
    // else: dropped, so the folder is watched again rather than silently paused
    // forever with no way to see why.
    pausedRoots: Array.isArray(paused)
      ? paused.filter((root): root is string => typeof root === "string" && root.startsWith("/"))
      : [],
    trading: {
      name: text(((input["trading"] ?? {}) as Record<string, unknown>)["name"], 80),
      // An unreadable id becomes empty, which means no payment link rather than
      // a link pointing somewhere nobody checked.
      upiId: text(((input["trading"] ?? {}) as Record<string, unknown>)["upiId"], 80)
    },
    // Anything malformed is dropped rather than repaired. A half-understood
    // entry in a list that decides who may operate this Mac must not survive as
    // a guess — the cost of dropping one is retyping a contact, and the cost of
    // keeping a wrong one is a stranger on the list.
    contacts: Array.isArray(input["contacts"])
      ? input["contacts"].filter((entry): entry is Contact => {
          if (typeof entry !== "object" || entry === null) {
            return false;
          }
          const candidate = entry as Record<string, unknown>;
          return (
            (candidate["channel"] === "telegram" ||
              candidate["channel"] === "whatsapp" ||
              candidate["channel"] === "email") &&
            typeof candidate["address"] === "string" &&
            candidate["address"].length > 0 &&
            typeof candidate["label"] === "string"
          );
        })
      : [],
    // Same discipline as contacts: anything malformed is dropped, never
    // repaired. A half-understood connector entry decides what third-party code
    // runs, and a guess there is not recoverable.
    connectors: Array.isArray(input["connectors"])
      ? input["connectors"].filter((entry): entry is McpServerSetting => {
          if (typeof entry !== "object" || entry === null) {
            return false;
          }
          const candidate = entry as Record<string, unknown>;
          return (
            typeof candidate["id"] === "string" &&
            candidate["id"].length > 0 &&
            typeof candidate["label"] === "string" &&
            typeof candidate["command"] === "string" &&
            candidate["command"].length > 0 &&
            Array.isArray(candidate["args"]) &&
            candidate["args"].every((arg) => typeof arg === "string")
          );
        })
      : [],
    approvals: Array.isArray(input["approvals"])
      ? input["approvals"].filter((entry): entry is McpApprovalSetting => {
          if (typeof entry !== "object" || entry === null) {
            return false;
          }
          const candidate = entry as Record<string, unknown>;
          // A missing hash is not "approved without a pin" — it is dropped.
          // Treating it as a wildcard would make every lapsed approval valid
          // again, which is the exact attack the pin exists to stop.
          return (
            typeof candidate["serverId"] === "string" &&
            candidate["serverId"].length > 0 &&
            typeof candidate["toolName"] === "string" &&
            candidate["toolName"].length > 0 &&
            typeof candidate["descriptionHash"] === "string" &&
            candidate["descriptionHash"].length > 0
          );
        })
      : [],
    // Only the two fields without which a brief is meaningless are required.
    // Everything else is repaired by `rehydrate`, which applies the same
    // clamping a brief written in code gets — so a lenient shape here is safe
    // and a strict one would discard recoverable work.
    agents: Array.isArray(input["agents"])
      ? input["agents"].filter((entry): entry is StoredAgent => {
          if (typeof entry !== "object" || entry === null) {
            return false;
          }
          const candidate = entry as Record<string, unknown>;
          return (
            typeof candidate["id"] === "string" &&
            candidate["id"].length > 0 &&
            typeof candidate["name"] === "string" &&
            candidate["name"].trim().length > 0
          );
        })
      : [],
    backup: readBackup(input["backup"]),
    window: {
      width: clamp(window["width"], DEFAULT_SETTINGS.window.width),
      height: clamp(window["height"], DEFAULT_SETTINGS.window.height),
      x: typeof window["x"] === "number" && Number.isFinite(window["x"]) ? Math.round(window["x"]) : null,
      y: typeof window["y"] === "number" && Number.isFinite(window["y"]) ? Math.round(window["y"]) : null,
      maximised: bool(window["maximised"], false)
    },
    consent: {
      crashReports: bool(consent["crashReports"], DEFAULT_SETTINGS.consent.crashReports),
      usageCounts: bool(consent["usageCounts"], false),
      // Never inherits a truthy default. If the stored value is not exactly
      // `true`, the answer is no.
      improveFromCorrections: consent["improveFromCorrections"] === true,
      // Same discipline, opposite consequence: an unreadable value means the
      // explanation is shown again. Showing it twice costs a click; skipping it
      // means the OS prompt is the first anybody hears of it.
      foldersExplained: consent["foldersExplained"] === true
    }
  };
}

/**
 * Migrates older settings forward.
 *
 * There is only one version so far, so this is a placeholder with real
 * behaviour: an unrecognised or future version is coerced rather than
 * rejected, which is what stops a downgrade from bricking the app.
 */
export function migrate(raw: unknown): { settings: Settings; migratedFrom: number | null } {
  const version =
    typeof raw === "object" && raw !== null && typeof (raw as { version?: unknown }).version === "number"
      ? (raw as { version: number }).version
      : null;

  return {
    settings: coerce(raw),
    migratedFrom: version !== null && version !== SETTINGS_VERSION ? version : null
  };
}

export class SettingsStore {
  private readonly file: string;
  private cache: Settings | null = null;

  constructor(directory: string) {
    this.file = join(directory, "settings.json");
  }

  async read(): Promise<Settings> {
    if (this.cache !== null) {
      return this.cache;
    }
    /**
     * Only a *missing* file means defaults.
     *
     * This used to swallow every error. A transient EACCES, EBUSY or EIO would
     * be read as "no settings yet", the cache would become DEFAULT_SETTINGS, and
     * the next write would erase the owner's contacts and connector approvals
     * from disk permanently — silent data loss from a temporary condition.
     */
    const raw = await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (raw === null) {
      this.cache = DEFAULT_SETTINGS;
      return this.cache;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unreadable settings are kept, not overwritten. The user may have hand
      // edited them, and a backup is worth more than a clean slate.
      await rename(this.file, `${this.file}.unreadable`).catch(() => undefined);
      this.cache = DEFAULT_SETTINGS;
      return this.cache;
    }
    this.cache = migrate(parsed).settings;
    return this.cache;
  }

  async write(next: Settings): Promise<void> {
    const settings = coerce(next);
    await mkdir(dirname(this.file), { recursive: true });
    // Written to a sibling and moved into place, so a crash mid-write leaves
    // the previous file intact rather than a truncated one.
    const temporary = `${this.file}.writing`;
    await writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
    this.cache = settings;
  }

  async update(change: (current: Settings) => Settings): Promise<Settings> {
    const next = change(await this.read());
    await this.write(next);
    // What was actually stored, not what was asked for. Returning `next`
    // handed back the *uncoerced* object while disk and cache held the coerced
    // one — so a caller that kept the result was working from a shape the app
    // had already rejected, and the divergence would surface much later as a
    // setting that "did not save".
    return this.read();
  }
}
