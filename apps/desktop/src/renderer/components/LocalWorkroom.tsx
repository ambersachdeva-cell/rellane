/**
 * The owner chooses context before the bundled model works. Sources stay visible,
 * answers are attributed in the durable room, and Stop is available during inference.
 */
import { useEffect, useRef, useState } from "react";
import { ENQUIRY_REVIEW_SEAT, type CaseRoom, type RuntimeModel } from "@cadrane/contracts";
import { CASE_SOURCE_SEAT_PREFIX, isCaseDataSource, isCaseReference } from "../../shared/case-sources.js";
import { referencePreview } from "./WorkroomReference.js";
import { workroomMessage } from "../workroom-message.js";
import { checkBundledModel } from "../bundled-model-readiness.js";
import type { PreparedDataRequest } from "./WorkroomDataReview.js";

export function LocalWorkroom({
  room,
  onRefresh,
  onRunning,
  onModels,
  preparedData = null,
  hidden = false,
  onEnquiryReady,
}: {
  readonly room: CaseRoom;
  readonly onModels: () => void;
  readonly onRefresh: () => void;
  readonly onRunning: (running: boolean) => void;
  readonly preparedData?: PreparedDataRequest | null;
  readonly hidden?: boolean;
  readonly onEnquiryReady: () => void;
}) {
  const [models, setModels] = useState<readonly RuntimeModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [checking, setChecking] = useState(false);
  const [question, setQuestion] = useState("");
  const [task, setTask] = useState<"question" | "enquiry">("question");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const requestInput = useRef<HTMLTextAreaElement>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [status, setStatus] = useState(
    "Check the bundled model before asking it to work.",
  );
  const sources = room.turns.filter((turn) => turn.kind === "verbatim" && (task === "question" ||
    (isCaseReference(turn) && !isCaseDataSource(turn) && turn.seat !== ENQUIRY_REVIEW_SEAT &&
      turn.seat !== "Source · Checked data" && turn.body.length <= 4_000)));
  const caseId = room.case?.id;
  const lastObserved = useRef<string | null>(null);
  const owned = useRef<string | null>(null);
  const refresh = useRef(onRefresh);
  const readinessCheck = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!preparedData) return;
    setTask("question");
    setSelected([preparedData.sourceTurnId]);
    setQuestion(preparedData.question);
    requestInput.current?.focus();
    requestInput.current?.scrollIntoView({ block: "center" });
  }, [preparedData]);
  useEffect(() => {
    refresh.current = onRefresh;
  }, [onRefresh]);
  useEffect(() => {
    setElapsedSeconds(0);
    if (!operation) return;
    const observedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - observedAt) / 1_000));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [operation]);
  // Returning to a room recovers Stop from the actual main-process operation.
  // No active request after restart means no automatic replay.
  useEffect(() => {
    if (!caseId) return;
    let disposed = false;
    let checkingState = false;
    async function check() {
      if (checkingState) return;
      checkingState = true;
      try {
        const active = await window.cadrane.cases.localState({ id: caseId! });
        if (disposed) return;
        if (active) {
          lastObserved.current = active.operationId;
          setOperation(active.operationId);
          setStopping(active.stopping);
          onRunning(true);
          if (owned.current !== active.operationId)
            setStatus(
              active.stopping
                ? "The local request is stopping."
                : "A local request is still running in this workroom. You can stop it here.",
            );
        } else if (lastObserved.current !== null && owned.current === null) {
          lastObserved.current = null;
          setOperation(null);
          setStopping(false);
          onRunning(false);
          setStatus(
            "The local request ended. Check Conversation and Activity for its saved outcome.",
          );
          refresh.current();
        }
      } catch {
        if (!disposed && lastObserved.current)
          setStatus(
            "The active request could not be checked. Its completion is not confirmed.",
          );
      } finally {
        checkingState = false;
      }
    }
    void check();
    const timer = window.setInterval(() => void check(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [caseId, onRunning]);

  async function discover() {
    readinessCheck.current?.abort();
    const controller = new AbortController();
    readinessCheck.current = controller;
    setChecking(true);
    setModels([]);
    setModelId("");
    setStatus("Checking this Mac's model…");
    try {
      const next = await checkBundledModel(
        () => window.cadrane.runtimes.discover(),
        controller.signal,
        (completed, maximum) => setStatus(
          `The local model is not ready yet. Checking again (${completed} of ${maximum}). You can keep reviewing your work.`,
        ),
      );
      if (controller.signal.aborted) return;
      setModels(next);
      setModelId(next[0]?.id ?? "");
      setStatus(
        next.length
          ? "Bundled model found. Only selected notes and your request will be used."
          : "The bundled model is not ready. Check local model settings, then try again.",
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = workroomMessage(
        error,
        "The local model could not be checked.",
      );
      setStatus(
        message === "The isolated local service did not respond in time."
          ? "The model check timed out. Try Check model again."
          : message,
      );
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }

  useEffect(() => {
    void discover();
    return () => readinessCheck.current?.abort();
  }, []);

  async function run() {
    if (!caseId || operation || !modelId ||
        (task === "question" ? !question.trim() : selected.length !== 1)) return;
    const operationId = crypto.randomUUID();
    owned.current = operationId;
    setOperation(operationId);
    setStopping(false);
    onRunning(true);
    setStatus("Working on this Mac. You can stop this request.");
    try {
      if (task === "enquiry") {
        await window.cadrane.cases.prepareEnquiry({
          id: caseId, operationId, modelId, sourceTurnId: selected[0]!
        });
        setStatus("Suggested fields are saved. Review them against the original in Sources.");
        onEnquiryReady();
      } else {
        await window.cadrane.cases.askLocal({
          id: caseId,
          operationId,
          modelId,
          question,
          sourceTurnIds: [...selected],
        });
        setStatus("The answer is saved in Conversation. Review it before using it.");
      }
    } catch (error) {
      const message = workroomMessage(
        error,
        "The local request did not complete.",
      );
      setStatus(
        message === "The local runtime operation was cancelled."
          ? "Stopped. No new answer was saved."
          : message,
      );
    } finally {
      owned.current = null;
      lastObserved.current = null;
      setOperation(null);
      setStopping(false);
      onRunning(false);
      onRefresh();
    }
  }

  async function stop() {
    if (!caseId || !operation) return;
    const operationId = operation;
    setStopping(true);
    try {
      const result = await window.cadrane.cases.stopLocal({
        id: caseId,
        operationId,
      });
      // The request may have settled while the Stop acknowledgement travelled
      // back. Its final outcome must not become "waiting" again.
      if (owned.current !== operationId && lastObserved.current !== operationId)
        return;
      setStatus(
        result.stopped
          ? "Stop requested. Waiting for the local request to finish stopping."
          : "The request already ended. Refreshing its record.",
      );
    } catch (error) {
      if (owned.current !== operationId && lastObserved.current !== operationId)
        return;
      setStatus(
        workroomMessage(error, "Stop could not be confirmed. Try again."),
      );
      setStopping(false);
    }
  }

  return (
    <section
      className={`local-workroom${operation ? " local-workroom--running" : ""}`}
      aria-labelledby="local-workroom-heading"
      hidden={hidden}
    >
      <div className="local-workroom__heading">
        <h2 id="local-workroom-heading">
          <span className="local-workroom__signal" aria-hidden="true" />
          Work with this Mac
        </h2>
        <button
          className="link"
          type="button"
          disabled={checking || operation !== null}
          onClick={() => void discover()}
        >
          {checking ? "Checking…" : "Check model"}
        </button>
      </div>
      <label className="local-workroom__task">Task
        <select className="input" value={task} disabled={operation !== null}
          onChange={event => {
            setTask(event.target.value as "question" | "enquiry");
            setSelected([]);
            setStatus("Choose the source for this task. Nothing runs until you ask.");
          }}>
          <option value="question">Ask a question or make a draft</option>
          <option value="enquiry">Prepare a print enquiry</option>
        </select>
      </label>
      {task === "enquiry" && <p className="local-workroom__task-help">Find quantities, specifications and open questions in one customer message.
        Review the suggested excerpts before saving a brief. Add the message in Sources first; up to 4,000 characters.</p>}
      <details className="local-workroom__context" open={task === "enquiry" ? true : undefined}>
        <summary>
          {selected.length} source{selected.length === 1 ? "" : "s"} selected{" "}
          <span>Choose context</span>
        </summary>
        <fieldset
          disabled={operation !== null}
          className="local-workroom__sources"
        >
          <legend className="sr-only">Sources the model may use</legend>
          {sources.length === 0 && (
            <p className="muted">
              Add reference notes in Sources to give the model facts to work
              with.
            </p>
          )}
          {sources.map((turn) => (
            <label key={turn.id}>
              <input
                type={task === "enquiry" ? "radio" : "checkbox"}
                name={task === "enquiry" ? "enquiry-source" : undefined}
                checked={selected.includes(turn.id)}
                onChange={(event) =>
                  setSelected((ids) =>
                    event.target.checked
                      ? task === "enquiry" ? [turn.id] : [...ids, turn.id]
                      : ids.filter((id) => id !== turn.id),
                  )
                }
              />
              <span>
                <strong>
                  {turn.seat.startsWith(CASE_SOURCE_SEAT_PREFIX)
                    ? turn.seat.slice(CASE_SOURCE_SEAT_PREFIX.length)
                    : isCaseReference(turn) ? "Reference note" : "AI draft"} ·{" "}
                  {turn.seq}
                </strong>
                <span className="local-workroom__source-text">
                  {referencePreview(turn, room.turns)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="muted">
          Only these sources and your request reach the model. AI drafts need
          checking before reuse. Previews are shortened; read complete references in Sources.
        </p>
      </details>
      <label className="local-workroom__request" hidden={task === "enquiry"}>
        <span className="sr-only">What should the model produce?</span>
        <textarea
          className="textarea"
          rows={3}
          maxLength={4_000}
          ref={requestInput}
          disabled={operation !== null}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="What should we make, improve or question?"
        />
      </label>
      <div className="local-workroom__actions">
        <label>
          <span className="sr-only">Local model</span>
          <select
            className="input"
            aria-label="Local model"
            disabled={checking || operation !== null || !models.length}
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          >
            {!models.length && (
              <option value="">Local model unavailable</option>
            )}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
        </label>
        {operation ? (
          <button
            className="btn"
            type="button"
            disabled={stopping}
            onClick={() => void stop()}
          >
            {stopping ? "Stopping…" : "Stop request"}
          </button>
        ) : (
          <button
            className="btn btn--primary"
            type="button"
            disabled={
              checking || !modelId || (task === "question" ? !question.trim() || selected.length > 20 : selected.length !== 1)
            }
            onClick={() => void run()}
          >
            {task === "enquiry" ? "Find enquiry details" : "Ask this Mac"} <span aria-hidden="true">↑</span>
          </button>
        )}
      </div>
      <div className="local-workroom__feedback">
        <p className="local-workroom__status" role="status">
          {status}
        </p>
        {operation && (
          <span
            className="local-workroom__elapsed"
            role="timer"
            aria-live="off"
          >
            {elapsedSeconds}s
            {owned.current === operation ? " elapsed" : " observed here"}
          </span>
        )}
      </div>
      {!checking && !models.length && !operation && (
        <button type="button" className="link" onClick={onModels}>
          Open local model settings →
        </button>
      )}
      {selected.length > 20 && (
        <p className="failure">Select at most 20 notes for one request.</p>
      )}
    </section>
  );
}
