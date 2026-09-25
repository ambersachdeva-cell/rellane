import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { URL } from "node:url";
import { z } from "zod";
import type { WorkstationProviderId, WorkstationReview } from "@cadrane/contracts";
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
import { nativeAskCompleted, nativeAskDetail, nativeAskEffectiveReason, type NativeAskOutcome } from "./types.js";

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
  readonly state: "planning" | "working" | "writing" | "done" | "stopped" | "failed" | "interrupted";
  readonly steps: readonly ResearchStepView[];
  readonly sourcesRead: number;
  readonly notesKept: number;
  readonly headline: string;
  readonly answer: string | null;
  readonly nativeOutcomes: readonly NativeAskOutcome[];
  readonly unanswered: readonly string[];
  readonly canStop: boolean;
}

export interface InstallResearchOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** Fetches one page. Already guarded against private addresses and redirects. */
  readonly fetchPage: (url: string, signal: AbortSignal) => Promise<{ readonly html: string; readonly finalUrl: string } | null>;
  /** The owner's chosen files, as text. */
  readonly files: (caseId: string) => Promise<readonly { readonly id: string; readonly label: string; readonly text: string }[]>;
  /** Asks a subscription one question through its provider adapter. */
  readonly ask: (input: { readonly prompt: string; readonly signal: AbortSignal }) => Promise<NativeAskOutcome>;
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
  private readonly nativeOutcomes: NativeAskOutcome[] = [];
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
      if (this.state === "stopped") return;
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
      nativeOutcomes: [...this.nativeOutcomes],
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

  private async acceptAsk(outcome: NativeAskOutcome): Promise<string | null> {
    this.nativeOutcomes.push(outcome);
    const stopped = this.abortController.signal.aborted || nativeAskEffectiveReason(outcome) === "stopped";
    if (!stopped && nativeAskCompleted(outcome)) return outcome.text;
    const detail = stopped && !outcome.cancellationRequested
      ? `Stopped. ${nativeAskDetail(outcome)}`
      : nativeAskDetail(outcome);
    this.state = stopped ? "stopped" : "failed";
    this.headline = detail;
    this.unanswered = [this.question];
    if (outcome.text.trim().length > 0) {
      this.answer = outcome.text;
      await this.options.record({
        caseId: this.caseId,
        body: `${outcome.text}\n\n---\nPartial research draft (${stopped ? "stopped" : nativeAskEffectiveReason(outcome)}): ${detail}`
      }).catch(() => undefined);
    }
    return null;
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
          const outcome = await this.options.ask({ prompt, signal });
          const accepted = await this.acceptAsk(outcome);
          if (accepted === null) {
            this.updateStep(stepIndex, { ok: false, detail: nativeAskDetail(outcome) });
            return;
          }
          askResponse = accepted;
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          this.updateStep(stepIndex, { ok: false, detail: error instanceof Error ? error.message : "The provider could not answer." });
          this.state = "failed";
          this.headline = "Research could not be completed.";
          return;
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
          const outcome = await this.options.ask({ prompt, signal });
          const accepted = await this.acceptAsk(outcome);
          if (accepted === null) {
            this.updateStep(stepIndex, { ok: false, detail: nativeAskDetail(outcome) });
            return;
          }
          askResponse = accepted;
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          this.updateStep(stepIndex, { ok: false, detail: error instanceof Error ? error.message : "The provider could not answer." });
          this.state = "failed";
          this.headline = "Research could not be completed.";
          return;
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
        const accepted = await this.acceptAsk(synthesis);
        if (accepted === null) return;
        finalAnswer = accepted.trim();
      } catch {
        if (signal.aborted) {
          return;
        }
        this.state = "failed";
        this.headline = "The provider could not finish the research answer.";
        this.answer = allNotes.map((n) => `- ${n}`).join("\n");
        this.unanswered = [this.question];
        return;
      }
    } else {
      finalAnswer = "No relevant information was found to answer this question.";
    }

    if (cutShortNotice.length > 0 && !finalAnswer.includes(cutShortNotice)) {
      finalAnswer = `${cutShortNotice}\n\n${finalAnswer}`;
    }

    if (finalAnswer.trim().length === 0 || signal.aborted) {
      if (!signal.aborted) {
        this.state = "failed";
        this.headline = "Research finished without an answer.";
        this.unanswered = [this.question];
      }
      return;
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

function toPlainErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return "This subscription was unable to answer.";
}

