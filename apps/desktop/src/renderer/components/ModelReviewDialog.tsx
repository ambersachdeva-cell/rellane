import { useEffect, useRef, useState } from "react";
import type { ModelLicenseReview } from "@cadrane/contracts";
import { Button } from "./ui.js";
import { size } from "../../shared/copy.js";

export interface ModelReviewView {
  modelId: string;
  name: string;
  installable: boolean;
  blocked: string | null;
  review: ModelLicenseReview | null;
  error: string | null;
}

/** Read the exact notice first. Opening, Escape and Close never accept it. */
export function ModelReviewDialog({ state, onClose, onConfirm }: {
  state: ModelReviewView; onClose(): void; onConfirm(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [agreed, setAgreed] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement;
    dialog.showModal(); closeRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const review = state.review;
  return <dialog ref={dialogRef} className="model-review" aria-labelledby="model-review-title"
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header className="model-review__head">
      <div><p className="model-review__eyebrow">On this Mac</p>
        <h2 id="model-review-title">{review?.displayName ?? state.name}</h2></div>
      <Button tone="ghost" ref={closeRef} onClick={onClose} aria-label="Close model review">Close</Button>
    </header>
    <p className="model-review__intro">Check the source and terms before adding a model. Opening this review downloads nothing and accepts no terms.</p>
    {state.error ? <p className="model-review__problem" role="alert">{state.error}</p>
      : review === null ? <p role="status">Reading the signed model notice…</p> : <>
        <dl className="model-review__facts">
          <div><dt>Download size</dt><dd>{size(review.downloadBytes)}</dd></div>
          <div><dt>Source</dt><dd>{review.sourceHost}<span>{review.repository}</span></dd></div>
          <div><dt>Licence</dt><dd>{review.licenseName}</dd></div>
        </dl>
        {state.blocked ? <p className="model-review__problem">{state.blocked}</p> : null}
        <h3 className="model-review__notice-title" id="model-review-notice">Model licence notice</h3>
        <pre className="model-review__notice" aria-labelledby="model-review-notice" tabIndex={0}>{review.noticeText}</pre>
        <details className="model-review__verification">
          <summary>Verification details</summary>
          <dl><dt>Model SHA-256</dt><dd>{review.artifactSha256}</dd>
            <dt>Notice SHA-256</dt><dd>{review.licenseNoticeSha256}</dd>
            <dt>Notice version</dt><dd>{review.licenseNoticeVersion}</dd>
            <dt>Catalogue generation</dt><dd>{review.catalogGeneration}</dd></dl>
        </details>
        {state.installable ? <footer className="model-review__confirm">
          <label><input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} />
            I agree to the model licence terms above.</label>
          <p>This downloads model files. It does not send your work or start an AI request.</p>
          <Button tone="primary" disabled={!agreed} onClick={() => { if (agreed) onConfirm(); }}>Agree and download {size(review.downloadBytes)}</Button>
        </footer> : <p className="model-review__foot">This review changes no installation or licence acceptance.</p>}
      </>}
  </dialog>;
}
