/** Outputs become useful when they can be edited, versioned and taken out of the app. */
import { useEffect, useRef, useState } from "react";
import type { CaseRoom, CaseArtifactFormat } from "@cadrane/contracts";
import { RichText } from "../RichText.js";
import type { WorkstationCitationCheckResult } from "@cadrane/contracts";
import { presentCitationCheck } from "./citation-presentation.js";
import { VersionDiffView } from "./VersionDiff.js";
import { Icon, IconButton } from "./ui.js";

export interface EditorDraft { readonly body: string; readonly sourceTurnId: string | null; readonly baseVersionId: string | null; }
/** A citation result belongs to the exact text, selection and work it was run on. */
interface CitationCheckSnapshot { readonly result: WorkstationCitationCheckResult; readonly body: string; readonly sourceKey: string; readonly caseId: string; }
export function ArtifactEditor({ room, selectedSourceIds = [], draft, setDraft, savedBody, onSaved, onClose, onMessage }: {
  room: CaseRoom; selectedSourceIds?: readonly string[]; draft: EditorDraft; setDraft: (draft: EditorDraft) => void; savedBody: string;
  onSaved: (room: CaseRoom) => void; onClose: () => void; onMessage: (message: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<CaseArtifactFormat>("docx");
  const [viewingId, setViewingId] = useState("");
  const [checkingCitations, setCheckingCitations] = useState(false);
  const [citationCheck, setCitationCheck] = useState<CitationCheckSnapshot | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const latest = room.artifacts[0];
  const historical = room.artifacts.find(version => version.id === viewingId);
  const body = historical?.body ?? draft.body;
  const selectedIds = [...selectedSourceIds];
  const sourceKey = selectedIds.join("|");
  const citationGeneration = useRef(0);
  useEffect(() => {
    citationGeneration.current += 1;
    setCitationCheck(null);
    setCheckingCitations(false);
    setShowDiff(false);
    return () => { citationGeneration.current += 1; };
  }, [room.case?.id, body, sourceKey, viewingId]);
  // Editing the draft, reordering or changing the sources, opening a saved
  // version or moving to other work all retire the result rather than leaving a
  // stale verdict beside text it was never run against.
  const check = citationCheck && !historical
    && citationCheck.body === draft.body
    && citationCheck.sourceKey === sourceKey
    && citationCheck.caseId === (room.case?.id ?? "")
    ? citationCheck.result
    : null;
  const presentation = check ? presentCitationCheck(check) : null;
  const dirty = draft.body !== savedBody || !draft.baseVersionId;
  const title = body.split("\n").find(line => line.trim())?.replace(/^#+\s*/u, "").slice(0, 70) || "Untitled output";
  async function save() {
    if (!room.case || !draft.body.trim()) return;
    setBusy(true);
    try {
      const next = await window.cadrane.cases.saveArtifact({ id: room.case.id, baseVersionId: draft.baseVersionId, sourceTurnId: draft.sourceTurnId, body: draft.body });
      onSaved(next); onMessage("Saved a new version.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "The output could not be saved.");
    }
    finally { setBusy(false); }
  }
  async function exportOutput() {
    const version = historical ?? latest;
    if (!room.case || !version || (!historical && dirty)) return;
    setBusy(true);
    try {
      const result = await window.cadrane.cases.exportArtifact({ id: room.case.id, versionId: version.id, format });
      onMessage(result.written ? "Export saved." : "Export cancelled.");
    }
    catch (error) {
      onMessage(error instanceof Error ? error.message : "The export could not be saved.");
    }
    finally { setBusy(false); }
  }
  async function runCitationCheck() {
    if (!room.case || historical || checkingCitations || selectedIds.length === 0) return;
    const generation = ++citationGeneration.current;
    setCitationCheck(null);
    const checkedBody = draft.body;
    const checkedSourceKey = sourceKey;
    const checkedCaseId = room.case.id;
    setCheckingCitations(true);
    try {
      const result = await window.cadrane.workstation.checkCitations({
        caseId: checkedCaseId,
        draft: checkedBody,
        sourceTurnIds: selectedIds
      });
      if (generation !== citationGeneration.current) return;
      setCitationCheck({ result, body: checkedBody, sourceKey: checkedSourceKey, caseId: checkedCaseId });
      if (result.status === "ok") onMessage("Every numbered reference matches a selected source. The claims themselves were not checked.");
      else if (result.status === "uncited") onMessage("No numbered [n] references were found in this draft.");
      else onMessage(result.summary);
    } catch (error) {
      if (generation === citationGeneration.current) onMessage(error instanceof Error ? error.message : "The citation check could not run.");
    } finally {
      if (generation === citationGeneration.current) setCheckingCitations(false);
    }
  }
  return <aside className="ws-editor" aria-label="Output editor">
    <header className="ws-editor-header"><div className="ws-editor-title"><Icon name="file" /><span>Output</span><span className="ws-badge">{historical ? `Version ${historical.revision}` : dirty ? "Unsaved" : `Version ${latest?.revision ?? 1}`}</span></div><IconButton icon="close" label="Close output editor" onClick={onClose} /></header>
    <div className="ws-editor-toolbar"><div className="ws-segmented" aria-label="Output view"><button aria-pressed={!preview && !historical} onClick={() => { setViewingId(""); setPreview(false); }}>Edit</button><button aria-pressed={preview || !!historical} onClick={() => setPreview(true)}>Preview</button></div><button className="ws-button ws-button--small" onClick={() => void runCitationCheck()} disabled={busy || checkingCitations || !!historical || !room.case || selectedIds.length === 0 || !draft.body.trim()}>{checkingCitations ? "Checking…" : "Check citation links"}</button><button className="ws-button ws-button--primary ws-button--small" onClick={() => void save()} disabled={busy || !!historical || !dirty || !draft.body.trim()}>{busy ? "Working…" : "Save version"}</button></div>
    {latest ? <div className="ws-version-history"><label>Saved versions<select aria-label="Saved versions" value={viewingId} onChange={event => setViewingId(event.target.value)}><option value="">Current output</option>{room.artifacts.map(version => <option key={version.id} value={version.id}>Version {version.revision} · {new Date(version.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</option>)}</select></label>{historical ? <p>Viewing a saved version. <button disabled={busy} onClick={() => { setDraft({ body: historical.body, sourceTurnId: historical.sourceTurnId, baseVersionId: latest.id }); setViewingId(""); setPreview(false); }}>Use as current draft</button> <button onClick={() => setShowDiff(value => !value)} aria-expanded={showDiff}>{showDiff ? "Hide changes" : "Show what changed"}</button></p> : null}</div> : null}
    {historical && showDiff ? <VersionDiffView before={historical.body} after={draft.body} beforeLabel={`Version ${historical.revision}`} afterLabel={dirty ? "Current draft" : `Version ${latest?.revision ?? 1}`} /> : null}
    {check && presentation ? <div className="ws-version-history ws-citation-results" role="region" aria-label="Citation check results">
      <p><strong>{presentation.headline}</strong> <span className="ws-badge">{presentation.badge === "ok" ? "References match" : presentation.badge === "uncited" ? "No numbered references" : presentation.badge === "unavailable" ? "Not checked" : "Issues found"}</span> <button className="ws-button ws-button--small" onClick={() => setCitationCheck(null)}>Dismiss</button></p>
      <p className="ws-form-hint">{check.summary}</p>
      <p className="ws-form-hint">{check.disclaimer}</p>
      {presentation.guidance.map((tip, index) => <p className="ws-form-hint" key={`citation-guidance-${index}`}>{tip}</p>)}
      <p><strong>Quoted text:</strong> <span className="ws-badge">{check.quotes.length === 0 ? "Not checked" : check.quotes.some(q => q.status !== "matched") ? "Issues found" : "Text matched"}</span></p>
      <p className="ws-form-hint">{check.quoteCheckNote}</p>
      {check.quotes.filter(q => q.status !== "matched").map((q, index) => (
        <p className="ws-inline-problem" role="alert" key={`quote-error-${index}`}>
          {q.status === "source_not_selected"
            ? `Quoted passage "${q.quote}" ${q.citation}: source not selected.`
            : `Quoted passage "${q.quote}" ${q.citation}: text not found in source.`}
        </p>
      ))}
      {check.sources.length ? <><p className="ws-eyebrow">Source numbers</p><ol>{check.sources.map(source => <li key={source.id}>[{source.id}] {source.label}</li>)}</ol><p className="ws-form-hint">Write [1], [2] after the sentences each source supports, then list them under a Sources heading.</p></> : <p className="ws-form-hint">No sources were selected for this work, so there was nothing to match against.</p>}
      {presentation.expectedBlockOrigin !== "none" ? <details className="ws-routine-details"><summary>{presentation.expectedBlockOrigin === "derived" ? "Expected Sources block (worked out from selected sources)" : "Expected Sources block (checker's own)"}</summary><p className="ws-form-hint">{presentation.expectedBlockOrigin === "derived" ? "Rellane worked this block out from the selected sources." : "This Sources block is the checker's own."}</p><pre>{presentation.expectedSourcesBlock}</pre></details> : null}
      {presentation.technicalDetail.length ? <details className="ws-routine-details"><summary>Technical details</summary>{presentation.technicalDetail.map((detail, index) => <p className="ws-form-hint" key={`citation-detail-${index}`}>{detail}</p>)}</details> : null}
    </div> : null}
    <div className="ws-editor-paper"><p className="ws-eyebrow">{title}</p>{preview || historical ? <div className="ws-prose ws-document"><RichText text={body} /></div> : <textarea className="ws-document-input" aria-label="Edit output" value={draft.body} maxLength={50_000} spellCheck onChange={event => setDraft({ ...draft, body: event.target.value })} />}</div>
    <footer className="ws-editor-footer"><div><strong>{body.trim().split(/\s+/u).filter(Boolean).length.toLocaleString()} words</strong><span>{historical ? `Saved version ${historical.revision}` : dirty ? "Save to keep this version" : "Saved on this Mac"}</span></div><div className="ws-export-control"><select aria-label="Export format" value={format} onChange={event => setFormat(event.target.value as CaseArtifactFormat)}><option value="docx">Word</option><option value="md">Markdown</option></select><button className="ws-button ws-button--small" disabled={busy || (!historical && dirty) || !latest} onClick={() => void exportOutput()}><Icon name="export" size={15} />Export</button></div></footer>
  </aside>;
}
