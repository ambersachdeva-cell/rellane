/**
 * Skills as folders.
 *
 * A skill is a directory with a `skill.json` beside whatever it needs. That
 * shape is deliberate: it can be read, diffed, versioned, and sent to someone
 * over AirDrop without a marketplace, an account, or a server.
 *
 * The manifest is parsed defensively because a skill may arrive from another
 * person. Every field is validated, anything unrecognised is refused rather
 * than ignored, and the permissions a skill asks for are surfaced *before* it
 * is installed — the install dialogue's whole job is to show what this folder
 * will be allowed to do.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { AUTONOMY_ORDER, HARD_CEILING, type Autonomy, type RiskClass } from "../tools/types.js";

export interface SkillManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** Who made it. Shown at install; never used as authorisation. */
  readonly author: string;
  /** Tools it will call. Anything not listed is refused at run time. */
  readonly tools: readonly string[];
  /** What it asks to do without being asked, per risk class. */
  readonly autonomy: Readonly<Partial<Record<RiskClass, Autonomy>>>;
  /** Words that should surface it in the overlay. */
  readonly triggers: readonly string[];
  /** When it should run by itself, if ever. */
  readonly watch: WatchTrigger | null;
}

export type WatchTrigger =
  | { readonly kind: "folder"; readonly path: string; readonly settleMs: number }
  | { readonly kind: "schedule"; readonly hour: number; readonly minute: number }
  | { readonly kind: "message" };

export type ManifestProblem = { readonly field: string; readonly problem: string };

const ID = /^[a-z][a-z0-9-]{1,40}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Parses a manifest, collecting every problem rather than stopping at the first.
 *
 * A person installing someone else's skill deserves the whole list at once, not
 * a sequence of one-at-a-time refusals.
 */
export function parseManifest(
  raw: unknown
): { ok: true; manifest: SkillManifest } | { ok: false; problems: readonly ManifestProblem[] } {
  const problems: ManifestProblem[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: [{ field: "skill.json", problem: "This is not a skill manifest." }] };
  }
  const input = raw as Record<string, unknown>;

  const id = asString(input["id"]);
  if (id === null || !ID.test(id)) {
    problems.push({ field: "id", problem: "Must be lowercase letters, numbers and hyphens." });
  }
  const name = asString(input["name"]);
  if (name === null) {
    problems.push({ field: "name", problem: "A skill needs a name." });
  }
  const version = asString(input["version"]);
  if (version === null || !VERSION.test(version)) {
    problems.push({ field: "version", problem: "Must look like 1.0.0." });
  }

  const tools = asStringArray(input["tools"]);
  if (tools.length === 0) {
    problems.push({ field: "tools", problem: "A skill that calls no tools cannot do anything." });
  }

  const autonomy: Partial<Record<RiskClass, Autonomy>> = {};
  const rawAutonomy = input["autonomy"];
  if (typeof rawAutonomy === "object" && rawAutonomy !== null) {
    for (const [risk, level] of Object.entries(rawAutonomy as Record<string, unknown>)) {
      if (!(risk in HARD_CEILING)) {
        problems.push({ field: `autonomy.${risk}`, problem: `There is no risk class called “${risk}”.` });
        continue;
      }
      if (typeof level !== "string" || !AUTONOMY_ORDER.includes(level as Autonomy)) {
        problems.push({ field: `autonomy.${risk}`, problem: `“${String(level)}” is not a level.` });
        continue;
      }
      autonomy[risk as RiskClass] = level as Autonomy;
    }
  }

  const watch = parseWatch(input["watch"], problems);

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    manifest: {
      id: id as string,
      name: name as string,
      description: asString(input["description"]) ?? "",
      version: version as string,
      author: asString(input["author"]) ?? "unknown",
      tools,
      autonomy,
      triggers: asStringArray(input["triggers"]),
      watch
    }
  };
}

