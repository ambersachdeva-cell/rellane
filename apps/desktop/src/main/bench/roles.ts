/**
 * The roles two models take when they argue.
 *
 * D-018, made concrete. Debate without a judge is theatre: two capable models
 * produce two confident answers, a longer transcript and a larger bill. Three
 * things make an argument better than a single answer, and all three are here
 * rather than left to emerge.
 *
 * **Roles are assigned.** Left to themselves, models converge — the second one
 * reads the first and agrees, because agreement is what the training data
 * rewards. So one proposes and one is instructed to break it, and the
 * instruction is explicit that finding nothing wrong is a legitimate answer,
 * because an adversary that must find a fault will invent one.
 *
 * **The adversary sees the claim before the reasoning.** A model that reads a
 * well-argued case first is anchored by it and critiques the edges. Given the
 * conclusion alone it has to construct its own account of whether that could be
 * true, which is where genuine disagreement comes from.
 *
 * **Nobody is asked to be adversarial about facts.** The critic attacks the
 * reasoning; where evidence exists, the Backtest settles it. Rhetoric is not
 * how you decide what a file contains.
 */

export type Seat = "proposer" | "adversary" | "adjudicator";

/** What the proposer is told. Ordinary work — it is not performing. */
export function proposerPrompt(question: string): string {
  return [
    "You are answering a question that a second model will then try to break.",
    "Give your answer, then the reasoning behind it, in that order — the claim first, on its own line, prefixed with CLAIM:.",
    "Be specific enough to be wrong. A hedged answer cannot be checked, and an answer nobody can check is not worth arguing about.",
    "",
    question
  ].join("\n");
}

/**
 * What the adversary is told, given only the claim.
 *
 * The reasoning is deliberately withheld on the first pass.
 */
export function adversaryPrompt(question: string, claim: string): string {
  return [
    "Another model answered the question below. You are shown its conclusion but not its reasoning, on purpose.",
    "Work out independently whether that conclusion can be right.",
    "",
    "Say AGREE if you reach the same conclusion and can say why.",
    "Say DISAGREE and give the specific fault if you do not — name what would have to be true for the answer to hold, and why you think it is not.",
    "",
    "Finding nothing wrong is a real answer. Do not manufacture a disagreement to look useful; a critic who must find a fault will invent one, and that wastes the owner's money and time.",
    "",
    `The question: ${question}`,
    `Its conclusion: ${claim}`
  ].join("\n");
}

/**
 * What the proposer is told when its answer has been attacked.
 *
 * It may concede. Conceding is the cheapest correct outcome available and the
 * prompt says so, because a model told only to "respond" will defend.
 */
export function rebuttalPrompt(claim: string, objection: string): string {
  return [
    "Your answer was challenged. The objection is below.",
    "If it is right, say CONCEDE and give the corrected answer. Conceding is the best outcome available when the objection holds, and it costs nothing.",
    "If it is wrong, say HOLD and answer the specific fault — not the general topic.",
    "",
    `Your claim: ${claim}`,
    `The objection: ${objection}`
  ].join("\n");
}

/**
 * What a human reads when no evidence can settle it.
 *
 * Used only where the Backtest has nothing to replay against. It summarises
 * rather than picks, because a third model asked to choose between two others
 * is a third opinion, not a verdict.
 */
export function summaryPrompt(question: string, transcript: string): string {
  return [
    "Two models argued about the question below and did not converge.",
    "Summarise, for the person who has to decide: what each concluded, precisely where they diverge, and what evidence would settle it.",
    "Do not pick a side. You are not better placed than either of them; you are making the disagreement legible.",
    "",
    `The question: ${question}`,
    "",
    transcript
  ].join("\n");
}

/**
 * Reads a verdict out of what a model wrote.
 *
 * Deliberately conservative: anything unrecognised is `unclear` rather than
 * guessed. A debate that silently mis-reads "I DISAGREE with the framing" as
 * agreement would terminate early on a false consensus, which is the one
 * failure that would make the whole feature actively misleading.
 */
export function readVerdict(text: string): "agree" | "disagree" | "concede" | "hold" | "unclear" {
  const head = text.trim().slice(0, 400).toUpperCase();
  // Checked in order of how strongly each word settles the exchange.
  if (says(head, "CONCEDE")) return "concede";
  if (says(head, "DISAGREE")) return "disagree";
  if (says(head, "HOLD")) return "hold";
  if (says(head, "AGREE")) return "agree";
  return "unclear";
}

/**
 * Whether the reply actually casts this verdict.
 *
 * Substring matching read two very different things wrong, and both are worse
 * than returning `unclear`:
 *
 *   - **`HOLD` matched `WITHHOLDING`.** Also `THRESHOLD` and `STAKEHOLDER`.
 *     This product's arguments are about an Indian business ledger, where TDS
 *     withholding is ordinary vocabulary — so a model discussing it was recorded
 *     as holding its position.
 *   - **`AGREE` matched `I DO NOT AGREE`.** A model explicitly refusing to agree
 *     closed the debate as a consensus. That is the one failure that makes the
 *     whole feature misleading rather than merely wrong: the owner is told two
 *     independent models concurred when one said the opposite.
 *
 * So the token must stand as a word, and must not be negated. Anything else is
 * `unclear`, which is the honest answer and the one the session already knows
 * how to handle.
 */
function says(head: string, token: string): boolean {
  const at = new RegExp(`\\b${token}\\b`, "u").exec(head);
  if (at === null) {
    return false;
  }
  // Negation looks backwards a short way: "I do not agree", "cannot concede",
  // "will never hold". Far enough to catch the phrasing, short enough that an
  // unrelated "not" earlier in the sentence does not swallow a real verdict.
  const before = head.slice(Math.max(0, at.index - 24), at.index);
  return !/\b(NOT|NEVER|CANNOT|CAN'T|WON'T|DON'T|DOES NOT|DO NOT)\b[^.]*$/u.test(before);
}

/** Pulls the claim line the proposer was asked to mark. */
export function readClaim(text: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((candidate) => candidate.trim().toUpperCase().startsWith("CLAIM:"));
  if (index !== -1) {
    const sameLine = (lines[index] ?? "").trim().slice("CLAIM:".length).trim();
    if (sameLine.length > 0) {
      return sameLine;
    }
    // `CLAIM:` alone on its line, conclusion on the next. This returned an empty
    // string, so the adversary was handed "Its conclusion: " and asked to argue
    // with nothing.
    const next = lines.slice(index + 1).map((l) => l.trim()).find((l) => l.length > 0);
    if (next !== undefined) {
      return next;
    }
  }
  // No marker: fall back to the first non-empty line rather than the whole
  // answer, so the adversary still gets a conclusion rather than the reasoning
  // the blind-critique rule exists to withhold.
  return text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? text.trim();
}
