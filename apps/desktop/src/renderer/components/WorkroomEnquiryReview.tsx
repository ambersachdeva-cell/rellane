/** Human review makes an extracted enquiry usable; missing model output stays visible. */
import { useEffect, useRef, useState } from "react";
import {
  ENQUIRY_FIELDS, ENQUIRY_PROPOSAL_SEAT, ENQUIRY_REVIEW_SEAT, EnquiryProposalSchema, EnquiryReviewSnapshotSchema,
  type CaseRoom, type EnquiryProposal, type EnquiryFieldId, type EnquirySuggestion
} from "@cadrane/contracts";
import { workroomMessage } from "../workroom-message.js";
import type { PreparedDataRequest } from "./WorkroomDataReview.js";

function readProposal(body: string): EnquiryProposal | null {
  try {
    const result = EnquiryProposalSchema.safeParse(JSON.parse(body));
    return result.success ? result.data : null;
  } catch { return null; }
}
function savedReview(room: CaseRoom, proposalId: string, proposal: EnquiryProposal) {
  for (const turn of [...room.turns].reverse()) {
    if (turn.seat !== ENQUIRY_REVIEW_SEAT || turn.kind !== "verbatim") continue;
    try {
      const parsed = EnquiryReviewSnapshotSchema.safeParse(JSON.parse(turn.body));
      if (!parsed.success || parsed.data.proposalId !== proposalId ||
          parsed.data.sourceId !== proposal.sourceTurnId || parsed.data.sourceSha256 !== proposal.sourceSha256) continue;
      const fields = { ...proposal.suggestion.fields };
      const notNeeded: EnquiryFieldId[] = [];
      for (const field of parsed.data.fields) {
        fields[field.field] = field.quote;
        if (field.state === "not_needed_by_reviewer") notNeeded.push(field.field);
      }
      return { sourceId: turn.id, fields, notNeeded };
    } catch { continue; }
  }
  return null;
}
export function WorkroomEnquiryReview({ room, onUpdate, onPrepared, onReveal, localRunning, onDirty }: {
  readonly room: CaseRoom;
  readonly onUpdate: (room: CaseRoom) => void;
  readonly onPrepared: (request: PreparedDataRequest) => void;
  readonly onReveal: () => void;
  readonly localRunning: boolean;
  readonly onDirty: (dirty: boolean) => void;
}) {
  const proposals = room.turns.filter(turn => turn.kind === "finding" && turn.seat === ENQUIRY_PROPOSAL_SEAT);
  const latestId = proposals.at(-1)?.id ?? "";
  const [chosen, setChosen] = useState(latestId);
  const [dirty, setDirty] = useState(false);
  const lastLatest = useRef(latestId);
  useEffect(() => {
    if (latestId === lastLatest.current) return;
    lastLatest.current = latestId;
    if (!dirty) setChosen(latestId);
  }, [latestId, dirty]);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const selected = proposals.find(turn => turn.id === chosen) ?? proposals.at(-1);
  const proposal = selected ? readProposal(selected.body) : null;
  if (!selected) return null;
  return <section className="enquiry-review" aria-labelledby="enquiry-heading">
    <header className="enquiry-review__head"><div><span className="eyebrow">PRINT ENQUIRY</span>
      <h3 id="enquiry-heading">Turn the message into a clear brief</h3></div>
      <span className="enquiry-review__badge">{dirty ? "Unsaved changes" :
        proposal && savedReview(room, selected.id, proposal) ? "Reviewed by you" : "Review required"}</span>
    </header>
    <p>Check what was asked, keep every option, and find what still needs confirming. This does not create a quote or send a reply.</p>
    {proposals.length > 1 && <label>Suggestion to review
      <select className="input" disabled={dirty || localRunning} value={selected.id}
        onChange={event => setChosen(event.target.value)}>
        {proposals.map(turn => <option key={turn.id} value={turn.id}>Suggestion · {turn.seq}</option>)}
      </select></label>}
    {proposal ? <ReviewForm key={selected.id} room={room} proposal={proposal} proposalId={selected.id}
      localRunning={localRunning} onUpdate={onUpdate} onPrepared={onPrepared} onReveal={onReveal}
      onDirty={setDirty} /> :
      <p role="alert">This saved suggestion could not be read. The original source remains available below.</p>}
  </section>;
}

