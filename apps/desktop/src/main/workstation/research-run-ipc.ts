import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { URL } from "node:url";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
/**
 * One reader for pages, not three. This file arrived with its own title, text
 * and link extractors — strip-every-tag versions that kept nav menus, cookie
 * banners and script bodies, then fed all of it to a subscription as if it were
 * the article. extractPage drops the boilerplate, keeps tables and code intact,
 * resolves links against the address it actually landed on, and says when a page
 * turned out to be mostly script.
 */
import { extractPage } from "./page-extract.js";

export type ResearchStepKind = "planning" | "reading" | "asking" | "thinking" | "writing";

export interface ResearchStepView {
  readonly index: number;
  readonly kind: ResearchStepKind;
  readonly title: string;
  readonly detail: string;
  readonly at: number;
  readonly ok: boolean | null;
}

export interface ResearchRunView {
  readonly runId: string;
  readonly caseId: string;
  readonly question: string;
  readonly state: "planning" | "working" | "writing" | "done" | "stopped" | "failed";
  readonly steps: readonly ResearchStepView[];
  readonly sourcesRead: number;
  readonly notesKept: number;
  readonly headline: string;
  readonly answer: string | null;
  readonly unanswered: readonly string[];
  readonly canStop: boolean;
}

export interface InstallResearchOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** Fetches one page. Already guarded against private addresses and redirects. */
  readonly fetchPage: (url: string, signal: AbortSignal) => Promise<{ readonly html: string; readonly finalUrl: string } | null>;
  /** The owner's chosen files, as text. */
  readonly files: (caseId: string) => Promise<readonly { readonly id: string; readonly label: string; readonly text: string }[]>;
  /** Asks a subscription one question. Read-only. */
  readonly ask: (input: { readonly prompt: string; readonly signal: AbortSignal }) => Promise<string>;
  /** Writes the finished answer into the room. */
  readonly record: (input: { readonly caseId: string; readonly body: string }) => Promise<string>;
}

export const WorkstationResearchStartSchema = z.object({
  caseId: z.string().min(1),
  question: z.string().min(1),
  urls: z.array(z.string().min(1)).optional(),
  depth: z.enum(["quick", "thorough"])
});

export const WorkstationResearchPollSchema = z.object({
  runId: z.string().min(1)
});

export const WorkstationResearchStopSchema = z.object({
  runId: z.string().min(1)
});

interface QueueItemUrl {
  readonly kind: "url";
  readonly url: string;
  readonly depth: number;
}

interface QueueItemFile {
  readonly kind: "file";
  readonly file: { readonly id: string; readonly label: string; readonly text: string };
}

type QueueItem = QueueItemUrl | QueueItemFile;

function parseNotes(raw: string): readonly string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.toUpperCase() === "NONE") {
    return [];
  }
  return trimmed
    .split("\n")
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0 && line.toUpperCase() !== "NONE");
}

export class ResearchRunSession {
  public readonly runId: string;
  public readonly caseId: string;
  public readonly question: string;
  public readonly urls: readonly string[];
  public readonly depth: "quick" | "thorough";
  private readonly options: InstallResearchOptions;
  private readonly abortController = new AbortController();

  private state: "planning" | "working" | "writing" | "done" | "stopped" | "failed" = "planning";
  private headline: string = "Planning research.";
  private answer: string | null = null;
  private sourcesRead: number = 0;
  private notesKept: number = 0;
  private readonly steps: ResearchStepView[] = [];
  private unanswered: readonly string[] = [];
  private loopPromise: Promise<void> | null = null;

  public constructor(init: {
    readonly runId: string;
    readonly caseId: string;
    readonly question: string;
    readonly urls: readonly string[];
    readonly depth: "quick" | "thorough";
    readonly options: InstallResearchOptions;
  }) {
    this.runId = init.runId;
    this.caseId = init.caseId;
    this.question = init.question;
    this.urls = init.urls;
    this.depth = init.depth;
    this.options = init.options;
  }

  public canStop(): boolean {
    return this.state === "planning" || this.state === "working" || this.state === "writing";
  }

