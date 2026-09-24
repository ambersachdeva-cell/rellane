/** A useful request can become an editable procedure without becoming a standing permission. */
import { useEffect, useState } from "react";
import type { WorkstationRoutine, WorkstationRoutineSaveInput, WorkstationSavedRoutine } from "@cadrane/contracts";
import { Icon, Modal, type IconName } from "./ui.js";

export interface RoutineSeed {
  readonly title: string;
  readonly prompt: string;
  readonly originCaseId?: string;
  readonly originTurnId?: string;
}
type Form = Pick<WorkstationRoutine, "title" | "description" | "prompt" | "icon" | "sourceHint" | "outputLabel">;
const ICONS: Record<WorkstationRoutine["icon"], IconName> = {write: "edit", research: "search", build: "code", review: "shield", data: "grid"};
function fields(value?: WorkstationRoutine | RoutineSeed): Form {
  return { title: value?.title ?? "", prompt: value?.prompt ?? "", description: value && "description" in value ? value.description : "A reusable procedure from your work.", icon: value && "icon" in value ? value.icon : "write", sourceHint: value && "sourceHint" in value ? value.sourceHint : "Choose the files and answers relevant to this run.", outputLabel: value && "outputLabel" in value ? value.outputLabel : "Useful output" };
}

export function RoutinesPanel({ starters, saved, seed, onChoose, onSave, onVersions, onClose }: {
  starters: readonly WorkstationRoutine[];
  saved: readonly WorkstationSavedRoutine[];
  seed: RoutineSeed | null;
  onChoose: (routine: WorkstationRoutine) => string | null;
  onSave: (input: WorkstationRoutineSaveInput) => Promise<WorkstationSavedRoutine>;
  onVersions: (id: string) => Promise<readonly WorkstationSavedRoutine[]>;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(seed !== null);
  const [base, setBase] = useState<WorkstationSavedRoutine | null>(null);
  const [form, setForm] = useState<Form>(() => fields(seed ?? undefined));
  const [original, setOriginal] = useState<Form>(() => fields());
  const [origin, setOrigin] = useState<RoutineSeed | null>(seed);
  const [versions, setVersions] = useState<readonly WorkstationSavedRoutine[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState<WorkstationRoutine | null>(null);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState<"close" | "back" | null>(null);
  const dirty = editing && JSON.stringify(form) !== JSON.stringify(original);
  const historical = versions.find(value => value.revision === historyRevision);
  const valid = [form.title, form.description, form.prompt, form.sourceHint, form.outputLabel].every(value => value.trim());

  useEffect(() => {
    if (!base) { setVersions([]); return; }
    let current = true;
    void onVersions(base.id).then(value => { if (current) setVersions(value); }).catch(problem => { if (current) setError(problem instanceof Error ? problem.message : "Version history could not be loaded."); });
    return () => { current = false; };
  }, [base, onVersions]);

  function leave(destination: "close" | "back") {
    if (busy) return;
    if (dirty) { setDiscard(destination); return; }
    if (inspecting) { setInspecting(null); if (destination === "close") onClose(); return; }
    if (destination === "close") onClose();
    else { setEditing(false); setBase(null); setError(""); }
  }
  function edit(value?: WorkstationSavedRoutine) {
    const next = fields(value);
    setBase(value ?? null); setForm(next); setOriginal(next); setOrigin(null); setHistoryRevision(0); setEditing(true); setError("");
  }
  async function save() {
    if (!valid || busy) return;
    setBusy(true); setError("");
    try {
      await onSave({ ...form, ...(base ? {id: base.id, expectedRevision: base.revision} : origin?.originCaseId && origin.originTurnId ? {originCaseId: origin.originCaseId, originTurnId: origin.originTurnId} : {}) });
      setEditing(false); setOriginal(form); setBase(null); setOrigin(null); setDiscard(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Your routine could not be saved. Your draft is still here."); }
    finally { setBusy(false); }
  }
  function patch<K extends keyof Form>(key: K, value: Form[K]) { setForm(previous => ({...previous, [key]: value})); }
  function choose(value: WorkstationRoutine) { const error = onChoose(value); if (error) setError(error); }

  const hermesRoutines = starters.filter(value => Boolean(value.upstream || value.id.startsWith("hermes/")));
  const nativeStarters = starters.filter(value => !value.upstream && !value.id.startsWith("hermes/"));

  return <Modal title={editing ? (base ? "Make the next run better" : "Keep a useful way of working") : inspecting ? inspecting.title : "Good work, ready to repeat"} eyebrow={inspecting ? "Inspect procedure" : "Routines"} wide onClose={() => leave("close")}>
    {editing ? <div className="ws-continuity-form">
      <p className="ws-modal-description">Write the reusable steps and the result you want. Leave customer details in the sources you choose for each run.</p>
      <div className="ws-form-pair"><label>Routine name<input autoFocus data-autofocus maxLength={100} value={form.title} onChange={event => patch("title", event.target.value)} disabled={busy} placeholder="e.g. Check a production brief" /></label><label>Expected output<input maxLength={100} value={form.outputLabel} onChange={event => patch("outputLabel", event.target.value)} disabled={busy} /></label></div>
      <label>Instructions<textarea rows={10} maxLength={8000} value={form.prompt} onChange={event => patch("prompt", event.target.value)} disabled={busy} placeholder="Describe the steps, what to check, and what a useful result looks like." /></label>
      <details className="ws-routine-details"><summary>Description and source guidance</summary><label>What it helps with<input value={form.description} maxLength={500} onChange={event => patch("description", event.target.value)} disabled={busy} /></label><label>What to bring<input value={form.sourceHint} maxLength={500} onChange={event => patch("sourceHint", event.target.value)} disabled={busy} /></label><label>Kind<select value={form.icon} onChange={event => patch("icon", event.target.value as Form["icon"])} disabled={busy}><option value="write">Writing</option><option value="research">Research</option><option value="build">Building</option><option value="review">Reviewing</option><option value="data">Data</option></select></label></details>
      {versions.length > 1 ? <details className="ws-routine-details"><summary>Earlier versions</summary><label>Saved version<select value={historyRevision} onChange={event => setHistoryRevision(Number(event.target.value))}><option value={0}>Choose a version to inspect</option>{versions.map(value => <option key={value.revision} value={value.revision}>Version {value.revision} · {new Date(value.updatedAt).toLocaleDateString()}</option>)}</select></label>{historical ? <div className="ws-routine-history"><strong>{historical.title}</strong><pre>{historical.prompt}</pre><button className="ws-button ws-button--small" onClick={() => {setForm(fields(historical)); setHistoryRevision(0);}}>Use this version in my draft</button><p>Saving adds a new version. Earlier versions stay intact.</p></div> : null}</details> : null}
      <p className="ws-form-hint">A routine prepares an editable request. It never sends, schedules or grants tools on its own.</p>
      <footer className="ws-modal-footer"><button className="ws-button" onClick={() => leave("back")} disabled={busy}>Back to routines</button><button className="ws-button ws-button--primary" onClick={() => void save()} disabled={busy || !valid || (Boolean(base) && !dirty)}>{busy ? "Saving…" : base ? "Save new version" : "Save routine"}</button></footer>
    </div> : inspecting ? <div className="ws-continuity-form">
      <p className="ws-modal-description">{inspecting.description}</p>
      {inspecting.upstream ? <div className="ws-review-facts"><span>Source: {inspecting.upstream.repository.replace(/^https:\/\/github\.com\//u, "")}</span><span>Commit: {inspecting.upstream.commit.slice(0, 7)}</span><span>License: {inspecting.upstream.license}</span></div> : null}
      <label>Procedure instructions<textarea rows={12} readOnly value={inspecting.prompt} /></label>
      {inspecting.upstream ? <details className="ws-routine-details"><summary>Upstream provenance and file details</summary><p className="ws-form-hint">Repository: {inspecting.upstream.repository}<br />Path: {inspecting.upstream.path}<br />Commit: {inspecting.upstream.commit}<br />SHA-256: {inspecting.upstream.sha256}</p></details> : null}
      <p className="ws-form-hint">Choosing this routine sets your draft request. It never sends or grants tool permissions on its own.</p>
      <footer className="ws-modal-footer"><button className="ws-button" onClick={() => setInspecting(null)}>Back to routines</button><button className="ws-button ws-button--primary" onClick={() => { const item = inspecting; setInspecting(null); choose(item); }}>Use routine</button></footer>
    </div> : <>
      <div className="ws-project-intro"><p className="ws-modal-description">Choose a starting point or keep a procedure from your own work. Make it yours, add context, then choose your AI.</p><button className="ws-button" onClick={() => edit()}><Icon name="plus" size={15} />Create routine</button></div>
      {saved.length ? <><div className="ws-section-heading"><h3>Yours</h3><span>{saved.length}</span></div><div className="ws-saved-routines">{saved.map(value => <article key={value.id}><span className="ws-routine-symbol"><Icon name={ICONS[value.icon]} size={21} /></span><div><h3>{value.title}</h3><p>{value.description}</p><span>{value.outputLabel} · Version {value.revision}</span></div><div className="ws-routine-row-actions"><button className="ws-button ws-button--small" onClick={() => choose(value)}>Use routine</button><button className="ws-text-button" onClick={() => edit(value)}>Edit</button></div></article>)}</div></> : null}
      {hermesRoutines.length ? <><div className="ws-section-heading"><h3>Hermes skills</h3><span>{hermesRoutines.length}</span></div><div className="ws-saved-routines">{hermesRoutines.map(value => <article key={value.id}><span className="ws-routine-symbol"><Icon name={ICONS[value.icon]} size={21} /></span><div><h3>{value.title}</h3><p>{value.description}</p><span>{value.outputLabel}{value.upstream ? ` · Hermes (${value.upstream.commit.slice(0, 7)}) · ${value.upstream.license}` : ""}</span></div><div className="ws-routine-row-actions"><button className="ws-button ws-button--small" onClick={() => choose(value)}>Use routine</button><button className="ws-text-button" onClick={() => setInspecting(value)}>Inspect</button></div></article>)}</div></> : null}
      <div className="ws-section-heading"><h3>Starting points</h3><span>{nativeStarters.length}</span></div><div className="ws-routines-grid">{nativeStarters.map(value => <button className="ws-routine-card" key={value.id} onClick={() => choose(value)}><Icon name={ICONS[value.icon]} size={23} /><h3>{value.title}</h3><p>{value.description}</p><small>{value.sourceHint}</small><span>{value.outputLabel}<Icon name="arrow" size={14} /></span></button>)}</div>
    </>}
    {error ? <p className="ws-inline-problem" role="alert">{error.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "")}</p> : null}
    {discard ? <div className="ws-discard-inline" role="alert"><p>Your routine has unsaved changes.</p><button className="ws-button" onClick={() => setDiscard(null)}>Keep editing</button><button className="ws-button" onClick={() => {const destination = discard;setDiscard(null);setEditing(false);if (destination === "close") onClose();}}>Discard changes</button></div> : null}
  </Modal>;
}
