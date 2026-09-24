/**
 * Which build this is, and what changing it would cost.
 *
 * ## It never updates itself
 *
 * A product that can replace its own binary can replace it with anything, and
 * every promise this one makes about what it does and does not do is a promise
 * about *that binary*. An auto-updater makes those promises conditional on a
 * server nobody in this house controls, which is the same shape of trust the
 * whole local-first argument (D-037) exists to avoid.
 *
 * So the check reports, and links. Downloading and installing is the owner's
 * action, taken in their browser, with their eyes on it.
 *
 * ## It never checks on its own
 *
 * There is no timer, no launch ping, and nothing in a background loop. The one
 * network request this module can make happens because somebody pressed a
 * button, and a test asserts nothing calls it otherwise. *"Nothing leaves this
 * Mac without you"* has to survive contact with the mundane features too, or it
 * is a slogan rather than a rule.
 *
 * ## Why updating costs something worth stating
 *
 * macOS ties both a folder grant and an encrypted keychain entry to the app's
 * identity. A new build is a new identity, so an update **withdraws every folder
 * grant** and can orphan a workspace key — that is not a hypothetical, it is
 * what happened to the flow workspace on this machine (D-068). Somebody about to
 * update deserves to know that before, not after.
 */

export interface BuildIdentity {
  readonly version: string;
  /** Whether this build is signed, which is what keeps folder grants. */
  readonly signed: boolean;
  readonly platform: string;
}

export interface UpdateCheck {
  readonly current: string;
  /** The newest published version, or null when the list could not be read. */
  readonly latest: string | null;
  readonly behind: boolean;
  /** Where to go. Opened by the owner, never fetched and run. */
  readonly url: string;
  /** What updating would cost them, stated before they go. */
  readonly costs: readonly string[];
  /** What happened, in the owner's words. Always set. */
  readonly said: string;
}

/** Where releases are listed. A page for a person, not an install feed. */
export const RELEASES_URL = "https://github.com/ambersachdeva-cell/rellane/releases";

/** The list this asks for. Reachable only when somebody presses the button. */
export const VERSIONS_URL = "https://raw.githubusercontent.com/ambersachdeva-cell/rellane/main/latest.json";

export const UPDATE_TIMEOUT_MS = 8_000;

/**
 * What updating costs. Stated the same way every time, because it is a
 * property of macOS rather than of any particular release.
 */
export const UPDATE_COSTS: readonly string[] = [
  "Every folder you granted will need granting again. macOS ties permission to the app's identity, and a new build is a new identity.",
  "Flows encrypted by this build may not open in the next one, for the same reason. Your book, your records and the Vault are not affected — they are not tied to the app.",
  "Nothing is downloaded or installed by Rellane. The link opens in your browser and the rest is yours."
];

/**
 * Compares two `major.minor.patch` strings.
 *
 * Deliberately not semver-complete: no pre-release tags, no build metadata, no
 * ranges. This decides one thing — whether a person should be told there is a
 * newer build — and a wrong answer costs a needless look at a web page. A
 * dependency for that would cost more than the mistake.
 */
export function isBehind(current: string, latest: string): boolean {
  // Digits only, per part. `parseInt` is lenient in exactly the wrong
  // direction: it reads "0-beta" as 0, so a pre-release string would compare as
  // an ordinary release and this would tell somebody they are behind on the
  // strength of a version it did not actually understand.
  const parse = (value: string): number[] =>
    value
      .trim()
      .split(".")
      .map((part) => (/^\d+$/u.test(part) ? Number(part) : -1));
  const a = parse(current);
  const b = parse(latest);
  // An unparseable version on either side means "do not claim anything". Saying
  // somebody is out of date when they are not sends them to download a build
  // they already have, and they stop believing the message.
  if (a.includes(-1) || b.includes(-1) || a.length === 0 || b.length === 0) {
    return false;
  }
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) {
      return right > left;
    }
  }
  return false;
}

/**
 * Asks, once, because somebody pressed the button.
 *
 * Never throws. A version check that fails is not worth an error screen — the
 * app works exactly as well as it did a second ago, and the honest report is
 * that we could not look.
 */
export async function checkForUpdate(
  current: string,
  fetcher: typeof fetch = fetch
): Promise<UpdateCheck> {
  const base = { current, url: RELEASES_URL, costs: UPDATE_COSTS };
  try {
    const response = await fetcher(VERSIONS_URL, {
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
      // Sends nothing about this Mac: no version, no identifier, no query. The
      // comparison happens here, on what came back.
      headers: { accept: "application/json" },
      redirect: "follow"
    });
    if (!response.ok) {
      return {
        ...base,
        latest: null,
        behind: false,
        said: "The list of versions could not be read just now. Nothing is wrong with this build."
      };
    }
    // `response.json()` resolves to `null` for a payload of literal `null`, and
    // `typeof null === "object"`, so the cast succeeded and the index threw —
    // landing in the catch below and reporting a network failure that had not
    // happened.
    const body = (await response.json()) as Record<string, unknown> | null;
    const latest =
      body !== null && typeof body["version"] === "string" ? body["version"].trim() : null;
    if (latest === null || latest.length === 0) {
      return {
        ...base,
        latest: null,
        behind: false,
        said: "That list did not say which version is newest."
      };
    }
    const behind = isBehind(current, latest);
    // `isBehind` returns false both for "you are current" and for "these two
    // versions could not be compared". Reporting the second as the first would
    // tell somebody on a pre-release build that they are up to date, which is
    // exactly the confident wrongness the parser was made strict to avoid.
    const comparable = isBehind(latest, current) || latest === current || behind;
    return {
      ...base,
      latest,
      behind,
      said: behind
        ? `You are on ${current}. ${latest} is out. Rellane will not install it for you — the link opens the page in your browser.`
        : comparable
          ? `You are on ${current}, which is the newest.`
          : `The newest published version is ${latest}, and this build is ${current}. Those cannot be compared, so Rellane will not guess which is older.`
    };
  } catch {
    return {
      ...base,
      latest: null,
      behind: false,
      said: "Could not reach the version list. That may be the network, and it changes nothing about this build."
    };
  }
}