  public stop(): void {
    if (!this.canStop()) {
      return;
    }
    this.abortController.abort();
    this.state = "stopped";
    this.headline = "Research stopped.";
    // Any in-flight step is marked incomplete so the observed trace remains truthful
    if (this.steps.length > 0) {
      const lastIndex = this.steps.length - 1;
      const last = this.steps[lastIndex];
      if (last && last.ok === null) {
        this.steps[lastIndex] = {
          index: last.index,
          kind: last.kind,
          title: last.title,
          detail: "Stopped.",
          at: last.at,
          ok: false
        };
      }
    }
  }

  public start(): void {
    this.loopPromise = this.runLoop().catch(() => {
      this.state = "failed";
      this.headline = "Research could not be completed.";
    });
  }

  public async waitForFinish(): Promise<void> {
    await this.loopPromise;
  }

  public toView(): ResearchRunView {
    return {
      runId: this.runId,
      caseId: this.caseId,
      question: this.question,
      state: this.state,
      steps: [...this.steps],
      sourcesRead: this.sourcesRead,
      notesKept: this.notesKept,
      headline: this.headline,
      answer: this.answer,
      unanswered: this.unanswered,
      canStop: this.canStop()
    };
  }

  private updateStep(index: number, patch: Partial<Omit<ResearchStepView, "index">>): void {
    if (index > 0 && index <= this.steps.length) {
      const existing = this.steps[index - 1];
      if (existing) {
        this.steps[index - 1] = {
          index: existing.index,
          kind: patch.kind ?? existing.kind,
          title: patch.title ?? existing.title,
          detail: patch.detail ?? existing.detail,
          at: patch.at ?? existing.at,
          ok: patch.ok !== undefined ? patch.ok : existing.ok
        };
      }
    }
  }

