/** Keep workrooms, tools and their records reachable without requiring file access
 * merely to open the app. Individual operations explain their own permission and
 * recovery boundaries before the owner chooses them. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkstationApp } from "./workstation/WorkstationApp.js";
import type {
  ContentDigest,
  DesktopBridge,
  FolderDiff,
  HandoffEvent,
  Settings,
  ActivityLog,
  LostGrant,
  SkillCatalogue,
  SkillPreview,
  SkillRunResult,
  RestoreSubject,
  AgentCard,
  AgentRunResult,
  BenchResult,
  BenchProgress,
  BookStanding,
  RunProgress,
  Seen,
  VaultSyncResult,
  ConnectorsSnapshot,
  ConnectorToolView,
  AutomationWorkspaceSnapshot,
  ConciergeSnapshot,
  ModelInstallStatus,
  EngineRoomStatus,
  TimelineCapture
} from "@cadrane/contracts";
import { EngineRoom } from "./components/EngineRoom";
import { AgentsView } from "./components/AgentsView";
import { BriefEditor, BLANK, draftFromCard, newBriefId, type DraftBrief } from "./components/BriefEditor";
import { BookView } from "./components/BookView";
import { useLocalShortcut } from "./hooks/useLocalShortcut";
import { ConnectorsView } from "./components/ConnectorsView";
import { ModelsView, whyBlocked } from "./components/ModelsView";
import { Button, Notice } from "./components/ui";
import { WorkroomGuide } from "./components/WorkroomGuide.js";
import { ModelReviewDialog, type ModelReviewView } from "./components/ModelReviewDialog.js";
import { createModelReview } from "./model-review.js";
import { PlanSheet } from "./components/PlanSheet";
import { RestoreSheet } from "./components/RestoreSheet";
import { SettingsView } from "./components/SettingsView";
import { SkillsView } from "./components/SkillsView";
import { Timeline } from "./components/Timeline";
import { MemoryView } from "./components/MemoryView";
import { Desk, type DeskTurn } from "./components/Desk";
import { Preflight } from "./components/Preflight";
import type { CaseSummary, Deal, DealSummary, TodayItem } from "@cadrane/contracts";
import { CasesView } from "./components/CasesView.js";
import { DealRoom } from "./components/DealRoom.js";
import { DealsView } from "./components/DealsView.js";
import { TodayView } from "./components/TodayView.js";
import { browserStorage, readResume, writeResume } from "./resume.js";
import { CommandPalette } from "./components/CommandPalette";
import { StatusBar } from "./components/StatusBar";
import type { Command } from "./commands";
import { FolderHistory } from "./components/FolderHistory";
import { said } from "../shared/copy.js";
import { ProductNavigation, PRODUCT_ROUTES } from "./components/ProductNavigation.js";
import { placeCount } from "./navigation.js";
import type { Place } from "./navigation.js";
import { RellaneMark } from "./components/RellaneMark.js";
import "./styles/app.css";
import "./styles/workroom.css";

/**
 * Destinations and their counts now live in `navigation.ts`, beside the rail
 * that renders them. Re-exported here so existing importers are undisturbed.
 */
export { placeCount };
export type { Place };

function bridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.cadrane;
}

