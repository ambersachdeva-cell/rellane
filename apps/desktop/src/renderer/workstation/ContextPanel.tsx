/** Local suggestions help choose files; the owner's selection and outgoing review remain separate. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { searchSources, type SearchDocument } from "./source-search.js";
import type { CaseTurnView, DesktopBridge, WorkstationBridge, WorkstationContextSuggestion } from "@cadrane/contracts";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import { Icon, Modal, ProviderGlyph } from "./ui.js";

const isFile = (turn: CaseTurnView) => turn.seat.startsWith(CASE_SOURCE_SEAT_PREFIX);
const label = (turn: CaseTurnView) => isFile(turn) ? turn.seat.slice(CASE_SOURCE_SEAT_PREFIX.length)
  : `${turn.seat === "owner" ? "You" : turn.seat.replace(/^Workstation · /u, "")} · message ${turn.seq}`;
const explain = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "") : "The local suggestion did not finish. Your selection is unchanged.";

function renderSnippet(snippet: string, highlights: readonly (readonly [number, number])[]): ReactNode {
  if (highlights.length === 0) return snippet;
  const elements: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < highlights.length; i++) {
    const range = highlights[i];
    if (!range) continue;
    const [start, end] = range;
    if (start > cursor) elements.push(snippet.slice(cursor, start));
    elements.push(<mark key={i} className="ws-context-highlight" aria-label="Search match">{snippet.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < snippet.length) elements.push(snippet.slice(cursor));
  return elements;
}

export function ContextPanel({ caseId, question, sources, selected, disabled, bridge, shortcuts, onSelection, onAddFile, onClose }: {
  caseId: string; question: string; sources: readonly CaseTurnView[]; selected: readonly string[]; disabled: boolean;
  bridge: WorkstationBridge; shortcuts: DesktopBridge["localShortcuts"];
  onSelection: (ids: readonly string[]) => void; onAddFile: () => void; onClose: () => void;
}) {
  const [suggestion, setSuggestion] = useState<WorkstationContextSuggestion | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [working, setWorking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef<string | null>(null);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const trimmedQuery = searchQuery.trim();
  const searchDocuments = useMemo<readonly SearchDocument[]>(() => sources.map(turn => ({
    id: turn.id,
    label: label(turn),
    text: turn.body,
  })), [sources]);
  const searchHits = useMemo(() => {
    if (!trimmedQuery) return [];
    return searchSources(searchDocuments, trimmedQuery);
  }, [searchDocuments, trimmedQuery]);
  const files = sources.filter(isFile);
  const candidates = files.length <= 20 ? files : files.filter(turn => selected.includes(turn.id));
  const canSuggest = !disabled && question.trim().length > 0 && question.trim().length <= 2_000 && candidates.length > 0 && candidates.length <= 20;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (operation.current) void shortcuts.stop({ handle: operation.current }).catch(() => undefined); };
  }, [shortcuts]);

  async function suggest() {
    if (!canSuggest || working) return;
    cancelled.current = false;
    setWorking(true); setStopping(false); setError(""); setSuggestion(null);
    try {
      const { handle } = await shortcuts.begin({ kind: "context-selection" });
      if (!mounted.current) { await shortcuts.stop({ handle }); return; }
      operation.current = handle;
      if (cancelled.current) throw new Error("Stopped. Your selection is unchanged.");
      const result = await bridge.suggestContext({ caseId, handle, question: question.trim(), sourceTurnIds: candidates.map(turn => turn.id) });
      if (mounted.current && !cancelled.current) setSuggestion(result);
    } catch (reason) { if (mounted.current) setError(explain(reason)); }
    finally {
      const handle = operation.current;
      if (handle) await shortcuts.stop({ handle }).catch(() => undefined);
      operation.current = null;
      if (mounted.current) { setWorking(false); setStopping(false); }
    }
  }
  async function stop() {
    cancelled.current = true;
    setStopping(true);
    if (!operation.current) return;
    try { await shortcuts.stop({ handle: operation.current }); }
    catch (reason) { if (mounted.current) setError(explain(reason)); }
  }
  function applySuggestion() {
    if (!suggestion || working || disabled) return;
    const keep = selected.filter(id => !suggestion.consideredIds.includes(id));
    const next = [...new Set([...keep, ...suggestion.sourceTurnIds])];
    if (next.length > 20) { setError("That would select more than 20 files and messages. Uncheck a few, then use the suggestion."); return; }
    onSelection(next);
    setSuggestion(null);
    setError("");
  }

  return <Modal title="Give your AI the right context" eyebrow="Files and conversation" onClose={onClose}>
    <p className="ws-modal-description">Choose what helps with this request. Checked files and messages join your draft. Review the outgoing text before your subscription receives it.</p>
    {files.length > 0 ? <section className="ws-context-assistant" aria-label="Local context assistant">
      <div className="ws-context-assistant-heading"><ProviderGlyph family="local" /><div><strong>A little help from this Mac</strong><p>Let the local model suggest which saved files matter for your draft.</p></div></div>
      {question.trim() ? <blockquote className="ws-context-question">{question.trim().slice(0, 240)}{question.trim().length > 240 ? "…" : ""}</blockquote> : <p>Write your question first, then come back for a suggestion.</p>}
      <div className="ws-context-assistant-actions"><span>{files.length > 20 ? "Check up to 20 saved files to consider." : `${files.length} saved ${files.length === 1 ? "file" : "files"} in this work · stays on this Mac`}</span>
        {working ? <button className="ws-button ws-button--small" disabled={stopping} onClick={() => void stop()}><Icon name="stop" size={13} />{stopping ? "Stopping…" : "Stop"}</button>
          : <button className="ws-button ws-button--small" disabled={!canSuggest} onClick={() => void suggest()}><Icon name="search" size={14} />Suggest relevant files</button>}</div>
      {question.trim().length > 2_000 ? <p>Shorten your question to 2,000 characters for local suggestions. Manual selection still works.</p> : null}
      {working ? <p className="ws-context-progress" role="status">{stopping ? "Stopping the local reading. Your selection is unchanged." : "Reading saved text and looking for direct support…"}</p> : null}
      {suggestion ? <div className="ws-context-suggestion" role="status"><strong>{suggestion.sourceTurnIds.length ? `${suggestion.sourceTurnIds.length} ${suggestion.sourceTurnIds.length === 1 ? "file looks" : "files look"} useful` : "No directly useful file found"}</strong>
        <p>A local suggestion, ready for your judgement. {suggestion.excerptedIds.length ? `${suggestion.excerptedIds.length} files were read as excerpts. ` : ""}{suggestion.omittedIds.length ? `${suggestion.omittedIds.length} files did not fit and were not read. ` : ""}The checked items have not changed.</p>
        {suggestion.sourceTurnIds.length ? <ul>{suggestion.sourceTurnIds.map(id => <li key={id}>{sources.find(turn => turn.id === id) ? label(sources.find(turn => turn.id === id)!) : "Saved file unavailable"}</li>)}</ul> : null}
        <div className="ws-context-assistant-actions"><span>{(suggestion.durationMs / 1000).toFixed(1)}s · {suggestion.modelId}</span>
          {suggestion.sourceTurnIds.length ? <button className="ws-button ws-button--primary ws-button--small" disabled={disabled} onClick={applySuggestion}>Use suggested files</button> : null}</div>
        <small>Using suggestions replaces the files considered here. Your other checked items stay selected. No request is sent.</small>
      </div> : null}
      {error ? <p className="ws-inline-problem" role="alert">{error}</p> : null}
    </section> : null}
    <div className="ws-context-search"><input type="search" className="ws-context-search-input" placeholder="Search passages in saved sources…" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} aria-label="Search passages in saved sources" /></div>
    <div className="ws-source-list">{trimmedQuery ? (searchHits.length > 0 ? searchHits.map(hit => <label key={hit.id}><input type="checkbox" checked={selected.includes(hit.id)} disabled={disabled || working || (!selected.includes(hit.id) && selected.length >= 20)} onChange={event => onSelection(event.target.checked ? [...new Set([...selected, hit.id])] : selected.filter(id => id !== hit.id))} /><div><strong>{hit.label}</strong><p>{renderSnippet(hit.snippet, hit.highlights)}</p></div></label>) : <p className="ws-context-search-empty">No matching passages found.</p>) : sources.map(turn => <label key={turn.id}><input type="checkbox" checked={selected.includes(turn.id)} disabled={disabled || working || (!selected.includes(turn.id) && selected.length >= 20)} onChange={event => onSelection(event.target.checked ? [...new Set([...selected, turn.id])] : selected.filter(id => id !== turn.id))} /><div><strong>{label(turn)}</strong><p>{turn.body.slice(0, 180)}{turn.body.length > 180 ? "…" : ""}</p><span>{turn.body.length.toLocaleString()} characters</span></div></label>)}</div>
    <footer className="ws-modal-footer"><button className="ws-button" disabled={working || disabled} onClick={onAddFile}><Icon name="plus" size={15} />Add a file</button><button className="ws-button ws-button--primary" onClick={onClose}>Use selected context</button></footer>
  </Modal>;
}