  private async runLoop(): Promise<void> {
    const signal = this.abortController.signal;
    const startTime = Date.now();
    const maxSteps = this.depth === "quick" ? 6 : 12;
    const timeLimitMs = this.depth === "quick" ? 120_000 : 360_000;

    this.state = "working";
    this.headline = "Reading sources.";

    // Link crawling remains bounded strictly to hostnames the owner initially trusted
    const initialHosts = new Set<string>();
    for (const urlStr of this.urls) {
      try {
        initialHosts.add(new URL(urlStr).hostname.toLowerCase());
      } catch {
        // Discard unparseable seeds
      }
    }

    const queue: QueueItem[] = [];
    const queuedUrls = new Set<string>();
    for (const urlStr of this.urls) {
      try {
        const parsed = new URL(urlStr);
        queue.push({
          kind: "url",
          url: parsed.href,
          depth: 0
        });
        queuedUrls.add(parsed.href);
      } catch {
        // Invalid initial inputs are ignored
      }
    }

    try {
      const caseFiles = await this.options.files(this.caseId);
      if (signal.aborted) {
        return;
      }
      for (const file of caseFiles) {
        queue.push({
          kind: "file",
          file
        });
      }
    } catch {
      // Failure to load local case files does not abort online research
    }

    const visitedFinalUrls = new Set<string>();
    const allNotes: string[] = [];
    let consecutiveZeroNoteSteps = 0;
    let stopReason: "completed" | "step_limit" | "time_limit" | "no_notes" = "completed";

    while (queue.length > 0) {
      if (signal.aborted) {
        return;
      }

      if (Date.now() - startTime >= timeLimitMs) {
        stopReason = "time_limit";
        break;
      }

      if (this.steps.length >= maxSteps) {
        stopReason = "step_limit";
        break;
      }

      // Stopping when two successive sources add nothing protects the owner's subscription quota
      if (consecutiveZeroNoteSteps >= 2) {
        stopReason = "no_notes";
        break;
      }

      const item = queue.shift()!;

      if (item.kind === "url") {
        if (visitedFinalUrls.has(item.url)) {
          continue;
        }

        const parsed = new URL(item.url);
        const host = parsed.hostname.replace(/^www\./, "");
        const stepIndex = this.steps.length + 1;

        // Step titles avoid raw URL formatting to maintain calm, human-readable copy
        const step: ResearchStepView = {
          index: stepIndex,
          kind: "reading",
          title: `Reading ${host}`,
          detail: "Fetching page.",
          at: Date.now(),
          ok: null
        };
        this.steps.push(step);

        let fetchResult: { readonly html: string; readonly finalUrl: string } | null = null;
        try {
          fetchResult = await this.options.fetchPage(item.url, signal);
        } catch {
          if (signal.aborted) {
            return;
          }
          fetchResult = null;
        }

        if (signal.aborted) {
          return;
        }

        if (!fetchResult) {
          this.updateStep(stepIndex, {
            ok: false,
            detail: "Could not open this page."
          });
          consecutiveZeroNoteSteps++;
          continue;
        }

        // Deduplicating by landing address avoids re-reading redirects
        if (visitedFinalUrls.has(fetchResult.finalUrl)) {
          this.updateStep(stepIndex, {
            ok: true,
            detail: "Page already read under another address."
          });
          consecutiveZeroNoteSteps++;
          continue;
        }

        visitedFinalUrls.add(fetchResult.finalUrl);
        this.sourcesRead++;

        const page = extractPage(fetchResult.html, fetchResult.finalUrl);
        const pageTitle = page.title.length > 0 ? page.title : host;
        const plainText = page.text;

        let askResponse = "";
        try {
          const prompt = `Question: ${this.question}\nSource: ${pageTitle}\nContent:\n${plainText.slice(0, 12_000)}\n\nExtract concise factual notes that help answer the question. If this source contains no relevant information, answer NONE. Otherwise, list each note on a new line starting with "- ".`;
          askResponse = await this.options.ask({ prompt, signal });
        } catch {
          if (signal.aborted) {
            return;
          }
          askResponse = "";
        }

        if (signal.aborted) {
          return;
        }

        const notes = parseNotes(askResponse);
        if (notes.length > 0) {
          this.notesKept += notes.length;
          allNotes.push(...notes);
          consecutiveZeroNoteSteps = 0;

          this.updateStep(stepIndex, {
            title: `Reading "${pageTitle}"`,
            ok: true,
            detail: `Kept ${notes.length} ${notes.length === 1 ? "note" : "notes"}.`
          });

          // Discovered links are followed only when the parent yielded usable knowledge
          if (item.depth < 2) {
            for (const { href: link } of page.links) {
              try {
                const targetHost = new URL(link).hostname.toLowerCase();
                const isAllowedHost = item.depth === 0 || initialHosts.has(targetHost);
                if (isAllowedHost && !visitedFinalUrls.has(link) && !queuedUrls.has(link)) {
                  queuedUrls.add(link);
                  queue.push({
                    kind: "url",
                    url: link,
                    depth: item.depth + 1
                  });
                }
              } catch {
                // Discard invalid link candidates
              }
            }
          }
        } else {
          consecutiveZeroNoteSteps++;
          this.updateStep(stepIndex, {
            title: `Reading "${pageTitle}"`,
            ok: true,
            detail: "No relevant notes found."
          });
        }
      } else if (item.kind === "file") {
        const stepIndex = this.steps.length + 1;
        const step: ResearchStepView = {
          index: stepIndex,
          kind: "reading",
          title: `Reading "${item.file.label}"`,
          detail: "Reading file.",
          at: Date.now(),
          ok: null
        };
        this.steps.push(step);

        let askResponse = "";
        try {
          const prompt = `Question: ${this.question}\nFile: ${item.file.label}\nContent:\n${item.file.text.slice(0, 12_000)}\n\nExtract concise factual notes that help answer the question. If this file contains no relevant information, answer NONE. Otherwise, list each note on a new line starting with "- ".`;
          askResponse = await this.options.ask({ prompt, signal });
        } catch {
          if (signal.aborted) {
            return;
          }
          askResponse = "";
        }

        if (signal.aborted) {
          return;
        }

        this.sourcesRead++;
        const notes = parseNotes(askResponse);
        if (notes.length > 0) {
          this.notesKept += notes.length;
          allNotes.push(...notes);
          consecutiveZeroNoteSteps = 0;

          this.updateStep(stepIndex, {
            ok: true,
            detail: `Kept ${notes.length} ${notes.length === 1 ? "note" : "notes"}.`
          });
        } else {
          consecutiveZeroNoteSteps++;
          this.updateStep(stepIndex, {
            ok: true,
            detail: "No relevant notes found."
          });
        }
      }
    }

    if (signal.aborted) {
      return;
    }

    if (this.steps.length >= maxSteps) {
      stopReason = "step_limit";
    }

    this.state = "writing";
    this.headline = "Writing answer.";

    let cutShortNotice = "";
    if (stopReason === "step_limit") {
      cutShortNotice = `Research was cut short after reaching the limit of ${maxSteps} steps.`;
    } else if (stopReason === "time_limit") {
      const minutes = Math.round(timeLimitMs / 60_000);
      cutShortNotice = `Research was cut short after reaching the ${minutes}-minute time limit.`;
    } else if (stopReason === "no_notes") {
      cutShortNotice = "Research stopped early because the last two sources added no new notes.";
    }

    let finalAnswer = "";
    if (allNotes.length > 0) {
      try {
        const prompt = `Question: ${this.question}\n\nNotes collected during research:\n${allNotes.map((n) => `- ${n}`).join("\n")}\n\nWrite a calm, direct summary answering the question based only on these notes.`;
        const synthesis = await this.options.ask({ prompt, signal });
        finalAnswer = synthesis.trim();
      } catch {
        if (signal.aborted) {
          return;
        }
        finalAnswer = allNotes.map((n) => `- ${n}`).join("\n");
      }
    } else {
      finalAnswer = "No relevant information was found to answer this question.";
    }

    if (cutShortNotice.length > 0 && !finalAnswer.includes(cutShortNotice)) {
      finalAnswer = `${cutShortNotice}\n\n${finalAnswer}`;
    }

    try {
      await this.options.record({ caseId: this.caseId, body: finalAnswer });
    } catch {
      // Recording errors do not void the observed findings
    }

    if (signal.aborted) {
      return;
    }

    this.answer = finalAnswer;
    this.state = "done";

    if (stopReason === "step_limit") {
      this.headline = `Research reached the step limit of ${maxSteps} steps.`;
      this.unanswered = ["Remaining sources could not be checked because the step limit was reached."];
    } else if (stopReason === "time_limit") {
      this.headline = "Research reached the time limit.";
      this.unanswered = ["Remaining sources could not be checked because the time limit was reached."];
    } else if (stopReason === "no_notes") {
      this.headline = "Research stopped early: the last two sources added no new notes.";
      this.unanswered = allNotes.length === 0 ? [this.question] : [];
    } else {
      this.headline = "Research complete.";
      this.unanswered = [];
    }
  }
}