function LegacyApp() {
  /**
   * Where the app opens.
   *
   * Read once, lazily, from what was remembered — never in a way that can stop
   * the first render, because nothing at startup may block the window. A
   * remembered place that no longer exists comes back as null and lands on the
   * Desk, which is the right answer to "I do not know where you were".
   */
  const remembered = useRef(readResume(browserStorage()));
  const [place, setPlaceRaw] = useState<Place>(
    // Today is the front door: what the business needs from you, not a list of
    // your own containers. A returning session still lands where it left off.
    (remembered.current.place as Place | null) ?? "today"
  );
  const setPlace = useCallback((next: Place) => {
    if (!window.dispatchEvent(new Event("rellane:before-navigation", { cancelable: true }))) return;
    setPlaceRaw(next);
  }, []);
  const [cases, setCases] = useState<readonly CaseSummary[] | null>(null);
  const [todayItems, setTodayItems] = useState<readonly TodayItem[] | null>(null);
  /** Null until the first read lands, so the greeting never flashes. */
  const [freshBook, setFreshBook] = useState<boolean | null>(null);
  /** Every deal, for the rail's second word. Null until the first read lands. */
  const [dealList, setDealList] = useState<readonly DealSummary[] | null>(null);
  /** Whether older enquiries exist that the list is not showing. */
  const [dealsTruncated, setDealsTruncated] = useState(false);
  /**
   * Which screen the open deal was opened from.
   *
   * The room's way out used to be a button that said "← Today" and always went
   * there. Once Deals became a real list that was wrong half the time: somebody
   * working down their quotes came back to a morning list they had not asked
   * for and had to find their place again.
   */
  const [dealFrom, setDealFrom] = useState<Place>("today");
  /** The deal the owner asked to open from Today, consumed once. */
  const [openDealId, setOpenDealId] = useState<string | null>(null);
  /** The deal itself. Null while it loads, and null again on the way out. */
  const [deal, setDeal] = useState<Deal | null>(null);
  /**
   * The room to reopen, consumed once.
   *
   * After the first restore this is cleared, so navigating away from a case and
   * back lands on the list rather than dragging you into the same room forever.
   */
  const [resumeCaseId, setResumeCaseId] = useState<string | null>(
    remembered.current.caseId
  );
  const [roots, setRoots] = useState<readonly string[]>([]);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [catalogue, setCatalogue] = useState<SkillCatalogue | null>(null);
  const [activity, setActivity] = useState<ActivityLog | null>(null);
  // Learning the product is optional. Text work does not require a folder grant.
  const [guideOpen, setGuideOpen] = useState(false);
  /**
   * The folder the rail is pointed at. Every skill runs against this one and
   * says so before it runs.
   *
   * It used to be `roots[0]`, chosen silently. Someone who had granted Desktop,
   * Downloads and Clients could click Librarian and watch it act on whichever
   * folder happened to be first, with nothing on screen naming it. For a
   * product whose first principle is that nothing moves before it has been
   * read, an unnamed target is the wrong default.
   */
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  /**
   * Folders granted in a past session that will not open now.
   *
   * Rellane is ad-hoc signed, so macOS treats every update as a different app
   * and withdraws its folder permissions. These are not an error state; they
   * are the ordinary state after an update, and the rail says so rather than
   * letting a folder disappear.
   */
  const [lost, setLost] = useState<readonly LostGrant[]>([]);
  /**
   * Step-level detail for runs made in this session, keyed by receipt.
   *
   * The ledger records the outcome in one sentence, which is the right level
   * for a record that has to survive a schema change. The per-step breakdown is
   * richer and more perishable, so it lives here and the timeline reveals it on
   * the rows that still have it, rather than being a second list beside the
   * first saying the same things twice.
   */
  const [details, setDetails] = useState<Readonly<Record<string, SkillRunResult>>>({});
  const [pending, setPending] = useState<{ preview: SkillPreview; folder: string } | null>(null);
  /**
   * The row waiting on a decision to be put back.
   *
   * Restore is a change to someone's files, so it gets the same sheet the run
   * that made them got. It is held here rather than acted on directly, because
   * the timeline row is a one-click control and reversing a week-old run from a
   * list is not a click anyone should be able to make by accident.
   */
  const [restoring, setRestoring] = useState<RestoreSubject | null>(null);
  /**
   * The folder's own history: every recorded state, the moment being compared
   * against now, and the diff between them.
   *
   * Kept beside the ledger rather than inside the Timeline component because
   * both surfaces are refreshed by the same events — a run writes to the record
   * *and* changes the folder — and threading one refresh through two components
   * that each fetch their own is how the two get out of step.
   */
  const [captures, setCaptures] = useState<readonly TimelineCapture[] | null>(null);
  const [pickedAt, setPickedAt] = useState<string | null>(null);
  const [diff, setDiff] = useState<FolderDiff | null>(null);
  const [digests, setDigests] = useState<Readonly<Record<string, ContentDigest>>>({});
  /**
   * What this Mac can think with, and the probe behind each answer.
   *
   * Read on demand rather than on a timer: keeping a light green by spawning
   * three version checks all day is exactly the kind of background cost a
   * local-first app has no excuse for.
   */
  const [engineRoom, setEngineRoom] = useState<EngineRoomStatus | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [agents, setAgents] = useState<readonly AgentCard[] | null>(null);
  const [agentRuns, setAgentRuns] = useState<Readonly<Record<string, AgentRunResult>>>({});
  const [benchResult] = useState<BenchResult | null>(null);
  const [connectors, setConnectors] = useState<ConnectorsSnapshot | null>(null);
  const [book, setBook] = useState<BookStanding | null>(null);
  const [bookBusy, setBookBusy] = useState(false);
  const [seen, setSeen] = useState<Seen | null>(null);
  const [benchProgress, setBenchProgress] = useState<BenchProgress | null>(null);
  /** The conversation on the Desk. Kept in memory: it is a working surface. */
  const [deskTurns, setDeskTurns] = useState<readonly DeskTurn[]>([]);
  const [deskBusy, setDeskBusy] = useState(false);
  /** Text the Desk decided was a bill, held for the form to read. */
  const [deskBill, setDeskBill] = useState<string | null>(null);
  /** True while the pre-flight is on screen, before the first folder picker. */
  const [preflight, setPreflight] = useState(false);
  /** True while the command palette is open. ⌘K, from anywhere. */
  const [palette, setPalette] = useState(false);
  /** What the running agent is doing right now, or null between runs. */
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [vaultSaid, setVaultSaid] = useState<VaultSyncResult | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryProblem, setMemoryProblem] = useState<string | null>(null);
  /** The agent being written, or null when nobody is writing one. */
  const [draft, setDraft] = useState<DraftBrief | null>(null);
  const [savingAgent, setSavingAgent] = useState(false);
  const [wish, setWish] = useState("");
  const draftRequest = useLocalShortcut();
  const drafting = draftRequest.busy;
  useEffect(() => { if (place !== "agents") draftRequest.stop(); }, [place, draftRequest.stop]);
  const [draftSaid, setDraftSaid] = useState<string | null>(null);
  const [connectorsBusy, setConnectorsBusy] = useState(false);
  const [benchRunning] = useState(false);
  /**
   * One agent at a time, deliberately. Two frontier CLIs running at once on a
   * laptop is a fan and a bill, and nothing here needs the concurrency.
   */
  const [runningAgent, setRunningAgent] = useState<string | null>(null);
  /**
   * The on-device model catalogue and what is installed.
   *
   * Both have been reachable over IPC the whole time with nothing calling
   * them — the components that did were deleted and never replaced.
   */
  const [models, setModels] = useState<ConciergeSnapshot | null>(null);
  const [installs, setInstalls] = useState<readonly ModelInstallStatus[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);
  const [modelReview, setModelReview] = useState<ModelReviewView | null>(null);
  const modelReviewFlow = useMemo(() => { const api = bridge(); return api ? createModelReview(api.models) : null; }, []);
  useEffect(() => () => modelReviewFlow?.close(), [modelReviewFlow]);
  /** Set when the catalogue could not be read, so the retry does not spin. */
  const [modelsFailed, setModelsFailed] = useState<string | null>(null);
  /** The workflow engine's whole workspace: workflows, runs, artifacts. */
  const [workspace, setWorkspace] = useState<AutomationWorkspaceSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Re-read the record. Called on mount and after anything that writes to it,
   * because a list cached at startup quietly shows the state from before the
   * run the reader came here to check.
   */
  const readActivity = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;
    try {
      setActivity(await api.activity.read());
    } catch {
      setActivity({
        entries: [],
        integrity: "The record could not be read.",
        trustworthy: false
      });
    }
  }, []);

  /**
   * Re-read the folder's recorded states.
   *
   * Silent on failure rather than raising a notice: the timeline is a
   * secondary read on a screen whose primary job is the record, and a folder
   * whose grant an update withdrew would otherwise put an error banner over
   * everything on every refresh. The empty rail already says there is nothing.
   */
  const readCaptures = useCallback(async (folder: string | null) => {
    const api = bridge();
    if (api === undefined || folder === null) {
      setCaptures(folder === null ? [] : null);
      return;
    }
    try {
      setCaptures(await api.timeline.captures({ folder }));
    } catch {
      setCaptures([]);
    }
  }, []);

  /** Compares a chosen moment with the newest reading. */
  const compare = useCallback(
    async (folder: string, from: string, to: string) => {
      const api = bridge();
      if (api === undefined) return;
      setDigests({});
      try {
        setDiff(await api.timeline.diff({ folder, from, to }));
      } catch (problem) {
        setDiff(null);
        setError(said(problem, "That comparison could not be made."));
      }
    },
    []
  );

  /**
   * Picks a moment and compares it with the newest reading.
   *
   * "Since then" rather than a two-handled range: the question this screen
   * exists to answer is "what changed in Clients this week", and that has one
   * end the reader chooses and one end that is always now.
   */
  const pickMoment = useCallback(
    (at: string) => {
      setPickedAt(at);
      setDiff(null);
      const newest = captures?.[0];
      if (activeRoot !== null && newest !== undefined) {
        void compare(activeRoot, at, newest.at);
      }
    },
    [activeRoot, captures, compare]
  );

  const markMoment = useCallback(
    async (reason: string) => {
      const api = bridge();
      if (api === undefined || activeRoot === null) return;
      try {
        await api.timeline.checkpoint({ folder: activeRoot, reason });
        await readCaptures(activeRoot);
      } catch (problem) {
        setError(said(problem, "That moment could not be marked."));
      }
    },
    [activeRoot, readCaptures]
  );

  const hashFile = useCallback(
    async (path: string) => {
      const api = bridge();
      if (api === undefined || activeRoot === null) return;
      try {
        const digest = await api.timeline.hash({ folder: activeRoot, path });
        setDigests((current) => ({ ...current, [path]: digest }));
      } catch {
        setDigests((current) => ({
          ...current,
          [path]: { path, digest: null, problem: "That file could not be read." }
        }));
      }
    },
    [activeRoot]
  );

  const readEngines = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;
    setEngineBusy(true);
    try {
      setEngineRoom(await api.engines.room());
    } catch {
      // Reported as "nothing connected" rather than as an error banner: the
      // Engine Room's own empty state already says this, and better.
      setEngineRoom(null);
    } finally {
      setEngineBusy(false);
    }
  }, []);

  const readAgents = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;
    try {
      setAgents(await api.agents.list());
    } catch {
      setAgents([]);
    }
  }, []);

  /**
   * One argument at a time. A Bench session is two CLIs running concurrently
   * already; letting a second start would put four frontier processes on a
   * laptop and spend two subscriptions on work nobody is reading yet.
   */
  /**
   * Say what you want; get a brief you can correct.
   *
   * The result opens the editor rather than saving, so the sentence under the
   * form is still the thing that decides — a drafted brief the owner did not
   * read is exactly the agent this product exists not to ship.
   */
  const askForDraft = useCallback(async () => {
    const api = bridge();
    if (api === undefined || wish.trim().length === 0) return;
    setDraftSaid(null);
    try {
      const result = await draftRequest.run(api, "agent-brief", handle => api.agents.draft({ handle, sentence: wish.trim() }));
      if (!result) { setDraftSaid("Stopped. Your request is still here; no agent was saved or run."); return; }
      setDraftSaid(result.said);
      if (result.draft !== null) {
        setDraft({
          ...BLANK,
          id: newBriefId(),
          name: result.draft.name,
          purpose: result.draft.purpose,
          instructions: result.draft.instructions ?? "",
          folders: [...(result.draft.folders ?? [])],
          capabilities: [...(result.draft.capabilities ?? [])],
          tier: result.draft.tier ?? "fast",
          maxSteps: result.draft.maxSteps ?? 12,
          maxMinutes: result.draft.maxMinutes ?? 3,
          outbound: result.draft.outbound ?? "never"
        });
        setWish("");
      }
    } catch (problem) {
      setDraftSaid(said(problem, "That could not be drafted."));
    }
  }, [wish, draftRequest.run]);

  const saveDraft = useCallback(async () => {
    const api = bridge();
    if (api === undefined || draft === null) return;
    setSavingAgent(true);
    try {
      // The resolved roster comes back, so the list shows what will run rather
      // than what was typed.
      setAgents(await api.agents.save(draft));
      setDraft(null);
    } catch (problem) {
      setError(said(problem, "That agent could not be saved."));
    } finally {
      setSavingAgent(false);
    }
  }, [draft, setError]);

  const removeAgent = useCallback(
    async (id: string) => {
      const api = bridge();
      if (api === undefined) return;
      try {
        setAgents(await api.agents.remove({ id }));
      } catch (problem) {
        setError(said(problem, "That agent could not be removed."));
      }
    },
    [setError]
  );

  const sayToDesk = useCallback(
    async (text: string) => {
      const api = bridge();
      if (api === undefined) return;
      const mine: DeskTurn = { id: crypto.randomUUID(), mine: true, text, answer: null };
      setDeskTurns((current) => [...current, mine]);
      setDeskBusy(true);
      try {
        const answer = await api.desk.say({ text });
        setDeskTurns((current) => [
          ...current,
          { id: crypto.randomUUID(), mine: false, text: answer.said, answer }
        ]);
        // Held rather than acted on: the bill form is where a person checks the
        // figures, and nothing is stored until they do.
        if (answer.open?.what === "bill") {
          setDeskBill(text);
        }
      } catch (problem) {
        setDeskTurns((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            mine: false,
            text: said(problem, "That could not be answered."),
            answer: null
          }
        ]);
      } finally {
        setDeskBusy(false);
      }
    },
    []
  );

  const readBillFromFile = useCallback(async () => {
    // The book owns the picker, Stop and first proposal; it never discards a
    // computed result just to ask the model for the same reading again.
    setPlace("book");
  }, []);

  const readSeen = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;
    try {
      setSeen(await api.memory.read());
      setMemoryProblem(null);
    } catch (error) {
      // Null rather than an empty list: "nothing has been seen" and "we could
      // not ask" are different answers, and only one of them is reassuring.
      setSeen(null);
      setMemoryProblem(said(error, "That could not be read."));
    }
  }, []);

  const hideTerm = useCallback(
    async (key: string, hidden: boolean) => {
      const api = bridge();
      if (api === undefined) return;
      setMemoryBusy(true);
      try {
        await api.memory.hide({ key, hidden });
        await readSeen();
      } catch (error) {
        setMemoryProblem(said(error, "That term could not be hidden."));
      } finally {
        setMemoryBusy(false);
      }
    },
    [readSeen]
  );

  const pauseFolder = useCallback(
    async (path: string, paused: boolean) => {
      const api = bridge();
      if (api === undefined) return;
      setMemoryBusy(true);
      try {
        await api.memory.pause({ path, paused });
        await readSeen();
        // The agent cards say which folders they work in, and pausing one
        // changes that sentence. Leaving them stale would show a permission
        // the app would now refuse.
        await readAgents();
      } catch (error) {
        setMemoryProblem(said(error, "That folder could not be changed."));
      } finally {
        setMemoryBusy(false);
      }
    },
    [readSeen, readAgents]
  );

  const syncVault = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;
    setMemoryBusy(true);
    try {
      setVaultSaid(await api.vault.sync());
      // A sync can bring notes in, so what has been seen may have changed.
      await readSeen();
    } catch (error) {
      setMemoryProblem(said(error, "The vault could not be written."));
    } finally {
      setMemoryBusy(false);
    }
  }, [readSeen]);

  const readBook = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;
    try {
      setBook(await api.book.standing());
    } catch {
      // The book may not be open yet. Leaving it null shows nothing rather
      // than a zero nobody measured.
      setBook(null);
    }
  }, []);

  /**
   * Writes to the book, then re-reads it.
   *
   * Re-reading rather than patching state: every figure on screen is derived
   * from the bills, so showing a locally-adjusted total would be showing a
   * number the book did not produce — which is the exact class of drift the
   * derived-balance rule exists to prevent.
   */
  const writeToBook = useCallback(
    async (write: (api: NonNullable<ReturnType<typeof bridge>>) => Promise<unknown>) => {
      const api = bridge();
      if (api === undefined) return false;
      setBookBusy(true);
      try {
        await write(api);
        try { setBook(await api.book.standing()); }
        catch { setError("The record was saved, but its balance could not refresh. Reopen the book; do not record it again."); }
        return true;
      } catch (problem) {
        setError(said(problem, "That could not be saved."));
        return false;
      } finally {
        setBookBusy(false);
      }
    },
    [setError]
  );

  const readConnectorList = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;
    try {
      setConnectors(await api.connectors.read());
    } catch (problem) {
      setError(said(problem, "Connectors could not be read."));
    }
  }, [setError]);

  /**
   * Installing, removing and approving all go through settings, because that is
   * where the main process reads them from. Writing settings and then re-reading
   * the connectors keeps the screen honest: it shows what was actually stored,
   * not what the click intended.
   */
  const changeConnectors = useCallback(
    async (change: (current: Settings) => Settings) => {
      const api = bridge();
      if (api === undefined || settings === null) return;
      setConnectorsBusy(true);
      try {
        setSettings(await api.settings.write(change(settings)));
        await readConnectorList();
      } catch (problem) {
        setError(said(problem, "That could not be saved."));
      } finally {
        setConnectorsBusy(false);
      }
    },
    [settings, readConnectorList, setError]
  );

  const runAgent = useCallback(
    async (agentId: string, question: string, sourceToken?: string) => {
      const api = bridge();
      if (api === undefined) return;
      setRunningAgent(agentId);
      setProgress(null);
      try {
        const result = await api.agents.run({ agentId, question, ...(sourceToken ? { sourceToken } : {}) });
        setAgentRuns((current) => ({ ...current, [agentId]: result }));
        // A run is a thing that happened, so the record is re-read whether it
        // answered or not.
        void readActivity();
      } catch (problem) {
        setError(said(problem, "That agent could not be run."));
      } finally {
        setRunningAgent(null);
        setProgress(null);
      }
    },
    [readActivity]
  );

  const exportBrief = useCallback(async (agentId: string) => {
    const api = bridge();
    if (api === undefined) return;
    try {
      const result = await api.agents.exportOne({ agentId });
      // Said only when something was written. A cancelled save box is not an
      // event worth a line of feedback.
      if (result.written) {
        setDraftSaid(`Saved as ${result.fileName}. It carries no folders and no permissions.`);
      }
    } catch (problem) {
      setError(said(problem, "That brief could not be saved."));
    }
  }, []);

  const importBrief = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;
    try {
      const read = await api.agents.importOne();
      setDraftSaid(read.said);
      if (read.ok && read.brief !== null) {
        // Opened in the editor rather than saved: an imported brief is read
        // before it is kept, and it enters the roster through the same save
        // path — and the same ceiling — as one typed by hand.
        setDraft({
          ...BLANK,
          id: newBriefId(),
          name: read.brief.name,
          purpose: read.brief.purpose,
          instructions: read.brief.instructions,
          capabilities: [...read.brief.capabilities],
          tier: read.brief.tier,
          maxSteps: read.brief.limits.maxSteps,
          maxMinutes: read.brief.limits.maxMinutes,
          outbound: read.brief.outbound
        });
      }
    } catch (problem) {
      setError(said(problem, "That brief could not be read."));
    }
  }, []);

  const stopAgent = useCallback(async (agentId: string) => {
    // Told to stop, not asked to. The run's own controller is aborted, which is
    // the same path its clock takes — so it lands on the record as stopped
    // rather than as a failure, and what it had already done is kept.
    await bridge()?.agents.stop({ agentId });
  }, []);

  /**
   * Listens while an agent runs.
   *
   * Subscribed for the life of the app rather than per run: a listener attached
   * when a run starts can miss the first step, which is the one that says which
   * engine it went to.
   */
  useEffect(() => {
    const api = bridge();
    if (api === undefined) return;
    return api.events.onAgentProgress(setProgress);
  }, []);

  useEffect(() => {
    const api = bridge();
    if (api === undefined) return;
    return api.events.onBenchProgress(setBenchProgress);
  }, []);

  const readModels = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;
    try {
      // Recommendations are measured against this machine, so the mode is left
      // to the concierge rather than pinned here.
      const [snapshot, installed] = await Promise.all([
        api.models.recommend(null),
        api.models.installations()
      ]);
      setModels(snapshot);
      setInstalls(installed);
      setModelsFailed(null);
    } catch (problem) {
      // Kept and shown rather than swallowed. A page that silently stays on
      // "loading" forever is the worst of both — no data and no reason.
      setModels(null);
      setModelsFailed(
        said(problem, "The model catalogue could not be read.")
      );
    }
  }, []);

  const reviewModel = useCallback(async (modelId: string) => {
    const fit = models?.recommendations.find(candidate => candidate.model.id === modelId);
    if (!fit || !modelReviewFlow) return;
    const installed = installs.some(item => item.modelId === modelId && item.state === "installed");
    const installable = fit.canInstall && !installed;
    setModelReview({ modelId, name: fit.model.displayName, installable,
      blocked: installed ? "Already installed on this Mac. You can read its terms here."
        : !fit.canInstall ? `${whyBlocked(fit)} Installation is not enabled for this model in this build.` : null,
      review: null, error: null });
    try {
      const review = await modelReviewFlow.open(modelId, installable);
      if (review) setModelReview(current => current?.modelId === modelId ? { ...current, review } : current);
    } catch (error) {
      setModelReview(current => current?.modelId === modelId
        ? { ...current, error: said(error, "This model's signed notice is not available for review.") } : current);
    }
  }, [models, installs, modelReviewFlow]);

  const closeModelReview = useCallback(() => { modelReviewFlow?.close(); setModelReview(null); }, [modelReviewFlow]);

  const confirmModelInstall = useCallback(async () => {
    const review = modelReview?.review;
    if (!review || !modelReview.installable || !modelReviewFlow) return;
    setInstalling(review.modelId);
    setModelReview(null);
    try { await modelReviewFlow.confirm(review); }
    catch (error) { setError(said(error, "That model could not be installed.")); }
    finally { setInstalling(null); void readModels(); }
  }, [modelReview, modelReviewFlow, readModels]);

  const modelInstallActive = installing !== null || installs.some(item => ["queued", "downloading", "verifying"].includes(item.state));
  useEffect(() => {
    if (!modelInstallActive) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        const snapshot = await bridge()?.models.installations();
        if (active && snapshot) setInstalls(snapshot);
      } catch (error) { if (active) setError(said(error, "The model download status could not be read.")); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1_000);
    return () => { active = false; clearInterval(timer); };
  }, [modelInstallActive]);

  const cancelInstall = useCallback(
    async (operationId: string) => {
      const api = bridge();
      if (api === undefined) return;
      try {
        await api.models.cancelInstall(operationId);
      } finally {
        void readModels();
      }
    },
    [readModels]
  );

  const refresh = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;
    try {
      const granted = await api.workspace.roots();
      setRoots(granted);
      // Point at the first folder only when nothing is pointed at yet, or when
      // the folder that was selected has since been revoked.
      setActiveRoot((current) =>
        current !== null && granted.includes(current) ? current : (granted[0] ?? null)
      );
    } catch {
      /* the folder list is not worth an error banner */
    }
    try {
      setLost(await api.workspace.lost());
    } catch {
      /* a rail that cannot list its losses simply shows none */
    }
    try {
      setCatalogue(await api.skills.catalogue());
    } catch {
      /* the rail falls back to empty rather than to an invented list */
    }
    try {
      setSettings(await api.settings.read());
    } catch {
      /* defaults are applied in main; the UI can live without them */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void readActivity();
    void readEngines();
    void readAgents();
  }, [refresh, readActivity, readEngines, readAgents]);

  /**
   * The catalogue is read when somebody opens Models, not at startup.
   *
   * It used to be fetched on mount, where the daemon is not up yet: the call
   * rejected, the catch set null, and nothing ever retried — so the page showed
   * "Measuring this Mac" forever. Loading a place when it is entered is both
   * cheaper at startup and self-healing, because coming back retries.
   */
  useEffect(() => {
    if (place === "models" && models === null && !modelsFailed) {
      void readModels();
    }
  }, [place, models, modelsFailed, readModels]);

  // Same rule for connectors, and more important here: reading them starts
  // third-party processes, which must not happen at launch for a screen nobody
  // opened.
  // Read on entering Home, so a bill added elsewhere shows without a restart.
  useEffect(() => {
    if (place === "desk" || place === "book") {
      void readBook();
    }
  }, [place, readBook]);

  /**
   * Cases, loaded when the place is entered.
   *
   * Null until the first answer comes back, so the screen can say "checking…"
   * rather than printing a zero nobody observed.
   */
  const readCases = useCallback(async (): Promise<void> => {
    const api = bridge();
    if (api === undefined) {
      return;
    }
    const answer = await api.cases.list();
    setCases(answer.cases);
  }, []);

  const readToday = useCallback(async (): Promise<void> => {
    const api = bridge();
    if (api === undefined) {
      return;
    }
    const answer = await api.today.read();
    setTodayItems(answer.items);
    setFreshBook(answer.freshBook);
  }, []);

  useEffect(() => {
    if (place === "today") {
      void readToday();
    }
  }, [place, readToday]);


  /**
   * The deal room's whole data path.
   *
   * Every verb answers with the deal, so the room re-renders from what the book
   * actually holds rather than from what the renderer hoped the write did. A
   * screen that shows an optimistic price beside a customer's own words is the
   * one failure this screen exists to prevent.
   */
  const readOneDeal = useCallback(async (enquiryId: string): Promise<void> => {
    const api = bridge();
    if (api === undefined) return;
    setDeal((await api.deals.read({ enquiryId })).deal);
  }, []);

  useEffect(() => {
    if (openDealId === null) {
      setDeal(null);
      return;
    }
    void readOneDeal(openDealId);
  }, [openDealId, readOneDeal]);

  const readDeals = useCallback(async (): Promise<void> => {
    const api = bridge();
    if (api === undefined) {
      return;
    }
    const answer = await api.deals.list();
    setDealList(answer.deals);
    setDealsTruncated(answer.more);
  }, []);

  // Re-read on arrival rather than once: a deal closed in the room behind this
  // screen changes a row here, and a list that is only correct on first mount
  // is one the owner learns to distrust.
  useEffect(() => {
    if (place === "deals" && openDealId === null) {
      void readDeals();
    }
  }, [place, openDealId, readDeals]);

  const leaveDeal = useCallback(() => {
    setOpenDealId(null);
    setPlace(dealFrom);
    // Whichever list they are going back to is stale: the deal behind them may
    // have just been priced, sent, closed or dismissed.
    void (dealFrom === "deals" ? readDeals() : readToday());
  }, [dealFrom, readDeals, readToday, setPlace]);

  useEffect(() => {
    if (place === "cases") {
      void readCases();
    }
  }, [place, readCases]);

  // Where you are, written as you move. A convenience, so it never throws and
  // never reports — losing it costs one click.
  useEffect(() => {
    writeResume(browserStorage(), { place, caseId: null });
  }, [place]);

  useEffect(() => {
    if (place === "memory") {
      void readSeen();
    }
  }, [place, readSeen]);

  useEffect(() => {
    if (place === "connectors" && connectors === null) {
      void readConnectorList();
    }
  }, [place, connectors, readConnectorList]);

  // A different folder is a different history, so the chosen moment and its
  // comparison are dropped rather than carried across — a diff labelled with
  // one folder's timestamps while listing another's files would be worse than
  // no diff at all.
  useEffect(() => {
    setPickedAt(null);
    setDiff(null);
    setDigests({});
    void readCaptures(activeRoot);
    // A folder grant changes what every brief resolves to, so the cards are
    // re-read rather than left showing a withheld folder that now exists.
    void readAgents();
  }, [activeRoot, readCaptures, readAgents]);

  // The overlay does the reading, so a plan arrives already made and the sheet
  // is up the moment the window comes forward.
  useEffect(() => {
    const api = bridge();
    if (api === undefined) {
      return;
    }
    return api.events.onHandoff((event: HandoffEvent) => {
      if (event.problem !== undefined) {
        setError(event.problem);
        return;
      }
      if (event.preview !== undefined && event.folder !== undefined) {
        setError(null);
        setPending({ preview: event.preview, folder: event.folder });
        return;
      }
      // "Ask" and "search" have no home yet. Say so rather than doing nothing,
      // which is indistinguishable from being broken.
      setError(
        `“${event.query}” needs a skill that does not exist yet. Desktop Librarian is the only one so far.`
      );
    });
  }, []);

  // The theme is applied to the document, not guessed. "system" removes the
  // stamp entirely so prefers-color-scheme decides, which is the only way the
  // three states stay distinguishable.
  useEffect(() => {
    const root = document.documentElement;
    if (settings === null || settings.theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", settings.theme);
    }
  }, [settings]);

  const saveSettings = useCallback(async (next: Settings) => {
    setSettings(next); // optimistic: the switch moves on the frame you click it
    const api = bridge();
    if (api === undefined) return;
    try {
      setSettings(await api.settings.write(next));
    } catch {
      void refresh();
    }
  }, [refresh]);

  const revokeFolder = useCallback(async (root: string) => {
    const api = bridge();
    if (api === undefined) return;
    setRoots(await api.workspace.revoke({ path: root }));
  }, []);

  /**
   * Opens the picker, having already explained what macOS will ask.
   *
   * Split from `grantFolder` so the explanation cannot be skipped by a new call
   * site: everything that grants a folder goes through `grantFolder`, and only
   * this half — reached after the pre-flight — actually opens the picker.
   */
  const pickFolder = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;
    try {
      setRoots(await api.workspace.grant());
      setError(null);
      // Re-read rather than patch: granting a folder can also clear it from the
      // lost list, and a rail still showing "grant it again" beside the folder
      // you just granted is worse than no message at all.
      void refresh();
    } catch (caught) {
      setError(said(caught, "That folder could not be granted."));
    }
  }, [refresh]);

  const grantFolder = useCallback(async () => {
    const api = bridge();
    if (api === undefined) return;
    // Said once, before the first folder. macOS shows its own box within a
    // second of the picker closing, and a system prompt nobody was warned about
    // reads as the app helping itself.
    if (settings?.consent.foldersExplained === true) {
      await pickFolder();
      return;
    }
    setPreflight(true);
  }, [settings, pickFolder]);

  const passedPreflight = useCallback(async () => {
    setPreflight(false);
    const api = bridge();
    // Recorded before the picker opens, not after: somebody who reads the
    // explanation and then cancels has still been told, and showing it again
    // would be the app not listening.
    if (api !== undefined && settings !== null) {
      const next = {
        ...settings,
        consent: { ...settings.consent, foldersExplained: true }
      };
      setSettings(await api.settings.write(next).catch(() => next));
    }
    await pickFolder();
  }, [settings, pickFolder]);

  /** Step one: work out what would happen. Touches nothing. */
  const preview = useCallback(
    async (skill: string, folder: string) => {
      const api = bridge();
      if (api === undefined) return;
      setBusy(true);
      setError(null);
      try {
        const result = await api.skills.preview({ skill, path: folder });
        setPending({ preview: result, folder });
      } catch (caught) {
        setError(said(caught, "That folder could not be read."));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  /** Step two: run what you just approved. */
  const run = useCallback(async () => {
    const api = bridge();
    const held = pending;
    if (api === undefined || held === null) return;
    setPending(null);
    setBusy(true);
    setError(null);
    try {
      const result: SkillRunResult = await api.skills.run({ planId: held.preview.planId });
      setDetails((current) => ({ ...current, [result.receiptId]: result }));
      if (result.historyWarning !== undefined) setError(result.historyWarning);
    } catch (caught) {
      setError(said(caught, "That run did not finish."));
    } finally {
      setBusy(false);
      // The record is the surface now, so it is re-read whether the run
      // succeeded or not — a failure is a thing that happened too. The folder's
      // own history is re-read with it: a run that moved files changed both
      // what Rellane has done and what the folder now looks like.
      void readActivity();
      void readCaptures(activeRoot);
    }
  }, [pending, readActivity, readCaptures, activeRoot]);

  const restore = useCallback(
    async (receiptId: string) => {
      const api = bridge();
      if (api === undefined) return;
      setRestoring(null);
      setError(null);
      try {
        const result = await api.skills.undo({ receiptId });
        if (result.undone) {
          setDetails((current) => {
            const remaining = { ...current };
            delete remaining[receiptId];
            return remaining;
          });
          if (result.historyWarning !== undefined) setError(result.historyWarning);
        } else {
          setError("That restore is no longer available. No files were restored by this request.");
        }
      } catch (caught) {
        setError(said(caught, "That could not be put back."));
      } finally {
        // An undo is itself recorded, so the timeline has to be re-read rather
        // than patched in place: the row that changes is not only the one that
        // was restored. Putting a folder back also changes the folder, so its
        // history is re-read too.
        void readActivity();
        void readCaptures(activeRoot);
      }
    },
    [readActivity, readCaptures, activeRoot]
  );

  /**
   * Every verb and every place, for the palette.
   *
   * Only things that actually run are listed. There is no "Crew" group yet
   * because there is no crew yet, and a palette that offers a command which
   * does nothing is how a person learns to stop trusting the palette. The one
   * exception is a verb that exists but cannot run *right now* — that carries
   * its reason and stays visible, because "no engine is docked" is an answer
   * and a missing row is not.
   */
  const commands = useMemo<readonly Command[]>(() => {
    const verbs: Command[] = [
      {
        id: "do.workroom-guide",
        title: "How a workroom works",
        group: "Do",
        hint: "brief, sources, output",
        keywords: ["help", "walkthrough", "guide", "getting started"]
      },
      {
        id: "do.grant-folder",
        title: "Grant a folder…",
        group: "Do",
        hint: "opens the picker",
        keywords: ["permission", "access", "add folder", "downloads"]
      },
      {
        id: "do.read-bill",
        title: "Read a bill from a file",
        group: "Do",
        hint: "no typing",
        keywords: ["invoice", "photograph", "scan", "pdf", "import", "paste"]
      },
      {
        id: "do.sync-vault",
        title: "Mirror the book to the vault",
        group: "Do",
        hint: "markdown",
        keywords: ["obsidian", "export", "notes", "plain text"]
      },
      {
        id: "do.import-brief",
        title: "Import an agent brief",
        group: "Do",
        keywords: ["open", "load", "share", "agent file"]
      },
      {
        id: "do.refresh",
        title: "Refresh everything",
        group: "Do",
        hint: "re-probes",
        keywords: ["reload", "check again", "status"]
      }
    ];

    const places: Command[] = PRODUCT_ROUTES.map((entry) => ({
      id: `go.${entry.id}`,
      title: entry.label,
      group: "Go" as const,
      hint: entry.id
    }));

    return [...verbs, ...places];
  }, []);

  const runCommand = useCallback(
    (id: string) => {
      if (id.startsWith("go.")) {
        setPlace(id.slice(3) as Place);
        return;
      }
      switch (id) {
        case "do.workroom-guide": setGuideOpen(true); return;
        case "do.grant-folder": void grantFolder(); return;
        case "do.read-bill": void readBillFromFile(); return;
        case "do.sync-vault": void syncVault(); return;
        case "do.import-brief": void importBrief(); return;
        case "do.refresh": void refresh(); return;
        default: return;
      }
    },
    [grantFolder, readBillFromFile, syncVault, importBrief, refresh]
  );

  /**
   * ⌘K, from anywhere.
   *
   * Bound on the window rather than on the shell, so it works while focus is in
   * a text field — which is most of the time, and is exactly when somebody
   * wants to jump somewhere else. `preventDefault` because the browser under
   * Electron has its own idea about ⌘K.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="shell">
      {guideOpen ? <WorkroomGuide onClose={() => setGuideOpen(false)} /> : null}
      {modelReview ? <ModelReviewDialog state={modelReview} onClose={closeModelReview} onConfirm={() => void confirmModelInstall()} /> : null}
      {palette ? (
        <CommandPalette
          commands={commands}
          onRun={(id) => runCommand(id)}
          onClose={() => setPalette(false)}
        />
      ) : null}
      {/**
       * One sidebar of places, one content area. The old shell had three
       * navigation mechanisms — header buttons, rail links and folder buttons,
       * all opening overlays — which is why nobody could say where they were.
       * Drawers now survive only for consent moments: the plan sheet and the
       * restore sheet, which are decisions rather than destinations.
       */}
      <nav className="side" aria-label="Places">
        <div className="side__top" />
        <div className="side__brand"><RellaneMark className="rellane-mark" /><span>rellane<span className="side__edition">WORKROOM</span></span></div>
        <ProductNavigation place={place} onGo={setPlace} />

        <div className="side__group">
          <p className="side__label">Workspace folders</p>
          {roots.length === 0 ? (
            <button type="button" className="scope" onClick={() => void grantFolder()}>
              <span className="scope__name">Grant a folder…</span>
            </button>
          ) : (
            <>
              {roots.map((root) => (
                <button
                  key={root}
                  type="button"
                  className={root === activeRoot ? "scope scope--on" : "scope"}
                  onClick={() => setActiveRoot(root)}
                >
                  <span className="scope__name">{root.split("/").filter(Boolean).pop() ?? root}</span>
                </button>
              ))}
              <button type="button" className="scope" onClick={() => void grantFolder()}>
                <span className="scope__name">Add another…</span>
              </button>
            </>
          )}
          {lost.length === 0 ? null : (
            // A count only, because the folders and their reasons are named in
            // full at the top of the content area. Saying it twice in different
            // words would read as two different problems.
            <p className="side__lost">
              {lost.length === 1 ? "1 folder needs" : `${lost.length} folders need`} granting again
            </p>
          )}
        </div>

        <div className="side__foot">
          <span className="side__local">Stored on this Mac</span>
          <button
            type="button"
            className={place === "settings" ? "place place--on" : "place"}
            onClick={() => setPlace("settings")}
          >
            Workspace settings
          </button>
        </div>
      </nav>

      {preflight ? (
        <Preflight onContinue={() => void passedPreflight()} onCancel={() => setPreflight(false)} />
      ) : null}

      <main className="view">
        {error === null ? null : <Notice tone="bad">{error}</Notice>}

        {/**
          * Folders that were granted once and will not open now.
          *
          * Named, with the reason, and with the one action that fixes it — the
          * sidebar's *"1 folder granted before will not open now"* said neither
          * which folder nor why, which is precisely the silent degradation this
          * task exists to forbid. Almost always this is macOS withdrawing
          * permission after an update rather than anything being wrong, and
          * saying so is the difference between a person re-granting a folder
          * and a person concluding the app lost their data.
          */}
        {lost.length === 0 ? null : (
          <div className="lost">
            {lost.map((grant) => (
              <div className="lost__row" key={grant.path}>
                <span className="lost__text">
                  <span className="lost__name">{grant.path.split("/").filter(Boolean).pop()}</span>
                  <span className="lost__why">{grant.reason}</span>
                </span>
                <Button onClick={() => void grantFolder()}>Grant it again</Button>
              </div>
            ))}
          </div>
        )}

        {place === "desk" ? (
          <Desk
            turns={deskTurns}
            book={book}
            busy={deskBusy}
            onSay={(text) => void sayToDesk(text)}
            onReadFile={() => void readBillFromFile()}
            onOpenLink={(url) => void bridge()?.updates.openLink({ url })}
            onOpen={(what, id) => {
              // The Desk names a surface; opening it is still the ordinary
              // route to that surface, with whatever it normally asks intact.
              if (what === "bill") {
                setPlace("book");
              } else if (id !== undefined) {
                setPlace("agents");
                void runAgent(id, "");
              }
            }}
          />
        ) : null}

        {place === "agents" ? (
          <>
            <header className="view__head">
              <h1 className="view__title">Agents</h1>
              <p className="view__lede">
                Every agent is a brief you can read. Nothing here has standing permission to
                send anything: whatever an agent prepares, you approve before it leaves this Mac.
              </p>
            </header>
            {draft === null ? (
              <div className="ag__new">
                <div className="ag__wish">
                  <input
                    className="input"
                    value={wish}
                    maxLength={2_000}
                    disabled={drafting}
                    placeholder="Describe a job — “read client notes and list what needs confirming”"
                    onChange={(event) => setWish(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !drafting) {
                        void askForDraft();
                      }
                    }}
                  />
                  <Button
                    tone="primary"
                    disabled={drafting || wish.trim().length === 0}
                    onClick={() => void askForDraft()}
                  >
                    {drafting ? "Drafting on this Mac…" : "Draft on this Mac"}
                  </Button>
                  {drafting ? <Button disabled={draftRequest.phase === "stopping"} onClick={draftRequest.stop}>
                    {draftRequest.phase === "stopping" ? "Stopping…" : "Stop drafting"}</Button> : null}
                  <Button disabled={drafting} onClick={() => setDraft({ ...BLANK, id: newBriefId() })}>Write it myself</Button>
                  <Button disabled={drafting} onClick={() => void importBrief()}>Open one</Button>
                </div>
                {draftSaid === null ? null : <p className="ag__wishsaid">{draftSaid}</p>}
              </div>
            ) : (
              <BriefEditor
                draft={draft}
                roots={roots}
                saved={agents?.find((card) => card.id === draft.id) ?? null}
                busy={savingAgent}
                onChange={setDraft}
                onSave={() => void saveDraft()}
                onCancel={() => setDraft(null)}
              />
            )}
            <AgentsView
              agents={agents}
              onEdit={(card) => { draftRequest.stop(); setDraft(draftFromCard(card)); }}
              onRemove={(id) => void removeAgent(id)}
              contacts={settings?.contacts ?? []}
              onStage={async (input) => {
                const api = bridge();
                if (api === undefined) {
                  return { staged: false, said: "Rellane is not ready yet." };
                }
                const result = await api.dispatch.stage(input);
                // A staged message is a thing that happened, so the record is
                // re-read whether it opened or was refused.
                void readActivity();
                return result;
              }}
              runs={agentRuns}
              running={runningAgent}
              progress={progress}
              onStop={(id) => void stopAgent(id)}
              onExport={(id) => void exportBrief(id)}
              onRun={runAgent}
              onWorkroom={(id) => { setResumeCaseId(id); setPlace("cases"); }}
            />
          </>
        ) : null}

        {place === "connectors" ? (
          <>
            <header className="view__head">
              <h1 className="view__title">Connectors</h1>
              <p className="view__lede">
                Other people&rsquo;s programs, giving Rellane abilities we did not build. Each
                one runs as its own process, and every tool inside it needs your approval
                before an agent can use it — whatever the connector says about itself.
              </p>
            </header>
            <ConnectorsView
              snapshot={connectors}
              busy={connectorsBusy}
              onInstall={(id) =>
                void changeConnectors((current) => {
                  const offer = connectors?.available.find((entry) => entry.id === id);
                  return offer === undefined
                    ? current
                    : {
                        ...current,
                        connectors: [
                          ...current.connectors,
                          {
                            id: offer.id,
                            label: offer.label,
                            command: offer.command,
                            args: offer.args
                          }
                        ]
                      };
                })
              }
              onRemove={(id) =>
                void changeConnectors((current) => ({
                  ...current,
                  connectors: current.connectors.filter((entry) => entry.id !== id),
                  // Approvals go with it. Leaving them behind would silently
                  // re-approve every tool if the same connector were reinstalled.
                  approvals: current.approvals.filter((entry) => entry.serverId !== id)
                }))
              }
              onApprove={(tool, approved) =>
                void changeConnectors((current) => ({
                  ...current,
                  approvals: approved
                    ? [
                        ...current.approvals.filter(
                          (entry) =>
                            !(entry.serverId === tool.serverId && entry.toolName === tool.name)
                        ),
                        {
                          serverId: tool.serverId,
                          toolName: tool.name,
                          // Sent back exactly as received; the renderer never derives it.
                          descriptionHash: tool.descriptionHash
                        }
                      ]
                    : current.approvals.filter(
                        (entry) =>
                          !(entry.serverId === tool.serverId && entry.toolName === tool.name)
                      )
                }))
              }
            />
          </>
        ) : null}

        {place === "book" ? (
          <>
            <header className="view__head">
              <h1 className="view__title">The book</h1>
              <p className="view__lede">
                Read a bill, check its details, then record it. Customer balances are calculated
                from your saved bills and payments.
              </p>
            </header>
            <BookView
              standing={book}
              busy={bookBusy}
              onAddParty={(input) => void writeToBook((api) => api.book.addParty(input))}
              onAddInvoice={(input) => writeToBook((api) => api.book.addInvoice(input))}
              onAddPayment={(input) => void writeToBook((api) => api.book.addPayment(input))}
              api={bridge()}
              initialText={deskBill ?? ""}
            />
          </>
        ) : null}

        {place === "models" ? (
          <>
            <header className="view__head">
              <h1 className="view__title">Local models</h1>
              <p className="view__lede">
                Models that run on this Mac, ranked by how well they fit it rather than by how
                large they are. Nothing is offered that Rellane expects to fail here.
              </p>
            </header>
            {modelsFailed === null ? null : (
              <Notice tone="bad">
                {modelsFailed}{" "}
                <button
                  type="button"
                  className="band__more"
                  onClick={() => {
                    setModelsFailed(null);
                    void readModels();
                  }}
                >
                  Try again
                </button>
              </Notice>
            )}
            <ModelsView
              snapshot={models}
              installs={installs}
              busy={installing}
              onReview={(id) => void reviewModel(id)}
              onCancel={(op) => void cancelInstall(op)}
            />
          </>
        ) : null}

        {place === "today" ? (
          <TodayView
            items={todayItems}
            freshBook={freshBook}
            onRefresh={() => void readToday()}
            onAddEnquiry={async (input) => {
              const api = bridge();
              if (api === undefined) return;
              const { enquiryId } = await api.enquiries.add(input);
              // This book is no longer empty, and we know it because the write
              // came back with an id. Without this the greeting reappears for a
              // frame on the way back to Today — `todayItems` is still the empty
              // array from before the add, and the re-read has not landed yet.
              setFreshBook(false);
              // Straight into the room it created. The owner pasted this to do
              // something about it, and a list that just grew by one is not that.
              setDealFrom("today");
              setOpenDealId(enquiryId);
              setPlace("deals");
            }}
            onOpen={(item) => {
              // A line goes to the thing it came from. Enquiries and quotations
              // open the deal they belong to; a case opens its room. `invoice`
              // is unreachable here: today() stopped producing one when billing
              // was cut, and the branch that sent it to the Book went with it.
              if (item.kind === "enquiry" || item.kind === "quotation") {
                setDealFrom("today");
                setOpenDealId(item.id);
                setPlace("deals");
                return;
              }
              setResumeCaseId(item.id);
              setPlace("cases");
            }}
          />
        ) : null}

        {place === "deals" && openDealId !== null && deal !== null ? (
          <DealRoom
            /*
             * Keyed on the enquiry, so a different deal is a different
             * component and not the same one being talked out of its state.
             *
             * The resets used to be effects, which run after paint: switching
             * deals rendered the new customer for a frame carrying the previous
             * one's typed reason, message preview and proposed lines. Worse, a
             * reading still in flight when the owner moved on resolved into the
             * new room and put one customer's lines under another's name — the
             * single thing this screen exists to prevent.
             */
            key={deal.enquiryId}
            deal={deal}
            now={Date.now()}
            backTo={dealFrom === "deals" ? "Enquiries" : "Today"}
            onBack={leaveDeal}
            onDraft={() => {
              void (async () => {
                const api = bridge();
                if (api === undefined) return;
                setDeal((await api.deals.draft({ enquiryId: deal.enquiryId })).deal);
              })();
            }}
            onReadEnquiry={async () => {
              const api = bridge();
              if (api === undefined) return { lines: [], said: "" };
              const answer = await api.deals.readEnquiry({ enquiryId: deal.enquiryId });
              // `said` is returned whether it worked or not, so a refusal is
              // read by the owner rather than becoming an empty panel.
              return { lines: answer.lines, said: answer.said };
            }}
            onAddLine={async (line) => {
              const api = bridge();
              if (api === undefined) return;
              // Drafted on demand. Reading an enquiry writes nothing, so a
              // proposal can exist before a quotation does — and refusing the
              // first line the owner priced because of that is the product
              // saying no to the one thing it asked them to do.
              const quotation =
                deal.quotation ?? (await api.deals.draft({ enquiryId: deal.enquiryId })).deal?.quotation ?? null;
              if (quotation === null) return;
              setDeal(
                (
                  await api.deals.addLine({
                    quotationId: quotation.quotationId,
                    description: line.description,
                    quantity: line.quantity,
                    unitPricePaise: line.unitPricePaise,
                    unit: line.unit ?? null
                  })
                ).deal
              );
            }}
            onRemoveLine={async (itemId) => {
              const api = bridge();
              if (api === undefined || deal.quotation === null) return;
              setDeal(
                (await api.deals.removeLine({ quotationId: deal.quotation.quotationId, itemId })).deal
              );
            }}
            onRecall={async (like) => {
              const api = bridge();
              if (api === undefined) return [];
              return (await api.deals.pastLines({ like })).lines;
            }}
            onMessage={async () => {
              const api = bridge();
              if (api === undefined) return null;
              return (await api.deals.message({ enquiryId: deal.enquiryId })).text;
            }}
            onSend={() => {
              void (async () => {
                const api = bridge();
                if (api === undefined || deal.quotation === null) return;
                setDeal((await api.deals.send({ quotationId: deal.quotation.quotationId })).deal);
              })();
            }}
            onClose={(state, reason) => {
              void (async () => {
                const api = bridge();
                if (api === undefined || deal.quotation === null) return;
                const answer = await api.deals.close({
                  quotationId: deal.quotation.quotationId,
                  state,
                  reason: reason.trim() === "" ? null : reason
                });
                setDeal(answer.deal);
                // A closed deal leaves Today, so the queue behind it is stale
                // the moment this returns.
                void readToday();
              })();
            }}
            onModels={() => setPlace("models")}
            onAllowCustomer={async () => {
              const api = bridge();
              if (api === undefined) return "Rellane is not ready yet.";
              const answer = await api.deals.allowCustomer({ enquiryId: deal.enquiryId });
              // The list the app obeys just changed. Settings would otherwise
              // show a stale copy of it, missing the customer just added.
              void (async () => {
                try {
                  setSettings(await api.settings.read());
                } catch {
                  /* the screen that shows the list re-reads on its own */
                }
              })();
              return answer.said;
            }}
            onWhatsApp={async () => {
              const api = bridge();
              if (api === undefined) {
                return { said: "Rellane is not ready yet.", canAdd: false };
              }
              const answer = await api.deals.handoff({ enquiryId: deal.enquiryId });
              // Staged, refused or failed, something outbound was attempted —
              // and the record of what this Mac did is read from the timeline,
              // not from what this screen hoped happened.
              void readActivity();
              return { said: answer.said, canAdd: answer.canAdd };
            }}
            onSetCustomer={async (who) => {
              const api = bridge();
              if (api === undefined) return;
              const answer = await api.deals.setCustomer({ enquiryId: deal.enquiryId, ...who });
              setDeal(answer.deal);
              // A named customer changes the row this deal has in the list.
              void readDeals();
            }}
            onTriage={(triage) => {
              void (async () => {
                const api = bridge();
                if (api === undefined) return;
                setDeal((await api.deals.triage({ enquiryId: deal.enquiryId, triage })).deal);
                // Junk leaves Today and `real` puts it back, so the queue behind
                // this room is wrong either way until it is read again.
                void readToday();
              })();
            }}
          />
        ) : null}

        {place === "deals" && openDealId === null ? (
          <DealsView
            deals={dealList}
            more={dealsTruncated}
            now={Date.now()}
            onOpen={(enquiryId) => {
              setDealFrom("deals");
              setOpenDealId(enquiryId);
            }}
          />
        ) : null}

        {place === "cases" && openDealId === null ? (
          <CasesView
            cases={cases}
            onModels={() => setPlace("models")}
            onGuide={() => setGuideOpen(true)}
            onRefresh={() => void readCases()}
            resumeCaseId={resumeCaseId}
            onResumed={() => setResumeCaseId(null)}
            onRoomChanged={(caseId) =>
              writeResume(browserStorage(), { place: "cases", caseId })
            }
          />
        ) : null}

        {place === "memory" ? (
          <MemoryView
            seen={seen}
            vault={vaultSaid}
            busy={memoryBusy}
            problem={memoryProblem}
            onHide={(key, hidden) => void hideTerm(key, hidden)}
            onPause={(path, paused) => void pauseFolder(path, paused)}
            onSyncVault={() => void syncVault()}
            onRevealVault={() => void bridge()?.vault.reveal()}
            onGrantFolder={() => void grantFolder()}
          />
        ) : null}

        {place === "timeline" ? (
          <>
            <header className="view__head">
              <h1 className="view__title">Timeline</h1>
              <p className="view__lede">
                What Rellane did, and what changed in the folders it watches. One record, sealed
                as it is written.
              </p>
            </header>
            {activeRoot === null ? null : (
              <FolderHistory
                folderName={activeRoot.split("/").filter(Boolean).pop() ?? activeRoot}
                captures={captures}
                selectedAt={pickedAt}
                diff={diff}
                busy={busy}
                digests={digests}
                onSelect={pickMoment}
                onCheckpoint={(reason) => void markMoment(reason)}
                onHash={(path) => void hashFile(path)}
              />
            )}
            <Timeline
              log={activity}
              details={details}
              busy={busy}
              canGrant={roots.length === 0}
              onRestore={(entry) => setRestoring(entry)}
              onGrantFolder={() => void grantFolder()}
            />
          </>
        ) : null}

        {place === "engines" ? (
          <>
            <header className="view__head">
              <h1 className="view__title">AI connections</h1>
              <p className="view__lede">
                See which local model is running and which subscription tools were found on
                this Mac. Detection and readiness are separate checks.
              </p>
            </header>
            <EngineRoom
              room={engineRoom}
              busy={engineBusy}
              onRefresh={() => void readEngines()}
              onModels={() => setPlace("models")}
            />
          </>
        ) : null}

        {place === "settings" ? (
          <>
            <header className="view__head">
              <h1 className="view__title">Settings</h1>
            </header>
            {settings === null ? null : (
              <SettingsView
            onTelegramStatus={async () => {
              const api = bridge();
              if (api === undefined) return { saved: false, encryptionAvailable: false };
              return api.telegram.status();
            }}
            onTelegramSave={async (token) => {
              const api = bridge();
              if (api === undefined) return { saved: false, said: "Rellane is not ready yet." };
              return api.telegram.save({ token });
            }}
            onTelegramForget={async () => {
              const api = bridge();
              if (api === undefined) return { saved: false, said: "Rellane is not ready yet." };
              return api.telegram.forget();
            }}
                settings={settings}
                roots={roots}
                onGuide={() => setGuideOpen(true)}
                onChange={(next) => void saveSettings(next)}
                onGrantFolder={() => void grantFolder()}
                onRevokeFolder={(root) => void revokeFolder(root)}
                onCheckForUpdate={async () =>
              (await bridge()?.updates.check()) ?? {
                current: "",
                latest: null,
                behind: false,
                url: "",
                costs: [],
                said: "This build cannot be checked from here."
              }
            }
            onOpenReleases={() => void bridge()?.updates.open()}
            onReadDiagnostics={async () =>
                  (await bridge()?.diagnostics.bundle()) ?? "Diagnostics are not available."
                }
              />
            )}
            <SkillsView
              skills={catalogue?.installed ?? []}
              rejected={catalogue?.rejected ?? []}
              busy={busy}
              canRun={roots.length > 0}
              onRun={(id) => {
                // The folder the owner is looking at, not the first one they
                // ever granted. These are the same only until a second folder
                // exists, and then the skill runs somewhere the owner is not
                // looking — with a plan sheet naming a folder they did not pick.
                const folder = activeRoot ?? roots[0];
                if (folder !== undefined) void preview(id, folder);
              }}
            />
          </>
        ) : null}
      </main>

      {/**
       * The strip along the bottom. It is outside `<main>` because it is chrome:
       * it states what is true of the whole app, not of whichever place you
       * happen to be standing in, and it must not scroll away with the content.
       */}
      <StatusBar
        freshBook={freshBook}
        book={book}
        engines={engineRoom}
        agents={agents}
        activity={activity}
        folders={roots}
        onGo={setPlace}
        onOpenPalette={() => setPalette(true)}
      />

      {/* Decisions, not destinations. These stay modal on purpose. */}
      {restoring === null || restoring.receiptId === null ? null : (
        <RestoreSheet
          entry={restoring}
          onConfirm={() => void restore(restoring.receiptId as string)}
          onCancel={() => setRestoring(null)}
        />
      )}

      {pending === null ? null : (
        <PlanSheet
          preview={pending.preview}
          folder={pending.folder}
          onApprove={() => void run()}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

/** The workstation stays mounted so unsent drafts survive a visit to specialist tools. */
export function App() {
  const [toolsOpen, setToolsOpen] = useState(false);
  return <>
    <div hidden={toolsOpen}><WorkstationApp active={!toolsOpen} onTools={() => setToolsOpen(true)} /></div>
    {toolsOpen ? <><LegacyApp /><button className="ws-return-workstation" onClick={() => {
      const navigation = new Event("rellane:before-navigation", { cancelable: true });
      if (window.dispatchEvent(navigation)) setToolsOpen(false);
    }}>← Back to workspace</button></> : null}
  </>;
}
