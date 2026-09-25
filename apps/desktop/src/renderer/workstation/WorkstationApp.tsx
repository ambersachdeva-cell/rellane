/** A single place to ask, bring selected context, and turn answers into saved work. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CaseRoom, CaseSourcePreview, CaseSummary, CaseTurnView, DesktopBridge, RuntimeModel } from "@cadrane/contracts";
import type { WorkstationBridge, WorkstationProvider, WorkstationProviderId, WorkstationReview, WorkstationRoutine, WorkstationSnapshot, WorkstationWorkspace } from "@cadrane/contracts";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import { RichText } from "../RichText.js";
import { RellaneMark } from "../components/RellaneMark.js";
import { checkBundledModel } from "../bundled-model-readiness.js";
import { ArtifactEditor, type EditorDraft } from "./ArtifactEditor.js";
import { loadArtifactDraft, removeArtifactDraft, saveArtifactDraft } from "./artifact-drafts.js";
import { Icon, IconButton, Modal, ProviderGlyph, type IconName } from "./ui.js";
import { ReviewPacket } from "./ReviewPacket.js";
import { summariseToolReview } from "./tool-review.js";
import { searchCommands, type CommandItem } from "./command-search.js";
import { SourceAnswer } from "./SourceAnswer.js";
import { conversationTurns, previousWorkModel } from "./conversation.js";
import { readComposerDraft, writeComposerDraft } from "./composer-drafts.js";
import { ContextPanel } from "./ContextPanel.js";
import { ImagesPanel } from "./ImagesPanel.js";
import { CreativePanel } from "./CreativePanel.js";
import { useConversationScroll } from "./useConversationScroll.js";
import { ProjectsPanel } from "./ProjectsPanel.js";
import { RoutinesPanel, type RoutineSeed } from "./RoutinesPanel.js";
import type { WorkstationProject, WorkstationProjectSaveInput, WorkstationRoutineSaveInput } from "@cadrane/contracts";
import type { BookSearchView, DeliveryPackView, FileChangeView, FilePreviewResult, ParsedTableView, TableQueryRequest, TableQueryView, WorkspaceListingView } from "@cadrane/contracts";
import { SessionsPanel } from "./SessionsPanel.js";
import { CrewPanel } from "./CrewPanel.js";
import { FilesPanel } from "./FilesPanel.js";
import { DataPanel } from "./DataPanel.js";
import { SearchPanel } from "./SearchPanel.js";
import { ProjectInsights } from "./ProjectInsights.js";
import { RoutineProposalCard } from "./GuidanceCards.js";
import { homeStarters, type Starter } from "./home-starters.js";
import { AgentRunPanel } from "./AgentRunPanel.js";
import { DispatchPanel } from "./DispatchPanel.js";
import { ComparisonView } from "./ComparisonView.js";
import { PairingPanel } from "./PairingPanel.js";
import { PublishPanel } from "./PublishPanel.js";
import { compareAnswers, type Comparison } from "./answer-compare.js";
import { buildAgentRunView } from "./agent-run-view.js";
import { ChartView } from "./ChartView.js";
import { planAgentRun } from "./agent-plan.js";
import { CrewPicker, CrewStrip } from "./CrewPicker.js";
import { CrewPlanReview } from "./CrewPlanReview.js";
import { CrewRunPanel } from "./CrewRunPanel.js";
import { TelegramPanel, type TelegramLink } from "./TelegramPanel.js";
import { AgentLibraryPanel } from "./AgentLibraryPanel.js";
import { AgentEditor } from "./AgentEditor.js";
import { KnowledgePanel } from "./KnowledgePanel.js";
import { ConnectorsPanel } from "./ConnectorsPanel.js";
import { eligibleCrewIntegrationOwners, splitForCrew, withCrewIntegrationOwner } from "./crew-split.js";
import { readAgent, checkAgentDraft } from "./agent-library.js";
import type { CrewRunPollView } from "@cadrane/contracts";
import type { AgentPollView, DispatchBoardView, PairingStatusView, PublishPreviewView, PublishFormatView } from "@cadrane/contracts";
import type { GovernedProjectMemoryCommand, GovernedProjectMemoryItem, GovernedProjectMemoryView, ProjectMemoryView, ResearchRunView, WatchView, WorkstationChangesView } from "@cadrane/contracts";
import { ResearchPanel } from "./ResearchPanel.js";
import { MemoryPanel, type Learned as LearnedForPanel } from "./MemoryPanel.js";
import { ChangesPanel } from "./ChangesPanel.js";
import { WatchPanel } from "./WatchPanel.js";
import { UsagePanel } from "./UsagePanel.js";
import { WhatsAppPanel, type WhatsAppStatus } from "./WhatsAppPanel.js";
import { tallyUsage } from "./usage-tally.js";
import { lastOperationIn } from "./last-operation.js";
import { sessionRows, type SnapshotLike } from "./running-sessions.js";
import { summariseFleet, type FleetSession } from "./fleet-summary.js";
import { buildBoard, type SeatInput } from "./crew-board.js";
import { summariseContributions, type ContributionTurn } from "./project-contributions.js";
import { onboardingView } from "./onboarding-path.js";
import { availableActions, matchActions, type ActionId } from "./quick-actions.js";
import { presentProposal, proposalKey, shouldOffer, type DismissalRecord, type ProposalLike } from "./routine-proposal.js";
import { WorkroomCanvas } from "./WorkroomCanvas.js";
import { StudioWorkspace, type StudioStage } from "./StudioWorkspace.js";
import { ProjectWorkspaceSwitcher } from "./ProjectWorkspaceSwitcher.js";
import { WorkOverview } from "./WorkOverview.js";
import "./workstation.css";
import "./workstation-panels.css";

/** The agent gets six steps; more than that is a session, not a question. */
const AGENT_STEPS_ALLOWED = 6;
type Panel = "creative" | "images" | "rename" | "models" | "routines" | "projects" | "search" | "sources" | "help" | "library" | "discard" | "sessions" | "crew" | "files" | "data" | "chart" | "insights" | "crew-plan" | "phone" | "agents" | "agent-edit" | "knowledge" | "outside" | "canvas" | "agent" | "dispatch" | "compare" | "pairing" | "publish" | "research" | "memory" | "changes" | "watch" | "usage" | "whatsapp" | null;
type Selection = WorkstationProviderId | "local";
const ACTIVE = new Set(["starting", "running", "needs-approval", "stopping"]);
const FALLBACK_FAMILY: Record<Selection, string> = { codex: "codex", claude: "claude", gemini1: "gemini", gemini2: "gemini", gemini3: "gemini", local: "local" };
const LABELS: Record<Selection, string> = { codex: "Codex", claude: "Claude", gemini1: "Gemini · 1", gemini2: "Gemini · 2", gemini3: "Gemini · 3", local: "On this Mac" };
const ROUTINE_ICONS: Record<WorkstationRoutine["icon"], IconName> = { write: "edit", research: "search", build: "code", review: "shield", data: "grid" };
const ROUTINE_COPY: Readonly<Record<string, { title: string; description: string }>> = {
  "research-brief": { title: "Make sense of research", description: "Turn your sources into a clear, traceable brief." },
  "client-proposal": { title: "Write a client proposal", description: "Shape a brief into scope, milestones and next steps." },
  "engineering-review": { title: "Get a second opinion", description: "Find the risks and gaps in a proposed change." },
  "implementation-plan": { title: "Plan your next build", description: "Break an idea into decisions and achievable steps." },
  "data-findings": { title: "Understand your data", description: "Find useful patterns and explain what they mean." },
};
function describeRoutine(routine: WorkstationRoutine): WorkstationRoutine { return { ...routine, ...ROUTINE_COPY[routine.id] }; }
/**
 * The store keeps a fact; the screen shows a card. Kept apart on purpose, and
 * mapped in exactly one place, so the words on screen can change without
 * rewriting what is on disk.
 */
const PANEL_KIND: Readonly<Record<string, LearnedForPanel["kind"]>> = {
  "about-the-business": "business",
  "about-a-person": "people",
  "a-decision": "decision",
  "a-preference": "preference",
  "a-constraint": "constraint",
};

/** A fact unconfirmed for this long is offered for review rather than trusted. */
const MEMORY_STALE_MS = 30 * 24 * 60 * 60 * 1000;

function toPanelFact(fact: ProjectMemoryView["facts"][number]): LearnedForPanel {
  return {
    id: fact.id,
    kind: PANEL_KIND[fact.kind] ?? "business",
    text: fact.text,
    source: fact.learnedFrom,
    count: fact.confirmations,
    pinned: fact.pinned,
    hidden: fact.hidden,
    lastSeen: Date.parse(fact.updatedAt) || 0,
  };
}

function api(): DesktopBridge & { workstation?: WorkstationBridge } { return window.cadrane; }
function host(): WorkstationBridge { const value = api().workstation; if (!value) throw new Error("This build does not include subscription sessions yet. Open the latest installed Rellane app."); return value; }
function problem(error: unknown): string { return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "") : "That action could not finish. Try again."; }
function source(turn: CaseTurnView): boolean { return turn.kind === "verbatim" && turn.seat.startsWith(CASE_SOURCE_SEAT_PREFIX); }
function contextLabel(turn: CaseTurnView): string { return source(turn) ? turn.seat.slice(CASE_SOURCE_SEAT_PREFIX.length) : `${turn.seat === "owner" ? "You" : turn.seat.replace(/^Workstation · /u, "")} · message ${turn.seq}`; }
function titleFor(prompt: string): string { return prompt.trim().split("\n")[0]?.slice(0, 100) || "Untitled work"; }
function relativeTime(at: number): string { const days = Math.floor((Date.now() - at) / 86_400_000); return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? `${days} days ago` : new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" }); }
function storedTheme(): "light" | "dark" { try { return localStorage.getItem("rellane.workstation.appearance") === "dark" ? "dark" : "light"; } catch { return "light"; } }
const GUIDE_KEY = "rellane.workstation.guide-dismissed";
const DISMISSALS_KEY = "rellane.workstation.routine-dismissals";
function storedGuideDismissed(): boolean { try { return localStorage.getItem(GUIDE_KEY) === "yes"; } catch { return false; } }
/** A refused suggestion stays refused across restarts, or it is not a refusal. */
function storedDismissals(): readonly DismissalRecord[] {
  try {
    const raw = localStorage.getItem(DISMISSALS_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap(entry =>
      typeof entry === "object" && entry !== null && typeof (entry as DismissalRecord).key === "string"
        ? [{ key: (entry as DismissalRecord).key, count: Number((entry as DismissalRecord).count) || 1, lastAt: Number((entry as DismissalRecord).lastAt) || 0 }]
        : []);
  } catch { return []; }
}
/** Significant words, for deciding whether two requests are the same request. */
function significantWords(text: string): readonly string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/u).filter(word => word.length > 3))];
}
function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return 0;
  const other = new Set(b);
  return a.filter(word => other.has(word)).length / a.length;
}


/**
 * Marks the characters a fuzzy match actually landed on.
 *
 * Without this a typo-tolerant result looks arbitrary — the owner types one
 * thing, sees another, and cannot tell why it came back.
 */
