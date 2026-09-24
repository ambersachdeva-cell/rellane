/** People should see exactly which document text they are adding to a workroom. */
import { useEffect, useRef, useState } from "react";
import type { CaseRoom, CaseSourcePreview } from "@cadrane/contracts";
import { workroomMessage } from "../workroom-message.js";

export function WorkroomSourceImport({
  caseId,
  onAdded,
}: {
  readonly caseId: string;
  readonly onAdded: (room: CaseRoom) => void;
}) {
  const [preview, setPreview] = useState<CaseSourcePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [range, setRange] = useState<{ start: number; end: number } | null>(
    null,
  );
  const mounted = useRef(true);
  const previewText = useRef<HTMLTextAreaElement>(null);

  function selectedRange() {
    const input = previewText.current;
    return input && input.selectionStart < input.selectionEnd
      ? { start: input.selectionStart, end: input.selectionEnd }
      : null;
  }

  function syncSelection() {
    setRange(selectedRange());
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void window.cadrane.cases
        .discardSource({ id: caseId })
        .catch(() => undefined);
    };
  }, [caseId]);

  async function choose() {
    setBusy(true);
    setMessage("");
    setPreview(null);
    setRange(null);
    try {
      const next = await window.cadrane.cases.previewSource({ id: caseId });
      if (!mounted.current) {
        if (next)
          void window.cadrane.cases
            .discardSource({ id: caseId, token: next.token })
            .catch(() => undefined);
        return;
      }
      setPreview(next);
    } catch (error) {
      if (mounted.current)
        setMessage(
          workroomMessage(error, "This source could not be previewed."),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function add(excerpt: boolean) {
    if (!preview) return;
    // Native keyboard/accessibility selection does not always fire React's
    // synthetic onSelect. Sample the actual control at the explicit Add action.
    // Main still validates these offsets against its own reviewed snapshot.
    const selection = excerpt ? selectedRange() : null;
    if (excerpt && !selection) {
      setMessage(
        "Select the text you want to keep, then choose Add selected excerpt.",
      );
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const next = await window.cadrane.cases.addSource({
        id: caseId,
        token: preview.token,
        ...(selection
          ? { startOffset: selection.start, endOffset: selection.end }
          : {}),
      });
      if (!mounted.current) return;
      setPreview(null);
      setRange(null);
      setMessage(
        "Source saved. Select it below when you want the model to use it.",
      );
      onAdded(next);
    } catch (error) {
      if (mounted.current)
        setMessage(workroomMessage(error, "This source could not be added."));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function discard() {
    if (!preview) return;
    setBusy(true);
    try {
      await window.cadrane.cases.discardSource({
        id: caseId,
        token: preview.token,
      });
      if (mounted.current) {
        setPreview(null);
        setRange(null);
        setMessage("Preview discarded.");
      }
    } catch {
      if (mounted.current)
        setMessage("The preview could not be discarded. Try again.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section
      className="workroom-source-import"
      aria-label="Import a source document"
    >
      <div className="source-import__head">
        <div>
          <h3>Bring the facts</h3>
          <p>Documents or a CSV export. Review what comes in.</p>
        </div>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => void choose()}
        >
          {busy
            ? "Working…"
            : preview
              ? "Choose another file"
              : "Add a file"}
        </button>
      </div>
      {preview && (
        <div className="source-preview">
          <strong>{preview.fileName}</strong>
          <p className="source-preview__coverage">{preview.coverage}</p>
          <label htmlFor={`source-preview-${caseId}`}>
            {preview.format === "csv" ? "Review the CSV snapshot" : "Review the text, or select an excerpt to add"}
          </label>
          <textarea
            ref={previewText}
            id={`source-preview-${caseId}`}
            className="textarea source-preview__text"
            readOnly
            value={preview.text}
            onSelect={syncSelection}
            onKeyUp={syncSelection}
            onMouseUp={syncSelection}
          />
          <p className="muted">
            {preview.text.length.toLocaleString()} characters
            {range ? ` · ${range.end - range.start} selected` : ""}. Preview
            expires after ten minutes.
          </p>
          {preview.text.length > 10_000 && preview.format !== "csv" && (
            <p className="source-preview__coverage">
              For a local request, select a short excerpt that leaves room for
              your question and other sources.
            </p>
          )}
          <div className="source-preview__actions">
            {preview.format !== "csv" && <button
              className="btn btn--primary"
              type="button"
              disabled={busy}
              onClick={() => void add(true)}
            >
              Add selected excerpt
            </button>}
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => void add(false)}
            >
              {preview.format === "csv" ? "Add CSV snapshot" : "Add all previewed text"}
            </button>
            <button
              className="link"
              type="button"
              disabled={busy}
              onClick={() => void discard()}
            >
              Discard
            </button>
          </div>
          <p className="muted">
            Keeps a text snapshot in this workroom. You choose whether to
            include it in a request.
          </p>
        </div>
      )}
      {message && (
        <p role="status" className="source-preview__status">
          {message}
        </p>
      )}
    </section>
  );
}
