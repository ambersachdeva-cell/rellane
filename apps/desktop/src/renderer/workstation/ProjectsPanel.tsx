/** A shared brief lets related work begin with context instead of another explanation. */
import { useState } from "react";
import type { CaseSummary, WorkstationProject, WorkstationProjectLink, WorkstationProjectSaveInput } from "@cadrane/contracts";
import { RichText } from "../RichText.js";
import { Icon, Modal } from "./ui.js";

export function ProjectsPanel({ projects, links, cases, initialId, currentId, onSave, onStart, onOpen, onUse, onClose }: {
  projects: readonly WorkstationProject[];
  links: readonly WorkstationProjectLink[];
  cases: readonly CaseSummary[];
  initialId: string | null;
  currentId: string | undefined;
  onSave: (input: WorkstationProjectSaveInput) => Promise<WorkstationProject>;
  onStart: (projectId: string) => void;
  onOpen: (caseId: string) => void;
  onUse: (project: WorkstationProject) => Promise<void>;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(initialId);
  const [editing, setEditing] = useState(false);
  const [base, setBase] = useState<WorkstationProject | null>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState<"close" | "back" | null>(null);
  const project = projects.find(value => value.id === selectedId);
  const dirty = editing && (title !== (base?.title ?? "") || brief !== (base?.brief ?? ""));
  const projectCases = cases.filter(value => links.some(link => link.caseId === value.id && link.projectId === selectedId));

  function leave(destination: "close" | "back") {
    if (busy) return;
    if (dirty) { setDiscard(destination); return; }
    if (destination === "close") onClose();
    else { setEditing(false); setSelectedId(null); setError(""); }
  }
  function edit(value: WorkstationProject | null) {
    setBase(value); setTitle(value?.title ?? ""); setBrief(value?.brief ?? ""); setEditing(true); setError("");
  }
  async function save() {
    if (!title.trim() || !brief.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const value = await onSave({ ...(base ? { id: base.id, expectedRevision: base.revision } : {}), title, brief });
      setSelectedId(value.id); setEditing(false); setBase(value); setDiscard(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Your project could not be saved. Your draft is still here."); }
    finally { setBusy(false); }
  }
  async function use() {
    if (!project || busy) return;
    setBusy(true); setError("");
    try { await onUse(project); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "The brief could not be added. Try again."); }
    finally { setBusy(false); }
  }

  return <Modal title={editing ? (base ? "Refine the shared brief" : "A place for the bigger picture") : project?.title ?? "Keep the whole picture together"} eyebrow="Projects" wide onClose={() => leave("close")}>
    {editing ? <div className="ws-continuity-form">
      <p className="ws-modal-description">Give related tasks one clear brief. Each saved revision stays intact when you change direction.</p>
      <label>Project name<input autoFocus data-autofocus value={title} onChange={event => setTitle(event.target.value)} maxLength={100} placeholder="e.g. Studio North launch" disabled={busy} /></label>
      <label>Shared brief<textarea value={brief} onChange={event => setBrief(event.target.value)} maxLength={8000} rows={10} placeholder="What are we making, who is it for, and what should every AI know? Include the goal, important decisions and what remains unknown." disabled={busy} /></label>
      <p className="ws-form-hint">Saved on this Mac. You choose when a brief becomes context for an AI request.</p>
      <footer className="ws-modal-footer"><button className="ws-button" onClick={() => leave("back")} disabled={busy}>Back to projects</button><button className="ws-button ws-button--primary" onClick={() => void save()} disabled={busy || !title.trim() || !brief.trim() || (Boolean(base) && !dirty)}>{busy ? "Saving…" : base ? "Save new brief version" : "Create project"}</button></footer>
    </div> : project ? <>
      <div className="ws-project-toolbar"><button className="ws-text-button" onClick={() => leave("back")}><Icon name="back" size={15} />All projects</button><span>Shared brief · Version {project.revision}</span><button className="ws-button ws-button--small" onClick={() => edit(project)}><Icon name="edit" size={14} />Edit brief</button></div>
      <div className="ws-project-brief"><RichText text={project.brief} /></div>
      <div className="ws-project-actions"><button className="ws-button ws-button--primary" onClick={() => onStart(project.id)} disabled={busy}><Icon name="plus" size={15} />Start work in this project</button>{currentId ? <button className="ws-button" onClick={() => void use()} disabled={busy}>{busy ? "Adding brief…" : "Use this brief in current work"}</button> : null}</div>
      <div className="ws-section-heading"><h3>Work in this project</h3><span>{projectCases.length}</span></div>
      {projectCases.length ? <div className="ws-project-work">{projectCases.map(value => <button key={value.id} onClick={() => onOpen(value.id)}><Icon name={value.closedAt ? "check" : "chat"} size={17} /><div><strong>{value.title}</strong><span>{value.question.slice(0, 150)}</span></div><Icon name="chevron" size={14} /></button>)}</div> : <p className="ws-empty-message">Start the first task. The shared brief can travel with it, while each conversation keeps its own record.</p>}
    </> : <>
      <div className="ws-project-intro"><p className="ws-modal-description">One goal, several tasks. Keep the brief close and continue with any of your AIs.</p><button className="ws-button ws-button--primary" onClick={() => edit(null)}><Icon name="plus" size={15} />New project</button></div>
      <div className="ws-project-grid">{projects.map(value => <button className="ws-project-card" key={value.id} onClick={() => setSelectedId(value.id)}><span className="ws-project-symbol"><Icon name="folder" size={24} /></span><h3>{value.title}</h3><p>{value.brief.slice(0, 160)}</p><footer><span>{links.filter(link => link.projectId === value.id).length} tasks</span><span>Brief v{value.revision}</span></footer></button>)}</div>
      {projects.length === 0 ? <div className="ws-empty-project"><Icon name="folder" size={38} /><h3>Some work is bigger than one conversation.</h3><p>A client, a product, a long-running idea. Give it a project, then build on the same brief across your tasks.</p></div> : null}
    </>}
    {error ? <p className="ws-inline-problem" role="alert">{error.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "")}</p> : null}
    {discard ? <div className="ws-discard-inline" role="alert"><p>Your brief has unsaved changes.</p><button className="ws-button" onClick={() => setDiscard(null)}>Keep editing</button><button className="ws-button" onClick={() => { const destination = discard; setDiscard(null); setEditing(false); if (destination === "close") onClose(); else setSelectedId(null); }}>Discard changes</button></div> : null}
  </Modal>;
}
