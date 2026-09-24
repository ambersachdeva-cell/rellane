/**
 * The sandbox: which paths a tool may touch.
 *
 * A model proposing a path is not authorisation. Every filesystem access is
 * resolved to its real location on disk and checked against roots the user
 * explicitly granted. Nothing here trusts a string.
 *
 * The attack this exists to stop is not a malicious user — it is a model that
 * has read a prompt-injecting document and emits `../../.ssh/id_rsa` or a
 * symlink that points out of the workspace. Both are ordinary failure modes,
 * not exotic ones.
 */

import { realpath, lstat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

export type SandboxDenial =
  | "not-absolute"
  | "outside-roots"
  | "symlink-escape"
  | "sensitive-path"
  | "no-roots-granted";

export class SandboxError extends Error {
  constructor(
    readonly denial: SandboxDenial,
    message: string
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * Locations that are never grantable, even if the user asks.
 *
 * These hold credentials and keys. A skill has no legitimate reason to read
 * them, and the cost of being wrong once is unrecoverable — so this is a hard
 * floor under the grant system rather than a default that can be overridden.
 */
const NEVER: readonly string[] = Object.freeze([
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  "Library/Keychains",
  "Library/Application Support/com.apple.TCC",
  ".gemini",
  ".claude",
  ".npmrc",
  ".netrc"
]);

export interface Sandbox {
  /** Absolute, already-realpathed roots the user granted. Authoritative. */
  readonly roots: readonly string[];
  /**
   * The same roots as the user spelled them, before realpath.
   *
   * Kept because on macOS one directory has two valid spellings (/var and
   * /private/var), and telling a symlink escape apart from an out-of-bounds
   * request needs the pre-resolution form to compare against.
   */
  readonly spelledRoots: readonly string[];
}

/** Roots are realpathed once at grant time so later checks compare like with like. */
export async function createSandbox(grantedRoots: readonly string[]): Promise<Sandbox> {
  const roots: string[] = [];
  const spelledRoots: string[] = [];
  for (const root of grantedRoots) {
    if (!isAbsolute(root)) {
      throw new SandboxError("not-absolute", `A granted root must be an absolute path: ${root}`);
    }
    // Resolved *before* the sensitivity check, not after.
    //
    // A granted root that is itself a symlink — `/tmp/keys` pointing at
    // `~/.ssh` — passed a check made on the name it was given and then had its
    // real target added to the roots, which is the one thing `NEVER` exists to
    // make impossible.
    const real = await realpath(root).catch(() => resolve(root));
    if (isSensitive(root) || isSensitive(real)) {
      throw new SandboxError(
        "sensitive-path",
        `${root} holds credentials and can never be granted to a skill.`
      );
    }
    spelledRoots.push(resolve(root));
    roots.push(real);
  }
  return { roots: Object.freeze(roots), spelledRoots: Object.freeze(spelledRoots) };
}

function isSensitive(candidate: string): boolean {
  const home = homedir();
  const normalised = resolve(candidate);
  // macOS may spell the temporary home as /var/... while realpath returns
  // /private/var/.... Check both spellings against the credential denylist.
  const realHome = realpathSync(home, { encoding: "utf8" });
  return NEVER.some((entry) => {
    return [home, realHome].some((base) => {
      const banned = resolve(base, entry);
      return normalised === banned || isInside(banned, normalised);
    });
  });
}

/** True when `child` is `parent` or lives beneath it. Path-segment aware. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolves a candidate path for use, or throws.
 *
 * `mustExist` distinguishes reading from writing. A path being written to does
 * not exist yet, so its *parent* is what gets resolved and checked — which is
 * also what closes the "create a symlink then write through it" hole, because
 * the parent is real and its realpath is what we verify.
 */
export async function resolveInSandbox(
  sandbox: Sandbox,
  candidate: string,
  options: { mustExist: boolean }
): Promise<string> {
  if (sandbox.roots.length === 0) {
    throw new SandboxError(
      "no-roots-granted",
      "No folder has been granted yet. Grant one before running a skill that touches files."
    );
  }
  if (!isAbsolute(candidate)) {
    throw new SandboxError(
      "not-absolute",
      `Paths must be absolute so they cannot be reinterpreted: ${candidate}`
    );
  }
  if (isSensitive(candidate)) {
    throw new SandboxError(
      "sensitive-path",
      `${candidate} holds credentials and is never readable by a skill.`
    );
  }

  const requested = resolve(candidate);

  // Resolve before comparing. Roots were realpathed at grant time, and on macOS
  // the same directory has two spellings — /var is a symlink to /private/var —
  // so a lexical check against an unresolved candidate produces false denials
  // for perfectly legitimate paths.
  const real = options.mustExist
    ? await realpath(requested).catch(() => {
        throw new SandboxError("outside-roots", `${requested} does not exist.`);
      })
    : await resolveParentReal(requested);

  if (!sandbox.roots.some((root) => isInside(root, real))) {
    // Distinguish "you asked for somewhere else" from "this looked fine until
    // it was followed". Only the second is a symlink escape, and the two want
    // different words in front of a user.
    const lexicallyInside = sandbox.spelledRoots.some((root) => isInside(root, requested));
    throw lexicallyInside
      ? new SandboxError(
          "symlink-escape",
          `${candidate} resolves to ${real}, which is outside every folder you have granted.`
        )
      : new SandboxError(
          "outside-roots",
          `${requested} is outside every folder you have granted.`
        );
  }

  if (isSensitive(real)) {
    throw new SandboxError("sensitive-path", `${candidate} resolves into a credential store.`);
  }

  return real;
}

/** Realpath of the parent, with the final segment appended unresolved. */
async function resolveParentReal(target: string): Promise<string> {
  const parts = target.split(sep);
  const leaf = parts.pop() ?? "";
  const parent = parts.join(sep) || sep;
  const realParent = await realpath(parent).catch(() => {
    throw new SandboxError("outside-roots", `The folder for ${target} does not exist.`);
  });
  const joined = resolve(realParent, leaf);

  /**
   * The leaf may already exist, and it may be a symlink.
   *
   * This function is for paths being *written*, and it resolved only the
   * parent on the assumption that the leaf does not exist yet. When it does —
   * planted as a symlink to somewhere outside — the returned path was the
   * unresolved link, the root check passed on the parent, and a write followed
   * the link straight out of the sandbox.
   *
   * The docstring above this function's caller has claimed since it was written
   * that resolving the parent "closes the create-a-symlink-then-write-through-it
   * hole". It did not. Returning the fully resolved path makes the ordinary root
   * check the thing that catches it, which is where that decision belongs.
   */
  const link = await lstat(joined).catch(() => null);
  if (link?.isSymbolicLink() === true) {
    return realpath(joined).catch(() => {
      throw new SandboxError("symlink-escape", `${joined} is a link that does not resolve.`);
    });
  }
  return joined;
}

/**
 * Refuses a path that is a symlink, for operations where following one would be
 * surprising — deleting or overwriting, in particular.
 */
export async function assertNotSymlink(target: string): Promise<void> {
  const info = await lstat(target).catch(() => null);
  if (info?.isSymbolicLink() === true) {
    throw new SandboxError(
      "symlink-escape",
      `${target} is a link, not a real file. Rellane will not write through links.`
    );
  }
}

/** Default grants offered during onboarding. Never applied without a click. */
export function suggestedRoots(): readonly string[] {
  const home = homedir();
  return Object.freeze([resolve(home, "Downloads"), resolve(home, "Desktop"), resolve(home, "Documents")]);
}
