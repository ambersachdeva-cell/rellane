import { useState } from "react";
import { BILL_TEXT_LIMIT, type BillRead, type DesktopBridge } from "@cadrane/contracts";
import { rupees } from "../../main/book/money.js";
import { said } from "../../shared/copy.js";
import { useLocalShortcut } from "../hooks/useLocalShortcut.js";
import { Button } from "./ui";

interface Proposal { source: string; result: BillRead; method: string }
const fields = [
  ["partyName", "Customer"], ["number", "Bill number"], ["issuedOn", "Issued"], ["dueOn", "Due"],
  ["subtotalPaise", "Before tax"], ["taxPaise", "Tax amount"], ["totalPaise", "Stated total"]
] as const;

export function BillProposal({ proposal, applied, disabled = false, onApply }: {
  proposal: Proposal; applied: boolean; disabled?: boolean; onApply(): void;
}) {
  const bill = proposal.result.bill;
  if (!bill) return null;
  return <section className="bill-review" aria-label="Bill proposal">
    <header><p className="bill-reader__eyebrow">CHECK THE READING</p><h3>A proposal, ready to compare.</h3>
      <p>{proposal.method}</p><p>{proposal.result.said}</p></header>
    <div className="bill-review__comparison">
      <dl className="bill-review__fields">
        {fields.map(([key, label]) => {
          const field = bill[key];
          return <div className="bill-review__field" key={key}>
            <dt>{label}</dt><dd><strong>{field.value === null ? "Unknown" : typeof field.value === "number" ? rupees(field.value, { paise: true }) : field.value}</strong>
              {field.from !== null ? <blockquote>{field.from}</blockquote> : <span className="bill-review__unknown">No usable excerpt selected.</span>}
              {field.problem ? <p className="bform__warn">{field.problem}</p> : null}</dd>
          </div>;
        })}
      </dl>
      <div className="bill-review__source"><h4>Text used for this reading</h4><pre tabIndex={0}>{proposal.source}</pre>
        <p>Exact text membership is checked. Field meanings and completeness still need your review. Unknown does not mean absent.</p></div>
    </div>
    {proposal.result.disagreement ? <p className="bform__warn" role="status">{proposal.result.disagreement}</p> : null}
    <footer><p>Apply replaces the bill form below, including its customer and dates. Unknowns become empty fields. An unmatched customer stays unselected. Nothing is recorded by applying.</p>
      <Button tone="primary" disabled={disabled || applied || !Object.values(bill).some(f => f.value !== null)} onClick={onApply}>
        {applied ? "Applied to the bill form" : "Apply to the bill form"}
      </Button></footer>
  </section>;
}

export function BillReader({ api, initialText = "", disabled, onApply }: {
  api: DesktopBridge | undefined; initialText?: string; disabled: boolean;
  onApply(bill: NonNullable<BillRead["bill"]>): void;
}) {
  const [text, setText] = useState(initialText);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const request = useLocalShortcut();
  const read = async (file: boolean) => {
    if (!api || request.busy) return;
    setProposal(null); setMessage(null); setApplied(false);
    const source = text;
    try {
      if (file) {
        const result = await request.run(api, "bill-file", handle => api.book.readFile({ handle }));
        if (!result) { setMessage("Stopped. The bill form is unchanged."); return; }
        setMessage(result.bill?.said ?? result.said);
        if (result.text) setText(result.text);
        if (result.bill?.ok && result.bill.bill) setProposal({ source: result.text, result: result.bill, method: result.said });
      } else {
        const result = await request.run(api, "bill-text", handle => api.book.read({ handle, text: source }));
        if (!result) { setMessage("Stopped. The bill form is unchanged."); return; }
        setMessage(result.said);
        if (result.ok && result.bill) setProposal({ source, result, method: "Read from the text you pasted. Compare it with the original bill." });
      }
    } catch (error) { setMessage(said(error, "The bill could not be read. Your input and bill form are still here.")); }
  };
  return <section className="bill-reader" aria-label="Read a bill on this Mac">
    <header><p className="bill-reader__eyebrow">LESS TYPING. YOUR FINAL CHECK.</p><h2>Bring a bill. Check the details.</h2>
      <p>Paste its text or choose a PDF or photograph. The local model proposes fields for you to review before they enter the form.</p></header>
    <label className="bill-reader__input"><span>Bill text</span><textarea className="input bform__paste" rows={5}
      value={text} maxLength={BILL_TEXT_LIMIT} disabled={request.busy || disabled}
      placeholder="One bill, including the customer, dates and amounts as written."
      onChange={event => { setText(event.target.value); setProposal(null); setApplied(false); setMessage(null); }} /></label>
    <div className="bill-reader__actions">
      <Button tone="primary" disabled={!api || disabled || request.busy || !text.trim() || text.length > BILL_TEXT_LIMIT} onClick={() => void read(false)}>
        {request.busy ? "Reading on this Mac…" : "Read this bill"}</Button>
      {request.busy ? <Button disabled={request.phase === "stopping"} onClick={request.stop}>{request.phase === "stopping" ? "Stopping…" : "Stop reading"}</Button>
        : <Button disabled={!api || disabled} onClick={() => void read(true)}>Choose a PDF or photo</Button>}
      <span>{text.length.toLocaleString()} / 8,000 characters · Nothing uploaded</span>
    </div>
    {!api ? <p role="status">The local connection is not ready. You can enter the bill below.</p> : null}
    {text.length > BILL_TEXT_LIMIT ? <p className="bform__warn">This source is too long. Keep one bill of up to 8,000 characters, then read it.</p> : null}
    {message && !proposal ? <p className="bill-reader__message" role="status">{message}</p> : null}
    {proposal ? <BillProposal proposal={proposal} applied={applied} disabled={disabled} onApply={() => {
      if (!proposal.result.bill || disabled) return;
      onApply(proposal.result.bill); setApplied(true);
    }} /> : null}
  </section>;
}