export const WorkstationResearchPrepareInputSchema = z.strictObject({
  caseId: z.string().min(1),
  question: z.string().trim().min(1),
  providerId: z.custom<WorkstationProviderId>((val) => typeof val === "string" && val.length > 0),
  modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u),
  urls: z.array(z.string().min(1)).max(20).optional()
    .refine((urls) => urls === undefined || new Set(urls).size === urls.length,
      "Choose each URL once."),
  fileIds: z.array(z.string().min(1)).max(20).optional()
    .refine((ids) => ids === undefined || new Set(ids).size === ids.length,
      "Choose each file once."),
  sourceTurnIds: z.array(z.string().min(1)).max(20).optional()
    .refine((ids) => ids === undefined || new Set(ids).size === ids.length,
      "Choose each source once."),
  depth: z.enum(["quick", "thorough"]).optional()
}).refine(
  (data) => (data.urls && data.urls.length > 0) ||
            (data.fileIds && data.fileIds.length > 0) ||
            (data.sourceTurnIds && data.sourceTurnIds.length > 0),
  "At least one explicit source (urls, fileIds, or sourceTurnIds) is required."
).refine(
  (data) => data.depth !== "thorough",
  "The 'thorough' depth mode is not supported for reviewed research. Use 'quick'."
);

export const WorkstationResearchPrepareSchema = WorkstationResearchPrepareInputSchema;
export type WorkstationResearchPrepareInput = z.infer<typeof WorkstationResearchPrepareInputSchema>;

export const WorkstationReviewedStartInputSchema = z.strictObject({
  token: z.string().regex(/^[0-9a-f]{64}$/u)
});

export interface InstallReviewedResearchOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly ownerFor: (event: IpcMainInvokeEvent) => object | string;
  readonly fetchPage?: (url: string, signal: AbortSignal) => Promise<{ readonly html: string; readonly finalUrl: string } | null>;
  readonly files?: (caseId: string) => Promise<readonly { readonly id: string; readonly label: string; readonly text: string }[]>;
  readonly prepareChild: (input: {
    readonly caseId: string;
    readonly providerId: WorkstationProviderId;
    readonly modelId: string;
    readonly prompt: string;
    readonly sourceTurnIds: readonly string[];
    readonly owner: object | string;
    readonly freshSession?: boolean;
  }) => Promise<WorkstationReview>;
  readonly runChild: (input: {
    readonly review: WorkstationReview;
    readonly owner: object | string;
    readonly signal: AbortSignal;
    readonly onActivity?: (line: string) => void;
  }) => Promise<NativeAskOutcome & { readonly turnId: string | null }>;
  readonly persistParent: (input: {
    readonly event: "parent";
    readonly runId: string;
    readonly caseId: string;
    readonly prompt: string;
    readonly brief?: string;
    readonly at: number;
    readonly children: readonly {
      readonly providerId: WorkstationProviderId;
      readonly label: string;
      readonly modelId: string;
      readonly contextSnapshotId: string;
      readonly sourceHash: string;
    }[];
  }) => Promise<void>;
  readonly persistChild: (
    caseId: string,
    input: {
      readonly event: "child";
      readonly runId: string;
      readonly index: number;
      readonly state: "starting" | "answered" | "stopped" | "failed" | "interrupted";
      readonly at: number;
      readonly line: string;
      readonly answerTurnId: string | null;
      readonly draftTurnId: string | null;
      readonly chars: number;
      readonly attempt?: {
        readonly attemptId: string;
        readonly contextSnapshotId: string;
        readonly sourceHash: string;
        readonly providerId: WorkstationProviderId;
        readonly modelId: string;
      };
    }
  ) => Promise<void>;
  readonly checkFreshness?: (review: WorkstationReview) => Promise<boolean> | boolean;
  readonly record?: (input: { readonly caseId: string; readonly body: string }) => Promise<string>;
  readonly recover?: (runId: string) => Promise<ResearchRunView | null>;
  readonly now?: () => number;
}