function parseWatch(raw: unknown, problems: ManifestProblem[]): WatchTrigger | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "object") {
    problems.push({ field: "watch", problem: "Not a trigger." });
    return null;
  }
  const input = raw as Record<string, unknown>;
  switch (input["kind"]) {
    case "folder": {
      const path = asString(input["path"]);
      if (path === null || !path.startsWith("/")) {
        problems.push({ field: "watch.path", problem: "Must be an absolute path." });
        return null;
      }
      // A settle delay stops a skill firing once per file during a large copy.
      const settle = typeof input["settleMs"] === "number" ? input["settleMs"] : 5_000;
      return { kind: "folder", path, settleMs: Math.min(Math.max(settle, 1_000), 300_000) };
    }
    case "schedule": {
      const hour = input["hour"];
      const minute = input["minute"];
      if (typeof hour !== "number" || hour < 0 || hour > 23) {
        problems.push({ field: "watch.hour", problem: "Must be 0–23." });
        return null;
      }
      if (typeof minute !== "number" || minute < 0 || minute > 59) {
        problems.push({ field: "watch.minute", problem: "Must be 0–59." });
        return null;
      }
      return { kind: "schedule", hour, minute };
    }
    case "message":
      return { kind: "message" };
    default:
      problems.push({ field: "watch.kind", problem: `Unknown trigger “${String(input["kind"])}”.` });
      return null;
  }
}

/**
 * What installing this skill would permit, in the owner's words.
 *
 * Shown before install. The hard ceiling is applied here too, so a manifest
 * asking for more than the platform allows is displayed at what it will
 * actually get rather than at what it requested.
 */
export function describePermissions(manifest: SkillManifest): readonly string[] {
  const words: Readonly<Record<RiskClass, string>> = {
    read: "read files in the folders you grant",
    write: "move and change files in those folders",
    network: "fetch things from the internet",
    outbound: "send messages or data to other people",
    shell: "run commands on your Mac"
  };

  const lines: string[] = [];
  for (const [risk, requested] of Object.entries(manifest.autonomy) as [RiskClass, Autonomy][]) {
    if (requested === "off") {
      continue;
    }
    const ceiling = HARD_CEILING[risk];
    const effective =
      AUTONOMY_ORDER.indexOf(requested) <= AUTONOMY_ORDER.indexOf(ceiling) ? requested : ceiling;
    const qualifier =
      effective === "auto"
        ? "without asking"
        : effective === "confirm"
          ? "after asking you each time"
          : "and show you a draft first";

    /**
     * Say when a skill asked for more than it can have.
     *
     * Showing only the *effective* permission is accurate and incomplete: a
     * skill requesting `auto` on something locked to `confirm` gets confirm
     * either way, and the owner would never learn it tried. That reach is worth
     * knowing about — it is the difference between a skill that fits the rules
     * and one that would ignore them given the chance.
     */
    lines.push(
      effective === requested
        ? `It can ${words[risk]} ${qualifier}.`
        : // Deliberately never repeats the phrase it was refused. Writing "it
          // can send messages … without asking, but it asked for that" puts the
          // exact sentence the owner must not come away with into the line —
          // and a person skimming reads the first half. An existing test guards
          // this, correctly.
          `It can ${words[risk]} ${qualifier}. It asked for more than that, and Rellane does not allow it.`
    );
  }
  if (manifest.watch !== null) {
    lines.push(describeWatch(manifest.watch));
  }
  return lines.length === 0 ? ["It does nothing on its own."] : lines;
}

export function describeWatch(watch: WatchTrigger): string {
  switch (watch.kind) {
    case "folder":
      return `It runs by itself when ${watch.path} changes.`;
    case "schedule":
      return `It runs by itself every day at ${String(watch.hour).padStart(2, "0")}:${String(
        watch.minute
      ).padStart(2, "0")}.`;
    case "message":
      return "It runs when you message Mark.";
  }
}

/** Reads every skill folder under a directory, reporting the broken ones. */
export async function loadSkills(directory: string): Promise<{
  readonly loaded: readonly SkillManifest[];
  readonly rejected: readonly { folder: string; problems: readonly ManifestProblem[] }[];
}> {
  const loaded: SkillManifest[] = [];
  const rejected: { folder: string; problems: readonly ManifestProblem[] }[] = [];

  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const folder = join(directory, entry.name);
    const file = join(folder, "skill.json");
    if (!(await stat(file).then(() => true).catch(() => false))) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      rejected.push({ folder, problems: [{ field: "skill.json", problem: "Not valid JSON." }] });
      continue;
    }
    const result = parseManifest(parsed);
    if (result.ok) {
      loaded.push(result.manifest);
    } else {
      rejected.push({ folder, problems: result.problems });
    }
  }
  return { loaded, rejected };
}