function markRanges(text: string, ranges: readonly (readonly [number, number])[]) {
  if (ranges.length === 0) return text;
  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) pieces.push(text.slice(cursor, start));
    pieces.push(<mark key={index} className="ws-search-hit">{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return pieces;
}

export function WorkstationApp({ onTools, active = true }: { onTools: () => void; active?: boolean }) {
  const [theme, setTheme] = useState(storedTheme);
  const [cases, setCases] = useState<readonly CaseSummary[]>([]);
  const [room, setRoom] = useState<CaseRoom | null>(null);
  const [initialDraft] = useState(() => {
    try { return { value: readComposerDraft(localStorage, "new:personal"), error: "" }; }
    catch { return { value: null, error: "Your previous draft could not be read. Copy any unsaved work before closing." }; }
  });
  const [draft, setDraft] = useState(initialDraft.value?.text ?? "");
  const [selected, setSelected] = useState<readonly string[]>(initialDraft.value?.selected ?? []);
  const [draftSaved, setDraftSaved] = useState(!initialDraft.error);
  const [providers, setProviders] = useState<readonly WorkstationProvider[]>([]);
  const [providerId, setProviderId] = useState<Selection>("codex");
  const [modelId, setModelId] = useState("");
  const [enableTools, setEnableTools] = useState(false);
  const [workspace, setWorkspace] = useState<WorkstationWorkspace | null>(null);
  const [routines, setRoutines] = useState<readonly WorkstationRoutine[]>([]);
  const [continuity, setContinuity] = useState<Awaited<ReturnType<WorkstationBridge["continuity"]>>>({ projects: [], links: [], routines: [] });
  const [newProjectId, setNewProjectId] = useState<string | null>(null);
  const [projectPanelId, setProjectPanelId] = useState<string | null>(null);
  const [routineSeed, setRoutineSeed] = useState<RoutineSeed | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [citationId, setCitationId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [workTitle, setWorkTitle] = useState("");
  const [renameProblem, setRenameProblem] = useState("");
  const [status, setStatus] = useState<WorkstationSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(initialDraft.error);
  const [review, setReview] = useState<WorkstationReview | null>(null);
  const [dispatchReview, setDispatchReview] = useState<Awaited<ReturnType<WorkstationBridge["dispatchPrepare"]>> | null>(null);
  const [agentReview, setAgentReview] = useState<Awaited<ReturnType<WorkstationBridge["agentPrepare"]>> | null>(null);
  const [crewReview, setCrewReview] = useState<Awaited<ReturnType<WorkstationBridge["crewPrepare"]>> | null>(null);
  const [researchReview, setResearchReview] = useState<Awaited<ReturnType<WorkstationBridge["researchPrepare"]>> | null>(null);
  const [crewModelPicker, setCrewModelPicker] = useState(false);
  const [crewModelIds, setCrewModelIds] = useState<Record<string, string>>({});
  const [crewRoles, setCrewRoles] = useState<Record<string, string>>({});
  const [crewExpectedOutputs, setCrewExpectedOutputs] = useState<Record<string, string>>({});
  const [crewIntegrationOwner, setCrewIntegrationOwner] = useState("");
  const [filePreview, setFilePreview] = useState<CaseSourcePreview | null>(null);
  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [savedBody, setSavedBody] = useState("");
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioStage, setStudioStage] = useState<StudioStage>("direction");
  const [localModels, setLocalModels] = useState<readonly RuntimeModel[]>([]);
  const [checkingLocal, setCheckingLocal] = useState(false);
  const [localOperation, setLocalOperation] = useState<string | null>(null);
  const [library, setLibrary] = useState<readonly CaseRoom[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  // Everything working right now, across every case — not just this one.
  const [live, setLive] = useState<readonly WorkstationSnapshot[]>([]);
  const [panelBusy, setPanelBusy] = useState(false);
  const [listing, setListing] = useState<WorkspaceListingView | null>(null);
  const [filePreviewText, setFilePreviewText] = useState<FilePreviewResult | null>(null);
  const [fileDiff, setFileDiff] = useState<FileChangeView | null>(null);
  const [table, setTable] = useState<ParsedTableView | null>(null);
  const [tableSourceId, setTableSourceId] = useState<string | null>(null);
  const [tableResult, setTableResult] = useState<TableQueryView | null>(null);
  const [contentHits, setContentHits] = useState<BookSearchView | null>(null);
  const [pack, setPack] = useState<DeliveryPackView | null>(null);
  const [guideDismissed, setGuideDismissed] = useState(storedGuideDismissed);
  const [dismissals, setDismissals] = useState<readonly DismissalRecord[]>(storedDismissals);
  const seenText = useRef(new Map<string, string>());
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [agentGoal, setAgentGoal] = useState("");
  const [agentExpectedOutput, setAgentExpectedOutput] = useState("");
  const [selectedSavedAgent, setSelectedSavedAgent] = useState<{
    readonly id: string;
    readonly origin: "bundled" | "user";
    readonly revision: string;
  } | null>(null);
  const [agentPoll, setAgentPoll] = useState<AgentPollView | null>(null);
  const [dispatchRunId, setDispatchRunId] = useState<string | null>(null);
  const [dispatchBoard, setDispatchBoard] = useState<DispatchBoardView | null>(null);
  const [answers, setAnswers] = useState<readonly { readonly providerId: string; readonly text: string }[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [pairing, setPairing] = useState<PairingStatusView>({ state: "off" });
  const [publishPreview, setPublishPreview] = useState<PublishPreviewView | null>(null);
  const [researchRunId, setResearchRunId] = useState<string | null>(null);
  const [researchRun, setResearchRun] = useState<ResearchRunView | null>(null);
  const [memory, setMemory] = useState<ProjectMemoryView | null>(null);
  const [governedMemory, setGovernedMemory] = useState<GovernedProjectMemoryView | null>(null);
  const [governedLoading, setGovernedLoading] = useState(false);
  const [governedError, setGovernedError] = useState<string | null>(null);
  const [memoryDraftsByProject, setMemoryDraftsByProject] = useState<
    Record<string, { kind: GovernedProjectMemoryItem["kind"]; text: string; id?: string; expectedRevision?: number }>
  >({});
  const memoryReqSeq = useRef(0);
  const memoryProjectIdRef = useRef<string | null>(null);
  const [changes, setChanges] = useState<WorkstationChangesView | null>(null);
  const [changeDiff, setChangeDiff] = useState<{ readonly relativePath: string; readonly before: string; readonly after: string } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [watches, setWatches] = useState<readonly WatchView[]>([]);
  const [watchChecking, setWatchChecking] = useState(false);
  const [watchFound, setWatchFound] = useState<ReadonlyMap<string, string>>(new Map());
  const [usageWindow, setUsageWindow] = useState<"today" | "week" | "month">("week");
  const [usage, setUsage] = useState<ReturnType<typeof tallyUsage> | null>(null);
  const [whatsApp, setWhatsApp] = useState<WhatsAppStatus>({ configured: false, encryptionAvailable: true, canReceive: false, phoneNumberId: null });
  const [whatsAppProblem, setWhatsAppProblem] = useState<string | null>(null);
  /** Bots he has chosen, in the order he chose them. One is ordinary; several is a crew. */
  const [crewSeats, setCrewSeats] = useState<readonly WorkstationProviderId[]>([]);
  const [crewRunId, setCrewRunId] = useState<string | null>(null);
  const [crewRun, setCrewRun] = useState<CrewRunPollView | null>(null);
  const [crewAnswers, setCrewAnswers] = useState<readonly { readonly partId: string; readonly text: string }[]>([]);
  const [agents, setAgents] = useState<Awaited<ReturnType<WorkstationBridge["agentsList"]>>["agents"]>([]);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [editingAgentOrigin, setEditingAgentOrigin] = useState<"bundled" | "user">("user");
  const [agentDraft, setAgentDraft] = useState("");
  const [agentSavedAt, setAgentSavedAt] = useState<number | null>(null);
  const [phoneLink, setPhoneLink] = useState<TelegramLink>({ state: "off" });
  const [phoneProblem, setPhoneProblem] = useState<string | null>(null);
  /**
   * What the phone may do, from the part of the app that decides it.
   *
   * This screen used to state the list itself, in its own words, and the two
   * had already drifted apart. A screen that tells him what his phone can do
   * without asking is a claim, not a report — and this is the one screen where
   * being wrong about that matters most.
   */
  const [phonePowers, setPhonePowers] = useState<{ readonly mayDo: readonly string[]; readonly mayNotDo: readonly string[] } | null>(null);
  const [phoneKnocks, setPhoneKnocks] = useState<readonly { readonly chatId: string; readonly from: string; readonly at: number }[]>([]);
  const composer = useRef<HTMLTextAreaElement>(null);
  const drafts = useRef(new Map<string, string>());
  const lastDraftWrite = useRef({ key: "new:personal", text: initialDraft.value?.text ?? "", selected: JSON.stringify(initialDraft.value?.selected ?? []) });
  const choices = useRef(new Map<string, { selected: readonly string[]; workspace: WorkstationWorkspace | null; ai: { providerId: Selection; modelId: string } }>());
  const roomRef = useRef(room);
  roomRef.current = room;
  const currentId = room?.case?.id;
  const draftKey = currentId ?? `new:${newProjectId ?? "personal"}`;
  const project = continuity.projects.find(value => value.id === (currentId ? continuity.links.find(link => link.caseId === currentId)?.projectId : newProjectId));
  const currentProjectId = project?.id ?? null;
  useEffect(() => {
    if (memoryProjectIdRef.current !== currentProjectId) {
      memoryProjectIdRef.current = currentProjectId;
      setMemory(null);
      setGovernedMemory(null);
      setGovernedError(null);
      const reqSeq = ++memoryReqSeq.current;
      if (panel === "memory" || studioOpen) {
        setPanelBusy(true);
        if (currentProjectId) {
          setGovernedLoading(true);
        }
        void (async () => {
          try {
            const [legacyResult, governedResult] = await Promise.allSettled([
              host().memoryRead({ projectId: currentProjectId ?? "personal" }),
              currentProjectId
                ? (async () => {
                    const bridge = host() as unknown as { memoryGoverned?: (cmd: GovernedProjectMemoryCommand) => Promise<GovernedProjectMemoryView> };
                    if (typeof bridge.memoryGoverned !== "function") {
                      throw new Error("Canonical project memory is unavailable.");
                    }
                    return bridge.memoryGoverned({ action: "read", projectId: currentProjectId });
                  })()
                : Promise.resolve(null)
            ]);
            if (memoryReqSeq.current === reqSeq && memoryProjectIdRef.current === currentProjectId) {
              if (legacyResult.status === "fulfilled") {
                setMemory(legacyResult.value);
              } else {
                setMemory(null);
                setNotice(problem(legacyResult.reason));
              }
              if (currentProjectId) {
                if (governedResult.status === "fulfilled" && governedResult.value) {
                  setGovernedMemory(governedResult.value);
                } else if (governedResult.status === "rejected") {
                  setGovernedMemory(null);
                  setGovernedError(problem(governedResult.reason));
                }
              }
            }
          } finally {
            if (memoryReqSeq.current === reqSeq) {
              setPanelBusy(false);
              setGovernedLoading(false);
            }
          }
        })();
      }
    }
  }, [currentProjectId, panel, studioOpen]);
  const lastRequest = room?.turns.filter(turn => turn.kind === "verbatim" && turn.seat === "owner").at(-1);
  const running = (status !== null && ACTIVE.has(status.status)) || localOperation !== null;
  const dirty = editor !== null && editor.body.trim().length > 0 && (editor.body !== savedBody || editor.baseVersionId === null);
  const pickedProvider = providers.find(value => value.id === providerId);
  const openCases = cases.filter(value => !value.closedAt);
  const label = providerId === "local" ? "On this Mac" : pickedProvider?.label ?? LABELS[providerId];
  const turns = conversationTurns(room?.turns ?? [], room?.case?.question);
  const sources = room?.turns.filter(turn => turn.kind === "verbatim") ?? [];
  const empty = turns.length === 0 && !running;
  const conversationScroll = useConversationScroll(currentId, empty);
  const citation = sources.find(turn => turn.id === citationId);

  const refreshCases = useCallback(async () => { const result = await api().cases.list(); setCases(result.cases); }, []);
  const refreshContinuity = useCallback(async () => { setContinuity(await host().continuity()); }, []);
  const routineVersions = useCallback((id: string) => host().routineVersions({ id }), []);
  const message = useCallback((text: string) => setNotice(text), []);
  useEffect(() => {
    let disposed = false;
    async function load() {
      if (!window.cadrane) { setNotice("Open Rellane on your Mac to use your work and AI connections."); setLoading(false); return; }
      const results = await Promise.allSettled([api().cases.list(), host().providers(), host().routines(), host().continuity()]);
      if (disposed) return;
      const [history, engines, catalogue, savedWork] = results;
      if (savedWork.status === "fulfilled") setContinuity(savedWork.value);
      else setNotice(problem(savedWork.reason));
      if (history.status === "fulfilled") setCases(history.value.cases);
      else setNotice(problem(history.reason));
      if (engines.status === "fulfilled") {
        setProviders(engines.value);
        const first = engines.value.find(value => value.state === "detected");
        if (first) setProviderId(first.id);
      } else setNotice(problem(engines.reason));
      if (catalogue.status === "fulfilled") setRoutines(catalogue.value.map(describeRoutine));
      setLoading(false);
    }
    void load().catch(error => { if (!disposed) { setNotice(problem(error)); setLoading(false); } });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!currentId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let previous = "";
    async function poll() {
      try {
        const next = await host().state({ caseId: currentId! });
        if (disposed) return;
        setStatus(next);
        const signature = `${next?.operationId}:${next?.status}`;
        if (next && !ACTIVE.has(next.status) && signature !== previous) {
          const updated = await api().cases.read({ id: currentId! });
          if (!disposed) { setRoom(updated); void refreshCases().catch(error => message(problem(error))); }
        }
        previous = signature;
        if (!disposed) timer = setTimeout(() => void poll(), next && ACTIVE.has(next.status) ? 350 : 1800);
      } catch (error) {
        if (!disposed) { setNotice(problem(error)); timer = setTimeout(() => void poll(), 4000); }
      }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [currentId, refreshCases, message]);
  /**
   * What the whole machine is doing, in one call.
   *
   * The per-case poll above answers for the room the owner is looking at. This
   * one answers for the rest of them, which is the only way a second session
   * can say it needs an approval while the owner is somewhere else. It costs a
   * single call, so it runs whenever this screen is in front — otherwise the
   * badge would only be true while the panel that shows it is already open.
   */
  useEffect(() => {
    if (!active || !window.cadrane) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const fast = panel === "sessions" || panel === "crew";
    async function poll() {
      try {
        const next = await host().running();
        if (disposed) return;
        setLive(next);
      } catch {
        // A fleet view that cannot be read is empty, not an error banner: the
        // owner did not ask for it, and the room they are in still works.
        if (!disposed) setLive([]);
      }
      if (!disposed) timer = setTimeout(() => void poll(), fast ? 900 : 2600);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [active, panel]);
  useEffect(() => {
    const previous = lastDraftWrite.current;
    const selectedText = JSON.stringify(selected);
    // The initial read is not a write: an unreadable draft is never erased on mount.
    if (previous.key === draftKey && previous.text === draft && previous.selected === selectedText) return;
    try {
      writeComposerDraft(localStorage, draftKey, { text: draft, selected });
      lastDraftWrite.current = { key: draftKey, text: draft, selected: selectedText };
      setDraftSaved(true);
    } catch { setDraftSaved(false); }
  }, [draftKey, draft, selected]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      let saved = draftSaved;
      const previous = lastDraftWrite.current;
      if (previous.key !== draftKey || previous.text !== draft || previous.selected !== JSON.stringify(selected)) {
        try { writeComposerDraft(localStorage, draftKey, { text: draft, selected }); saved = true; }
        catch { saved = false; }
      }
      if (dirty || (!saved && (draft.length > 0 || selected.length > 0))) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, draftKey, draft, selected, draftSaved]);
  useEffect(() => {
    if (!active || !window.cadrane) return;
    void refreshCases().catch(error => message(problem(error)));
    const id = roomRef.current?.case?.id;
    if (id) void api().cases.read({ id }).then(value => setRoom(value)).catch(error => message(problem(error)));
  }, [active, refreshCases, message]);
  useEffect(() => {
    function keys(event: KeyboardEvent) {
      if (!active) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!panel && !review && !filePreview && !citationId) setPanel("search");
      }
      if (event.key === "Escape" && !panel && !review && !filePreview) composer.current?.focus();
    }
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [active, panel, review, filePreview, citationId]);

  function rememberDraft() {
    if (initialDraft.error && draftKey === "new:personal" && !draftSaved && !draft && selected.length === 0)
      throw new Error("The previous draft has not been read.");
    writeComposerDraft(localStorage, draftKey, { text: draft, selected });
    drafts.current.set(draftKey, draft);
    choices.current.set(draftKey, { selected, workspace, ai: { providerId, modelId } });
  }
  useEffect(() => {
    const erased = (event: Event) => {
      const id: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof id !== "string") return;
      drafts.current.delete(id); choices.current.delete(id);
      if (roomRef.current?.case?.id === id) {
        setRoom(null); setDraft(drafts.current.get("new:personal") ?? ""); setSelected([]); setWorkspace(null); setEditor(null); setStudioOpen(false); setStatus(null);
        setNewProjectId(null);
      }
      void refreshCases().catch(error => message(problem(error)));
    };
    window.addEventListener("rellane:case-erased", erased);
    return () => window.removeEventListener("rellane:case-erased", erased);
  }, [refreshCases, message]);
  function canNavigate(): boolean {
    if (busy || running) { message("Finish or stop the current response before switching work."); return false; }
    if (dirty) { message("Save your output, or close its editor, before switching work."); return false; }
    try { rememberDraft(); return true; } catch { setDraftSaved(false); message("Your draft could not be saved. Copy it before leaving this work."); return false; }
  }
  function newWork(projectId: string | null = null) {
    if (!canNavigate()) return;
    const key = `new:${projectId ?? "personal"}`;
    let saved;
    try { saved = readComposerDraft(localStorage, key); }
    catch { message("That draft could not be read. Your current work is still here."); return; }
    setRoom(null); setStatus(null); setEditor(null); setStudioOpen(false); setPanel(null); setSelected([]); setWorkspace(null); setLocalOperation(null); setEnableTools(false);
    setNewProjectId(projectId); setDraft(drafts.current.get(key) ?? saved?.text ?? ""); setNotice(""); conversationScroll.latest();
    requestAnimationFrame(() => composer.current?.focus());
  }
  async function openWork(id: string, openOutput = false) {
    if (!canNavigate()) return;
    setBusy(true);
    try {
      const [next, lastSession] = await Promise.all([api().cases.read({ id }), host().state({ caseId: id })]);
      const saved = readComposerDraft(localStorage, id);
      setRoom(next); setStatus(null); setPanel(null); setEditor(null); setStudioOpen(false); setDraft(drafts.current.get(id) ?? saved?.text ?? ""); setNotice(""); setLocalOperation(null);
      const choice = choices.current.get(id);
      const previousAI = choice?.ai ?? previousWorkModel(next.turns, lastSession?.caseId === id ? lastSession : null);
      if (previousAI) { setProviderId(previousAI.providerId); setModelId(previousAI.modelId); }
      const available = new Set(next.turns.filter(turn => turn.kind === "verbatim").map(turn => turn.id));
      setSelected((choice?.selected ?? saved?.selected ?? []).filter(id => available.has(id)));
      setWorkspace(choice?.workspace ?? null);
      conversationScroll.latest();
      if (openOutput && next.artifacts[0]) { const value = next.artifacts[0]; const recovered = loadArtifactDraft(id); setEditor(recovered.status === "loaded" ? recovered.draft : { body: value.body, sourceTurnId: value.sourceTurnId, baseVersionId: value.id }); setSavedBody(value.body); }
    } catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function ensureRoom(): Promise<{ value: CaseRoom; sourceIds: readonly string[] }> {
    if (roomRef.current?.case) return { value: roomRef.current, sourceIds: selected };
    let value = await api().cases.open({ title: titleFor(draft), question: draft.trim() || "Work with selected files" });
    roomRef.current = value; setRoom(value);
    const sourceIds: string[] = [];
    if (project && value.case) {
      await host().assignProject({ caseId: value.case.id, projectId: project.id });
      try {
        const captured = await host().captureProjectBrief({ caseId: value.case.id, expectedRevision: project.revision });
        sourceIds.push(captured.sourceTurnId);
        value = await api().cases.read({ id: value.case.id });
        roomRef.current = value; setRoom(value); setSelected(sourceIds);
      } finally { await refreshContinuity(); }
    }
    if (value.case) {
      // Save the new task's draft before removing its original new-work copy.
      try {
        writeComposerDraft(localStorage, value.case.id, { text: draft, selected: sourceIds });
        writeComposerDraft(localStorage, draftKey, { text: "", selected: [] });
        drafts.current.delete(draftKey);
      } catch { setDraftSaved(false); message("Your draft is visible here, but could not be fully saved. Copy it before closing."); }
    }
    await refreshCases(); return { value, sourceIds };
  }
  async function openImages(creative = false) {
    if (busy || running) return;
    setBusy(true);
    try { const { value } = await ensureRoom(); if (value.case) setPanel(creative ? "creative" : "images"); }
    catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function addFile() {
    if (busy || running) return;
    setBusy(true); setNotice("");
    try { const { value } = await ensureRoom(); if (value.case) setFilePreview(await api().cases.previewSource({ id: value.case.id })); }
    catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function acceptFile() {
    if (!currentId || !filePreview || busy) return;
    setBusy(true);
    try {
      const before = new Set(room?.turns.map(turn => turn.id));
      const next = await api().cases.addSource({ id: currentId, token: filePreview.token });
      setRoom(next); setSelected(previous => [...new Set([...previous, ...next.turns.filter(turn => source(turn) && !before.has(turn.id)).map(turn => turn.id)])]);
      setFilePreview(null); message("File added. You’ll review it before sending it to a subscription.");
    } catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function cancelFile() {
    const previous = filePreview; setFilePreview(null);
    if (currentId && previous) try { await api().cases.discardSource({ id: currentId, token: previous.token }); } catch (error) { message(problem(error)); }
  }
  async function chooseWorkspace() {
    try { const value = await host().chooseWorkspace(); if (value) setWorkspace(value); }
    catch (error) { message(problem(error)); }
  }
  async function revealWorkspace() {
    if (!currentId) return;
    try { await host().revealWorkspace({ caseId: currentId, ...(workspace ? { workspaceId: workspace.id } : {}) }); }
    catch (error) { message(problem(error)); }
  }
  async function prepareSend() {
    if (!draft.trim() || busy || running || room?.case?.closedAt) return;
    const trimmed = draft.trim();
    if (trimmed === "/canvas" || trimmed.startsWith("/canvas ")) {
      setDraft(""); setPanel("canvas"); return;
    }
    setBusy(true); setNotice("");
    try {
      const { value, sourceIds } = await ensureRoom(); if (!value.case) throw new Error("The work could not be opened.");
      if (providerId === "local") {
        if (!modelId) throw new Error("Choose an installed local model first.");
        if (draft.length > 4000) throw new Error("The local model accepts requests up to 4,000 characters. Shorten this request or choose a subscription.");
        const operationId = crypto.randomUUID(); conversationScroll.latest(); setLocalOperation(operationId);
        const prompt = draft; setDraft(""); drafts.current.delete(draftKey);
        void api().cases.askLocal({ id: value.case.id, operationId, modelId, question: prompt, sourceTurnIds: [...sourceIds] }).then(next => {
          if (roomRef.current?.case?.id === value.case?.id) setRoom(next);
          void refreshCases().catch(error => message(problem(error)));
        }).catch(error => { setDraft(previous => previous || prompt); message(problem(error)); }).finally(() => setLocalOperation(null));
      } else {
        if (!modelId.trim()) throw new Error("Choose a model for this connection before reviewing.");
        setReview(await host().prepare({ caseId: value.case.id, providerId, modelId: modelId.trim(), prompt: draft, sourceTurnIds: [...sourceIds], ...(workspace ? { workspaceId: workspace.id } : {}), ...(providerId === "codex" && enableTools ? { enableTools: true } : {}) }));
      }
    } catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function sendReviewed() {
    if (!review || busy) return;
    setBusy(true);
    const token = review.token;
    try {
      const result = await host().start({ token });
      setStatus(result); setReview(null); setDraft(""); drafts.current.delete(draftKey); drafts.current.delete(`new:${newProjectId ?? "personal"}`); conversationScroll.latest();
      if (currentId) setRoom(await api().cases.read({ id: currentId }));
      await refreshCases();
    } catch (error) { setReview(null); message(problem(error)); }
    finally { setBusy(false); }
  }
  async function stop() {
    try {
      if (currentId && localOperation) { await api().cases.stopLocal({ id: currentId, operationId: localOperation }); }
      else if (status && currentId) setStatus(await host().stop({ caseId: currentId, operationId: status.operationId }));
    } catch (error) { message(problem(error)); }
  }
  async function decide(allow: boolean) {
    if (!status?.permission) return;
    setBusy(true);
    try { setStatus(await host().decide({ operationId: status.operationId, permissionId: status.permission.id, allow })); }
    catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  function openEditor(body: string, sourceTurnId: string | null) {
    if (dirty) { message("Save or close your current output before opening another."); return; }
    const latest = room?.artifacts[0];
    const recovered = room?.case ? loadArtifactDraft(room.case.id) : null;
    setEditor(recovered?.status === "loaded" ? recovered.draft : { body, sourceTurnId, baseVersionId: latest?.id ?? null }); setSavedBody(latest?.body ?? "");
    if (recovered?.status === "loaded") message("Recovered your unfinished output draft.");
  }
  function openStudio() {
    if (!room?.case) return;
    if (!editor) {
      const latest = room.artifacts[0];
      const recovered = loadArtifactDraft(room.case.id);
      setEditor(recovered.status === "loaded" ? recovered.draft : { body: latest?.body ?? "", sourceTurnId: latest?.sourceTurnId ?? null, baseVersionId: latest?.id ?? null });
      setSavedBody(latest?.body ?? "");
      if (recovered.status === "loaded") message("Recovered your unfinished output draft.");
    }
    setStudioStage("direction");
    setStudioOpen(true);
    if (!project) return;
    const targetProjectId = project.id;
    memoryProjectIdRef.current = targetProjectId;
    const reqSeq = ++memoryReqSeq.current;
    setGovernedLoading(true);
    setGovernedError(null);
    void host().memoryGoverned({ action: "read", projectId: targetProjectId }).then(value => {
      if (memoryReqSeq.current === reqSeq && memoryProjectIdRef.current === targetProjectId) setGovernedMemory(value);
    }).catch(error => {
      if (memoryReqSeq.current === reqSeq) setGovernedError(problem(error));
    }).finally(() => {
      if (memoryReqSeq.current === reqSeq) setGovernedLoading(false);
    });
  }
  function closeEditor() { if (dirty) setPanel("discard"); else setEditor(null); }
  function keepOutputDraftAndClose() {
    if (!currentId || !editor) return;
    const saved = saveArtifactDraft(currentId, editor);
    if (!saved.success) { message(saved.error); return; }
    setEditor(null);
    setPanel(null);
  }
  function savedOutput(next: CaseRoom, updatedDraft: EditorDraft) {
    setRoom(next); const latest = next.artifacts[0];
    if (latest) { setEditor(updatedDraft); setSavedBody(latest.body); }
  }
  async function loadLibrary() {
    setPanel("library"); setLibraryLoading(true);
    try { const results = await Promise.allSettled(cases.slice(0, 30).map(value => api().cases.read({ id: value.id }))); setLibrary(results.flatMap(value => value.status === "fulfilled" && value.value.artifacts.length ? [value.value] : [])); }
    finally { setLibraryLoading(false); }
  }
  async function checkLocal() {
    setCheckingLocal(true);
    try { const values = await checkBundledModel(() => api().runtimes.discover(), new AbortController().signal, () => undefined); setLocalModels(values); if (!values.length) message("No local model is ready. Open More tools → Models to check its setup."); }
    catch (error) { message(problem(error)); }
    finally { setCheckingLocal(false); }
  }
  function useRoutine(value: WorkstationRoutine) {
    if (busy || running || room?.case?.closedAt) { message("Start new work, or finish the current response, before choosing a routine."); return "Start new work, or finish the current response, before choosing a routine."; }
    if (draft.trim()) { message("Your draft is still here. Start new work before replacing it with a routine."); return "Your current request has unsent text. Close routines to keep editing it, or start new work before choosing a routine."; }
    setDraft(value.prompt); setPanel(null); setRoutineSeed(null); requestAnimationFrame(() => composer.current?.focus()); return null;
  }
  function editWorkTitle() {
    if (!room?.case || !canNavigate()) return;
    setWorkTitle(room.case.title); setRenameProblem(""); setPanel("rename");
  }
  async function saveWorkTitle() {
    if (!room?.case || busy || !workTitle.trim()) return;
    setBusy(true); setRenameProblem("");
    try {
      await host().renameWork({caseId: room.case.id, title: workTitle, expectedTitle: room.case.title});
      setRoom(await api().cases.read({id: room.case.id})); await refreshCases(); setPanel(null);
    } catch (error) { setRenameProblem(problem(error)); }
    finally { setBusy(false); }
  }
  async function saveProject(input: WorkstationProjectSaveInput) {
    const value = await host().saveProject(input); await refreshContinuity(); return value;
  }
  async function saveRoutine(input: WorkstationRoutineSaveInput) {
    const value = await host().saveRoutine(input); await refreshContinuity(); return value;
  }
  async function useProjectBrief(value: WorkstationProject) {
    if (busy || running) throw new Error("Finish or stop the current response before changing its project context.");
    if (!currentId) { newWork(value.id); return; }
    setBusy(true);
    try {
      await host().assignProject({ caseId: currentId, projectId: value.id });
      const captured = await host().captureProjectBrief({ caseId: currentId, expectedRevision: value.revision });
      const next = await api().cases.read({ id: currentId });
      const oldBriefIds = new Set(next.turns.filter(turn => turn.seat.startsWith(`${CASE_SOURCE_SEAT_PREFIX}Project brief · `)).map(turn => turn.id));
      setRoom(next); setSelected(previous => [...previous.filter(id => !oldBriefIds.has(id)), captured.sourceTurnId]);
      setPanel(null); message(`Shared brief v${captured.project.revision} added to context. You’ll review it before sending.`);
    } finally { try { await refreshContinuity(); } finally { setBusy(false); } }
  }
  function showProjects(id: string | null = null) {
    setProjectPanelId(id); setPanel("projects");
  }
  function saveRequestAsRoutine() {
    if (!currentId || !lastRequest || !canNavigate()) return;
    setRoutineSeed({title: room?.case?.title ?? "A useful procedure", prompt: lastRequest.body, originCaseId: currentId, originTurnId: lastRequest.id}); setPanel("routines");
  }
  async function stopOne(operationId: string) {
    const row = liveRows.find(value => value.operationId === operationId);
    if (!row) return;
    try {
      const next = await host().stop({ caseId: row.caseId, operationId });
      if (row.caseId === currentId) setStatus(next);
      setLive(await host().running());
    } catch (error) { message(problem(error)); }
  }

  /**
   * Opening the work a session belongs to.
   *
   * `openWork` refuses while something is running here, which is right for a
   * click in the history list and wrong for this: the whole point of the panel
   * is to reach a session that is asking for something somewhere else.
   */
  async function goToSession(caseId: string) {
    setPanel(null);
    if (caseId === currentId) return;
    await openWork(caseId);
  }

  /**
   * Going and reading, rather than answering from what a model remembers.
   *
   * Started from whatever is in the box, because that is where the question
   * already is. The run keeps going if this panel is closed; reopening shows
   * where it got to.
   */
  async function startResearch() {
    if (!currentId) { message("Open a piece of work first — the answer is written into it."); return; }
    const question = draft.trim();
    if (question.length === 0) { message("Type what you want looked up, then press Look it up."); return; }
    if (providerId === "local" || pickedProvider?.state !== "detected" || !modelId.trim()) {
      message("Choose a subscription connection and its model before reviewing research."); return;
    }
    if (selected.length === 0) { message("Select at least one saved source for this research."); return; }
    setPanel("research"); setPanelBusy(true); setResearchRun(null);
    try {
      setResearchReview(await host().researchPrepare({ caseId: currentId, question,
        providerId, modelId: modelId.trim(), sourceTurnIds: [...selected], depth: "quick" }));
    } catch (error) { setResearchRunId(null); message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function startReviewedResearch() {
    if (researchReview === null) return;
    setPanelBusy(true);
    try {
      const started = await host().researchStart({ token: researchReview.token });
      setResearchReview(null); setResearchRunId(started.runId); setDraft("");
      setResearchRun(await host().researchPoll({ runId: started.runId }));
    } catch (error) { setResearchRunId(null); message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function stopResearch() {
    if (!researchRunId) return;
    setPanelBusy(true);
    try { setResearchRun(await host().researchStop({ runId: researchRunId })); }
    catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  function keepResearch() {
    setPanel(null); setResearchRunId(null); setResearchRun(null);
    if (currentId) void api().cases.read({ id: currentId }).then(setRoom).catch(() => {});
    message("The answer and its sources are in your work.");
  }

  /**
   * He decides what is worth remembering.
   *
   * Nothing is learned from an answer on its own. A model summarising its own
   * output into "facts" and filing them unasked is how a product ends up
   * confidently believing something nobody ever said, and this store is put in
   * front of every later question — so it takes his word, or nothing.
   */
  async function rememberAnswer(text: string) {
    const sentences = text
      .split(/(?<=[.!?])\s+/u)
      .map(value => value.trim())
      .filter(value => value.length > 15 && value.length < 240)
      .slice(0, 5);
    if (sentences.length === 0) { message("There is nothing short enough to remember in that answer."); return; }
    setPanelBusy(true);
    try {
      const result = await host().memoryLearn({
        projectId: project?.id ?? "personal",
        findings: sentences.map(sentence => ({ finding: sentence, fromTitle: room?.case?.title ?? "this piece of work" }))
      });
      setMemory(result);
      message(`Remembered ${sentences.length === 1 ? "one thing" : `${sentences.length} things`} from this answer. Review them under What it knows.`);
    } catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); }
  }

  async function openMemory() {
    setPanel("memory"); setPanelBusy(true);
    const targetProjectId = project?.id ?? null;
    memoryProjectIdRef.current = targetProjectId;
    setMemory(null);
    setGovernedMemory(null);
    setGovernedError(null);
    const reqSeq = ++memoryReqSeq.current;
    if (targetProjectId) {
      setGovernedLoading(true);
    }
    try {
      const [legacyResult, governedResult] = await Promise.allSettled([
        host().memoryRead({ projectId: targetProjectId ?? "personal" }),
        targetProjectId
          ? (async () => {
              const bridge = host() as unknown as { memoryGoverned?: (cmd: GovernedProjectMemoryCommand) => Promise<GovernedProjectMemoryView> };
              if (typeof bridge.memoryGoverned !== "function") {
                throw new Error("Canonical project memory is unavailable.");
              }
              return bridge.memoryGoverned({ action: "read", projectId: targetProjectId });
            })()
          : Promise.resolve(null)
      ]);
      if (memoryReqSeq.current === reqSeq && memoryProjectIdRef.current === targetProjectId) {
        if (legacyResult.status === "fulfilled") {
          setMemory(legacyResult.value);
        } else {
          setMemory(null);
          message(problem(legacyResult.reason));
        }
        if (targetProjectId) {
          if (governedResult.status === "fulfilled" && governedResult.value) {
            setGovernedMemory(governedResult.value);
          } else if (governedResult.status === "rejected") {
            setGovernedMemory(null);
            setGovernedError(problem(governedResult.reason));
          }
        }
      }
    } finally {
      if (memoryReqSeq.current === reqSeq) {
        setPanelBusy(false);
        setGovernedLoading(false);
      }
    }
  }
  const reloadGovernedMemory = useCallback(async () => {
    if (!project?.id) return;
    const targetProjectId = project.id;
    const reqSeq = ++memoryReqSeq.current;
    setGovernedLoading(true);
    setGovernedError(null);
    try {
      const bridge = host() as unknown as { memoryGoverned?: (cmd: GovernedProjectMemoryCommand) => Promise<GovernedProjectMemoryView> };
      if (typeof bridge.memoryGoverned !== "function") {
        throw new Error("Canonical project memory is unavailable.");
      }
      const view = await bridge.memoryGoverned({ action: "read", projectId: targetProjectId });
      if (memoryReqSeq.current === reqSeq && memoryProjectIdRef.current === targetProjectId) {
        setGovernedMemory(view);
      }
    } catch (err) {
      if (memoryReqSeq.current === reqSeq && memoryProjectIdRef.current === targetProjectId) {
        setGovernedError(problem(err));
      }
    } finally {
      if (memoryReqSeq.current === reqSeq) {
        setGovernedLoading(false);
      }
    }
  }, [project?.id]);
  async function proposeGovernedMemory(input: {
    kind: GovernedProjectMemoryItem["kind"];
    text: string;
    id?: string;
    expectedRevision?: number;
  }) {
    if (!project?.id) {
      message("Select a project first to propose approved memory.");
      return;
    }
    setGovernedLoading(true);
    setGovernedError(null);
    const targetProjectId = project.id;
    const reqSeq = ++memoryReqSeq.current;
    try {
      const bridge = host() as unknown as { memoryGoverned?: (cmd: GovernedProjectMemoryCommand) => Promise<GovernedProjectMemoryView> };
      if (typeof bridge.memoryGoverned !== "function") {
        throw new Error("Canonical project memory is unavailable.");
      }
      const updated = await bridge.memoryGoverned({
        action: "propose",
        projectId: targetProjectId,
        kind: input.kind,
        text: input.text,
        ...(input.id ? { id: input.id } : {}),
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {})
      });
      if (memoryReqSeq.current === reqSeq && memoryProjectIdRef.current === targetProjectId) {
        setGovernedMemory(updated);
      }
    } catch (err) {
      const msg = problem(err);
      if (memoryReqSeq.current === reqSeq && memoryProjectIdRef.current === targetProjectId) {
        setGovernedError(msg);
      }
      throw err;
    } finally {
      if (memoryReqSeq.current === reqSeq) {
        setGovernedLoading(false);
      }
    }
  }
  async function reviewGovernedMemory(
    id: string,
    expectedRevision: number,
    decision: "approve" | "reject",
    reason?: string
  ) {
    if (!project?.id) return;
    setGovernedLoading(true);
    setGovernedError(null);
    const targetProjectId = project.id;
    const reqSeq = ++memoryReqSeq.current;
    try {
      const bridge = host() as unknown as { memoryGoverned?: (cmd: GovernedProjectMemoryCommand) => Promise<GovernedProjectMemoryView> };
      if (typeof bridge.memoryGoverned !== "function") {
        throw new Error("Canonical project memory is unavailable.");
      }
      const updated = await bridge.memoryGoverned({
        action: "review",
        projectId: targetProjectId,
        id,
        expectedRevision,
        decision,
        ...(reason ? { reason } : {})
      });
      if (memoryReqSeq.current === reqSeq && memoryProjectIdRef.current === targetProjectId) {
        setGovernedMemory(updated);
      }
    } catch (err) {
      const msg = problem(err);
      if (memoryReqSeq.current === reqSeq && memoryProjectIdRef.current === targetProjectId) {
        setGovernedError(msg);
      }
      throw err;
    } finally {
      if (memoryReqSeq.current === reqSeq) {
        setGovernedLoading(false);
      }
    }
  }
  async function forgetGovernedMemory(
    id: string,
    expectedRevision: number,
    reason?: string
  ) {
    if (!project?.id) return;
    setGovernedLoading(true);
    setGovernedError(null);
    const targetProjectId = project.id;
    const reqSeq = ++memoryReqSeq.current;
    try {
      const bridge = host() as unknown as { memoryGoverned?: (cmd: GovernedProjectMemoryCommand) => Promise<GovernedProjectMemoryView> };
      if (typeof bridge.memoryGoverned !== "function") {
        throw new Error("Canonical project memory is unavailable.");
      }
      const updated = await bridge.memoryGoverned({
        action: "forget",
        projectId: targetProjectId,
        id,
        expectedRevision,
        ...(reason ? { reason } : {})
      });
      if (memoryReqSeq.current === reqSeq && memoryProjectIdRef.current === targetProjectId) {
        setGovernedMemory(updated);
      }
    } catch (err) {
      const msg = problem(err);
      if (memoryReqSeq.current === reqSeq && memoryProjectIdRef.current === targetProjectId) {
        setGovernedError(msg);
      }
      throw err;
    } finally {
      if (memoryReqSeq.current === reqSeq) {
        setGovernedLoading(false);
      }
    }
  }
  async function setMemoryFlag(id: string, flag: { readonly pinned?: boolean; readonly hidden?: boolean }) {
    setPanelBusy(true);
    const targetProjectId = project?.id ?? "personal";
    try {
      const res = await host().memorySet({ projectId: targetProjectId, id, ...flag });
      if ((project?.id ?? "personal") === targetProjectId) setMemory(res);
    } catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function forgetMemory(id: string) {
    setPanelBusy(true);
    const targetProjectId = project?.id ?? "personal";
    try {
      const res = await host().memoryForget({ projectId: targetProjectId, id });
      if ((project?.id ?? "personal") === targetProjectId) setMemory(res);
    } catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); }
  }

  /**
   * What the last session changed in this work's folder, and putting a file
   * back. The operation is the last one this case ran, which is the one he
   * would mean by "what did it just do".
   */
  async function openChanges() {
    if (!currentId) { message("Open a piece of work first — changes are shown per piece of work."); return; }
    const operationId = status?.operationId ?? lastOperationIn(turns);
    if (operationId === null) { message("Nothing has run in this work yet, so there is nothing to compare against."); return; }
    setPanel("changes"); setPanelBusy(true); setChangeDiff(null);
    try { setChanges(await host().changesList({ caseId: currentId, operationId })); }
    catch (error) { setChanges(null); message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function openChangeDiff(relativePath: string) {
    const operationId = status?.operationId ?? lastOperationIn(turns);
    if (!currentId || operationId === null) return;
    setPanelBusy(true);
    try {
      const result = await host().changeContents({ caseId: currentId, operationId, relativePath });
      setChangeDiff({ relativePath, before: result.before ?? "", after: result.after ?? "" });
    } catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function restoreChange(relativePath: string) {
    const operationId = status?.operationId ?? lastOperationIn(turns);
    if (!currentId || operationId === null) return;
    setRestoring(relativePath);
    try {
      const result = await host().changeRestore({ caseId: currentId, operationId, relativePath });
      message(result.restored ? `Put ${relativePath} back as it was.` : `${relativePath} could not be put back.`);
      setChanges(await host().changesList({ caseId: currentId, operationId }));
      setChangeDiff(null);
    } catch (error) { message(problem(error)); }
    finally { setRestoring(null); }
  }

  async function openWatches() {
    setPanel("watch"); setPanelBusy(true);
    try {
      const result = await host().watchList();
      setWatches(result.watches); setWatchChecking(result.checking);
    } catch (error) { setWatches([]); message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function addWatch(target: WatchView["target"], cadence: WatchView["cadence"], tellMeWhen: WatchView["tellMeWhen"]) {
    setPanelBusy(true);
    try {
      const result = await host().watchSave({
        watch: {
          id: `watch-${Date.now().toString(36)}`,
          target, cadence, tellMeWhen,
          quietHours: true,
          lastCheckedAt: null, lastChangedAt: null, paused: false
        }
      });
      setWatches(result.watches);
    } catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function pauseWatch(id: string, paused: boolean) {
    const found = watches.find(value => value.id === id);
    if (found === undefined) return;
    setPanelBusy(true);
    try { setWatches((await host().watchSave({ watch: { ...found, paused } })).watches); }
    catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function removeWatch(id: string) {
    setPanelBusy(true);
    try { setWatches((await host().watchRemove({ id })).watches); }
    catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function checkWatchNow(id: string) {
    setPanelBusy(true); setWatchChecking(true);
    try {
      const result = await host().watchNow({ id });
      if (result.verdict !== null) {
        const said = result.verdict.what;
        setWatchFound(previous => new Map(previous).set(id, said));
        message(said);
      }
      setWatches((await host().watchList()).watches);
    } catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); setWatchChecking(false); }
  }

  async function sendPhoneTest() {
    try {
      const result = await host().telegramNotify({
        text: "Rellane can reach this phone. That is all this message is for."
      });
      message(result.sent
        ? "Sent. If it did not arrive, message your bot once so it knows your chat."
        : "Not sent. Add your chat under Outside tools, then try again.");
    } catch (error) { message(problem(error)); }
  }

  async function openWhatsApp() {
    setPanel("whatsapp"); setWhatsAppProblem(null);
    try { setWhatsApp(await api().whatsapp.status()); }
    catch (error) { setWhatsAppProblem(problem(error)); }
  }
  async function saveWhatsApp(input: { readonly token: string; readonly phoneNumberId: string; readonly businessAccountId: string; readonly mailboxUrl: string; readonly collectSecret: string }) {
    setBusy(true); setWhatsAppProblem(null);
    try {
      const result = await api().whatsapp.save({
        token: input.token,
        phoneNumberId: input.phoneNumberId,
        businessAccountId: input.businessAccountId,
        // Absent rather than empty, so send-only stays a deliberate state.
        ...(input.mailboxUrl.length > 0 ? { mailboxUrl: input.mailboxUrl, collectSecret: input.collectSecret } : {})
      });
      if (!result.saved) { setWhatsAppProblem(result.said); return; }
      setWhatsApp(await api().whatsapp.status());
      message(result.said);
    } catch (error) { setWhatsAppProblem(problem(error)); }
    finally { setBusy(false); }
  }
  async function forgetWhatsApp() {
    setBusy(true); setWhatsAppProblem(null);
    try {
      const result = await api().whatsapp.forget();
      setWhatsApp(await api().whatsapp.status());
      message(result.said);
    } catch (error) { setWhatsAppProblem(problem(error)); }
    finally { setBusy(false); }
  }

  async function openPhone() {
    setPanel("phone");
    try {
      const status = await host().telegramWorkStatus();
      setPhonePowers({ mayDo: status.mayDo, mayNotDo: status.mayNotDo });
    } catch {
      // Left null, and the panel says it could not check rather than guessing.
      setPhonePowers(null);
    }
    void readKnocks();
  }

  /**
   * The phone's state, from both halves of it.
   *
   * Whether a token is stored comes from the keychain; which chat is obeyed
   * comes from the contact list. The panel showed the first and hard-coded the
   * second to null, so a paired chat never appeared even once there was one.
   */
  async function readPhoneLink() {
    try {
      const status = await api().telegram.status();
      if (!status.encryptionAvailable) {
        setPhoneLink({ state: "no-keychain", reason: "This Mac will not give Rellane an encryption key, so a token would have to sit unencrypted. It refuses to store one at all rather than do that." });
        return;
      }
      if (!status.saved) {
        setPhoneLink({ state: "off" });
        return;
      }
      let pairedChatId: string | null = null;
      try { pairedChatId = (await host().phoneKnocks()).pairedChatId; } catch { pairedChatId = null; }
      setPhoneLink({ state: "linked", botName: null, pairedChatId, lastHeardAt: null });
    } catch (error) {
      setPhoneLink({ state: "failed", reason: problem(error) });
    }
  }

  async function readKnocks() {
    try { setPhoneKnocks((await host().phoneKnocks()).knocks); }
    catch { setPhoneKnocks([]); }
  }

  /**
   * He points at a row and says that one is him. Nothing infers it: a bot's
   * username is discoverable, so first-to-write is a race a stranger can win.
   */
  async function pairPhoneChat(chatId: string) {
    try {
      const result = await host().phonePair({ chatId });
      message(result.said);
      await readKnocks();
      const status = await host().telegramWorkStatus();
      setPhonePowers({ mayDo: status.mayDo, mayNotDo: status.mayNotDo });
      await readPhoneLink();
    } catch (error) { message(problem(error)); }
  }

  async function unpairPhoneChat(chatId: string) {
    try {
      const result = await host().phonePair({ chatId, pair: false });
      message(result.said);
      await readKnocks();
      await readPhoneLink();
    } catch (error) { message(problem(error)); }
  }

  async function openUsage(next: "today" | "week" | "month" = usageWindow) {
    setPanel("usage"); setUsageWindow(next); setPanelBusy(true);
    try {
      const result = await host().usage({ window: next });
      setUsage(tallyUsage({ receipts: result.receipts, known: result.known, window: next, now: Date.now() }));
    } catch (error) { setUsage(null); message(problem(error)); }
    finally { setPanelBusy(false); }
  }

  async function openFiles() {
    if (!currentId) { message("Open a piece of work first — the files panel shows that work's folder."); return; }
    setPanel("files"); setPanelBusy(true); setFilePreviewText(null); setFileDiff(null);
    try { setListing(await host().listFiles({ caseId: currentId })); }
    catch (error) { setListing(null); message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function selectFile(relativePath: string) {
    if (!currentId) return;
    setPanelBusy(true); setFileDiff(null);
    try {
      const result = await host().previewFile({ caseId: currentId, relativePath });
      setFilePreviewText(result);
      // A diff is only meaningful once this panel has seen the file before.
      const seen = seenText.current.get(relativePath);
      if (result.status === "text") {
        if (seen !== undefined && seen !== result.text) {
          setFileDiff(await host().fileChange({ caseId: currentId, relativePath, previousText: seen }));
        }
        seenText.current.set(relativePath, result.text);
      }
    } catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function revealFile(relativePath: string) {
    if (!currentId) return;
    try {
      const workspace = await host().revealWorkspace({ caseId: currentId });
      const target = `${workspace.path}/${relativePath}`;
      const described = await host().describeMacAction({ kind: "reveal", caseId: currentId, path: target });
      if (described.refusedBecause !== null) { message(described.refusedBecause); return; }
      const result = await host().runMacAction({ kind: "reveal", caseId: currentId, path: target });
      message(result.status === "done" ? result.detail : result.reason);
    } catch (error) { message(problem(error)); }
  }

  async function openTable(sourceTurnId: string) {
    if (!currentId) return;
    setPanel("data"); setPanelBusy(true); setTableResult(null); setTableSourceId(sourceTurnId);
    try { setTable(await host().parseTable({ caseId: currentId, sourceTurnId })); }
    catch (error) { setTable(null); message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function runTableQuery(spec: Omit<TableQueryRequest, "caseId" | "sourceTurnId">) {
    if (!currentId || !tableSourceId) return;
    setPanelBusy(true);
    try { setTableResult(await host().queryTable({ ...spec, caseId: currentId, sourceTurnId: tableSourceId })); }
    catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  /** A query result becomes an ordinary request, not a hidden instruction. */
  function tableToDraft(summary: string) {
    setPanel(null);
    setDraft(previous => previous.trim() ? `${previous.trim()}\n\n${summary}` : summary);
    requestAnimationFrame(() => composer.current?.focus());
  }

  async function runContentSearch(next: string) {
    setSearch(next);
    if (next.trim().length === 0) { setContentHits(null); return; }
    setPanelBusy(true);
    try { setContentHits(await host().searchBook({ query: next })); }
    catch { setContentHits(null); }
    finally { setPanelBusy(false); }
  }
  async function runQuickAction(id: string) {
    const action = quickActions.find(value => value.id === id);
    if (!action || action.disabledBecause !== null) { if (action) message(action.disabledBecause ?? ""); return; }
    switch (action.id as ActionId) {
      case "new-work": setPanel(null); newWork(); return;
      case "new-in-project": setPanel(null); newWork(project?.id ?? null); return;
      case "run-routine": setRoutineSeed(null); setPanel("routines"); return;
      case "switch-ai": setPanel("models"); return;
      case "add-file": setPanel(null); await addFile(); return;
      case "capture-screen": setPanel(null); await captureScreen(); return;
      case "export-output": {
        setPanel(null);
        const output = room?.artifacts[0];
        if (output) openEditor(output.body, output.sourceTurnId);
        return;
      }
      case "open-folder": setPanel(null); await revealWorkspace(); return;
      case "check-citations": setPanel(null); message("Open an output and use its citation check to verify sources."); return;
      case "stop-session": setPanel(null); await stop(); return;
      case "show-record": await openInsights(); return;
    }
  }

  /**
   * A screen or window, chosen by the owner, saved into this work's folder.
   *
   * Listing first is not a formality: the host only accepts a target id it
   * handed to this window, so a capture cannot be asked for by name.
   */
  async function captureScreen() {
    if (!currentId) { message("Open a piece of work first — a capture is saved into that work's folder."); return; }
    setBusy(true);
    try {
      const targets = await host().listCaptureTargets();
      const first = targets[0];
      if (!first) { message("No screen or window was available to capture."); return; }
      const result = await host().captureTarget({ caseId: currentId, targetId: first.id });
      message(result.status === "captured" ? `Captured "${result.label}" into this work's folder.` : result.reason);
      if (result.status === "captured" && panel === "files") await openFiles();
    } catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }

  async function openInsights() {
    if (!currentId) { message("Open a piece of work first."); return; }
    setPanel("insights"); setPack(null);
  }
  async function planPack() {
    if (!currentId) return;
    setPanelBusy(true);
    try { setPack(await host().deliveryPack({ caseId: currentId })); }
    catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); }
  }
  async function confirmPack() {
    if (!currentId) return;
    setPanelBusy(true);
    try {
      const written = await host().deliveryPack({ caseId: currentId, confirm: true });
      setPack(written);
      message(written.writtenTo ? `Delivery pack written to ${written.writtenTo}.` : "Delivery pack prepared.");
    } catch (error) { message(problem(error)); }
    finally { setPanelBusy(false); }
  }

  function dismissGuide() {
    setGuideDismissed(true);
    try { localStorage.setItem(GUIDE_KEY, "yes"); } catch { /* The guide stays hidden for this window. */ }
  }
  function dismissProposal() {
    if (!proposal) return;
    const key = proposalKey(proposal);
    const next = [...dismissals.filter(value => value.key !== key), { key, count: (dismissals.find(value => value.key === key)?.count ?? 0) + 1, lastAt: Date.now() }];
    setDismissals(next);
    try { localStorage.setItem(DISMISSALS_KEY, JSON.stringify(next)); } catch { /* It stays dismissed for this window. */ }
  }
  function acceptProposal(edit: boolean) {
    if (!proposal || !lastRequest || !currentId) return;
    dismissProposal();
    setRoutineSeed({ title: proposal.title, prompt: proposal.prompt, originCaseId: currentId, originTurnId: lastRequest.id });
    if (edit) setPanel("routines");
    else void saveRoutine({
      title: proposal.title.slice(0, 100),
      description: proposal.description,
      prompt: proposal.prompt,
      sourceHint: proposal.sourceHint,
      outputLabel: proposal.outputLabel,
      icon: "write",
      originCaseId: currentId,
      originTurnId: lastRequest.id
    })
      .then(() => message("Saved as a routine. You'll find it under Routines."))
      .catch(error => message(problem(error)));
  }

  async function copy(text: string) { try { await navigator.clipboard.writeText(text); message("Copied."); } catch { message("Copy was unavailable. Select the text and press ⌘C."); } }
  function changeAppearance() { const value = theme === "light" ? "dark" : "light"; setTheme(value); try { localStorage.setItem("rellane.workstation.appearance", value); } catch { /* Appearance remains available in this window. */ } }
  const showStreaming = status && ACTIVE.has(status.status);
  const toolSummary = review?.tools ? summariseToolReview(review.tools) : null;
  /**
   * Everything the palette can reach.
   *
   * Built here rather than in the search module so that what is findable is
   * decided by what the screen actually has, and stays honest when a list grows.
   */
  const commandItems: readonly CommandItem[] = useMemo(() => [
    ...cases.map(value => ({ id: `work:${value.id}`, kind: "work" as const, title: value.title, detail: value.question, at: value.lastActivityAt })),
    ...continuity.projects.map(value => ({ id: `project:${value.id}`, kind: "project" as const, title: value.title, detail: value.brief, at: 0 })),
    ...routines.map(value => ({ id: `routine:${value.id}`, kind: "routine" as const, title: value.title, detail: value.description, at: 0 })),
    ...continuity.routines.map(value => ({ id: `saved:${value.id}`, kind: "routine" as const, title: value.title, detail: value.prompt, at: 0 }))
  ], [cases, continuity.projects, continuity.routines, routines]);
  const commandHits = useMemo(() => searchCommands(commandItems, search), [commandItems, search]);

  /**
   * The fleet, named in the owner's own words.
   *
   * A snapshot knows an id and a status; it does not know what the work is
   * called or which subscription that provider id belongs to. Those are on
   * screen already, so they are joined here rather than widened into the
   * contract — the main process has no business restating a title the renderer
   * is looking at.
   */
  const caseTitles = useMemo(() => new Map(cases.map(value => [value.id, value.title])), [cases]);
  const providerLabels = useMemo(() => new Map(providers.map(value => [value.id, value.label])), [providers]);
  const liveViews: readonly SnapshotLike[] = useMemo(() => live.map(value => ({
    operationId: value.operationId,
    caseId: value.caseId,
    caseTitle: caseTitles.get(value.caseId) ?? "Untitled work",
    providerLabel: providerLabels.get(value.providerId) ?? LABELS[value.providerId],
    status: value.status,
    detail: value.detail,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    waitingTitle: value.permission?.title ?? null
  })), [live, caseTitles, providerLabels]);
  const liveRows = useMemo(() => sessionRows(liveViews, Date.now()), [liveViews]);
  const fleet = useMemo(() => summariseFleet(live.map((value): FleetSession => ({
    operationId: value.operationId,
    providerLabel: providerLabels.get(value.providerId) ?? LABELS[value.providerId],
    state: value.status === "needs-approval" ? "needs-approval" : value.status === "starting" ? "starting" : value.status === "stopping" ? "stopping" : "running",
    startedAt: value.startedAt,
    endedAt: null,
    toolCalls: 0,
    declined: 0,
    outcome: null
  })), Date.now()), [live, providerLabels]);
  const board = useMemo(() => buildBoard(providers.map((value): SeatInput => {
    const session = live.find(snapshot => snapshot.providerId === value.id);
    return {
      providerId: value.id,
      providerLabel: value.label,
      detected: value.state === "detected",
      session: session
        ? {
            caseId: session.caseId,
            caseTitle: caseTitles.get(session.caseId) ?? "Untitled work",
            status: session.status,
            startedAt: session.startedAt,
            waitingTitle: session.permission?.title ?? null
          }
        : null,
      finishedToday: 0,
      lastUsedAt: 0
    };
  }), Date.now()), [providers, live, caseTitles]);
  const waitingElsewhere = liveRows.filter(row => row.needsYou && row.caseId !== currentId).length;

  /** What this screen can actually do right now, and why not when it cannot. */
  const quickActions = useMemo(() => matchActions(availableActions({
    hasOpenWork: Boolean(currentId),
    workClosed: Boolean(room?.case?.closedAt),
    hasOutput: Boolean(room?.artifacts.length),
    hasSources: sources.length > 0,
    sessionRunning: running,
    inProject: Boolean(project),
    providersDetected: providers.filter(value => value.state === "detected").length
  }), search), [currentId, room, sources.length, running, project, providers, search]);

  /**
   * Who did the work, counted from the record rather than from memory.
   *
   * Turns from the open work only: a contribution view that reached across
   * every case would be a different feature, and a slower one.
   */
  const insightView = useMemo(() => summariseContributions((room?.turns ?? []).map((turn): ContributionTurn => ({
    caseId: room?.case?.id ?? "",
    caseTitle: room?.case?.title ?? "This work",
    seat: turn.seat,
    kind: turn.kind,
    at: turn.at,
    chars: turn.body.length,
    producedOutput: (room?.artifacts ?? []).some(output => output.sourceTurnId === turn.id)
  })), Date.now()), [room]);

  const guide = useMemo(() => onboardingView({
    hasSource: sources.some(turn => source(turn)),
    hasSentRequest: cases.length > 0,
    hasOutput: library.length > 0 || Boolean(room?.artifacts.length),
    hasExport: false,
    hasSecondProvider: new Set(cases.flatMap(() => [] as string[])).size > 1,
    connectionsDetected: providers.filter(value => value.state === "detected").length
  }), [sources, cases, library.length, room, providers]);

  /**
   * A routine offered only when the owner has actually repeated themselves.
   *
   * The evidence is other work whose question shares most of its significant
   * words with this request. Without that test this is a prompt that appears
   * after every answer, which is the thing everybody turns off.
   */
  const proposal = useMemo((): ProposalLike | null => {
    if (!lastRequest || !currentId) return null;
    const words = significantWords(lastRequest.body);
    if (words.length < 4) return null;
    const echoes = cases.filter(value => value.id !== currentId && overlap(words, significantWords(value.question)) >= 0.6);
    if (echoes.length === 0) return null;
    return {
      title: room?.case?.title ?? "Save this as a routine",
      description: "A routine you can run again without retyping it.",
      prompt: lastRequest.body,
      sourceHint: "The files you choose when you run it",
      outputLabel: "Document",
      because: `You have asked for something like this in ${echoes.length} other ${echoes.length === 1 ? "piece" : "pieces"} of work.`,
      evidence: echoes.slice(0, 5).map(value => value.title)
    };
  }, [lastRequest, currentId, cases, room]);
  const offerProposal = proposal !== null && shouldOffer(proposal, dismissals);

  /** What the agent would do, worked out before it is allowed to do any of it. */
  const agentPlan = useMemo(() => planAgentRun({
    goal: agentGoal,
    sources: sources.filter(turn => selected.includes(turn.id)).map(turn => ({ id: turn.id, label: contextLabel(turn), chars: turn.body.length })),
    toolLabels: ["Your files"],
    stepsAllowed: AGENT_STEPS_ALLOWED,
    providerLabel: providers.find(value => value.state === "detected")?.label ?? "your subscription"
  }), [agentGoal, sources, selected, providers]);

  /**
   * What the home screen offers, decided rather than hard-coded.
   *
   * The list it replaced advertised six things in the vocabulary of whoever
   * built them — "DuckDB SQL", "recursive multi-step reasoning" — and two of
   * them did nothing when pressed. This one is computed from what is actually
   * available and says what each is for in the owner's own words.
   */
  const starters: readonly Starter[] = useMemo(() => homeStarters({
    providersDetected: providers.filter(value => value.state === "detected").length,
    hasSources: sources.length > 0,
    hasTabularSource: sources.some(turn => /\n/u.test(turn.body) && /[,;\t]/u.test(turn.body.split("\n")[0] ?? "")),
    hasOutput: Boolean(room?.artifacts.length),
    localModelReady: localModels.length > 0,
    pairingAvailable: true,
    savedRoutines: continuity.routines.map(value => ({ id: value.id, title: value.title, description: value.description })),
    now: Date.now()
  }), [providers, sources, room, localModels.length, continuity.routines]);

  /**
   * Watching the agent, and watching the board, are the same shape of problem:
   * something is working somewhere else and this screen has to keep up. Both
   * poll while their panel is open and stop the moment it closes, because a
   * timer that outlives its panel is a timer nobody is reading.
   */
  useEffect(() => {
    if (panel !== "agent" || agentRunId === null) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await host().agentPoll({ runId: agentRunId! });
        if (disposed) return;
        setAgentPoll(next);
        if (next.state === "done" || next.state === "stopped" || next.state === "failed") {
          if (currentId) setRoom(await api().cases.read({ id: currentId }));
          return;
        }
      } catch (error) {
        if (!disposed) message(problem(error));
        return;
      }
      if (!disposed) timer = setTimeout(() => void poll(), 700);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [panel, agentRunId, currentId, message]);

  useEffect(() => {
    if (panel !== "dispatch" || dispatchRunId === null) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await host().dispatchPoll({ runId: dispatchRunId! });
        if (disposed) return;
        setDispatchBoard(next);
        if (next.done) {
          if (currentId) {
            const updated = await api().cases.read({ id: currentId });
            if (disposed) return;
            setRoom(updated);
            setAnswers(next.lanes.flatMap(lane => {
              const turn = lane.answerTurnId === null ? undefined : updated.turns.find(value => value.id === lane.answerTurnId);
              return turn === undefined ? [] : [{ providerId: lane.providerId, text: turn.body }];
            }));
          }
          return;
        }
      } catch (error) {
        if (!disposed) message(problem(error));
        return;
      }
      if (!disposed) timer = setTimeout(() => void poll(), 900);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [panel, dispatchRunId, currentId, message]);

  /**
   * Opening the plan, not starting the run.
   *
   * Nothing reaches a subscription until the owner has read what it is about to
   * do and pressed Start. The version of this that shipped last week went
   * straight to the model, which is the rule this product is built on.
   */
  function proposeAgent(): void {
    if (!draft.trim()) { message("Say what you want it to work through, then start it."); return; }
    setAgentGoal(draft.trim()); setAgentRunId(null); setAgentPoll(null); setPanel("agent");
  }
  async function startAgent() {
    const goal = agentGoal.trim();
    if (!goal) { message("Say what you want it to work through, then start it."); return; }
    if (providerId === "local" || pickedProvider?.state !== "detected" || !modelId.trim()) {
      message("Choose a subscription connection and its model before reviewing this agent run."); return;
    }
    if (selectedSavedAgent !== null && !agentExpectedOutput.trim()) {
      message("Say what the saved agent should produce before reviewing this run."); return;
    }
    setBusy(true);
    try {
      const { value, sourceIds } = await ensureRoom();
      if (!value.case) throw new Error("The work could not be opened.");
      setAgentReview(await host().agentPrepare({ caseId: value.case.id, goal,
        providerId, modelId: modelId.trim(), sourceTurnIds: [...sourceIds],
        ...(selectedSavedAgent ? { savedAgent: {
          id: selectedSavedAgent.id, origin: selectedSavedAgent.origin,
          expectedRevision: selectedSavedAgent.revision,
          expectedOutput: agentExpectedOutput.trim(), requestedToolScopes: ["none"]
        } } : {}) }));
    } catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function startReviewedAgent() {
    if (agentReview === null) return;
    setBusy(true);
    try {
      const started = await host().agentStart({ token: agentReview.token });
      setAgentReview(null); setAgentRunId(started.runId); setAgentPoll(null); setDraft("");
      setSelectedSavedAgent(null); setAgentExpectedOutput("");
    } catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function stopAgent() {
    if (agentRunId === null) return;
    try { await host().agentStop({ runId: agentRunId }); }
    catch (error) { message(problem(error)); }
  }

  async function prepareDispatch(brief: string, selections: readonly { readonly providerId: string; readonly modelId: string }[]) {
    setBusy(true);
    try {
      const { value, sourceIds } = await ensureRoom();
      if (!value.case) throw new Error("The work could not be opened.");
      setDispatchReview(await host().dispatchPrepare({ caseId: value.case.id, brief, selections, sourceTurnIds: [...sourceIds] }));
    } catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function startDispatch() {
    if (dispatchReview === null) return;
    setBusy(true);
    try {
      const started = await host().dispatchStart({ token: dispatchReview.token });
      setDispatchReview(null);
      setDispatchRunId(started.runId); setDispatchBoard(null); setAnswers([]); setComparison(null);
    } catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function stopLane(providerId: string) {
    if (dispatchRunId === null) return;
    try { setDispatchBoard(await host().dispatchStop({ runId: dispatchRunId, providerId })); }
    catch (error) { message(problem(error)); }
  }
  async function stopAllLanes() {
    if (dispatchRunId === null) return;
    try { setDispatchBoard(await host().dispatchStop({ runId: dispatchRunId })); }
    catch (error) { message(problem(error)); }
  }
  function compareNow() {
    const labelFor = (id: string) => providers.find(value => value.id === id)?.label ?? id;
    setComparison(compareAnswers(answers.map(answer => ({ providerId: answer.providerId, label: labelFor(answer.providerId), text: answer.text }))));
    setPanel("compare");
  }
  function keepAnswer(label: string) {
    const match = answers.find(answer => (providers.find(value => value.id === answer.providerId)?.label ?? answer.providerId) === label);
    if (!match) { message("That answer is no longer here."); return; }
    setPanel(null);
    openEditor(match.text, null);
  }

  useEffect(() => {
    if (panel !== "pairing") return;
    void refreshPairing();
  }, [panel]);

  async function refreshPairing() {
    try { setPairing(await host().pairingStatus()); }
    catch (error) { message(problem(error)); }
  }
  async function startPairing(reachable: "this-mac" | "wifi") {
    setBusy(true);
    try { setPairing(await host().pairingStart({ reachable })); }
    catch (error) { setPairing({ state: "failed", reason: problem(error) }); }
    finally { setBusy(false); }
  }
  async function stopPairing() {
    setBusy(true);
    try { setPairing(await host().pairingStop()); }
    catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }

  async function previewPublish(format: PublishFormatView) {
    if (!currentId) return;
    setBusy(true);
    try { setPublishPreview(await host().publishPreview({ caseId: currentId, format })); }
    catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function writePublish(format: PublishFormatView) {
    if (!currentId) return;
    setBusy(true);
    try {
      const written = await host().publishWrite({ caseId: currentId, format });
      setPublishPreview(written);
      message(written.writtenTo ? `Written to ${written.writtenTo}.` : "Published.");
    } catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }

  /** The split he is about to approve, worked out from what he typed. */
  const crewSplit = useMemo(() => splitForCrew({
    request: draft.trim(),
    seats: crewSeats.map(id => ({ id, label: providers.find(p => p.id === id)?.label ?? LABELS[id] })),
    sourceIds: [...selected]
  }), [draft, crewSeats, providers, selected]);

  const seatChoices = useMemo(() => providers.map(value => ({
    id: value.id, label: value.label, family: value.family, detail: value.detail,
    usable: value.state === "detected"
  })), [providers]);

  useEffect(() => {
    if (panel !== "crew" || crewRunId === null) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await host().crewPoll({ runId: crewRunId! });
        if (disposed) return;
        setCrewRun(next);
        if (next.round === "done" || next.round === "stopped" || next.round === "failed") {
          if (currentId) {
            const updated = await api().cases.read({ id: currentId });
            if (disposed) return;
            setRoom(updated);
            setCrewAnswers(next.parts.flatMap(part => {
              const turn = part.answerTurnId === null ? undefined : updated.turns.find(value => value.id === part.answerTurnId);
              return turn === undefined ? [] : [{ partId: part.id, text: turn.body }];
            }));
          }
          return;
        }
      } catch (error) {
        if (!disposed) message(problem(error));
        return;
      }
      if (!disposed) timer = setTimeout(() => void poll(), 800);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [panel, crewRunId, currentId, message]);

  /** A selected model for each Crew seat is required before any review is prepared. */
  async function sendToCrew() {
    if (crewSplit.refusedBecause !== null) { message(crewSplit.refusedBecause); return; }
    if (!crewSplit.parts.some(part => part.id === crewIntegrationOwner)) {
      message("Choose which Crew part owns the final result before reviewing this run.");
      return;
    }
    for (const part of crewSplit.parts) {
      const seat = providers.find(one => one.id === part.seatId);
      if (seat?.state !== "detected" || !crewModelIds[part.seatId]?.trim()) {
        message(`Choose a model for ${part.seatLabel} before reviewing this Crew run.`);
        return;
      }
      if (!crewRoles[part.id]?.trim() || !crewExpectedOutputs[part.id]?.trim()) {
        message(`Name the role and expected output for ${part.title} before reviewing this Crew run.`);
        return;
      }
    }
    setBusy(true);
    try {
      const { value, sourceIds } = await ensureRoom();
      if (!value.case) throw new Error("The work could not be opened.");
      const parts = withCrewIntegrationOwner(crewSplit.parts, crewIntegrationOwner).map(part => ({
        id: part.id, title: part.title, role: crewRoles[part.id]!.trim(),
        work: part.prompt, expectedOutput: crewExpectedOutputs[part.id]!.trim(),
        providerId: part.seatId, modelId: crewModelIds[part.seatId]!.trim(),
        seatLabel: part.seatLabel, dependsOn: [...part.dependsOn],
        sourceTurnIds: [...sourceIds]
      }));
      setCrewReview(await host().crewPrepare({
        caseId: value.case.id, request: draft.trim(), integrationOwner: crewIntegrationOwner,
        parts, sourceTurnIds: [...sourceIds]
      }));
      setCrewModelPicker(false);
    } catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function prepareCrewContinuation() {
    if (crewRunId === null) return;
    setBusy(true);
    try { setCrewReview(await host().crewPrepare({ runId: crewRunId })); }
    catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function startReviewedCrew() {
    if (crewReview === null) return;
    setBusy(true);
    try {
      const started = await host().crewStart({ token: crewReview.token });
      setCrewReview(null); setCrewRunId(started.runId); setCrewAnswers([]);
      setDraft(""); setPanel("crew");
      setCrewRun(await host().crewPoll({ runId: started.runId }));
    } catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  async function stopCrewPart(partId: string) {
    if (crewRunId === null) return;
    try { setCrewRun(await host().crewStop({ runId: crewRunId, partId })); }
    catch (error) { message(problem(error)); }
  }
  async function stopCrew() {
    if (crewRunId === null) return;
    try { setCrewRun(await host().crewStop({ runId: crewRunId })); }
    catch (error) { message(problem(error)); }
  }

  /**
   * Whether the phone is actually set up, asked rather than assumed.
   *
   * `saved` says a token is in the Keychain; `encryptionAvailable` false means
   * this Mac will not encrypt one, and the store refuses to write in the clear
   * rather than pretending. Those are two different states and the screen shows
   * them differently.
   */
  useEffect(() => {
    if (panel !== "phone") return;
    let disposed = false;
    void readPhoneLink().then(() => { if (disposed) return; });
    return () => { disposed = true; };
  }, [panel]);

  /**
   * While this panel is open, a chat that writes in appears without reopening
   * it — which matters because the two halves of setting this up happen on two
   * devices, seconds apart.
   */
  useEffect(() => {
    if (panel !== "phone") return;
    const timer = setInterval(() => { void readKnocks(); }, 3_000);
    return () => clearInterval(timer);
  }, [panel]);

  async function savePhoneToken(token: string) {
    setBusy(true); setPhoneProblem(null);
    try {
      const result = await api().telegram.save({ token });
      if (!result.saved) { setPhoneProblem(result.said); return; }
      await readPhoneLink();
      /**
       * The next step, said where he is, rather than sending him to another
       * screen. His chat appears in this panel the moment he writes to the bot.
       */
      message(`${result.said} Message your bot from your phone and it will appear here.`);
      void readKnocks();
    } catch (error) { setPhoneProblem(problem(error)); }
    finally { setBusy(false); }
  }
  async function forgetPhone() {
    setBusy(true); setPhoneProblem(null);
    try { await api().telegram.forget(); setPhoneLink({ state: "off" }); }
    catch (error) { setPhoneProblem(problem(error)); }
    finally { setBusy(false); }
  }

  async function loadAgents() {
    setPanel("agents");
    try { const result = await host().agentsList(); setAgents(result.agents); }
    catch (error) { message(problem(error)); }
  }
  function openAgent(key: string) {
    const found = agents.find(agent => `${agent.origin}:${agent.id}` === key);
    if (!found) { message("That agent is no longer here."); return; }
    setEditingAgentId(found.id); setEditingAgentOrigin(found.origin);
    setAgentDraft(found.markdown); setAgentSavedAt(null); setPanel("agent-edit");
  }
  async function saveAgent() {
    if (editingAgentId === null) return;
    setBusy(true);
    try {
      const saved = await host().agentSave({ id: editingAgentId, markdown: agentDraft });
      setEditingAgentId(saved.id); setEditingAgentOrigin("user"); setAgentSavedAt(saved.updatedAt);
      const result = await host().agentsList(); setAgents(result.agents);
    } catch (error) { message(problem(error)); }
    finally { setBusy(false); }
  }
  function runSavedAgent() {
    const found = agents.find(agent => agent.id === editingAgentId &&
      agent.origin === editingAgentOrigin && agent.markdown === agentDraft);
    if (!found) { message("Save this agent before running it, so the review can pin its exact version."); return; }
    setSelectedSavedAgent({ id: found.id, origin: found.origin, revision: found.revision });
    setAgentExpectedOutput("");
    setAgentReview(null); setAgentRunId(null); setAgentPoll(null);
    if (!draft.trim()) {
      setPanel(null);
      composer.current?.focus();
      message("Type this agent's task, then choose Agent to review its full instructions.");
      return;
    }
    setAgentGoal(draft.trim());
    setPanel("agent");
  }
  async function deleteAgent(id: string) {
    try { await host().agentDelete({ id }); const result = await host().agentsList(); setAgents(result.agents); }
    catch (error) { message(problem(error)); }
  }

  function runStarter(starter: Starter): void {
    if (!starter.available) { message(starter.unavailableBecause ?? "That is not ready yet."); return; }
    switch (starter.id) {
      case "ask": composer.current?.focus(); return;
      case "watch-it-work": proposeAgent(); return;
      case "send-to-several": setPanel("dispatch"); return;
      case "read-my-files": void addFile(); return;
      case "ask-a-spreadsheet": {
        const found = sources.find(turn => /\n/u.test(turn.body) && /[,;\t]/u.test(turn.body.split("\n")[0] ?? ""));
        if (found) void openTable(found.id); else message("Add a spreadsheet first, then open it here.");
        return;
      }
      case "make-an-image": void openImages(true); return;
      case "publish": setPanel("publish"); return;
      case "continue-on-phone": setPanel("pairing"); return;
      case "routine": {
        const saved = continuity.routines.find(value => value.id === starter.routineId);
        if (saved) useRoutine(saved);
        return;
      }
    }
  }

  return <div className={`ws-root ws-root--${theme} ${editor ? "ws-root--editing" : ""}`}>
    <aside className="ws-sidebar" aria-label="Workspace navigation">
      <div className="ws-window-space" />
      <button className="ws-brand" onClick={() => newWork()} aria-label="Rellane home"><span className="ws-brand-mark"><RellaneMark /></span><span>rellane<span className="ws-brand-period">.</span></span></button>
      <button className="ws-new-work" onClick={() => newWork()}><Icon name="plus" /><span>New work</span></button>
      {/*
        Grouped, because nine flat items is a wall and he reads it every day.
        Two questions decide the groups: is this something running right now, or
        something of mine I come back to. "Find anything" belongs to neither and
        sits above both, where a search always is.
      */}
      {/*
        Nav and work list share one scrolling column.

        They were separate children of a flex column with nothing able to
        scroll, so on a short window — or after three more nav rows were added —
        the list of open work was squeezed to nothing and the places below the
        fold could not be reached at all.
      */}
      <div className="ws-sidebar-scroll">
      <nav className="ws-nav" aria-label="Workspace">
        <button onClick={() => setPanel("search")}><Icon name="search" /><span>Find anything</span><kbd>⌘ K</kbd></button>
        <p className="ws-nav-group">Running</p>
        <button onClick={() => setPanel("sessions")}><Icon name="chat" /><span>Sessions</span>{liveRows.length ? <span className={`ws-nav-count ${waitingElsewhere ? "is-waiting" : ""}`}>{waitingElsewhere ? `${waitingElsewhere} waiting` : liveRows.length}</span> : null}</button>
        <button onClick={() => setPanel("dispatch")}><Icon name="spark" /><span>Ask several</span></button>
        <button onClick={() => setPanel("crew")}><Icon name="grid" /><span>Your crew</span></button>
        <p className="ws-nav-group">Yours</p>
        <button onClick={() => showProjects()}><Icon name="folder" /><span>Projects</span></button>
        <button onClick={() => {setRoutineSeed(null);setPanel("routines");}}><Icon name="refresh" /><span>Routines</span></button>
        <button onClick={() => void loadAgents()}><Icon name="shield" /><span>Your agents</span></button>
        <button onClick={() => void loadLibrary()}><Icon name="file" /><span>My outputs</span></button>
        <button onClick={() => setPanel("canvas")}><Icon name="panel" /><span>Canvas</span></button>
        <button onClick={() => void openWatches()}><Icon name="clock" /><span>Keep an eye on</span>{watches.length ? <span className="ws-nav-count">{watches.length}</span> : null}</button>
        <button onClick={() => void openMemory()}><Icon name="spark" /><span>What it knows</span></button>
        <button onClick={() => void openUsage()}><Icon name="grid" /><span>What you have used</span></button>
        <button onClick={() => setPanel("knowledge")}><Icon name="clock" /><span>What it has seen</span></button>
      </nav>
      <div className="ws-history-heading"><span>Open work</span><span>{openCases.length || ""}</span></div>
      <div className="ws-history">{loading ? <div className="ws-history-empty">Opening your workspace…</div> : openCases.length ? openCases.slice(0, 60).map(value => <button key={value.id} className={`ws-history-row ${value.id === currentId ? "is-active" : ""}`} onClick={() => void openWork(value.id)} aria-current={value.id === currentId ? "page" : undefined} title={value.title}><Icon name={value.closedAt ? "check" : "chat"} size={15} /><span>{value.title}</span></button>) : <div className="ws-history-empty">Your work will collect here.<br />Start with a question or a file.</div>}</div>
      </div>
      <footer className="ws-sidebar-footer"><button className="ws-connection-link" onClick={() => setPanel("models")}><span className="ws-connection-dots"><i /><i /><i /></span><span>Your AI connections</span><Icon name="chevron" size={14} /></button><button className="ws-connection-link" onClick={() => setPanel("outside")}><span className="ws-connection-dots"><i /><i /></span><span>Outside tools</span><Icon name="chevron" size={14} /></button><button className="ws-connection-link" onClick={() => void openPhone()}><span className="ws-connection-dots"><i /></span><span>Connect your phone</span><Icon name="chevron" size={14} /></button><button className="ws-connection-link" onClick={() => void openWhatsApp()}><span className="ws-connection-dots"><i /></span><span>WhatsApp business</span><Icon name="chevron" size={14} /></button><div className="ws-profile-row"><span className="ws-avatar">P</span><div><strong>Personal workspace</strong><span>Saved on this Mac</span></div><IconButton icon={theme === "light" ? "moon" : "sun"} label={`Switch to ${theme === "light" ? "dark" : "light"} appearance`} onClick={changeAppearance} /></div><div className="ws-footer-links"><button onClick={() => { if (canNavigate()) onTools(); }}>More tools<Icon name="chevron" size={12} /></button><button onClick={() => setPanel("help")}><Icon name="help" size={14} />How it works</button></div></footer>
    </aside>
    <main className="ws-main">
      <header className="ws-titlebar"><div className="ws-breadcrumb"><Icon name="folder" size={15} /><span>{project?.title ?? workspace?.label ?? "Personal workspace"}</span><span className="ws-breadcrumb-slash">/</span><strong>{room?.case?.title ?? "New work"}</strong>{currentId ? <IconButton icon="edit" label="Rename work" onClick={editWorkTitle} disabled={busy || running} /> : null}</div><div className="ws-title-actions">
        {currentId && !studioOpen ? <button className="ws-button ws-button--small ws-button--primary" onClick={openStudio}><Icon name="file" size={15} />Studio</button> : null}
        <details className="ws-title-more" onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onClick={event => { if ((event.target as HTMLElement).closest("button")) event.currentTarget.open = false; }}>
          <summary className="ws-button ws-button--small">More <Icon name="chevron" size={13} /></summary>
          <div className="ws-title-more-menu" aria-label="More work actions">
            {lastRequest && currentId ? <button onClick={saveRequestAsRoutine} disabled={busy || running}>Save routine</button> : null}
            {currentId ? <button onClick={() => void openFiles()}>Files</button> : null}
            {currentId ? <button onClick={() => void openChanges()}>Changes</button> : null}
            {currentId ? <button onClick={() => void startResearch()} disabled={busy || running}>Look it up</button> : null}
            {currentId ? <button onClick={() => void openInsights()}>Record</button> : null}
            {currentId ? <button onClick={() => setPanel("pairing")}>Phone</button> : null}
            {!studioOpen && room?.artifacts[0] && !editor ? <button onClick={() => { const output = room.artifacts[0]!; openEditor(output.body, output.sourceTurnId); }}>Output</button> : null}
            {!studioOpen && room?.artifacts[0] ? <button onClick={() => setPanel("publish")}>Publish</button> : null}
            <button onClick={() => setPanel("help")}>How this workspace works</button>
          </div>
        </details>
      </div></header>
      <div className="ws-work-switcher"><ProjectWorkspaceSwitcher
        projects={continuity.projects}
        projectId={project?.id ?? null}
        workspace={workspace}
        disabled={busy || running}
        onSelectProject={id => { if (id !== (project?.id ?? null)) newWork(id); }}
        onManageProjects={() => showProjects(project?.id ?? null)}
        onChooseWorkspace={() => void chooseWorkspace()}
        onUseDefaultWorkspace={() => setWorkspace(null)}
      /></div>
      <div className="ws-work-area">
        {studioOpen && currentId && room ? <StudioWorkspace
          caseId={currentId}
          title={room.case?.title ?? "This work"}
          stage={studioStage}
          onStageChange={setStudioStage}
          onClose={() => setStudioOpen(false)}
          direction={<div className="ws-studio-direction">
            <p className="ws-eyebrow">This work</p><h3>Set the direction</h3>
            <p>{room.case?.question || "Shape the document for this work."}</p>
            <section><h4>Project brief</h4>{project ? <><p>{project.brief}</p><button className="ws-button ws-button--small" onClick={() => showProjects(project.id)}>Edit project brief</button></> : <><p>No project is linked to this work.</p><button className="ws-button ws-button--small" onClick={() => showProjects()}>Choose a project</button></>}</section>
            <section><h4>Approved project memory</h4>{governedLoading ? <p>Loading approved memory…</p> : governedError ? <p role="alert">{governedError}</p> : (governedMemory?.items.filter(item => item.active?.state === "approved" && item.kind !== "finding") ?? []).length ? <ul>{governedMemory?.items.filter(item => item.active?.state === "approved" && item.kind !== "finding").map(item => <li key={item.id}><strong>{item.kind[0]?.toUpperCase()}{item.kind.slice(1)}</strong> {item.active?.text}</li>)}</ul> : <p>No approved instructions, decisions, or exclusions are linked to this project.</p>}<button className="ws-button ws-button--small" onClick={() => void openMemory()}>Review project memory</button></section>
            {governedMemory?.items.some(item => item.kind === "finding" && item.active?.state === "approved") ? <section><h4>Findings to consider</h4><p>Findings are reference material, not instructions.</p><ul>{governedMemory.items.filter(item => item.kind === "finding" && item.active?.state === "approved").map(item => <li key={item.id}>{item.active?.text}</li>)}</ul></section> : null}
            <button className="ws-button ws-button--primary" onClick={() => setStudioStage("design")}>Design document</button>
          </div>}
          editingSurface={editor ? <ArtifactEditor key={currentId} room={room} stage={studioStage} selectedSourceIds={selected} draft={editor} setDraft={setEditor} savedBody={savedBody} onSaved={savedOutput} onClose={() => setStudioOpen(false)} onMessage={message} /> : null}
          resources={<div className="ws-studio-resource-list"><p>{selected.length} selected for this work</p><button className="ws-button ws-button--small" onClick={() => setPanel("sources")}>Choose sources</button><button className="ws-button ws-button--small" disabled={busy || running || Boolean(room.case?.closedAt)} onClick={() => void addFile()}>Add file</button>{sources.length ? <ul>{sources.map(turn => <li key={turn.id}><label><input type="checkbox" checked={selected.includes(turn.id)} disabled={running || Boolean(room.case?.closedAt) || (!selected.includes(turn.id) && selected.length >= 20)} onChange={event => setSelected(previous => event.target.checked ? [...previous, turn.id] : previous.filter(id => id !== turn.id))} />{contextLabel(turn)}</label><button onClick={() => setCitationId(turn.id)}>Read</button></li>)}</ul> : <p>No saved sources in this work yet.</p>}</div>}
        /> : <>
        <section className={`ws-conversation ${empty ? "ws-conversation--empty" : ""} ${empty && !currentId ? "ws-conversation--overview" : ""}`} aria-label="Conversation">
          <div ref={conversationScroll.viewport} className="ws-conversation-scroll" tabIndex={0} role="region" aria-label="Conversation messages" onScroll={conversationScroll.onScroll} onWheel={conversationScroll.onWheel} onPointerDown={conversationScroll.onPointerDown} onKeyDown={conversationScroll.onKeyDown} onTouchMove={conversationScroll.onTouchMove}>
            {empty ? !currentId ? <WorkOverview cases={cases} sessions={liveRows} loading={loading} error={null} busy={busy} onOpenWork={id => void openWork(id)} onOpenSession={id => void goToSession(id)} onStop={id => void stopOne(id)} onNewWork={() => composer.current?.focus()} onRetry={() => void refreshCases().catch(error => message(problem(error)))} onAllSessions={() => setPanel("sessions")} /> : <div className="ws-welcome"><div className="ws-orbit-mark" aria-hidden="true"><span /><span /><span /><i /></div><p className="ws-welcome-kicker">A little space. A lot of possibility.</p><h1>Where should we start?</h1><p className="ws-welcome-description">Think with your AIs. Work with your files.<br />Make something you can use.</p></div> : <div className="ws-messages">{turns.map(turn => {
              const thoughtMatch = /<thought>([\s\S]*?)<\/thought>/i.exec(turn.body);
              const thoughtContent = thoughtMatch ? thoughtMatch[1]?.trim() : null;
              const cleanBody = turn.body.replace(/<thought>[\s\S]*?<\/thought>/gi, "").trim();
              return <article key={turn.id} className={`ws-message ${turn.seat === "owner" ? "ws-message--owner" : "ws-message--answer"}`}>
                <div className="ws-message-byline">{turn.seat === "owner" ? <span className="ws-message-avatar">You</span> : <><span className="ws-answer-mark"><RellaneMark /></span><strong>{turn.seat.replace(/^workstation\s*[·:]?\s*/iu, "")}</strong></>}<time dateTime={new Date(turn.at).toISOString()}>{new Date(turn.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time></div>
                {thoughtContent ? <details className="ws-thought-drawer" open={false}><summary className="ws-thought-summary"><Icon name="spark" size={12} /><span>Autonomous Reasoning ({thoughtContent.split(/\s+/).filter(Boolean).length} words)</span></summary><div className="ws-thought-body"><pre>{thoughtContent}</pre></div></details> : null}
                <div className="ws-prose"><SourceAnswer text={cleanBody || turn.body} sources={sources} onSource={setCitationId} /></div>
                {turn.seat !== "owner" ? <div className="ws-message-actions"><button onClick={() => openEditor(cleanBody || turn.body, turn.id)}><Icon name="file" size={14} />Make an output</button><button onClick={() => { setSelected(previous => previous.includes(turn.id) ? previous : [...previous, turn.id]); message("Added this answer to the next request’s context."); }} disabled={selected.includes(turn.id) || selected.length >= 20 || running}><Icon name="plus" size={14} />{selected.includes(turn.id) ? "In context" : "Use as context"}</button><button onClick={() => void rememberAnswer(cleanBody || turn.body)} disabled={panelBusy || running} title="Keep what this says about your business, for later work"><Icon name="spark" size={14} />Remember this</button><IconButton icon="copy" label="Copy answer" onClick={() => void copy(cleanBody || turn.body)} /></div> : null}
              </article>;
            })}
            {showStreaming ? <article className="ws-message ws-message--answer"><div className="ws-message-byline"><span className="ws-answer-mark is-working"><RellaneMark /></span><strong>{LABELS[status.providerId]}</strong><span className="ws-live-label">{status.status === "needs-approval" ? "Needs your review" : status.status === "stopping" ? "Stopping" : "Working"}</span></div>{status.text ? <div className="ws-prose"><RichText text={status.text} /></div> : <div className="ws-thinking"><i /><i /><i /><span>{status.activity.at(-1) ?? "Starting your session…"}</span></div>}{status.activity.length ? <details className="ws-activity"><summary>Activity <span>{status.activity.length}</span></summary><ol>{status.activity.map((activity, index) => <li key={index}>{activity}</li>)}</ol></details> : null}</article> : null}
            {localOperation ? <article className="ws-message ws-message--answer"><div className="ws-message-byline"><ProviderGlyph family="local" small /><strong>On this Mac</strong><span className="ws-live-label">Working locally</span></div><div className="ws-thinking"><i /><i /><i /><span>Reading your request and selected sources…</span></div></article> : null}
            {status?.status === "completed" && status.reportedModelId ? <p className="ws-model-receipt">Model reported by {LABELS[status.providerId]}: <span>{status.reportedModelId}</span></p> : null}
            {status && !ACTIVE.has(status.status) && status.status !== "completed" ? <div className="ws-run-result" role="status"><Icon name="clock" /><div><strong>{status.status === "stopped" ? "Stopped" : status.status === "interrupted" ? "Session interrupted" : "This request didn’t finish"}</strong><p>{status.detail}</p>{status.text && !turns.some(turn => turn.body === status.text) ? <details><summary>View partial response</summary><div className="ws-prose"><RichText text={status.text} /></div></details> : null}</div></div> : null}</div>}
          </div>
          <div className="ws-compose-region">
            {offerProposal && proposal && !running && !empty ? <RoutineProposalCard proposal={presentProposal(proposal)} onAccept={() => acceptProposal(false)} onEdit={() => acceptProposal(true)} onIgnore={dismissProposal} /> : null}
            {conversationScroll.showLatest && !empty ? <button className="ws-jump-latest" onClick={conversationScroll.latest}><Icon name="arrow" size={14} />Latest response</button> : null}
            {status?.permission ? <div className="ws-permission" role="region" aria-label="Tool approval"><div><Icon name="shield" /><strong>{status.permission.title}</strong></div><pre tabIndex={0} aria-label="Complete action details">{status.permission.detail}</pre><footer><button className="ws-button" disabled={busy} onClick={() => void decide(false)}>Decline</button><button className="ws-button ws-button--primary" disabled={busy} onClick={() => void decide(true)}>Allow once</button></footer></div> : null}
            {notice ? <div className="ws-notice" role="status"><span>{notice}</span><IconButton icon="close" label="Dismiss message" onClick={() => setNotice("")} /></div> : null}
            <div className={`ws-composer ${running ? "is-running" : ""}`}>
              {project ? <div className="ws-project-context"><button onClick={() => showProjects(project.id)}><Icon name="folder" size={14} />{project.title}</button><span>Brief v{project.revision}</span>{currentId ? <button disabled={busy || running || Boolean(room?.case?.closedAt)} onClick={() => void useProjectBrief(project).catch(error => message(problem(error)))}>Use shared brief</button> : <span>Added to your first request for review</span>}</div> : null}
              {selected.length || workspace ? <div className="ws-context-chips">{workspace ? <span className="ws-context-chip" title={workspace.path}><Icon name="folder" size={13} />{workspace.label}<button aria-label="Remove workspace folder" disabled={running} onClick={() => setWorkspace(null)}><Icon name="close" size={12} /></button></span> : null}{sources.filter(turn => selected.includes(turn.id)).map(turn => <span className="ws-context-chip" key={turn.id}><Icon name="file" size={13} /><button onClick={() => setPanel("sources")}>{contextLabel(turn)}</button><button aria-label={`Remove ${contextLabel(turn)} from selected context`} disabled={running} onClick={() => setSelected(previous => previous.filter(id => id !== turn.id))}><Icon name="close" size={12} /></button></span>)}</div> : null}
              <textarea ref={composer} aria-label="Message your AI" value={draft} maxLength={8000} onChange={event => setDraft(event.target.value)} placeholder={room?.case?.closedAt ? "This work is closed. Start new work to continue." : empty ? "Ask anything, or describe what you want to make…" : "Keep going, ask a question, or try another AI…"} disabled={Boolean(room?.case?.closedAt)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void prepareSend(); } }} rows={empty ? 3 : 2} />
              {/*
                The bots he picked sit with the other things he picked, not
                among the send buttons. Five seats inside `ws-send-controls`
                wrapped into five rows and pushed the toolbar apart around the
                icons, which is what he was looking at when he called it a mess.
              */}
              {crewSeats.length > 0 ? <CrewStrip seats={seatChoices} chosen={crewSeats} onOpen={() => setPanel("models")} onRemove={id => setCrewSeats(previous => previous.filter(one => one !== id))} disabled={running} /> : null}
              <div className="ws-composer-toolbar"><div className="ws-composer-tools"><IconButton icon="plus" label="Add a file (Word, Markdown, text or CSV)" onClick={() => void addFile()} disabled={busy || running} /><IconButton icon="image" label="Images for this work" onClick={() => void openImages()} disabled={busy || running} /><IconButton icon="folder" label="Choose a workspace folder" onClick={() => void chooseWorkspace()} disabled={busy || running} /><IconButton icon="grid" label="Open a table from a selected file" onClick={() => { const found = sources.find(turn => selected.includes(turn.id) && /\n/u.test(turn.body) && /[,;\t]/u.test(turn.body.split("\n")[0] ?? "")); if (found) void openTable(found.id); else message("Select a CSV or delimited file first, then open it as a table."); }} disabled={busy || running} /><IconButton icon="panel" label="Capture a screen or window into this work" onClick={() => void captureScreen()} disabled={busy || running} />{sources.length ? <button className="ws-source-count" onClick={() => setPanel("sources")} title="Choose context">{selected.length} in context</button> : null}</div><div className="ws-send-controls">{crewSeats.length > 1 ? <button className="ws-send-several" onClick={() => setPanel("crew-plan")} disabled={!draft.trim() || busy || running || Boolean(room?.case?.closedAt)} title="Split this between the bots you chose"><Icon name="grid" size={14} /><span>Send to {crewSeats.length} bots</span></button> : null}<button className="ws-step-through" onClick={proposeAgent} disabled={!draft.trim() || busy || running || Boolean(room?.case?.closedAt)} title="Let it work through this step by step, and watch each step"><Icon name="spark" size={14} /><span>Step through it</span></button><button className="ws-create-image" onClick={() => void openImages(true)} disabled={busy || running || Boolean(room?.case?.closedAt)}><Icon name="spark" size={14} /><span>Make an image</span></button><button className="ws-model-select" onClick={() => setPanel("models")} disabled={running}><ProviderGlyph family={FALLBACK_FAMILY[providerId]} small /><span>{label}{modelId && providerId !== "local" ? ` · ${pickedProvider?.models.find(value => value.id === modelId)?.label ?? modelId}` : ""}</span><Icon name="chevron" size={13} /></button>{providerId === "codex" ? <label className="ws-tools-toggle" title="Let this session read your selected sources in full, asking you before each call"><input type="checkbox" checked={enableTools} disabled={running} onChange={event => setEnableTools(event.target.checked)} /><span>Tools</span></label> : null}{running ? <IconButton className="ws-send is-stop" icon="stop" label="Stop response" onClick={() => void stop()} /> : <IconButton className="ws-send" icon="arrow" label={providerId === "local" ? "Ask the local model" : "Review and send"} disabled={!draft.trim() || busy || Boolean(room?.case?.closedAt)} onClick={() => void prepareSend()} />}</div></div>
            </div>
            {!draftSaved ? <p className="ws-inline-problem" role="alert">Your draft is not saved on this Mac. Copy it before closing.</p> : null}
            <div className="ws-composer-caption"><span>{draftSaved && draft ? "Draft saved on this Mac" : providerId === "local" ? "Runs on this Mac" : "You review what leaves this Mac"}</span><span>↵ to {providerId === "local" ? "ask" : "review"} <i /> ⇧ ↵ new line</span></div>
            {empty && !guideDismissed && guide.nextAction !== null ? <p className="ws-next-step">
              <span>Next</span>{guide.nextAction}
              <button onClick={dismissGuide} aria-label="Stop showing what is next">Hide</button>
            </p> : null}
            {empty && (currentId || (cases.length === 0 && liveRows.length === 0)) ? <div className="ws-starters">
              {starters.map(starter => <button
                key={starter.id === "routine" ? `routine:${starter.routineId ?? ""}` : starter.id}
                className={`ws-starter ws-starter--${starter.icon}`}
                disabled={!starter.available}
                title={starter.unavailableBecause ?? undefined}
                onClick={() => runStarter(starter)}>
                <span className="ws-starter-icon"><Icon name={starter.icon} /></span>
                <strong>{starter.title}</strong>
                <span>{starter.unavailableBecause ?? starter.line}</span>
                <Icon name="arrow" size={14} />
              </button>)}
            </div> : null}
          </div>
        </section>
        {editor && room ? <ArtifactEditor key={room.case?.id ?? "new"} room={room} selectedSourceIds={selected} draft={editor} setDraft={setEditor} savedBody={savedBody} onSaved={savedOutput} onClose={closeEditor} onMessage={message} /> : null}
        </>}
      </div>
    </main>
    {panel === "images" && currentId ? <ImagesPanel caseId={currentId} title={room?.case?.title ?? "This work"} onCreate={() => setPanel("creative")} bridge={host()} readOnly={Boolean(room?.case?.closedAt)} onClose={() => setPanel(null)} /> : null}
    {panel === "creative" && currentId ? <CreativePanel key={currentId} caseId={currentId} title={room?.case?.title ?? "This work"} seed={draft} sources={sources.map(value => ({id: value.id, label: contextLabel(value), text: value.body}))} selected={selected} bridge={host()} readOnly={Boolean(room?.case?.closedAt)} onImages={() => setPanel("images")} onClose={() => setPanel(null)} /> : null}
    {panel === "rename" ? <Modal title="Give this work a useful name" eyebrow="Find it again" onClose={() => {if (!busy) setPanel(null);}}><form className="ws-continuity-form" onSubmit={event => {event.preventDefault();void saveWorkTitle();}}><p className="ws-modal-description">Choose a name you’ll recognise in your history and project.</p><label>Work name<input data-autofocus value={workTitle} maxLength={200} onChange={event => setWorkTitle(event.target.value)} disabled={busy} /></label>{renameProblem ? <p className="ws-inline-problem" role="alert">{renameProblem}</p> : null}<footer className="ws-modal-footer"><button type="button" className="ws-button" disabled={busy} onClick={() => setPanel(null)}>Cancel</button><button className="ws-button ws-button--primary" type="submit" disabled={busy || !workTitle.trim() || workTitle.trim() === room?.case?.title}>{busy ? "Saving…" : "Save name"}</button></footer></form></Modal> : null}
    {panel === "models" ? <Modal title="Choose your AI" eyebrow="Your subscriptions, together" onClose={() => setPanel(null)}><p className="ws-modal-description">Pick the right collaborator for this request. Your conversation stays here when you switch.</p><CrewPicker
      seats={seatChoices}
      chosen={crewSeats}
      onToggle={id => setCrewSeats(previous => previous.includes(id as WorkstationProviderId) ? previous.filter(one => one !== id) : [...previous, id as WorkstationProviderId])}
      onClear={() => setCrewSeats([])}
      max={5} /><div className="ws-provider-list">{providers.map(value => <button key={value.id} className={`ws-provider-row ${providerId === value.id ? "is-selected" : ""}`} disabled={value.state !== "detected" || running} onClick={() => { setProviderId(value.id); setModelId(""); setEnableTools(false); }}><ProviderGlyph family={value.family} badge={value.id.match(/^gemini(\d)$/i)?.[1]} /><div><strong>{value.label}</strong><span>{value.state === "detected" ? "Subscription app found on this Mac" : value.detail}</span></div>{providerId === value.id ? <Icon name="check" /> : <span className="ws-badge">{value.state === "detected" ? "Detected" : "Unavailable"}</span>}</button>)}</div>{pickedProvider && providerId !== "local" ? <div className="ws-model-detail"><label>Model{providerId === "codex" ? <input value={modelId} onChange={event => setModelId(event.target.value)} disabled={running} placeholder="Enter a Codex model ID" /> : <select value={modelId} onChange={event => setModelId(event.target.value)} disabled={running}><option value="">Choose a model</option>{pickedProvider.models.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select>}</label><details className="ws-connection-details"><summary>Connection details</summary><p>{pickedProvider.detail}</p></details><p>{pickedProvider.canApproveTools ? "Tool actions can ask for your approval here." : "This connection is for conversation and selected context. Tool actions may be unavailable."}</p></div> : null}<div className="ws-local-choice"><ProviderGlyph family="local" /><div><strong>Keep it on this Mac</strong><p>Use an installed local model for private questions and selected files.</p></div><button className="ws-button ws-button--small" disabled={checkingLocal} onClick={() => void checkLocal()}>{checkingLocal ? "Checking…" : "Check models"}</button></div>{localModels.map(value => <button className="ws-local-model" key={value.id} onClick={() => { setProviderId("local"); setModelId(value.id); setEnableTools(false); }} disabled={running}><span>{value.id}</span>{providerId === "local" && modelId === value.id ? <Icon name="check" /> : <span>Use locally</span>}</button>)}<footer className="ws-modal-footer"><span>Login and usage limits stay with each provider.</span><button className="ws-button ws-button--primary" onClick={() => setPanel(null)}>Done</button></footer></Modal> : null}
    {panel === "routines" ? <RoutinesPanel starters={routines} saved={continuity.routines} seed={routineSeed} onChoose={useRoutine} onSave={saveRoutine} onVersions={routineVersions} onClose={() => {setPanel(null);setRoutineSeed(null);}} /> : null}
    {panel === "projects" ? <ProjectsPanel projects={continuity.projects} links={continuity.links} cases={cases} initialId={projectPanelId} currentId={currentId} onSave={saveProject} onStart={id => newWork(id)} onOpen={id => void openWork(id)} onUse={useProjectBrief} onClose={() => setPanel(null)} /> : null}
    {panel === "search" ? <SearchPanel
      query={search}
      onQuery={value => void runContentSearch(value)}
      commandHits={commandHits.map(hit => ({ id: hit.item.id, ...(hit.item.kind === "work" ? { caseId: hit.item.id.slice(hit.item.id.indexOf(":") + 1) } : {}), title: hit.item.title, subtitle: hit.item.detail.slice(0, 120), at: hit.item.at }))}
      contentOutcome={contentHits}
      actions={quickActions}
      onRunAction={id => void runQuickAction(id)}
      onOpenWork={id => { setPanel(null); void openWork(id); }}
      onOpenTurn={(caseId, turnId) => { setPanel(null); void openWork(caseId).then(() => setCitationId(turnId)); }}
      onClose={() => setPanel(null)}
      busy={panelBusy} /> : null}
    {panel === "sources" && currentId ? <ContextPanel caseId={currentId} question={draft} sources={sources} selected={selected} disabled={running || Boolean(room?.case?.closedAt)} bridge={host()} shortcuts={api().localShortcuts} onSelection={setSelected} onAddFile={() => {setPanel(null);void addFile();}} onClose={() => setPanel(null)} /> : null}
    {panel === "library" ? <Modal title="Made here. Ready to use." eyebrow="My outputs" wide onClose={() => setPanel(null)}><p className="ws-modal-description">Saved documents from your 30 most recent pieces of work. Open one to keep editing or export it.</p><div className="ws-library">{libraryLoading ? <p className="ws-empty-message">Finding saved outputs…</p> : library.map(value => <button key={value.case?.id} onClick={() => { if (value.case) void openWork(value.case.id, true); }}><div className="ws-library-preview"><Icon name="file" size={25} /><p>{value.artifacts[0]?.body.slice(0, 160)}</p></div><strong>{value.case?.title}</strong><span>Version {value.artifacts[0]?.revision} · {value.artifacts[0] ? relativeTime(value.artifacts[0].createdAt) : ""}</span></button>)}</div>{!libraryLoading && library.length === 0 ? <div className="ws-empty-output"><Icon name="file" size={36} /><h3>Good answers deserve a home.</h3><p>Choose “Make an output” beneath an answer, edit it, and save a version. Your work will appear here.</p><button className="ws-button" onClick={() => setPanel(null)}>Back to work</button></div> : null}</Modal> : null}
    {panel === "help" ? <Modal title="From a thought to something real" eyebrow="Welcome to your workspace" wide onClose={() => setPanel(null)}><div className="ws-guide-art" aria-hidden="true"><span><Icon name="chat" size={26} /></span><i /><span><RellaneMark /></span><i /><span><Icon name="file" size={26} /></span></div><div className="ws-guide-steps"><div><span>01</span><h3>Start with what you need</h3><p>Ask a question or choose a routine. Add files for context, and pick a subscription or a local model.</p></div><div><span>02</span><h3>Work with your AI</h3><p>Review the request before it leaves your Mac. See progress, approve supported tool actions, or stop a response.</p></div><div><span>03</span><h3>Make it yours</h3><p>Turn an answer into an editable output. Save versions and export to Word or Markdown.</p></div></div><footer className="ws-modal-footer"><span>You can reopen this guide whenever you need it.</span><button className="ws-button ws-button--primary" onClick={() => { setPanel(null); if (!draft.trim()) setDraft("Help me turn an idea into a practical plan. Start by asking me three useful questions."); composer.current?.focus(); }}>Try a first conversation<Icon name="arrow" size={15} /></button></footer></Modal> : null}
    {panel === "crew" && crewRun ? <CrewRunPanel
      view={crewRun}
      answers={crewAnswers}
      onStopPart={id => void stopCrewPart(id)}
      onStopAll={() => void stopCrew()}
      onReviewNext={() => void prepareCrewContinuation()}
      onKeep={id => { const found = crewAnswers.find(a => a.partId === id); if (found) { setPanel(null); openEditor(found.text, null); } }}
      onClose={() => setPanel(null)}
      busy={busy} /> : null}
    {panel === "crew-plan" ? <CrewPlanReview
      request={draft.trim()}
      parts={crewSplit.parts.map(part => ({
        id: part.id, title: part.title, prompt: part.prompt, seatLabel: part.seatLabel,
        dependsOnTitles: part.dependsOn.flatMap(id => { const found = crewSplit.parts.find(other => other.id === id); return found ? [found.title] : []; })
      }))}
      idleSeats={crewSeats.filter(id => !crewSplit.parts.some(part => part.seatId === id)).map(id => providers.find(p => p.id === id)?.label ?? LABELS[id])}
      sourceLabels={sources.filter(turn => selected.includes(turn.id)).map(turn => contextLabel(turn))}
      wholeJob={crewSplit.wholeJob}
      refusedBecause={crewSplit.refusedBecause}
      estimatedCalls={crewSplit.parts.length}
      onSend={() => {
        setCrewModelIds(providerId !== "local" && modelId.trim() ? { [providerId]: modelId.trim() } : {});
        setCrewRoles(Object.fromEntries(crewSplit.parts.map(part => [part.id, part.title])));
        setCrewExpectedOutputs({});
        setCrewIntegrationOwner("");
        setPanel(null); setCrewModelPicker(true);
      }}
      onEditPart={() => message("Edit the request in the composer, then review the split again.")}
      onClose={() => setPanel(null)}
      busy={busy} /> : null}
    {panel === "phone" ? <TelegramPanel
      link={phoneLink}
      knocks={phoneKnocks}
      now={Date.now()}
      mayDo={phonePowers?.mayDo ?? ["Checking what your phone may do…"]}
      mayNotDo={phonePowers?.mayNotDo ?? ["This Mac could not be asked just now, so nothing is claimed either way."]}
      saving={busy}
      problem={phoneProblem}
      onSaveToken={token => void savePhoneToken(token)}
      onPairChat={chatId => void pairPhoneChat(chatId)}
      onUnpairChat={() => { const paired = phoneLink.state === "linked" ? phoneLink.pairedChatId : null; if (paired) void unpairPhoneChat(paired); }}
      onForget={() => void forgetPhone()}
      onTestMessage={() => void sendPhoneTest()}
      onClose={() => setPanel(null)} /> : null}
    {panel === "agents" ? <AgentLibraryPanel
      agents={agents.map(agent => { const origin = agent.origin === "user" ? "mine" : "bundled"; const read = readAgent({ id: agent.id, origin, markdown: agent.markdown, updatedAt: agent.updatedAt }); return { id: `${agent.origin}:${agent.id}`, origin, name: read.name, summary: read.summary, updatedAt: agent.updatedAt }; })}
      now={Date.now()}
      onOpen={openAgent}
      onDuplicate={key => { const found = agents.find(a => `${a.origin}:${a.id}` === key); if (found) { setEditingAgentId(`${found.id}-mine`); setEditingAgentOrigin("user"); setAgentDraft(found.markdown); setAgentSavedAt(null); setPanel("agent-edit"); } }}
      onDelete={key => { const found = agents.find(a => `${a.origin}:${a.id}` === key); if (found?.origin === "user") void deleteAgent(found.id); }}
      onNew={() => { setEditingAgentId("my-agent"); setEditingAgentOrigin("user"); setAgentDraft("# My agent\n\nWhat it should do, in your own words.\n"); setAgentSavedAt(null); setPanel("agent-edit"); }}
      onClose={() => setPanel(null)}
      busy={busy} /> : null}
    {panel === "agent-edit" && editingAgentId !== null ? <AgentEditor
      id={editingAgentId}
      origin={editingAgentOrigin === "bundled" ? "bundled" : "mine"}
      markdown={agentDraft}
      check={checkAgentDraft(agentDraft)}
      saving={busy}
      savedAt={agentSavedAt}
      now={Date.now()}
      onChange={setAgentDraft}
      onSave={() => void saveAgent()}
      onRun={runSavedAgent}
      onClose={() => { setPanel("agents"); setEditingAgentId(null); }} /> : null}
    {panel === "knowledge" ? <KnowledgePanel
      seen={null}
      now={Date.now()}
      busy={busy}
      problem={null}
      onHideTerm={() => message("Changing this from here is not wired yet.")}
      onPauseFolder={() => message("Changing this from here is not wired yet.")}
      onGrantFolder={() => message("Adding a folder from here is not wired yet.")}
      onClose={() => setPanel(null)} /> : null}
    {panel === "outside" ? <ConnectorsPanel
      connectors={[]}
      now={Date.now()}
      busy={busy}
      problem={null}
      onEnable={() => message("Changing this from here is not wired yet.")}
      onDisable={() => message("Changing this from here is not wired yet.")}
      onRecheck={() => message("Checking from here is not wired yet.")}
      onClose={() => setPanel(null)} /> : null}
    {panel === "agent" ? <AgentRunPanel
      savedAgentLabel={selectedSavedAgent?.id ?? null}
      expectedOutput={agentExpectedOutput}
      onExpectedOutputChange={(value) => { setAgentExpectedOutput(value); setAgentReview(null); }}
      plan={agentPlan}
      view={buildAgentRunView({
        runId: agentRunId ?? "",
        caseId: currentId ?? "",
        goal: agentGoal,
        state: agentPoll?.state ?? (agentRunId === null ? "awaiting-approval" : "planning"),
        stepsAllowed: AGENT_STEPS_ALLOWED,
        steps: agentPoll?.steps ?? [],
        ...(agentPoll?.failure === undefined ? {} : { failure: agentPoll.failure }),
        now: Date.now()
      })}
      onStart={() => void startAgent()}
      onStop={() => void stopAgent()}
      onCancel={() => { setPanel(null); setAgentRunId(null); setSelectedSavedAgent(null); setAgentExpectedOutput(""); }}
      onClose={() => setPanel(null)}
      busy={busy} /> : null}
    {panel === "dispatch" ? <DispatchPanel
      providers={providers.map(value => ({ id: value.id, label: value.label, usable: value.state === "detected", detail: value.detail, models: value.models }))}
      board={dispatchBoard}
      answers={answers}
      sourceCount={selected.length}
      onSend={(brief, selections) => void prepareDispatch(brief, selections)}
      onStopLane={id => void stopLane(id)}
      onStopAll={() => void stopAllLanes()}
      onCompare={compareNow}
      onKeep={id => { const found = answers.find(answer => answer.providerId === id); if (found) { setPanel(null); openEditor(found.text, null); } }}
      onClose={() => setPanel(null)}
      busy={busy} /> : null}
    {panel === "compare" && comparison ? <ComparisonView comparison={comparison} onKeep={keepAnswer} onClose={() => setPanel("dispatch")} /> : null}
    {panel === "pairing" ? <PairingPanel
      status={pairing}
      now={Date.now()}
      onStart={() => void startPairing("wifi")}
      onStop={() => void stopPairing()}
      onCopyPin={() => { if (pairing.state === "listening") void copy(pairing.pin); }}
      onClose={() => setPanel(null)}
      busy={busy} /> : null}
    {panel === "publish" ? <PublishPanel
      outputTitle={room?.artifacts[0] ? room.case?.title ?? "This work" : null}
      outputWords={room?.artifacts[0]?.body.split(/\s+/u).filter(Boolean).length ?? 0}
      preview={publishPreview}
      onPreview={format => void previewPublish(format)}
      onWrite={format => void writePublish(format)}
      onReveal={() => void revealWorkspace()}
      onClose={() => { setPanel(null); setPublishPreview(null); }}
      busy={busy} /> : null}
    {panel === "research" ? <ResearchPanel
      view={researchRun === null ? null : {
        id: researchRun.runId,
        question: researchRun.question,
        status: researchRun.headline,
        steps: researchRun.steps.map(step => ({ id: String(step.index), title: step.title, live: step.ok === null })),
        answer: researchRun.answer,
        canStop: researchRun.canStop
      }}
      sources={[]}
      unanswered={researchRun?.unanswered ?? []}
      now={Date.now()}
      onStop={() => void stopResearch()}
      onKeep={keepResearch}
      onOpenSource={url => { void host().readWebPage({ url }); }}
      onClose={() => setPanel(null)}
      busy={panelBusy} /> : null}
    {panel === "memory" ? <MemoryPanel
      facts={(memory?.facts ?? []).filter(fact => (Date.now() - (Date.parse(fact.updatedAt) || 0)) < MEMORY_STALE_MS || fact.pinned).map(toPanelFact)}
      stale={(memory?.facts ?? []).filter(fact => !fact.pinned && (Date.now() - (Date.parse(fact.updatedAt) || 0)) >= MEMORY_STALE_MS).map(toPanelFact)}
      projectTitle={project?.title ?? "Personal workspace"}
      now={Date.now()}
      busy={panelBusy || governedLoading}
      onPin={(id, pinned) => void setMemoryFlag(id, { pinned })}
      onHide={(id, hidden) => void setMemoryFlag(id, { hidden })}
      onForget={id => void forgetMemory(id)}
      onClose={() => setPanel(null)}
      projectId={project?.id ?? null}
      governedView={governedMemory}
      governedLoading={governedLoading}
      governedError={governedError}
      proposalDraft={memoryDraftsByProject[currentProjectId ?? "__no_project__"] ?? { kind: "instruction", text: "" }}
      onProposalDraftChange={(draft) => {
        setMemoryDraftsByProject((prev) => ({
          ...prev,
          [currentProjectId ?? "__no_project__"]: draft
        }));
      }}
      onReload={reloadGovernedMemory}
      onPropose={proposeGovernedMemory}
      onReview={reviewGovernedMemory}
      onForgetGoverned={forgetGovernedMemory}
      onSelectProject={() => showProjects()} /> : null}
    {panel === "changes" ? <ChangesPanel
      changes={(changes?.changes ?? []).map(change => ({
        relativePath: change.relativePath,
        kind: change.kind,
        bytes: change.bytes,
        modifiedAt: change.modifiedAt,
        canRestore: change.canRestore,
        whyNot: change.canRestore ? null : "This file was too large to keep a copy of, so it cannot be put back."
      }))}
      folderKnown={changes?.folderKnown ?? false}
      beforeKnown={changes?.beforeKnown ?? false}
      diff={changeDiff}
      now={Date.now()}
      busy={panelBusy}
      restoring={restoring}
      onOpenDiff={value => void openChangeDiff(value)}
      onRestore={value => void restoreChange(value)}
      onReveal={value => void revealFile(value)}
      onClose={() => { setPanel(null); setChangeDiff(null); }} /> : null}
    {panel === "watch" ? <WatchPanel
      rows={watches.map(watch => ({
        watch,
        lastFound: watchFound.get(watch.id) ?? null,
        failing: false
      }))}
      now={Date.now()}
      checking={watchChecking ? "" : null}
      onAdd={(target, cadence, tellMeWhen) => void addWatch(target, cadence, tellMeWhen)}
      onRemove={id => void removeWatch(id)}
      onPause={(id, paused) => void pauseWatch(id, paused)}
      onCheckNow={id => void checkWatchNow(id)}
      onClose={() => setPanel(null)}
      busy={panelBusy} /> : null}
    {panel === "whatsapp" ? <WhatsAppPanel
      status={whatsApp}
      saving={busy}
      problem={whatsAppProblem}
      onSave={input => void saveWhatsApp(input)}
      onForget={() => void forgetWhatsApp()}
      onClose={() => setPanel(null)} /> : null}
    {panel === "usage" ? <UsagePanel
      view={usage}
      window={usageWindow}
      onWindow={next => void openUsage(next)}
      onClose={() => setPanel(null)}
      busy={panelBusy} /> : null}
    {panel === "sessions" ? <SessionsPanel rows={liveRows} summary={fleet} onStop={id => void stopOne(id)} onOpen={id => void goToSession(id)} onClose={() => setPanel(null)} /> : null}
    {panel === "crew" && crewRunId === null ? <CrewPanel board={board} onStart={id => { const seat = providers.find(value => value.id === id); setPanel(null); if (seat) { setProviderId(seat.id); setModelId(""); setEnableTools(false); } if (!room || turns.length === 0) newWork(); }} onOpen={id => void goToSession(id)} onClose={() => setPanel(null)} /> : null}
    {panel === "files" && currentId ? <FilesPanel listing={listing} preview={filePreviewText} change={fileDiff} onSelect={value => void selectFile(value)} onRefresh={() => void openFiles()} onReveal={value => void revealFile(value)} onClose={() => setPanel(null)} busy={panelBusy} /> : null}
    {panel === "data" && currentId ? <DataPanel table={table} result={tableResult} onQuery={spec => void runTableQuery(spec)} onUseAsContext={tableToDraft} onClose={() => setPanel(null)} busy={panelBusy} /> : null}
    {panel === "data" && tableResult ? <button className="ws-button ws-button--primary ws-chart-open" onClick={() => setPanel("chart")}><Icon name="grid" size={15} />Chart this</button> : null}
    {panel === "chart" && tableResult ? <Modal title="What that looks like" eyebrow="Your spreadsheet" wide onClose={() => setPanel("data")}>
      <ChartView
        columns={tableResult.columns.map(name => ({ name, type: "text" }))}
        rows={tableResult.rows}
        title={room?.case?.title ?? "This work"}
        onCopySummary={summary => void copy(summary)} />
    </Modal> : null}
    {panel === "insights" && currentId ? <ProjectInsights view={insightView} pack={pack} onPlanPack={() => void planPack()} onConfirmPack={() => void confirmPack()} onOpenWork={id => { setPanel(null); void openWork(id); }} onClose={() => setPanel(null)} busy={panelBusy} /> : null}
    {panel === "canvas" ? <WorkroomCanvas caseId={currentId ?? "draft"} title={room?.case?.title ?? "Workroom Canvas"} turns={room?.turns ?? []} onClose={() => setPanel(null)} /> : null}
    {panel === "discard" ? <Modal title="Keep your changes?" onClose={() => setPanel(null)}><p className="ws-modal-description">This output has unsaved edits. You can keep the local draft and return later, or discard it.</p><footer className="ws-modal-footer"><button className="ws-button" onClick={() => { if (currentId) removeArtifactDraft(currentId); setEditor(null); setPanel(null); }}>Discard edits</button><button className="ws-button" onClick={keepOutputDraftAndClose}>Keep draft and close</button><button className="ws-button ws-button--primary" onClick={() => setPanel(null)}>Keep editing</button></footer></Modal> : null}
    {citation ? <Modal title={contextLabel(citation)} eyebrow="Saved source" wide onClose={() => setCitationId(null)}><p className="ws-modal-description">The exact saved text behind this reference. Reading it sends nothing.</p><pre className="ws-source-preview">{citation.body}</pre></Modal> : null}
    {filePreview ? <Modal title={filePreview.fileName} eyebrow="Add a file to this work" wide onClose={() => { if (!busy) void cancelFile(); }}><div className="ws-review-facts"><span><Icon name="file" size={15} />{filePreview.format.toUpperCase()}</span><span>{filePreview.bytes.toLocaleString()} bytes</span><span>{filePreview.coverage}</span></div><pre className="ws-source-preview">{filePreview.text}</pre><footer className="ws-modal-footer"><span>This step saves the reviewed text locally.</span><button className="ws-button ws-button--primary" disabled={busy} onClick={() => void acceptFile()}>{busy ? "Adding…" : "Add to context"}</button></footer></Modal> : null}
    {crewModelPicker ? <Modal title="Choose Crew models" eyebrow="One model per connection" wide onClose={() => { if (!busy) { setCrewModelPicker(false); setPanel("crew-plan"); } }}>
      <p className="ws-modal-description">Choose the exact model each connection will use. The next screen shows every full request before anything starts.</p>
      {Array.from(new Set(crewSplit.parts.map(part => part.seatId))).map(id => {
        const seat = providers.find(one => one.id === id);
        return <label key={id} className="ws-model-detail">{seat?.label ?? id}
          <input value={crewModelIds[id] ?? ""} onChange={event => setCrewModelIds(previous => ({ ...previous, [id]: event.target.value }))}
            list={`crew-models-${id}`} placeholder="Enter exact model ID" disabled={busy} />
          <datalist id={`crew-models-${id}`}>{seat?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
        </label>;
      })}
      {crewSplit.parts.map(part => <section key={part.id}>
        <h3>{part.title}</h3>
        <label className="ws-model-detail">Role for this part<input value={crewRoles[part.id] ?? ""} onChange={event => setCrewRoles(previous => ({ ...previous, [part.id]: event.target.value }))} disabled={busy} /></label>
        <label className="ws-model-detail">Expected output<input value={crewExpectedOutputs[part.id] ?? ""} onChange={event => setCrewExpectedOutputs(previous => ({ ...previous, [part.id]: event.target.value }))} placeholder="Describe the result this part must produce" disabled={busy} /></label>
      </section>)}
      <label className="ws-model-detail">Owner of the final result<select value={crewIntegrationOwner} onChange={event => setCrewIntegrationOwner(event.target.value)} disabled={busy}>
        <option value="">Choose a part</option>
        {crewSplit.parts.filter(part => eligibleCrewIntegrationOwners(crewSplit.parts).includes(part.id)).map(part => <option key={part.id} value={part.id}>{part.title}</option>)}
      </select></label>
      <footer className="ws-modal-footer"><button className="ws-button" disabled={busy} onClick={() => { setCrewModelPicker(false); setPanel("crew-plan"); }}>Back to plan</button><button className="ws-button ws-button--primary" disabled={busy || !crewIntegrationOwner || crewSplit.parts.some(part => !crewModelIds[part.seatId]?.trim() || !crewRoles[part.id]?.trim() || !crewExpectedOutputs[part.id]?.trim())} onClick={() => void sendToCrew()}>Review exact calls</button></footer>
    </Modal> : null}
    {agentReview ? <Modal title="Review Step Agent" eyebrow="Exact request" wide onClose={() => { if (!busy) setAgentReview(null); }}>
      {agentReview.reviews.map((lane, index) => <section key={index}><h3>Step {index + 1} · {lane.providerLabel} · {lane.modelId}</h3><p>{lane.workspace.label}: {lane.workspace.path}</p><ReviewPacket raw={lane.contextPreview} /><p>Request fingerprint: <code>{lane.sourceHash}</code></p></section>)}
      <p className="ws-modal-description">This connection may use native tools according to its own permissions. Approval prompts appear when supported.</p>
      <footer className="ws-modal-footer"><button className="ws-button" disabled={busy} onClick={() => setAgentReview(null)}>Keep editing</button><button className="ws-button ws-button--primary" disabled={busy} onClick={() => void startReviewedAgent()}>Start reviewed Agent</button></footer>
    </Modal> : null}
    {crewReview ? <Modal title="Review Crew" eyebrow="Exact requests" wide onClose={() => { if (!busy) setCrewReview(null); }}>
      {crewReview.reviews.map((lane, index) => <section key={`${lane.partId}-${index}`}><h3>{lane.title} · {lane.providerLabel} · {lane.modelId}</h3><p>Role: {lane.role} · Expected output: {lane.expectedOutput} · Final result owner: {lane.integrationOwner}</p><p>{lane.workspace.label}: {lane.workspace.path}</p><ReviewPacket raw={lane.contextPreview} /><p>Request fingerprint: <code>{lane.sourceHash}</code></p></section>)}
      <p className="ws-modal-description">These parts run in order as dependencies allow. Later dependency packets require another review. Native tool access follows each connection’s permissions.</p>
      <footer className="ws-modal-footer"><button className="ws-button" disabled={busy} onClick={() => setCrewReview(null)}>Keep editing</button><button className="ws-button ws-button--primary" disabled={busy} onClick={() => void startReviewedCrew()}>Start reviewed Crew parts</button></footer>
    </Modal> : null}
    {researchReview ? <Modal title="Review Research" eyebrow="Exact request" wide onClose={() => { if (!panelBusy) setResearchReview(null); }}>
      <h3>{researchReview.review.providerLabel} · {researchReview.review.modelId}</h3><p>{researchReview.review.workspace.label}: {researchReview.review.workspace.path}</p>
      <ReviewPacket raw={researchReview.review.contextPreview} /><p>Request fingerprint: <code>{researchReview.review.sourceHash}</code></p>
      <p className="ws-modal-description">This connection may use native tools according to its own permissions. Approval prompts appear when supported.</p>
      <footer className="ws-modal-footer"><button className="ws-button" disabled={panelBusy} onClick={() => setResearchReview(null)}>Keep editing</button><button className="ws-button ws-button--primary" disabled={panelBusy} onClick={() => void startReviewedResearch()}>Start reviewed Research</button></footer>
    </Modal> : null}
    {dispatchReview ? <Modal title="Review Compare" eyebrow="One call per selected connection" wide onClose={() => { if (!busy) setDispatchReview(null); }}>
      <p className="ws-modal-description">These sessions run in order. Each connection receives the exact packet shown below in this work's folder.</p>
      {dispatchReview.reviews.map((lane) => <section key={lane.providerId} aria-label={`${lane.providerLabel} review`}>
        <h3>{lane.providerLabel} · {lane.modelId}</h3>
        <p>{lane.workspace.label}: {lane.workspace.path}</p>
        <ReviewPacket raw={lane.contextPreview} />
        <p>Request fingerprint: <code>{lane.sourceHash}</code></p>
      </section>)}
      <footer className="ws-modal-footer"><button className="ws-button" disabled={busy} onClick={() => setDispatchReview(null)}>Keep editing</button><button className="ws-button ws-button--primary" disabled={busy} onClick={() => void startDispatch()}>{busy ? "Starting…" : `Send ${dispatchReview.reviews.length} reviewed calls`}</button></footer>
    </Modal> : null}
    {review ? <Modal title={`Send to ${review.providerLabel}`} eyebrow="One last look" wide onClose={() => { if (!busy) setReview(null); }}><p className="ws-modal-description">This is the request and context your subscription will receive.</p><div className="ws-review-facts"><span><ProviderGlyph family={FALLBACK_FAMILY[review.providerId]} small />{review.modelId ?? "Subscription default"}</span><span><Icon name="file" size={15} />{review.sourceIds.length} selected {review.sourceIds.length === 1 ? "source" : "sources"}</span><span>{review.resumeSessionId ? "Continues this provider’s saved session" : "New native session"}</span>{toolSummary ? <span>{toolSummary.sessionLine}</span> : null}</div>{toolSummary ? <section className="ws-review-tools" aria-label="Tools this session may use"><h3>{toolSummary.heading}</h3><p className="ws-review-tools-reach">{toolSummary.reachLine}</p><ul className="ws-review-tools-list">{toolSummary.toolRows.map((row, index) => <li key={index}><strong>{row.label}</strong><span>{row.detail}</span></li>)}</ul>{toolSummary.skillNames.length ? <p className="ws-review-tools-skills">Bundled procedures it may read: {toolSummary.skillNames.join(", ")}.</p> : null}<ul className="ws-review-tools-sources">{toolSummary.sourceRows.map((row, index) => <li key={index}><span>{row.label}</span><span>{row.detail}</span></li>)}</ul><p className="ws-review-tools-total">{toolSummary.totalLine}</p></section> : null}<ReviewPacket raw={review.contextPreview} /><details className="ws-review-integrity"><summary>Request fingerprint</summary><code>{review.sourceHash}</code><p>This identifies the exact text being sent.</p></details><div className="ws-review-workspace"><Icon name="folder" /><div><strong>{review.workspace.label}</strong><p>{review.workspace.path}</p><span>{review.providerId === "claude" ? "Claude asks you before each text-file read or write in this folder." : review.providerId === "codex" ? "Codex can read and edit this folder, with minimal system files available for its tools. Access beyond that scope needs a separate approval." : "Tool access stays within the connection’s supported permissions."}</span></div></div><footer className="ws-modal-footer"><button className="ws-button" disabled={busy} onClick={() => setReview(null)}>Keep editing</button><button className="ws-button ws-button--primary" disabled={busy} onClick={() => void sendReviewed()}>{busy ? "Starting…" : `Send to ${review.providerLabel}`}<Icon name="arrow" size={15} /></button></footer></Modal> : null}
  </div>;
}
