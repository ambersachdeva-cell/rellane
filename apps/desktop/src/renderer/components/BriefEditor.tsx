/**
 * Writing an agent.
 *
 * The product's claim is that an agent is a brief you can read. That is only
 * half true if the briefs are ours — so this is the other half, and its whole
 * design problem is that a permissions form teaches nothing.
 *
 * A list of checkboxes produces an agent whose owner knows which boxes are
 * ticked and not what it will do. So the sentence sits under the fields and
 * rewrites itself as they change: *"Chase payments works in Downloads, may use
 * read_text, asks before anything leaves this Mac, thinks with the quickest
 * model, and stops after 12 steps or 3 minutes."* If that sentence is wrong, it
 * is obviously wrong, in a way a ticked box never is.
 *
 * The sentence shown here is built in the renderer from the same fields, but the
 * one that matters is the one the main process returns after saving — resolved
 * against real folder grants, with clamps applied. They agree in the ordinary
 * case, and where they differ the saved card wins and shows what was withheld.
 */

import type { AgentCard } from "@cadrane/contracts";
import { Button } from "./ui";

/** What the editor is working on. Loose, because it is mid-edit. */
export interface DraftBrief {
  id: string;
  name: string;
  purpose: string;
  instructions: string;
  folders: string[];
  capabilities: string[];
  tier: string;
  maxSteps: number;
  maxMinutes: number;
  outbound: string;
}

export const BLANK: DraftBrief = {
  id: "",
  name: "",
  purpose: "",
  instructions: "",
  folders: [],
  capabilities: ["list_folder", "read_text"],
  tier: "on-device",
  maxSteps: 12,
  maxMinutes: 3,
  // Closed by default. An agent that can prepare something to send should be a
  // choice somebody made, never what happens if they did not read the form.
  outbound: "never"
};

const TOOLS: readonly { readonly id: string; readonly says: string }[] = [
  { id: "list_folder", says: "see what is in a folder" },
  { id: "read_text", says: "read a file's contents" }
];

const TIERS: readonly { readonly id: string; readonly says: string }[] = [
  { id: "on-device", says: "On this Mac" },
  { id: "fast", says: "Quickest" },
  { id: "balanced", says: "Everyday" },
  { id: "frontier", says: "Strongest" }
];

/** Reopen the requested brief, including fields absent from its compact card. */
export function draftFromCard(card: AgentCard): DraftBrief {
  return {
    id: card.id === "" ? newBriefId() : card.id,
    name: card.name, purpose: card.purpose,
    instructions: card.brief.instructions,
    folders: [...card.brief.workspace.folders],
    capabilities: [...card.brief.capabilities],
    tier: card.brief.engine.tier,
    maxSteps: card.brief.limits.maxSteps, maxMinutes: card.brief.limits.maxMinutes,
    outbound: card.brief.outbound
  };
}

/** A name is editable and need not be unique; a new brief's identity is neither. */
export function newBriefId(): string {
  return `agent-${crypto.randomUUID()}`;
}

export function renameDraft(draft: DraftBrief, name: string): DraftBrief {
  return { ...draft, name, id: draft.id || newBriefId() };
}

/** The same sentence the brief will carry, built from what is on screen now. */
export function sentenceFor(draft: DraftBrief, folderNames: readonly string[]): string {
  const name = draft.name.trim() || "This agent";
  const where =
    folderNames.length === 0 ? "has no folder to work in" : `works in ${folderNames.join(" and ")}`;
  const may =
    draft.capabilities.length === 0
      ? "has no tools"
      : `may use ${draft.capabilities.join(" and ")}`;
  const sends =
    draft.outbound === "ask"
      ? "asks before anything leaves this Mac"
      : "never sends anything";
  const thinks = draft.tier === "on-device" ? "uses the model on this Mac"
    : `requests the ${TIERS.find(tier => tier.id === draft.tier)?.says.toLowerCase() ?? "quickest"} tier (this page currently runs locally)`;
  return `${name} ${where}, ${may}, ${sends}, ${thinks}, and stops after ${draft.maxSteps} steps or ${draft.maxMinutes} minutes.`;
}

