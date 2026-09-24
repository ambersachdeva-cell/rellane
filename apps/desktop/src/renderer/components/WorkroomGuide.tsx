/** Explain a real workroom without asking for access, creating work or running a model. */
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui.js";
import { RellaneMark } from "./RellaneMark.js";

const STEPS = [
  {
    label: "Brief", tone: "coral", title: "Give one task a home.",
    body: "Start a workroom for a proposal, a reply, a question or a decision. Say what you need to finish. The brief, sources, answers and versions stay together.",
    action: "Write your task, then choose Start workroom. This saves the brief; it does not start an AI request.",
    exampleLabel: "A client proposal",
    example: "Turn these client notes into a proposal. Separate the agreed work from the questions we still need to ask.",
    note: "Start with text. You do not need to grant a folder or connect a subscription."
  },
  {
    label: "Sources", tone: "iris", title: "Give the answer something to stand on.",
    body: "Add notes or documents in Sources, then select the material for your request. In Conversation, choose an available local model and ask for help. You can stop a running request.",
    action: "A source is reference material. Adding it does not make it an instruction, a checked fact or permission to act.",
    exampleLabel: "A note you choose to include",
    example: "The client needs a product brochure. The budget and delivery date still need confirming.",
    note: "The local model runs on this Mac. No model available? Open Models to check what is installed."
  },
  {
    label: "Output", tone: "citron", title: "Leave with work you have checked.",
    body: "Use a useful answer as an output draft, or write your own. Edit it, save a version and accept the version you have checked. Export a local file when it is ready to use.",
    action: "An AI answer is not an accepted result. Your review and the saved version make that distinction visible.",
    exampleLabel: "A useful result",
    example: "Proposed work: a product brochure.\nOpen questions: budget, delivery date and artwork approval.",
    note: "Saving is not sending. Export writes the file you choose; it does not send it to your client."
  }
] as const;

function WorkroomGuidePage({ step }: { step: number }) {
  const page = STEPS[step] ?? STEPS[0];
  return <div className="workroom-guide__page" key={page.label}>
    <div className="workroom-guide__explanation">
      <p className="workroom-guide__eyebrow">{page.label}</p>
      <h3>{page.title}</h3>
      <p>{page.body}</p>
      <p className="workroom-guide__action">{page.action}</p>
    </div>
    <aside className={`workroom-guide__example workroom-guide__example--${page.tone}`} aria-label="Walkthrough example">
      <span className="workroom-guide__eyebrow">Example · {page.exampleLabel}</span>
      <blockquote>{page.example}</blockquote>
      <p>{page.note}</p>
    </aside>
  </div>;
}

export function WorkroomGuide({ onClose }: { onClose(): void }) {
  const [step, setStep] = useState(0);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement;
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return <dialog className="workroom-guide" ref={dialogRef} aria-labelledby="workroom-guide-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => event.stopPropagation()}>
    <header className="workroom-guide__head">
      <div><RellaneMark className="rellane-mark" /><h2 id="workroom-guide-title">Your first workroom</h2></div>
      <Button tone="ghost" ref={closeRef} onClick={onClose} aria-label="Close walkthrough">Close</Button>
    </header>
    <p className="workroom-guide__intro">One task. Chosen sources. A result you can review and use.</p>
    <nav className="workroom-guide__steps" aria-label="Workroom walkthrough steps">
      {STEPS.map((page, index) => <button type="button" key={page.label}
        className={step === index ? "is-current" : undefined} aria-current={step === index ? "step" : undefined}
        onClick={() => setStep(index)}><span aria-hidden="true">{index + 1}</span>{page.label}</button>)}
    </nav>
    <div aria-live="polite" aria-atomic="true"><WorkroomGuidePage step={step} /></div>
    <div className="workroom-guide__agents"><strong>And agents?</strong> They are reusable briefs for jobs you repeat. Each run is kept in Workrooms so you can inspect the result.</div>
    <footer className="workroom-guide__foot">
      <span>{step + 1} of {STEPS.length} · This walkthrough runs no AI and creates no records.</span>
      <div>{step > 0 ? <Button onClick={() => setStep(current => current - 1)}>Back</Button> : null}
        {step < STEPS.length - 1 ? <Button tone="primary" onClick={() => setStep(current => current + 1)}>Next: {STEPS[step + 1]!.label}</Button>
          : <Button tone="primary" onClick={onClose}>Back to my work</Button>}</div>
    </footer>
  </dialog>;
}
