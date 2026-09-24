export type ExpectedBlockOrigin = "engine" | "derived" | "none";

export interface CitationPresentation {
  readonly badge: "ok" | "mismatch" | "uncited" | "unavailable";
  readonly headline: string;
  readonly guidance: readonly string[];
  readonly expectedSourcesBlock: string;
  readonly expectedBlockOrigin: ExpectedBlockOrigin;
  readonly technicalDetail: readonly string[];
}

/** Narrow structural input, so the test needs no full result literal. */
export interface CitationCheckLike {
  readonly status: "ok" | "mismatch" | "uncited" | "unavailable";
  readonly summary: string;
  readonly sources: readonly { readonly id: number; readonly label: string; readonly uri: string }[];
  readonly citedIds: readonly number[];
  readonly unknownReferences: readonly string[];
  readonly missingFromSourcesBlock: readonly number[];
  readonly unexpectedInSourcesBlock: readonly number[];
  readonly expectedSourcesBlock: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

function resolveHeadline(status: CitationCheckLike["status"]): string {
  switch (status) {
    case "ok":
      return "Every numbered reference matches a selected source.";
    case "mismatch":
      return "The citations do not match the selected sources.";
    case "uncited":
      return "No numbered citations were found in this draft.";
    case "unavailable":
      return "The citation check could not run.";
  }
}

function deriveSourcesBlock(
  sources: readonly { readonly id: number; readonly label: string; readonly uri: string }[]
): string {
  // Sort ascending by source id so ordering reflects source identifiers rather than selection order
  const sorted = [...sources].sort((a, b) => a.id - b.id);
  const lines: string[] = ["Sources"];
  for (const source of sorted) {
    const trimmed = source.label.trim();
    const label = trimmed.length > 0 ? trimmed : "Untitled source";
    lines.push(`[${source.id}] ${label} — ${source.uri}`);
  }
  return lines.join("\n");
}

export function presentCitationCheck(result: CitationCheckLike): CitationPresentation {
  let expectedSourcesBlock = "";
  let expectedBlockOrigin: ExpectedBlockOrigin = "none";

  if (result.expectedSourcesBlock.trim().length > 0) {
    expectedSourcesBlock = result.expectedSourcesBlock;
    expectedBlockOrigin = "engine";
  } else if (result.sources.length > 0) {
    expectedSourcesBlock = deriveSourcesBlock(result.sources);
    expectedBlockOrigin = "derived";
  }

  const guidance: string[] = [];

  if (expectedBlockOrigin === "derived") {
    guidance.push(
      // Addressed to the person reading it. Saying "the owner" here talks about
      // them in the third person on the one screen that exists to help them.
      "Rellane worked this block out from the sources you selected. Paste it at the end of your draft and the check can run properly."
    );
  }

  if (result.unknownReferences.length > 0) {
    guidance.push(
      `The draft references ${result.unknownReferences.join(", ")}; each points at a source that is not in this work.`
    );
  }

  if (result.missingFromSourcesBlock.length > 0) {
    guidance.push(
      `References ${result.missingFromSourcesBlock.map((id) => `[${id}]`).join(", ")} are cited but absent from the Sources list.`
    );
  }

  if (result.unexpectedInSourcesBlock.length > 0) {
    guidance.push(
      `References ${result.unexpectedInSourcesBlock.map((id) => `[${id}]`).join(", ")} are listed but never cited.`
    );
  }

  if (expectedBlockOrigin === "none") {
    guidance.push("No sources were selected, so there is nothing to check the citations against.");
  }

  if (result.status === "ok") {
    guidance.push("The citations match the selected sources.");
  }

  if (guidance.length === 0) {
    if (result.status === "uncited") {
      guidance.push("No numbered citations were found in this draft.");
    } else if (result.status === "unavailable") {
      guidance.push("The citation check could not run.");
    } else {
      guidance.push("The citations do not match the selected sources.");
    }
  }

  return {
    badge: result.status,
    headline: resolveHeadline(result.status),
    guidance: guidance.slice(0, 3),
    expectedSourcesBlock,
    expectedBlockOrigin,
    technicalDetail: [...result.errors, ...result.warnings]
  };
}