export function BriefEditor({
  draft,
  roots,
  saved,
  busy,
  onChange,
  onSave,
  onCancel
}: {
  readonly draft: DraftBrief;
  readonly roots: readonly string[];
  /** The card as the main process resolved it, after a save. */
  readonly saved: AgentCard | null;
  readonly busy: boolean;
  readonly onChange: (next: DraftBrief) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const folderNames = draft.folders.map((folder) => folder.split("/").filter(Boolean).pop() ?? folder);
  const ready = draft.name.trim().length > 0 && draft.id.length > 0;

  const set = (patch: Partial<DraftBrief>) => onChange({ ...draft, ...patch });

  return (
    <div className="be">
      <label className="be__field">
        <span className="be__label">What is it called?</span>
        <input
          className="input"
          value={draft.name}
          maxLength={60}
          placeholder="Chase payments"
          onChange={(event) => {
            onChange(renameDraft(draft, event.target.value));
          }}
        />
      </label>

      <label className="be__field">
        <span className="be__label">What is it for?</span>
        <input
          className="input"
          value={draft.purpose}
          maxLength={200}
          placeholder="Find who still owes and draft a reminder"
          onChange={(event) => set({ purpose: event.target.value })}
        />
      </label>

      <fieldset className="be__group">
        <legend className="be__label">Which folders may it work in?</legend>
        {roots.length === 0 ? (
          <p className="be__hint">
            No folders granted yet. Add one in Settings and it can be given to an agent.
          </p>
        ) : (
          roots.map((root) => (
            <label key={root} className="be__check">
              <input
                type="checkbox"
                checked={draft.folders.includes(root)}
                onChange={(event) =>
                  set({
                    folders: event.target.checked
                      ? [...draft.folders, root]
                      : draft.folders.filter((folder) => folder !== root)
                  })
                }
              />
              <span>{root.split("/").filter(Boolean).pop()}</span>
            </label>
          ))
        )}
      </fieldset>

      <fieldset className="be__group">
        <legend className="be__label">What may it do?</legend>
        {TOOLS.map((tool) => (
          <label key={tool.id} className="be__check">
            <input
              type="checkbox"
              checked={draft.capabilities.includes(tool.id)}
              onChange={(event) =>
                set({
                  capabilities: event.target.checked
                    ? [...draft.capabilities, tool.id]
                    : draft.capabilities.filter((id) => id !== tool.id)
                })
              }
            />
            {/* Named by what it does, with the tool's own name beside it — the
                sentence and the prompt both use the real name, so hiding it
                would make them unreadable to whoever wrote the brief. */}
            <span>
              {tool.says} <code className="be__tool">{tool.id}</code>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="be__group">
        <legend className="be__label">May it prepare something to send?</legend>
        <label className="be__check">
          <input
            type="radio"
            checked={draft.outbound === "never"}
            onChange={() => set({ outbound: "never" })}
          />
          <span>No — it only reads and answers</span>
        </label>
        <label className="be__check">
          <input
            type="radio"
            checked={draft.outbound === "ask"}
            onChange={() => set({ outbound: "ask" })}
          />
          <span>Yes, but you approve every message before it opens</span>
        </label>
      </fieldset>

      <div className="be__row">
        <label className="be__field be__field--narrow">
          <span className="be__label">Run on</span>
          <select
            className="select"
            value={draft.tier}
            onChange={(event) => set({ tier: event.target.value })}
          >
            {TIERS.map((tier) => (
              <option key={tier.id} value={tier.id} disabled={tier.id !== "on-device"}>
                {tier.id === "on-device" ? tier.says : `${tier.says} — saved preference; not available here`}
              </option>
            ))}
          </select>
        </label>
        <label className="be__field be__field--narrow">
          <span className="be__label">Stop after… steps</span>
          <input
            className="input"
            type="number"
            min={1}
            max={60}
            value={draft.maxSteps}
            onChange={(event) => set({ maxSteps: Number(event.target.value) })}
          />
        </label>
        <label className="be__field be__field--narrow">
          <span className="be__label">…or minutes</span>
          <input
            className="input"
            type="number"
            min={1}
            max={60}
            value={draft.maxMinutes}
            onChange={(event) => set({ maxMinutes: Number(event.target.value) })}
          />
        </label>
      </div>

      <label className="be__field">
        <span className="be__label">Anything it should always keep in mind?</span>
        <textarea
          className="input be__notes"
          rows={3}
          value={draft.instructions}
          maxLength={4_000}
          placeholder="Prefer the client's name over the date. Hindi and Hinglish are normal."
          onChange={(event) => set({ instructions: event.target.value })}
        />
      </label>

      {/* The whole point of the screen. A ticked box tells you what is on; this
          tells you what the agent will do, in the words the record will use. */}
      <p className="be__sentence">{sentenceFor(draft, folderNames)}</p>

      {saved === null || saved.withheld.length === 0 ? null : (
        <ul className="be__withheld">
          {saved.withheld.map((item) => (
            <li key={item.what}>
              <strong>{item.what}</strong> {item.why}
            </li>
          ))}
        </ul>
      )}

      <div className="be__actions">
        <Button tone="primary" disabled={!ready || busy} onClick={onSave}>
          {busy ? "Saving…" : "Save this agent"}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {ready ? null : <span className="be__hint">Give it a name first.</span>}
      </div>
    </div>
  );
}
