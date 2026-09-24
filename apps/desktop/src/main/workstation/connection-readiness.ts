export type ConnectionFamily = "codex" | "claude" | "gemini";

export interface ConnectionFacts {
  readonly family: ConnectionFamily;
  /** Absolute path to the command that was found, or null when nothing was found. */
  readonly executable: string | null;
  /** Gemini only: whether that profile's folder already exists. Absent otherwise. */
  readonly profileReady?: boolean;
  /** Gemini only: the profile folder key, e.g. "config2". Absent otherwise. */
  readonly profileKey?: string;
}

export interface ConnectionReadiness {
  /** One plain sentence the owner can act on. Never names a path or a CLI. */
  readonly headline: string;
  /** What the owner does next, in their own vendor's app. Empty when nothing is needed. */
  readonly nextStep: string;
  /** The precise technical locator, for anyone who wants it. May be empty. */
  readonly evidence: string;
  /** headline + nextStep + evidence, joined for the single `detail` string the contract carries. */
  readonly detail: string;
}

const PRODUCT_NAMES: Record<ConnectionFamily, string> = {
  codex: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini"
};

const SEARCH_LOCATIONS: Record<ConnectionFamily, string> = {
  codex: "/Applications/ChatGPT.app/Contents/Resources/codex or PATH",
  claude: "editor extensions or PATH",
  gemini: "~/.local/bin or PATH"
};

function joinDetail(headline: string, nextStep: string, evidence: string): string {
  return [headline, nextStep, evidence].filter((part) => part.length > 0).join(" ");
}

export function describeConnection(facts: ConnectionFacts): ConnectionReadiness {
  const productName = PRODUCT_NAMES[facts.family];

  if (facts.executable === null) {
    const headline = `${productName} was not found on this Mac.`;
    // Names the app the owner would actually go and get, rather than "the
    // vendor": somebody who has not installed it yet does not know who that is.
    const nextStep = `Install ${productName} on this Mac and sign in to it there, then check again here.`;
    const evidence = SEARCH_LOCATIONS[facts.family];
    return {
      headline,
      nextStep,
      evidence,
      detail: joinDetail(headline, nextStep, evidence)
    };
  }

  const headline = `${productName} is on this Mac and Rellane can start a session with it.`;

  if (facts.family === "gemini" && facts.profileReady === false) {
    const nextStep = "This profile has not been used yet, the first session will set it up, and it may ask you to sign in.";
    const evidence = facts.profileKey !== undefined
      ? `${facts.executable} (${facts.profileKey})`
      : facts.executable;
    return {
      headline,
      nextStep,
      evidence,
      detail: joinDetail(headline, nextStep, evidence)
    };
  }

  const nextStep = `Signing in stays inside ${productName} itself, and Rellane does not check it.`;
  const evidence = facts.executable;
  return {
    headline,
    nextStep,
    evidence,
    detail: joinDetail(headline, nextStep, evidence)
  };
}