class ReviewedResearchRunSession {
  public readonly runId: string;
  public readonly owner: object | string;
  public readonly caseId: string;
  public readonly question: string;
  public readonly prompt: string;
  public readonly review: WorkstationReview;
  public readonly sources: {
    readonly urls: readonly string[];
    readonly fileIds: readonly string[];
    readonly sourceTurnIds: readonly string[];
  };
  public readonly controller: AbortController = new AbortController();
  public state: "planning" | "working" | "writing" | "done" | "stopped" | "failed" = "working";
  public headline: string = "Synthesizing answer.";
  public answer: string | null = null;
  public answerTurnId: string | null = null;
  public draftTurnId: string | null = null;
  public readonly nativeOutcomes: NativeAskOutcome[] = [];
  public unanswered: readonly string[] = [];
  public activity: string = "";
  public readonly startedAt: number;
  public endedAt: number | null = null;
  private stopAllowed: boolean = true;

  public constructor(init: {
    readonly runId: string;
    readonly owner: object | string;
    readonly caseId: string;
    readonly question: string;
    readonly prompt: string;
    readonly review: WorkstationReview;
    readonly sources: {
      readonly urls: readonly string[];
      readonly fileIds: readonly string[];
      readonly sourceTurnIds: readonly string[];
    };
    readonly startedAt: number;
  }) {
    this.runId = init.runId;
    this.owner = init.owner;
    this.caseId = init.caseId;
    this.question = init.question;
    this.prompt = init.prompt;
    this.review = init.review;
    this.sources = init.sources;
    this.startedAt = init.startedAt;
  }

  public canStop(): boolean {
    return this.stopAllowed && (this.state === "planning" || this.state === "working" || this.state === "writing");
  }

  public disallowStop(): void {
    this.stopAllowed = false;
  }

  public stop(): void {
    if (!this.canStop()) return;
    this.stopAllowed = false;
    this.controller.abort();
    this.headline = "Stopping research.";
  }

  public toView(): ResearchRunView {
    const steps: ResearchStepView[] = [];
    let stepIndex = 1;
    for (const url of this.sources.urls) {
      let host = url;
      try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
      steps.push({
        index: stepIndex++,
        kind: "reading",
        title: `Reading ${host}`,
        detail: "Source read and snapshotted for review.",
        at: this.startedAt,
        ok: true
      });
    }
    for (const fileId of this.sources.fileIds) {
      steps.push({
        index: stepIndex++,
        kind: "reading",
        title: `Reading "${fileId}"`,
        detail: "File read and snapshotted for review.",
        at: this.startedAt,
        ok: true
      });
    }
    const isDone = this.state === "done";
    const isTerminal = isDone || this.state === "stopped" || this.state === "failed";
    steps.push({
      index: stepIndex,
      kind: "writing",
      title: "Synthesizing answer",
      detail: this.activity || (isDone ? "Answer complete." : this.state === "stopped" ? "Stopped." : this.state === "failed" ? "Failed." : "Working on reviewed answer..."),
      at: this.startedAt,
      ok: isDone ? true : isTerminal ? false : null
    });

    return {
      runId: this.runId,
      caseId: this.caseId,
      question: this.question,
      state: this.state,
      steps,
      sourcesRead: this.sources.urls.length + this.sources.fileIds.length,
      notesKept: this.sources.urls.length + this.sources.fileIds.length,
      headline: this.headline,
      answer: this.answer,
      nativeOutcomes: [...this.nativeOutcomes],
      unanswered: this.unanswered,
      canStop: this.canStop()
    };
  }
}