export function installResearch(options: InstallResearchOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);

  const runs = new Map<string, ResearchRunSession>();
  let activeRunId: string | null = null;

  ipcMain.handle(IPC_CHANNELS.workstationResearchStart, async (event, input: unknown): Promise<{ readonly runId: string }> => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    const parsed = WorkstationResearchStartSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("Invalid research start request.");
    }
    const request = parsed.data;

    // Only one research run executes at a time; starting anew aborts previous work
    if (activeRunId !== null) {
      const active = runs.get(activeRunId);
      if (active && active.canStop()) {
        active.stop();
      }
    }

    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    const session = new ResearchRunSession({
      runId,
      caseId: request.caseId,
      question: request.question,
      urls: request.urls ? [...request.urls] : [],
      depth: request.depth,
      options
    });

    runs.set(runId, session);
    activeRunId = runId;
    session.start();

    options.assertTrusted(event);
    if (ownerFor(event) !== owner) {
      throw new Error("This window changed while starting research.");
    }

    return { runId };
  });

  ipcMain.handle(IPC_CHANNELS.workstationResearchPoll, async (event, input: unknown): Promise<ResearchRunView> => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    const parsed = WorkstationResearchPollSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("Invalid research poll request.");
    }

    const session = runs.get(parsed.data.runId);
    if (!session) {
      throw new Error("Research run not found.");
    }

    options.assertTrusted(event);
    if (ownerFor(event) !== owner) {
      throw new Error("This window changed while polling research.");
    }

    return session.toView();
  });

  ipcMain.handle(IPC_CHANNELS.workstationResearchStop, async (event, input: unknown): Promise<ResearchRunView> => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    const parsed = WorkstationResearchStopSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("Invalid research stop request.");
    }

    const session = runs.get(parsed.data.runId);
    if (!session) {
      throw new Error("Research run not found.");
    }

    if (session.canStop()) {
      session.stop();
    }

    options.assertTrusted(event);
    if (ownerFor(event) !== owner) {
      throw new Error("This window changed while stopping research.");
    }

    return session.toView();
  });
}