function ReviewForm({ room, proposal, proposalId, onUpdate, onPrepared, onReveal, localRunning, onDirty }: {
  readonly room: CaseRoom; readonly proposal: EnquiryProposal; readonly proposalId: string;
  readonly onUpdate: (room: CaseRoom) => void; readonly onPrepared: (request: PreparedDataRequest) => void;
  readonly onReveal: () => void; readonly localRunning: boolean; readonly onDirty: (value: boolean) => void;
}) {
  const source = room.turns.find(turn => turn.id === proposal.sourceTurnId);
  const saved = savedReview(room, proposalId, proposal);
  const [fields, setFields] = useState<EnquirySuggestion["fields"]>(saved?.fields ?? proposal.suggestion.fields);
  const [notNeeded, setNotNeeded] = useState<EnquiryFieldId[]>(saved?.notNeeded ?? []);
  const [confirmed, setConfirmed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [savedId, setSavedId] = useState<string | null>(saved?.sourceId ?? null);
  const closed = room.case?.closedAt !== null;
  const supported = proposal.suggestion.scope === "one_job";
  const disabled = closed || busy || localRunning;
  const invalid = ENQUIRY_FIELDS.filter(field => fields[field.id] !== null &&
    (!fields[field.id]!.trim() || !source?.body.includes(fields[field.id]!)));
  const missing = ENQUIRY_FIELDS.filter(field => fields[field.id] === null && !notNeeded.includes(field.id));
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: Event) => {
      event.preventDefault();
      onReveal();
      setMessage("Save the reviewed brief or discard your changes before leaving this workroom.");
    };
    window.addEventListener("rellane:before-navigation", protect);
    return () => window.removeEventListener("rellane:before-navigation", protect);
  }, [dirty, onReveal]);
  function changed() {
    setDirty(true); setConfirmed(false); setSavedId(null); setMessage("");
  }
  async function save() {
    if (disabled || !confirmed || !source || !supported || invalid.length || fields.item === null) return;
    setBusy(true); setMessage("");
    try {
      const result = await window.cadrane.cases.saveEnquiryReview({
        id: room.case!.id, proposalTurnId: proposalId, operationId: crypto.randomUUID(),
        fields, notNeeded, reviewedSource: true, oneJob: true
      });
      setDirty(false); setSavedId(result.sourceTurnId); setConfirmed(false);
      onUpdate(result.room);
      setMessage("Reviewed brief saved as a source. No reply was sent.");
    } catch (error) {
      setMessage(workroomMessage(error, "The enquiry review could not be saved."));
    } finally { setBusy(false); }
  }
  return <>
    <div className="enquiry-review__source">
      <span className="eyebrow">ORIGINAL MESSAGE · SOURCE {source?.seq ?? "MISSING"}</span>
      <p>{source?.body ?? "The original source is no longer available."}</p>
    </div>
    {!supported && <p className="data-review__warning">The model could not identify one print job here.
      Add a separate source for each product, then prepare that enquiry. Quantity options for the same product can stay together.</p>}
    {supported && source && <>
      {savedId && <p className="enquiry-review__saved">Your saved review is shown, including corrections and not-needed choices.</p>}
      <p className="muted">These are suggestions, including possible omissions. Correct a field by copying an exact excerpt from the message.
        Blank means unknown. “Not needed” is your decision, never the model’s.</p>
      <fieldset disabled={disabled} className="enquiry-review__fields">
        <legend className="sr-only">Review suggested enquiry fields</legend>
        {ENQUIRY_FIELDS.map(field => <div className="enquiry-review__field" key={field.id}>
          <label htmlFor={"enquiry-" + field.id}>{field.label}
            <span>{notNeeded.includes(field.id) ? "Not needed · your choice" : fields[field.id] === null ? "Unknown · check the message" : "Source excerpt · check its meaning"}</span>
          </label>
          <textarea id={"enquiry-" + field.id} className="textarea" rows={2} maxLength={400}
            value={fields[field.id] ?? ""} disabled={disabled || notNeeded.includes(field.id)}
            placeholder="No value extracted — copy source words if it was missed"
            aria-invalid={invalid.some(one => one.id === field.id)}
            onChange={event => { changed(); setFields(current => ({ ...current, [field.id]: event.target.value || null })); }} />
          {invalid.some(one => one.id === field.id) && <p className="error">Use exact source words, including any “no” or “not”.</p>}
          <label className="enquiry-review__choice">
            <input type="checkbox" checked={notNeeded.includes(field.id)} disabled={disabled || fields[field.id] !== null}
              onChange={event => { changed(); setNotNeeded(current => event.target.checked ? [...current, field.id] : current.filter(key => key !== field.id)); }} />
            Not needed for this job
          </label>
        </div>)}
      </fieldset>
      <details className="enquiry-review__questions"><summary>{missing.length} suggested clarification{missing.length === 1 ? "" : "s"}</summary>
        <p className="muted">Only unresolved fields generate these prompts. Check the full message for relative dates, unfinished artwork and partial addresses even when a field has text.</p>
        <ul>{missing.map(field => <li key={field.id}>{field.question}</li>)}</ul>
      </details>
      {!closed && <div className="enquiry-review__finish">
        {fields.item === null && <p className="data-review__warning">Copy the printed item from the message before saving the brief.</p>}
        <label className="enquiry-review__choice"><input type="checkbox" checked={confirmed} disabled={disabled || Boolean(savedId)}
          onChange={event => { setConfirmed(event.target.checked); setDirty(true); setMessage(""); }} />
          I checked the full message, every quantity option and negation. This is one print job; unknowns still need follow-up.</label>
        <div className="enquiry-review__actions">
          <button className="btn btn--primary" type="button" disabled={disabled || !confirmed || invalid.length > 0 || Boolean(savedId) || fields.item === null}
            onClick={() => void save()}>{busy ? "Saving review…" : "Save reviewed brief"}</button>
          {dirty && <button className="link" type="button" disabled={disabled} onClick={() => {
            setFields(saved?.fields ?? proposal.suggestion.fields); setNotNeeded(saved?.notNeeded ?? []);
            setConfirmed(false); setDirty(false); setSavedId(saved?.sourceId ?? null);
            setMessage(saved ? "Changes discarded. Your saved review is restored." : "Changes discarded. The original model suggestions are shown.");
          }}>Discard review changes</button>}
        </div>
        {savedId && <button className="btn" type="button" disabled={localRunning}
          onClick={() => onPrepared({ sourceTurnId: savedId,
            question: "Draft a short customer reply using this reviewed print enquiry. Preserve quantity options, changes and negations. Ask only the useful unresolved questions. Do not invent prices, tax, exact dates, capacity, artwork approval or order acceptance. Match the customer's language. This is a draft for my review; send nothing." })}>
          Draft a reply from this brief →</button>}
      </div>}
    </>}
    {message && <p role="status">{message}</p>}
  </>;
}