/** The reviewed Research route: snapshot first, approval-bound parent token, host-owned child execution. */
export function installReviewedResearchRun(options: InstallReviewedResearchOptions): {
  readonly cancelOwner: (owner: object | string) => Promise<void>;
  readonly stopActive: () => Promise<boolean>;
  readonly shutdown: () => Promise<void>;
} {
  const clock = options.now ?? (() => Date.now());
  const ownerFor = options.ownerFor;
  const revokedOwners = new Set<unknown>();

  const pending = new Map<string, {
    readonly owner: object | string;
    readonly caseId: string;
    readonly question: string;
    readonly prompt: string;
    readonly reviews: readonly WorkstationReview[];
    readonly expiresAt: number;
    readonly sources: {
      readonly urls: readonly string[];
      readonly fileIds: readonly string[];
      readonly sourceTurnIds: readonly string[];
    };
    readonly omissions: readonly string[];
    readonly sourceHashes: Readonly<Record<string, string>>;
  }>();

  const runs = new Map<string, ReviewedResearchRunSession>();
  let activeRun: ReviewedResearchRunSession | null = null;

  ipcMain.handle(IPC_CHANNELS.workstationResearchPrepare, async (event, input: unknown) => {
    options.assertTrusted(event);
    const owner = ownerFor(event);
    if (revokedOwners.has(owner)) throw new Error("That research window is no longer active.");

    const request = WorkstationResearchPrepareInputSchema.parse(input);
    if (request.depth === "thorough") {
      throw new Error("The 'thorough' depth mode is not supported for reviewed research. Use 'quick'.");
    }

    const MAX_SOURCE_CHARS = 12_000;
    const omissions: string[] = [];
    const sourceHashes: Record<string, string> = {};

    // Read-only source collection with bounded URLs / depth
    const collectedPages: { title: string; text: string; url: string; hash: string }[] = [];
    if (request.urls && request.urls.length > 0) {
      if (!options.fetchPage) {
        throw new Error(`Failed to retrieve source URL: ${request.urls[0]}`);
      }
      const visitedUrls = new Set<string>();
      for (const urlStr of request.urls) {
        if (visitedUrls.has(urlStr)) continue;
        let fetched: { readonly html: string; readonly finalUrl: string } | null = null;
        try {
          fetched = await options.fetchPage(urlStr, new AbortController().signal);
        } catch {
          throw new Error(`Failed to retrieve source URL: ${urlStr}`);
        }
        if (!fetched) {
          throw new Error(`Failed to retrieve source URL: ${urlStr}`);
        }
        visitedUrls.add(urlStr);
        visitedUrls.add(fetched.finalUrl);
        const page = extractPage(fetched.html, fetched.finalUrl);
        const host = new URL(fetched.finalUrl).hostname.replace(/^www\./, "");
        const rawText = page.text;
        const pageTitle = page.title.length > 0 ? page.title : host;
        const hash = createHash("sha256").update(rawText).digest("hex");
        sourceHashes[fetched.finalUrl] = hash;

        let text = rawText;
        if (rawText.length > MAX_SOURCE_CHARS) {
          const omitted = rawText.length - MAX_SOURCE_CHARS;
          text = `${rawText.slice(0, MAX_SOURCE_CHARS)}\n\n[Omission: ${omitted} characters truncated from ${urlStr} exceeding ${MAX_SOURCE_CHARS} character limit]`;
          omissions.push(`${urlStr}: ${omitted} characters truncated exceeding ${MAX_SOURCE_CHARS} character limit`);
        }

        collectedPages.push({
          title: pageTitle,
          text,
          url: fetched.finalUrl,
          hash
        });
      }
    }

    const collectedFiles: { id: string; label: string; text: string; hash: string }[] = [];
    if (request.fileIds && request.fileIds.length > 0) {
      if (!options.files) {
        throw new Error(`Missing source file: ${request.fileIds[0]}`);
      }
      let caseFiles: readonly { readonly id: string; readonly label: string; readonly text: string }[];
      try {
        caseFiles = await options.files(request.caseId);
      } catch {
        throw new Error(`Failed to retrieve case files: ${request.fileIds[0]}`);
      }
      const availableFiles = new Map(caseFiles.map((f) => [f.id, f]));
      for (const fileId of request.fileIds) {
        const file = availableFiles.get(fileId);
        if (!file) {
          throw new Error(`Missing source file: ${fileId}`);
        }
        const rawText = file.text;
        const hash = createHash("sha256").update(rawText).digest("hex");
        sourceHashes[fileId] = hash;

        let text = rawText;
        if (rawText.length > MAX_SOURCE_CHARS) {
          const omitted = rawText.length - MAX_SOURCE_CHARS;
          text = `${rawText.slice(0, MAX_SOURCE_CHARS)}\n\n[Omission: ${omitted} characters truncated from file "${file.label}" exceeding ${MAX_SOURCE_CHARS} character limit]`;
          omissions.push(`${file.label} (${fileId}): ${omitted} characters truncated exceeding ${MAX_SOURCE_CHARS} character limit`);
        }

        collectedFiles.push({
          id: file.id,
          label: file.label,
          text,
          hash
        });
      }
    }

    const sourceBlocks: string[] = [];
    for (const page of collectedPages) {
      sourceBlocks.push(`Source: ${page.title}\nContent:\n${page.text}`);
    }
    for (const file of collectedFiles) {
      sourceBlocks.push(`File: ${file.label}\nContent:\n${file.text}`);
    }

    const prompt = sourceBlocks.length > 0
      ? `Question: ${request.question}\n\nCollected Sources:\n\n${sourceBlocks.join("\n\n---\n\n")}\n\nBased on these sources, answer the question thoroughly and accurately.`
      : `Question: ${request.question}`;

    const review = await options.prepareChild({
      caseId: request.caseId,
      providerId: request.providerId,
      modelId: request.modelId,
      prompt,
      sourceTurnIds: request.sourceTurnIds ?? [],
      owner,
      freshSession: true
    });

    if (
      review.caseId !== request.caseId ||
      review.providerId !== request.providerId ||
      review.modelId !== request.modelId
    ) {
      throw new Error("A research child did not match its selected connection and model.");
    }
    if (!review.contextSnapshotId || !review.sourceHash || !review.modelId) {
      throw new Error("A research child has no saved context or chosen model.");
    }
    if (revokedOwners.has(owner)) throw new Error("That research window is no longer active.");

    const token = randomBytes(32).toString("hex");
    const expiresAt = review.expiresAt;
    for (const [key, value] of pending) {
      if (value.expiresAt < clock()) pending.delete(key);
    }
    if (pending.size >= 8) {
      pending.delete(pending.keys().next().value!);
    }
    pending.set(token, {
      owner,
      caseId: request.caseId,
      question: request.question,
      prompt,
      reviews: [review],
      expiresAt,
      sources: {
        urls: collectedPages.map((p) => p.url),
        fileIds: collectedFiles.map((f) => f.id),
        sourceTurnIds: request.sourceTurnIds ?? []
      },
      omissions,
      sourceHashes
    });

    const { token: _laneToken, ...shown } = review;
    return {
      token,
      expiresAt,
      review: shown,
      reviews: [shown],
      omissions
    };
  });

  ipcMain.handle(IPC_CHANNELS.workstationResearchStart, async (event, input: unknown): Promise<{ readonly runId: string }> => {
    options.assertTrusted(event);
    const request = WorkstationReviewedStartInputSchema.parse(input);
    const manifest = pending.get(request.token);
    pending.delete(request.token);

    if (
      manifest === undefined ||
      manifest.owner !== ownerFor(event) ||
      revokedOwners.has(manifest.owner) ||
      clock() > manifest.expiresAt
    ) {
      throw new Error("That research review expired or belongs to another window. Review it again.");
    }

    if (options.checkFreshness) {
      const fresh = await options.checkFreshness(manifest.reviews[0]!);
      if (!fresh) {
        throw new Error("Research sources have changed. Review it again.");
      }
    }

    if (activeRun !== null && (activeRun.state === "planning" || activeRun.state === "working" || activeRun.state === "writing")) {
      throw new Error("The previous research is still running. Stop it or wait for its result.");
    }

    const runId = randomUUID();
    if (runs.has(runId)) {
      throw new Error("Duplicate run ID.");
    }

    // Persist parent record before starting child
    await options.persistParent({
      event: "parent",
      runId,
      caseId: manifest.caseId,
      prompt: manifest.prompt,
      brief: manifest.prompt,
      at: clock(),
      children: manifest.reviews.map((review) => {
        if (!review.contextSnapshotId || !review.sourceHash || !review.providerId || !review.modelId) {
          throw new Error("A research child has no saved context or chosen model. Nothing was sent.");
        }
        return {
          providerId: review.providerId,
          label: review.providerLabel,
          modelId: review.modelId,
          contextSnapshotId: review.contextSnapshotId,
          sourceHash: review.sourceHash
        };
      })
    });

    if (revokedOwners.has(manifest.owner)) {
      throw new Error("That research window closed before dispatch. No provider was started.");
    }

    const review = manifest.reviews[0]!;
    if (!review.contextSnapshotId || !review.sourceHash || !review.providerId || !review.modelId) {
      throw new Error("A research child has no saved context or chosen model. Nothing was sent.");
    }
    const { contextSnapshotId, sourceHash, providerId, modelId } = review;
    const run = new ReviewedResearchRunSession({
      runId,
      owner: manifest.owner,
      caseId: manifest.caseId,
      question: manifest.question,
      prompt: manifest.prompt,
      review,
      sources: manifest.sources,
      startedAt: clock()
    });

    runs.set(runId, run);
    while (runs.size > 24) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined || oldest === activeRun?.runId) break;
      runs.delete(oldest);
    }
    activeRun = run;

    void (async () => {
      if (run.controller.signal.aborted || revokedOwners.has(manifest.owner)) {
        try {
          await options.persistChild(manifest.caseId, {
            event: "child",
            runId,
            index: 0,
            state: "stopped",
            at: clock(),
            line: "Stopped before provider dispatch. No provider dispatched.",
            answerTurnId: null,
            draftTurnId: null,
            chars: 0
          });
          run.state = "stopped";
          run.headline = "Stopped before provider dispatch.";
          run.activity = "No provider dispatched.";
          run.disallowStop();
        } catch (error) {
          run.state = "failed";
          run.headline = `Could not save stopped receipt: ${toPlainErrorMessage(error)}`;
          run.disallowStop();
        }
        return;
      }

      const attempt = {
        attemptId: randomUUID(),
        contextSnapshotId,
        sourceHash,
        providerId,
        modelId
      };

      // Persist child starting before dispatch
      try {
        await options.persistChild(manifest.caseId, {
          event: "child",
          runId,
          index: 0,
          state: "starting",
          at: clock(),
          line: "Host admission pending.",
          answerTurnId: null,
          draftTurnId: null,
          chars: 0,
          attempt
        });
      } catch {
        run.state = "failed";
        run.headline = "Could not save the child intent. Nothing was sent.";
        run.disallowStop();
        return;
      }

      if (run.controller.signal.aborted || revokedOwners.has(manifest.owner)) {
        try {
          await options.persistChild(manifest.caseId, {
            event: "child",
            runId,
            index: 0,
            state: "stopped",
            at: clock(),
            line: "Stopped before provider dispatch. No provider dispatched.",
            answerTurnId: null,
            draftTurnId: null,
            chars: 0,
            attempt
          });
          run.state = "stopped";
          run.headline = "Stopped before provider dispatch.";
          run.activity = "No provider dispatched.";
          run.disallowStop();
        } catch (error) {
          run.state = "failed";
          run.headline = `Could not save stopped receipt: ${toPlainErrorMessage(error)}`;
          run.disallowStop();
        }
        return;
      }

      // No auto-approve of tool calls: WorkstationHost authority governs per-tool permissions.
      try {
        const result = await options.runChild({
          review,
          owner: manifest.owner,
          signal: run.controller.signal,
          onActivity: (line) => {
            run.activity = line;
          }
        });

        const completed = nativeAskCompleted(result);
        const stopped = result.finishReason === "stopped";

        run.endedAt = clock();
        run.nativeOutcomes.push(result);

        if (completed) {
          await options.persistChild(manifest.caseId, {
            event: "child",
            runId,
            index: 0,
            state: "answered",
            at: clock(),
            line: result.text.trim().split(/\r?\n/u)[0] ?? "Answer received.",
            answerTurnId: result.turnId,
            draftTurnId: null,
            chars: result.text.length,
            attempt
          });
          run.state = "done";
          run.headline = "Research complete.";
          run.answer = result.text;
          run.answerTurnId = result.turnId;
          run.disallowStop();
          if (options.record) {
            await options.record({ caseId: manifest.caseId, body: result.text }).catch(() => undefined);
          }
        } else if (stopped || run.controller.signal.aborted) {
          run.unanswered = [manifest.question];
          await options.persistChild(manifest.caseId, {
            event: "child",
            runId,
            index: 0,
            state: "stopped",
            at: clock(),
            line: "Stopped.",
            answerTurnId: null,
            draftTurnId: result.turnId,
            chars: result.text.length,
            attempt
          });
          run.state = "stopped";
          run.headline = nativeAskDetail(result);
          run.answer = result.text.trim().length > 0 ? result.text : null;
          run.disallowStop();
          if (result.text.trim().length > 0 && options.record) {
            await options.record({
              caseId: manifest.caseId,
              body: `${result.text}\n\n---\nPartial research draft (stopped): ${nativeAskDetail(result)}`
            }).catch(() => undefined);
          }
        } else {
          run.unanswered = [manifest.question];
          await options.persistChild(manifest.caseId, {
            event: "child",
            runId,
            index: 0,
            state: "failed",
            at: clock(),
            line: nativeAskDetail(result),
            answerTurnId: null,
            draftTurnId: result.turnId,
            chars: result.text.length,
            attempt
          });
          run.state = "failed";
          run.headline = nativeAskDetail(result);
          run.disallowStop();
        }
      } catch (error) {
        // Incomplete child receipt on crash is marked interrupted and never silently replayed.
        run.state = "failed";
        run.headline = `The host result needs inspection: ${toPlainErrorMessage(error)}`;
        run.endedAt = clock();
        run.disallowStop();
        const turnId = (typeof error === "object" && error !== null && "turnId" in error && typeof (error as { turnId: unknown }).turnId === "string")
          ? (error as { turnId: string }).turnId
          : null;
        try {
          await options.persistChild(manifest.caseId, {
            event: "child",
            runId,
            index: 0,
            state: "interrupted",
            at: clock(),
            line: run.headline,
            answerTurnId: null,
            draftTurnId: turnId,
            chars: 0,
            attempt
          });
        } catch {}
      }
    })();

    return { runId };
  });

  ipcMain.handle(IPC_CHANNELS.workstationResearchPoll, async (event, input: unknown): Promise<ResearchRunView> => {
    options.assertTrusted(event);
    const request = WorkstationResearchPollSchema.parse(input);
    const run = runs.get(request.runId);
    if (!run) {
      if (options.recover) {
        const recovered = await options.recover(request.runId);
        if (recovered !== null) return recovered;
      }
      throw new Error("That research run is unavailable.");
    }
    if (run.owner !== ownerFor(event)) {
      throw new Error("That research run is unavailable.");
    }
    return run.toView();
  });

  ipcMain.handle(IPC_CHANNELS.workstationResearchStop, async (event, input: unknown): Promise<ResearchRunView> => {
    options.assertTrusted(event);
    const request = WorkstationResearchStopSchema.parse(input);
    const run = runs.get(request.runId);
    if (!run || run.owner !== ownerFor(event)) {
      throw new Error("That research run is unavailable.");
    }
    if (run.canStop()) {
      run.stop();
    }
    return run.toView();
  });

  const stopActive = async (): Promise<boolean> => {
    if (activeRun !== null && activeRun.canStop()) {
      activeRun.stop();
      return true;
    }
    return false;
  };

  const cancelOwner = async (owner: object | string): Promise<void> => {
    revokedOwners.add(owner);
    for (const [token, review] of pending) {
      if (review.owner === owner) pending.delete(token);
    }
    for (const run of runs.values()) {
      if (run.owner === owner && run.canStop()) {
        run.stop();
      }
    }
  };

  return {
    cancelOwner,
    stopActive,
    shutdown: async () => {
      const allOwners = new Set([...runs.values()].map((r) => r.owner));
      await Promise.allSettled([...allOwners].map((owner) => cancelOwner(owner)));
    }
  };
}

export const installReviewedResearch = installReviewedResearchRun;
