export interface LiveState {
  readonly title: string;
  readonly stage: string;
  readonly lines: readonly string[];
  readonly done: boolean;
  readonly stoppable: boolean;
  readonly answer: string | null;
}

export interface LiveMessage {
  readonly text: string;
  readonly buttons: readonly (readonly { readonly text: string; readonly data: string }[])[];
}

const MAX_MESSAGE_LENGTH = 4096;
const REST_ON_MAC_NOTICE = "\n\n… The rest of this answer is on your Mac.";

const STOP_BUTTONS: readonly (readonly { readonly text: string; readonly data: string }[])[] = [
  [{ text: "Stop", data: "stop" }],
];

const DONE_BUTTONS: readonly (readonly { readonly text: string; readonly data: string }[])[] = [
  [
    { text: "Keep this", data: "keep_this" },
    { text: "See the sources", data: "see_sources" },
  ],
  [{ text: "Ask something else", data: "ask_something_else" }],
];

const NO_BUTTONS: readonly (readonly { readonly text: string; readonly data: string }[])[] = [];

// Determine whether an unfinished terminal state was triggered by user stop or system failure.
function describeUnfinishedTerminal(state: LiveState): string {
  const isStop = /stop|cancel/i.test(state.stage);
  if (isStop) {
    return "This was stopped before an answer was ready.";
  }

  for (const line of state.lines) {
    if (/stop|cancel/i.test(line)) {
      return "This was stopped before an answer was ready.";
    }
  }

  return "This could not be completed.";
}

// Telegram enforces a hard 4096 character ceiling on message text.
export function renderLive(state: LiveState): LiveMessage {
  if (state.done) {
    if (state.answer === null) {
      return {
        text: describeUnfinishedTerminal(state),
        buttons: DONE_BUTTONS,
      };
    }

    if (state.answer.length <= MAX_MESSAGE_LENGTH) {
      return {
        text: state.answer,
        buttons: DONE_BUTTONS,
      };
    }

    // Preserve the answer start while informing the reader where the complete text resides.
    const allowedLength = MAX_MESSAGE_LENGTH - REST_ON_MAC_NOTICE.length;
    const truncatedAnswer = state.answer.slice(0, allowedLength).trimEnd();

    return {
      text: `${truncatedAnswer}${REST_ON_MAC_NOTICE}`,
      buttons: DONE_BUTTONS,
    };
  }

  const buttons = state.stoppable ? STOP_BUTTONS : NO_BUTTONS;

  const headerSections: string[] = [];
  const trimmedTitle = state.title.trim();
  if (trimmedTitle.length > 0) {
    // Large titles are bounded so progress updates retain sufficient space for trace lines.
    const safeTitle =
      trimmedTitle.length > 500
        ? `${trimmedTitle.slice(0, 497).trimEnd()}…`
        : trimmedTitle;
    headerSections.push(safeTitle);
  }

  const trimmedStage = state.stage.trim();
  if (trimmedStage.length > 0) {
    headerSections.push(trimmedStage);
  }

  const headerText = headerSections.join("\n\n");

  if (state.lines.length === 0) {
    return {
      text: headerText.length > 0 ? headerText : "Working…",
      buttons,
    };
  }

  const availableBudget =
    MAX_MESSAGE_LENGTH - (headerText.length > 0 ? headerText.length + 2 : 0);

  const fullLinesText = state.lines.join("\n");
  if (fullLinesText.length <= availableBudget) {
    const text =
      headerText.length > 0 ? `${headerText}\n\n${fullLinesText}` : fullLinesText;
    return { text, buttons };
  }

  // Find the earliest line index that allows the recent trace and drop notice to fit.
  let startIdx = state.lines.length - 1;
  for (let candidateIdx = 1; candidateIdx < state.lines.length; candidateIdx++) {
    const droppedCount = candidateIdx;
    const notice =
      droppedCount === 1
        ? "… (1 earlier line dropped)\n"
        : `… (${droppedCount} earlier lines dropped)\n`;
    const keptLines = state.lines.slice(candidateIdx);
    const candidateText = notice + keptLines.join("\n");

    if (candidateText.length <= availableBudget) {
      startIdx = candidateIdx;
      break;
    }
  }

  const droppedCount = startIdx;
  const notice =
    droppedCount === 1
      ? "… (1 earlier line dropped)\n"
      : `… (${droppedCount} earlier lines dropped)\n`;

  const keptLines = state.lines.slice(startIdx);
  let linesSection = notice + keptLines.join("\n");

  if (linesSection.length > availableBudget) {
    const maxLineLength = availableBudget - notice.length;
    const lastLine = state.lines[state.lines.length - 1];
    if (lastLine !== undefined && maxLineLength > 3) {
      linesSection = `${notice}${lastLine.slice(0, maxLineLength - 1).trimEnd()}…`;
    } else {
      linesSection = notice.trimEnd();
    }
  }

  const text =
    headerText.length > 0 ? `${headerText}\n\n${linesSection}` : linesSection;

  return { text, buttons };
}

// Balance live responsiveness with Telegram edit rate limits and zero-diff rejection errors.
export function worthEditing(
  previous: LiveState | null,
  next: LiveState,
  sinceLastEditMs: number,
): boolean {
  // Terminal completions must always be dispatched immediately so users receive final answers.
  const doneFlipped = next.done && (previous === null || !previous.done);
  if (doneFlipped) {
    return true;
  }

  // Telegram imposes aggressive rate limits on message edits across short intervals.
  if (sinceLastEditMs < 2000) {
    return false;
  }

  if (previous === null) {
    return true;
  }

  const prevRendered = renderLive(previous);
  const nextRendered = renderLive(next);

  // Telegram returns a 400 Bad Request if an edit payload is character-identical to current state.
  if (prevRendered.text === nextRendered.text) {
    return false;
  }

  return true;
}
