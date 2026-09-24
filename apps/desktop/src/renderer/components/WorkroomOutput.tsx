/** A model answer becomes a deliverable only after the owner chooses and reviews it. */
import { useEffect, useState } from "react";
import type { CaseArtifactFormat, CaseRoom } from "@cadrane/contracts";
import { isCaseReference } from "../../shared/case-sources.js";
import { workroomMessage } from "../workroom-message.js";
import { RichText } from "../RichText.js";

export function WorkroomOutput({
  room,
  onUpdate,
  hidden = false,
  onReveal,
}: {
  readonly room: CaseRoom;
  readonly onUpdate: (room: CaseRoom) => void;
  readonly hidden?: boolean;
  readonly onReveal?: () => void;
}) {
  const latest = room.artifacts[0] ?? null;
  const [baseId, setBaseId] = useState(latest?.id ?? null);
  const [sourceId, setSourceId] = useState(latest?.sourceTurnId ?? null);
  const [body, setBody] = useState(latest?.body ?? "");
  const [savedBody, setSavedBody] = useState(latest?.body ?? "");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [format, setFormat] = useState<CaseArtifactFormat>("docx");
  const [preview, setPreview] = useState(Boolean(latest?.body));
  const edited = body !== savedBody;
  const historical =
    room.artifacts.find((version) => version.id === pickedId) ?? null;
  const showing = historical ?? latest;
  const answers = room.turns.filter(
    (turn) => turn.kind === "verbatim" && !isCaseReference(turn),
  );
  const newestAnswer = answers.at(-1);
  const closed = room.case?.closedAt !== null;

  useEffect(() => {
    if (edited || latest?.id === baseId || (!latest && !baseId)) return;
    setBaseId(latest?.id ?? null);
    setSourceId(latest?.sourceTurnId ?? null);
    setBody(latest?.body ?? "");
    setSavedBody(latest?.body ?? "");
  }, [latest, baseId, edited]);

  // Keep unsaved output visible when another place is requested. The owner can
  // save or discard explicitly; navigation never overwrites their draft.
  useEffect(() => {
    if (!edited) return;
    const protect = (event: Event) => {
      event.preventDefault();
      setPreview(false);
      onReveal?.();
      setStatus(
        "Save a version or discard your edits before leaving this workroom.",
      );
    };
    window.addEventListener("rellane:before-navigation", protect);
    return () =>
      window.removeEventListener("rellane:before-navigation", protect);
  }, [edited, onReveal]);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setStatus("");
    try {
      await work();
    } catch (error) {
      setStatus(workroomMessage(error, "The output could not be updated."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="workroom-output" aria-labelledby="output-heading" hidden={hidden}>
      <header className="workroom-output__head">
        <div>
          <span className="eyebrow">THE DELIVERABLE</span>
          <h2 id="output-heading">Your output</h2>
        </div>
        <span
          className={`output-state${showing?.acceptedAt ? " output-state--accepted" : ""}`}
        >
          {edited
            ? "Unsaved edits"
            : showing?.acceptedAt
              ? "Accepted"
              : "Draft"}
        </span>
      </header>
      <div className="workroom-output__toolbar">
        <label>
          Version
          <select
            className="input"
            value={pickedId ?? "latest"}
            disabled={busy || edited}
            onChange={(event) => {
              setPickedId(
                event.target.value === "latest" ? null : event.target.value,
              );
              setPreview(true);
              setStatus("");
            }}
          >
            <option value="latest">
              {latest ? `Latest · v${latest.revision}` : "No saved version"}
            </option>
            {room.artifacts.slice(1).map((version) => (
              <option key={version.id} value={version.id}>
                v{version.revision}
                {version.acceptedAt ? " · accepted" : " · draft"}
              </option>
            ))}
          </select>
        </label>
        {newestAnswer && !closed && !historical && (
          <button
            type="button"
            className="link"
            disabled={busy || edited}
            onClick={() => {
              setBody(newestAnswer.body);
              setSourceId(newestAnswer.id);
              setPreview(false);
              setStatus(
                "Answer loaded. Edit and check it, then save a version.",
              );
            }}
          >
            Use latest answer ↗
          </button>
        )}
      </div>
      {(body || historical) && (
        <div className="output-view" role="group" aria-label="Output view">
          <button type="button" className="link" aria-pressed={!preview}
            onClick={() => setPreview(false)}>
            {closed || historical ? "Original text" : "Edit"}
          </button>
          <button type="button" className="link" aria-pressed={preview}
            onClick={() => setPreview(true)}>Preview</button>
          <span>Reading view · exports may look different</span>
        </div>
      )}
      {!body && !historical && (
        <div className="output-invitation">
          <span className="output-invitation__symbol" aria-hidden="true">
            ↗
          </span>
          <h3>Good work has a finished form.</h3>
          <p>
            Choose an answer to refine, or write your own. Saved versions stay
            here when you return.
          </p>
        </div>
      )}
      <div className="output-preview" hidden={!preview} aria-label="Output preview">
        <RichText text={historical?.body ?? body} />
      </div>
      <label className="output-editor-label" hidden={preview}>
        <span className="sr-only">Output text</span>
        <textarea
          className="output-editor"
          spellCheck
          rows={15}
          maxLength={50_000}
          readOnly={closed || historical !== null}
          disabled={busy}
          value={historical?.body ?? body}
          placeholder="Write or refine the output here…"
          onChange={(event) => { setBody(event.target.value); setStatus(""); }}
        />
      </label>
      <div className="workroom-output__foot">
        {!closed && !historical && (
          <div className="workroom-output__actions">
            <button
              className="btn btn--primary"
              type="button"
              disabled={busy || !body.trim() || (!edited && latest !== null)}
              onClick={() =>
                void act(async () => {
                  const next = await window.cadrane.cases.saveArtifact({
                    id: room.case!.id,
                    baseVersionId: baseId,
                    sourceTurnId: sourceId,
                    body,
                  });
                  const version = next.artifacts[0]!;
                  setBaseId(version.id);
                  setBody(version.body);
                  setSavedBody(version.body);
                  onUpdate(next);
                  setStatus(`Version ${version.revision} saved on this Mac.`);
                })
              }
            >
              {busy ? "Working…" : latest ? "Save new version" : "Save version"}
            </button>
            {edited && (
              <button
                className="link"
                type="button"
                disabled={busy}
                onClick={() => {
                  setBody(savedBody);
                  setSourceId(latest?.sourceTurnId ?? null);
                  setPreview(Boolean(savedBody));
                  setStatus(
                    "Unsaved edits discarded. Saved versions are unchanged.",
                  );
                }}
              >
                Discard edits
              </button>
            )}
            {latest && !edited && !latest.acceptedAt && (
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    onUpdate(
                      await window.cadrane.cases.acceptArtifact({
                        id: room.case!.id,
                        versionId: latest.id,
                      }),
                    );
                    setStatus(
                      `You accepted version ${latest.revision}. Ready to export.`,
                    );
                  })
                }
              >
                Accept v{latest.revision}
              </button>
            )}
          </div>
        )}
        {showing && (
          <div className="output-export-row">
            <label>
              <span className="sr-only">Export format</span>
              <select
                className="input"
                value={format}
                disabled={busy}
                onChange={(event) =>
                  setFormat(event.target.value as CaseArtifactFormat)
                }
              >
                <option value="docx">Word document</option>
                <option value="md">Markdown</option>
              </select>
            </label>
            <button
              className="btn output-export"
              type="button"
              disabled={busy || edited}
              onClick={() =>
                void act(async () => {
                  let result;
                  try {
                    result = await window.cadrane.cases.exportArtifact({
                      id: room.case!.id,
                      versionId: showing.id,
                      format,
                    });
                  } catch (error) {
                    // A failed write can still leave a durable receipt. Show it
                    // immediately while preserving the original failure message.
                    try {
                      onUpdate(
                        await window.cadrane.cases.read({ id: room.case!.id }),
                      );
                    } catch {
                      // Refresh failure is not evidence that the export succeeded.
                    }
                    throw error;
                  }
                  onUpdate(
                    await window.cadrane.cases.read({ id: room.case!.id }),
                  );
                  setStatus(
                    result.written
                      ? `Exported ${result.fileName}.${result.receiptRecorded ? " Receipt saved." : " The file was written, but its receipt could not be confirmed. Check the file before exporting again."}`
                      : "Export cancelled.",
                  );
                })
              }
            >
              Export v{showing.revision} <span aria-hidden="true">↗</span>
            </button>
          </div>
        )}
        <p className="muted">
          {edited
            ? "Your edits are not saved yet."
            : showing?.acceptedAt
              ? "Accepted by you. Export creates a new file."
              : "Check the facts before accepting. Acceptance sends nothing."}
        </p>
        {status && (
          <p role="status" className="output-status">
            {status}
          </p>
        )}
        {room.exports.length > 0 && (
          <details className="output-history">
            <summary>Export history · {room.exports.length}</summary>
            <ol>
              {room.exports.map((receipt) => (
                <li key={receipt.id}>
                  <strong>{receipt.fileName}</strong>
                  <span>
                    v{receipt.revision} ·{" "}
                    {receipt.state === "written"
                      ? "Written"
                      : receipt.state === "failed"
                        ? "Did not finish"
                        : "Not confirmed"}{" "}
                    · {new Date(receipt.createdAt).toLocaleString()}
                  </span>
                  <span>
                    {receipt.acceptedAt === null
                      ? "Draft version"
                      : "Accepted version"}{" "}
                    · {receipt.bytes.toLocaleString()} bytes
                  </span>
                  <code title={receipt.sha256}>
                    SHA-256 {receipt.sha256.slice(0, 16)}…
                  </code>
                  {receipt.state !== "written" && (
                    <span>Check the chosen file before trying again.</span>
                  )}
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </aside>
  );
}
