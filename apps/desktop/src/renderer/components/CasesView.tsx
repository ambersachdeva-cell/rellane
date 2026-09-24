/** Workrooms give a brief, its sources and a reviewed output one place to live. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseRoom, CaseSummary, CaseTurnView } from "@cadrane/contracts";
import { ENQUIRY_PROPOSAL_SEAT } from "@cadrane/contracts";
import { isCaseReference } from "../../shared/case-sources.js";
import { LocalWorkroom } from "./LocalWorkroom.js";
import { WorkroomOutput } from "./WorkroomOutput.js";
import { RellaneMark } from "./RellaneMark.js";
import { WorkroomSourceImport } from "./WorkroomSourceImport.js";
import { WorkroomDataReview, type PreparedDataRequest } from "./WorkroomDataReview.js";
import { RichText } from "../RichText.js";
import { WorkroomEnquiryReview } from "./WorkroomEnquiryReview.js";
import { WorkroomConversationGuide, WorkroomReference } from "./WorkroomReference.js";

interface Props {
  readonly cases: readonly CaseSummary[] | null;
  readonly onRefresh: () => void;
  readonly onModels: () => void;
  readonly onGuide?: () => void;
  readonly resumeCaseId?: string | null;
  readonly onResumed?: () => void;
  readonly onRoomChanged?: (caseId: string | null) => void;
}

const STARTERS = [
  {
    name: "Understand business data",
    tone: "citron",
    symbol: "≋",
    description: "Check figures, inspect rows, decide what comes next.",
    title: "Business data review",
    question: "Help me understand a CSV export from my business. Calculate figures from the records, show missing values and supporting rows, and explain practical next checks. Keep the original data unchanged."
  },
  {
    name: "A brand campaign",
    tone: "coral",
    symbol: "✳",
    description: "Turn a brief into a clear direction.",
    title: "Campaign direction",
    question:
      "Help me turn a brand brief into a campaign direction: a headline, key message and three content ideas. Use the reference notes I provide. Flag unsupported claims and missing facts."
  },
  {
    name: "A client proposal",
    tone: "iris",
    symbol: "↗",
    description: "Give an opportunity a concrete shape.",
    title: "Client proposal",
    question:
      "Help me prepare a client proposal from my notes. Structure the problem, proposed work, deliverables and open questions. Leave prices, dates and commitments unconfirmed unless they are in the sources."
  },
  {
    name: "A better decision",
    tone: "citron",
    symbol: "⇄",
    description: "Compare the options and find the gaps.",
    title: "Decision brief",
    question:
      "Help me evaluate a decision using the notes I provide. Compare the options, separate evidence from assumptions, and identify what would change the recommendation."
  }
] as const;

export function CasesView({
  cases,
  onRefresh,
  onModels,
  onGuide,
  resumeCaseId = null,
  onResumed,
  onRoomChanged
}: Props) {
  const [room, setRoom] = useState<CaseRoom | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const briefInput = useRef<HTMLTextAreaElement | null>(null);
  const resumed = useRef(false);

  const update = useCallback(
    (next: CaseRoom) => {
      setRoom(next);
      onRefresh();
    },
    [onRefresh]
  );
  const call = useCallback(
    async (work: () => Promise<CaseRoom>) => {
      setBusy(true);
      setFailure(null);
      try {
        update(await work());
        return true;
      } catch (error) {
        setFailure(
          error instanceof Error
            ? error.message
            : "This workroom could not be opened."
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [update]
  );
  const openOne = useCallback(
    (id: string) => call(() => window.cadrane.cases.read({ id })),
    [call]
  );

  useEffect(() => {
    if (resumeCaseId === null || resumed.current) return;
    resumed.current = true;
    void openOne(resumeCaseId).finally(() => onResumed?.());
  }, [resumeCaseId, onResumed, openOne]);
  useEffect(() => {
    onRoomChanged?.(room?.case?.id ?? null);
  }, [room, onRoomChanged]);

  if (room?.case)
    return (
      <Room
        key={room.case.id}
        room={room}
        busy={busy}
        failure={failure}
        onModels={onModels}
        onUpdate={update}
        onRefresh={() => {
          void openOne(room.case!.id);
        }}
        onBack={() => {
          if (
            window.dispatchEvent(
              new Event("rellane:before-navigation", { cancelable: true })
            )
          ) {
            setRoom(null);
            setFailure(null);
          }
        }}
        onSay={(body) =>
          call(() => window.cadrane.cases.say({ id: room.case!.id, body }))
        }
        onClose={(verdict) => {
          if (
            !window.dispatchEvent(
              new Event("rellane:before-navigation", { cancelable: true })
            )
          )
            return;
          void call(async () => {
            await window.cadrane.cases.close({ id: room.case!.id, verdict });
            return window.cadrane.cases.read({ id: room.case!.id });
          });
        }}
      />
    );

  const open = cases?.filter((one) => one.closedAt === null) ?? [];
  const closed = cases?.filter((one) => one.closedAt !== null) ?? [];
  return (
    <section className="workroom-home">
      <header className="workroom-home__top">
        <span className="eyebrow">YOUR WORK, TOGETHER</span>
        <span className="workroom-local">
          <span aria-hidden="true" />
          Local workspace
        </span>
      </header>
      <div className="workroom-hero">
        <div>
          <h1>
            Make something
            <br />
            <span>worth sending.</span>
          </h1>
          <p>Bring a task and the notes behind it. Work with AI, check the answer and save something you can use.</p>
          {onGuide ? <button type="button" className="workroom-guide-link" onClick={onGuide}>How a workroom works <span aria-hidden="true">↗</span></button> : null}
        </div>
        <div className="workroom-motif" aria-hidden="true">
          <div className="motif-note motif-note--coral">
            Your context<span>Notes · facts · references</span>
          </div>
          <div className="motif-note motif-note--iris">
            A fresh perspective<span>Draft · question · refine</span>
          </div>
          <div className="motif-note motif-note--result">
            <RellaneMark />
            <span>Your finished work</span>
            <b>↗</b>
          </div>
        </div>
      </div>
      <form
        className="workroom-start"
        onSubmit={(event) => {
          event.preventDefault();
          if (!question.trim()) return;
          void call(async () => {
            const next = await window.cadrane.cases.open({
              title:
                title.trim() || question.trim().split("\n")[0]!.slice(0, 100),
              question
            });
            setTitle("");
            setQuestion("");
            return next;
          });
        }}
      >
        <label htmlFor="new-workroom-brief">What are we working on?</label>
        <textarea
          id="new-workroom-brief"
          ref={briefInput}
          rows={3}
          maxLength={10_000}
          value={question}
          disabled={busy}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Prepare a proposal for a new client. Help me find the strongest idea. Make sense of these notes…"
        />
        <div className="workroom-start__foot">
          <input
            className="input"
            aria-label="Workroom name (optional)"
            placeholder="Give it a name (optional)"
            maxLength={200}
            value={title}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button
            className="btn btn--primary"
            type="submit"
            disabled={busy || !question.trim()}
          >
            {busy ? "Opening…" : "Start workroom"}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
        <p className="muted">
          Creates a saved workroom. You choose the model and its sources inside.
        </p>
      </form>
      {failure && (
        <p role="alert" className="failure">
          {failure}
        </p>
      )}
      <section
        className="workroom-starting-points"
        aria-labelledby="starting-points"
      >
        <div className="workroom-section-heading">
          <h2 id="starting-points">A place to start</h2>
          <span>Starting briefs, ready to adapt</span>
        </div>
        <div className="workroom-starters">
          {STARTERS.map((starter) => (
            <button
              type="button"
              key={starter.name}
              className={`workroom-starter workroom-starter--${starter.tone}`}
              disabled={busy}
              onClick={() => {
                setTitle(starter.title);
                setQuestion(starter.question);
                briefInput.current?.focus();
              }}
            >
              <span className="workroom-starter__symbol" aria-hidden="true">
                {starter.symbol}
              </span>
              <strong>{starter.name}</strong>
              <span>{starter.description}</span>
              <span className="workroom-starter__arrow" aria-hidden="true">
                ↗
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className="workroom-recent" aria-labelledby="recent-work">
        <div className="workroom-section-heading">
          <h2 id="recent-work">Pick up where you left off</h2>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={onRefresh}
          >
            Refresh
          </button>
        </div>
        {cases === null ? (
          <p className="muted" role="status">
            Reading your workrooms…
          </p>
        ) : open.length === 0 ? (
          <div className="workroom-empty">
            <RellaneMark />
            <div>
              <strong>Your first workroom starts above.</strong>
              <p>
                Keep the brief, draft and decisions together. Come back when you
                are ready.
              </p>
            </div>
          </div>
        ) : (
          <CaseList rows={open} onPick={openOne} />
        )}
        {closed.length > 0 && (
          <details className="workroom-archive">
            <summary>
              {closed.length} completed workroom{closed.length === 1 ? "" : "s"}
            </summary>
            <CaseList rows={closed} onPick={openOne} />
          </details>
        )}
      </section>
    </section>
  );
}

function CaseList({
  rows,
  onPick
}: {
  readonly rows: readonly CaseSummary[];
  readonly onPick: (id: string) => void;
}) {
  return (
    <ul className="workroom-list">
      {rows.map((one) => (
        <li key={one.id}>
          <button type="button" onClick={() => onPick(one.id)}>
            <span className="workroom-list__icon" aria-hidden="true">
              ↗
            </span>
            <span className="workroom-list__name">
              <strong>{one.title}</strong>
              <span>{one.question}</span>
            </span>
            <span className="workroom-list__meta">
              <span>
                {one.closedAs ? closedWord(one.closedAs) : turnWord(one.turns)}
              </span>
              <time>{when(one.lastActivityAt)}</time>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Room({
  room,
  busy,
  failure,
  onModels,
  onUpdate,
  onRefresh,
  onBack,
  onSay,
  onClose
}: {
  readonly room: CaseRoom;
  readonly busy: boolean;
  readonly failure: string | null;
  readonly onModels: () => void;
  readonly onUpdate: (room: CaseRoom) => void;
  readonly onRefresh: () => void;
  readonly onBack: () => void;
  readonly onSay: (body: string) => Promise<boolean>;
  readonly onClose: (verdict: string) => void;
}) {
  const one = room.case!;
  const [note, setNote] = useState("");
  const [verdict, setVerdict] = useState("");
  const [localRunning, setLocalRunning] = useState(false);
  const [enquiryDirty, setEnquiryDirty] = useState(false);
  const [preparedData, setPreparedData] = useState<PreparedDataRequest | null>(null);
  const [tab, setTab] = useState<"conversation" | "sources" | "activity">(
    "conversation"
  );
  const [sourcesOpened, setSourcesOpened] = useState(false);
  function selectTab(next: typeof tab) {
    if (next === "sources") setSourcesOpened(true);
    setTab(next);
  }
  const visible = room.turns.filter((turn) =>
    tab === "activity"
      ? turn.kind === "receipt"
      : tab === "sources"
        ? isCaseReference(turn)
        : turn.kind !== "receipt" && !isCaseReference(turn) && turn.seat !== ENQUIRY_PROPOSAL_SEAT
  );
  return (
    <section className="workroom-detail">
      <header className="workroom-detail__head">
        <div className="workroom-breadcrumb">
          <button
            className="link"
            type="button"
            disabled={localRunning}
            onClick={onBack}
          >
            ← Workrooms
          </button>
          <span>{one.closedAt === null ? "In progress" : "Completed"}</span>
        </div>
        <h1>{one.title}</h1>
        <p className="muted">
          Started {when(one.openedAt)} · Saved on this Mac
        </p>
      </header>
      <details className="workroom-brief" open>
        <summary>The brief</summary>
        <p>{one.question}</p>
      </details>
      {one.verdict && (
        <p className="case-verdict">
          <strong>Outcome.</strong> {one.verdict}
        </p>
      )}
      {failure && (
        <p role="alert" className="failure">
          {failure}
        </p>
      )}
      <div
        className={`workroom-columns${tab !== "conversation" ? " workroom-columns--review" : ""}`}
      >
        <div className="workroom-conversation">
          <div
            className="workroom-tabs"
            role="tablist"
            aria-label="Workroom material"
          >
            {(["conversation", "sources", "activity"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                aria-controls="workroom-material"
                id={`tab-${item}`}
                tabIndex={tab === item ? 0 : -1}
                onClick={() => selectTab(item)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    const tabs = [
                      "conversation",
                      "sources",
                      "activity"
                    ] as const;
                    const next =
                      tabs[
                        (tabs.indexOf(item) +
                          (event.key === "ArrowRight" ? 1 : 2)) %
                          3
                      ]!;
                    selectTab(next);
                    document.getElementById(`tab-${next}`)?.focus();
                  }
                }}
              >
                {item === "conversation"
                  ? "Conversation"
                  : item === "sources"
                    ? "Sources"
                    : "Activity"}
                {item === "sources" && (
                  <span>
                    {
                      room.turns.filter(isCaseReference).length
                    }
                  </span>
                )}
              </button>
            ))}
          </div>
          {localRunning && tab !== "conversation" && (
            <div className="workroom-active-request" role="status">
              <span>A local request is running in this workroom.</span>
              <button type="button" className="link" onClick={() => selectTab("conversation")}>
                View request and Stop →
              </button>
            </div>
          )}
          <div
            id="workroom-material"
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
            className="workroom-material"
          >
            {tab === "conversation" && <WorkroomConversationGuide turns={room.turns}
              hasAnswers={visible.length > 0} onSources={() => selectTab("sources")}
              onActivity={() => selectTab("activity")} />}
            <div hidden={tab !== "sources"}>
              {sourcesOpened && <WorkroomEnquiryReview room={room} localRunning={localRunning}
                onDirty={setEnquiryDirty} onUpdate={onUpdate} onReveal={() => selectTab("sources")}
                onPrepared={request => { setPreparedData(request); selectTab("conversation"); }} />}
              {sourcesOpened && one.closedAt === null && (
                <>
                  <WorkroomSourceImport caseId={one.id} onAdded={onUpdate} />
                  <WorkroomDataReview
                    room={room}
                    localRunning={localRunning}
                    onUpdate={onUpdate}
                    onPrepared={(request) => {
                      setPreparedData(request);
                      selectTab("conversation");
                    }}
                  />
                </>
              )}
              {sourcesOpened && one.closedAt === null && (
                <form
                  className="workroom-note"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (note.trim())
                      void onSay(note).then((saved) => {
                        if (saved) setNote("");
                      });
                  }}
                >
                  <label htmlFor="source-note">Add reference notes</label>
                  <textarea
                    id="source-note"
                    className="textarea"
                    rows={4}
                    maxLength={50_000}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Paste approved facts, reference copy, constraints or meeting notes…"
                  />
                  <button
                    type="submit"
                    className="btn"
                    disabled={busy || !note.trim()}
                  >
                    Save source note
                  </button>
                </form>
              )}
            </div>
            {visible.length === 0 ? tab === "conversation" ? null : (
              <div className="conversation-empty">
                <span aria-hidden="true">✳</span>
                <h2>
                  {tab === "activity"
                    ? "The record starts when you work."
                    : "Give the work some context."}
                </h2>
                <p>
                  {tab === "activity"
                    ? "Requests, interruptions and output decisions stay on the record."
                    : "Only the notes you select are included in a local request."}
                </p>
              </div>
            ) : (
              <ol className="room">
                {visible.map((turn) => (
                  <Turn key={turn.id} turn={turn} turns={room.turns} />
                ))}
              </ol>
            )}
          </div>
          {one.closedAt === null && (
            <LocalWorkroom
              hidden={tab !== "conversation"}
              room={room}
              onModels={onModels}
              onRefresh={onRefresh}
              onRunning={setLocalRunning}
              preparedData={preparedData}
              onEnquiryReady={() => selectTab("sources")}
            />
          )}
        </div>
        <WorkroomOutput
          room={room}
          onUpdate={onUpdate}
          hidden={tab !== "conversation"}
          onReveal={() => selectTab("conversation")}
        />
      </div>
      {one.closedAt === null && (
        <details className="workroom-finish">
          <summary>Finish this workroom</summary>
          <p>Keep a short outcome so you can understand the decision later.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (verdict.trim() && !enquiryDirty) onClose(verdict);
            }}
          >
            <input
              className="input"
              aria-label="Workroom outcome"
              placeholder="What did you decide or finish?"
              maxLength={10_000}
              value={verdict}
              onChange={(event) => setVerdict(event.target.value)}
            />
            <button
              className="btn"
              type="submit"
              disabled={busy || localRunning || enquiryDirty || !verdict.trim()}
            >
              Complete workroom
            </button>
            {enquiryDirty && <p className="muted">Save or discard your enquiry review in Sources before completing this workroom.</p>}
          </form>
        </details>
      )}
    </section>
  );
}

function Turn({ turn, turns }: { readonly turn: CaseTurnView; readonly turns: readonly CaseTurnView[] }) {
  const [original, setOriginal] = useState(false);
  const canFormat = turn.kind === "verbatim" && !isCaseReference(turn);
  return (
    <li className={`turn turn--${turn.kind}`}>
      <div className="turn__byline">
        <span className="turn__avatar" aria-hidden="true">
          {turn.seat === "owner" ? "Y" : turn.kind === "receipt" ? "↳" : "R"}
        </span>
        <span className="turn__seat">
          {turn.seat === "owner" ? "Your reference" : turn.seat}
        </span>
        {turn.kind !== "verbatim" && (
          <span className="turn__note">
            {turn.kind === "compacted"
              ? `Summary of ${turn.compactedFrom?.length ?? 0} turns`
              : turn.kind === "finding"
                ? "Finding"
                : "Receipt"}
          </span>
        )}
        {canFormat && (
          <button className="link turn__format" type="button" onClick={() => setOriginal(!original)}>
            {original ? "Read formatted" : "View original"}
          </button>
        )}
      </div>
      {canFormat && !original ? (
        <div className="turn__body turn__body--formatted"><RichText text={turn.body} /></div>
      ) : isCaseReference(turn) ? <WorkroomReference turn={turn} turns={turns} /> : <p className="turn__body">{turn.body}</p>}
    </li>
  );
}

export function turnWord(turns: number): string {
  return turns === 1 ? "1 turn" : `${turns} turns`;
}
export function closedWord(
  closedAs: "settled" | "abandoned" | "dropped"
): string {
  return closedAs === "settled"
    ? "settled"
    : closedAs === "dropped"
      ? "dropped"
      : "closed itself";
}
function when(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}
