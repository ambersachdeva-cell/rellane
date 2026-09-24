import { useEffect, useRef, useState } from "react";
import type { AgentCard, CaseSourcePreview } from "@cadrane/contracts";
import { workroomMessage } from "../workroom-message.js";
import { Button } from "./ui";

/** The host owns the snapshot. UI state only keeps its one-use reference. */
export function useAgentSource(agent: AgentCard) {
  const [preview, setPreview] = useState<CaseSourcePreview | null>(null);
  const [required, setRequired] = useState(false);
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState("");
  const epoch = useRef(0);
  const mounted = useRef(true);
  const scope = JSON.stringify([agent.brief, agent.folders, agent.capabilities]);
  useEffect(() => {
    mounted.current = true;
    setPreview(null);
    setOpening(false);
    return () => {
      mounted.current = false;
      epoch.current++;
      void window.cadrane?.agents.discardSource({ agentId: agent.id }).catch(() => {});
    };
  }, [agent.id, scope]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => {
      setPreview(null);
      setMessage("This preview expired. Choose the source again before starting a new run.");
      void window.cadrane?.agents.discardSource({ agentId: agent.id, token: preview.token }).catch(() => {});
    }, Math.max(0, preview.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [agent.id, preview]);

  async function choose() {
    const api = window.cadrane;
    if (!api) { setMessage("The app connection is unavailable."); return; }
    const request = ++epoch.current;
    setRequired(true); setPreview(null); setOpening(true); setMessage("");
    try {
      const selected = await api.agents.previewSource({ agentId: agent.id });
      if (!mounted.current || request !== epoch.current) {
        if (selected) void api.agents.discardSource({ agentId: agent.id, token: selected.token }).catch(() => {});
        return;
      }
      setPreview(selected);
      if (!selected) setMessage("No file was selected. Choose a source, or use the brief's sources only.");
    } catch (error) {
      if (mounted.current && request === epoch.current) setMessage(workroomMessage(error, "This source could not be opened."));
    } finally {
      if (mounted.current && request === epoch.current) setOpening(false);
    }
  }
  function remove() {
    epoch.current++;
    setPreview(null); setRequired(false); setOpening(false); setMessage("");
    void window.cadrane?.agents.discardSource({ agentId: agent.id }).catch(error => {
      if (mounted.current) setMessage(workroomMessage(error, "The unused preview could not be cleared."));
    });
  }
  function retire(token: string | undefined) {
    if (!token || !mounted.current) return;
    setPreview(null);
    setMessage("For another run, choose a fresh source or use the brief's sources only. Continue this saved work from its Workroom.");
    void window.cadrane?.agents.discardSource({ agentId: agent.id, token }).catch(() => {});
  }
  return { preview, required, opening, message, choose, remove, retire,
    waiting: opening || (required && preview === null) };
}

export function AgentSourceInput({ agent, source, disabled }: {
  agent: AgentCard; source: ReturnType<typeof useAgentSource>; disabled: boolean;
}) {
  const canRead = !agent.inert && agent.capabilities.includes("read_text");
  return <section className="agsource" aria-label={`Source for ${agent.name}`}>
    <div className="agsource__head">
      <strong>{source.required ? "Required source" : "Give it a file to work from"}</strong>
      <Button disabled={disabled || source.opening || !canRead} onClick={() => void source.choose()}>
        {source.opening ? "Opening source…" : source.preview ? "Replace file" : "Choose text file"}
      </Button>
      {source.required ? <Button disabled={disabled} onClick={source.remove}>Use brief sources only</Button> : null}
    </div>
    <p className="agsource__help">
      {canRead
        ? "Optional: choose a .txt or .md file already inside this agent's granted folders. Up to 32 KB and 8,000 characters."
        : "A required file needs a granted folder and the read_text tool. Edit a copy of this brief to enable them."}
    </p>
    {source.preview ? <>
      <p className="agsource__file"><strong>{source.preview.fileName}</strong> · {source.preview.bytes.toLocaleString()} bytes</p>
      <pre className="agsource__text" tabIndex={0} aria-label={`Captured text from ${source.preview.fileName}`}>{source.preview.text}</pre>
      <p className="agsource__help">Run uses this captured text and saves it in Workroom Sources. Other sources and tools in the brief remain available. The file is not watched.</p>
      <details className="agsource__receipt"><summary>Check source details</summary>
        <p>{source.preview.coverage}</p>
        <p>File SHA-256: <code>{source.preview.fileSha256}</code></p>
        <p>Text SHA-256: <code>{source.preview.textSha256}</code></p>
        <p>Preview expires at {new Date(source.preview.expiresAt).toLocaleTimeString()}.</p>
      </details>
    </> : null}
    {source.message ? <p className="agsource__message" role="status">{source.message}</p> : null}
  </section>;
}
