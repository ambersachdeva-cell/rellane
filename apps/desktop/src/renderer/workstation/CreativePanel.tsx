/** The brief stays here; the person operates the creative product in their browser. */
import { useEffect, useState } from "react";
import type { CreativeHandoff, CreativeProductId, WorkstationBridge, WorkstationImageAsset } from "@cadrane/contracts";
import { Icon, Modal } from "./ui.js";
import { readCreativeDraft, writeCreativeDraft } from "./creative-drafts.js";

const PRODUCTS: readonly { id: CreativeProductId; name: string; domain: string; description: string }[] = [
  { id: "gemini", name: "Gemini", domain: "gemini.google.com", description: "Create images in your Google account." },
  { id: "chatgpt", name: "ChatGPT", domain: "chatgpt.com", description: "Continue in ChatGPT’s image workspace." },
  { id: "ai-studio", name: "Google AI Studio", domain: "aistudio.google.com", description: "Use the image tools available to your account." }
];
const problem = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "") : "This step could not finish. Try again.";

export function CreativePanel({ caseId, title, seed, sources, selected, bridge, readOnly, onImages, onClose }: {
  caseId: string; title: string; seed: string;
  sources: readonly { id: string; label: string; text: string }[];
  selected: readonly string[]; bridge: WorkstationBridge; readOnly: boolean;
  onImages: () => void; onClose: () => void;
}) {
  const [initial] = useState(() => {
    try { return { draft: readCreativeDraft(localStorage, caseId), problem: "" }; }
    catch { return { draft: null, problem: "Your image draft could not be read. Keep a copy before closing." }; }
  });
  const [prompt, setPrompt] = useState(initial.draft?.prompt ?? seed);
  const [productId, setProductId] = useState<CreativeProductId>(initial.draft?.productId ?? "gemini");
  const [sourceIds, setSourceIds] = useState<readonly string[]>(initial.draft?.sourceIds ?? selected);
  const [briefs, setBriefs] = useState<readonly CreativeHandoff[]>([]);
  const [images, setImages] = useState<readonly WorkstationImageAsset[]>([]);
  const [review, setReview] = useState<CreativeHandoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(initial.problem);
  const [draftSaved, setDraftSaved] = useState(!initial.problem);
  const [imageId, setImageId] = useState("");
  const product = PRODUCTS.find(value => value.id === (review?.productId ?? productId))!;

  useEffect(() => {
    let disposed = false;
    void Promise.all([bridge.creativeBriefs({ caseId }), bridge.images({ caseId })])
      .then(([saved, assets]) => { if (!disposed) { setBriefs(saved); setImages(assets); } })
      .catch(error => { if (!disposed) setNotice(problem(error)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [caseId, bridge]);
  useEffect(() => {
    try { writeCreativeDraft(localStorage, { caseId, productId, prompt, sourceIds: [...sourceIds] }); setDraftSaved(true); }
    catch { setDraftSaved(false); }
  }, [caseId, productId, prompt, sourceIds]);

  async function step(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setNotice("");
    try { await work(); } catch (error) { setNotice(problem(error)); }
    finally { setBusy(false); }
  }
  async function save() {
    if (readOnly) return;
    await step(async () => {
      const value = await bridge.saveCreativeBrief({ caseId, productId, prompt, sourceIds: [...sourceIds] });
      setReview(value); setImageId(""); setBriefs(await bridge.creativeBriefs({ caseId }));
    });
  }
  async function link(savedId?: string) {
    if (!review || readOnly) return;
    await step(async () => {
      const asset = savedId ? images.find(value => value.id === savedId) : await bridge.importImage({ caseId });
      if (!asset) return;
      setImageId(asset.id);
      // Import succeeds independently. If association fails, the original is still available.
      setImages(await bridge.images({ caseId }));
      const updated = await bridge.linkCreativeImage({ caseId, id: review.id, imageId: asset.id });
      setReview(updated); setBriefs(await bridge.creativeBriefs({ caseId }));
      setNotice("Image attached to this saved brief. The original is ready to compare or export.");
    });
  }
  return <Modal title={review ? "Your brief, ready to travel" : "Make something worth keeping"} eyebrow="Creative workspace" wide onClose={() => { if (!busy) onClose(); }}>
    <div className="ws-creative">
      <p className="ws-creative-project"><Icon name="folder" size={14} />{title}</p>
      <div className="ws-creative-path" aria-label="Image workflow"><span className="is-current"><b>1</b>Shape the brief</span><i /><span className={review?.openedAt ? "is-current" : ""}><b>2</b>Create in your tool</span><i /><span className={review?.imageId ? "is-current" : ""}><b>3</b>Bring it home</span></div>
      {notice ? <p className="ws-image-notice" role="status">{notice}</p> : null}
      {!draftSaved ? <p className="ws-inline-problem" role="alert">This draft could not be saved on this Mac. Copy it before closing.</p> : null}
      {review ? <>
        <div className="ws-creative-destination"><span className="ws-creative-symbol"><Icon name="image" size={24} /></span><div><h3>{product.name}</h3><p>{product.domain} · choose your account in the browser</p></div><button className="ws-button ws-button--small" disabled={busy || readOnly} onClick={() => { setPrompt(review.prompt); setProductId(review.productId); setSourceIds(review.sourceIds); setReview(null); }}>Revise brief</button></div>
        <p className="ws-modal-description">Read what you’re taking with you. Copy the brief, open {product.name}, then paste and send it there when you’re ready.</p>
        <label className="ws-creative-packet-label">Exact brief · {review.sourceIds.length} selected {review.sourceIds.length === 1 ? "source" : "sources"}<textarea className="ws-creative-packet" aria-label="Exact image brief" value={review.packet} readOnly rows={9} /></label>
        <div className="ws-creative-actions"><button className="ws-button" disabled={busy} onClick={() => void step(async () => { await bridge.copyCreativeBrief({ caseId, id: review.id }); setNotice("Exact brief copied. Paste it in your chosen product when you’re ready."); })}><Icon name="copy" size={15} />Copy brief</button><button className="ws-button ws-button--primary" disabled={busy || readOnly} onClick={() => void step(async () => { const updated = await bridge.openCreativeProduct({ caseId, id: review.id }); setReview(updated); setBriefs(await bridge.creativeBriefs({ caseId })); setNotice(`${product.name} opened. Choose the right account, paste your brief, and create the image there.`); })}>Open {product.name}<Icon name="arrow" size={15} /></button></div>
        <p className="ws-creative-boundary">Opening the website sends no brief or files. Product features and usage limits depend on the account you choose.</p>
        <section className="ws-creative-return"><div><p className="ws-eyebrow">Back to this work</p><h3>{review.imageId ? "The image is home." : "Keep the image with its direction."}</h3><p>{review.imageId ? "Your original and exact brief are saved together. Compare directions or export the file when you need it." : `Save your finished PNG or JPEG from ${product.name}, then add it here. The exact brief stays beside it.`}</p></div>{review.imageId ? <button className="ws-button ws-button--primary" onClick={onImages} disabled={busy}><Icon name="image" size={15} />View saved images</button> : <button className="ws-button" disabled={busy || readOnly} onClick={() => void link()}><Icon name="plus" size={15} />Add the saved image</button>}</section>
        {!review.imageId && images.length ? <div className="ws-creative-existing"><label>Or use an image already in this work<select value={imageId} onChange={event => setImageId(event.target.value)} disabled={busy || readOnly}><option value="">Choose an original</option>{images.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</select></label><button className="ws-button ws-button--small" disabled={!imageId || busy || readOnly} onClick={() => void link(imageId)}>Attach to brief</button></div> : null}
        <details className="ws-creative-details"><summary>Saved brief details</summary><p>Saved {new Date(review.createdAt).toLocaleString()}{review.openedAt ? ` · website last opened ${new Date(review.openedAt).toLocaleString()}` : " · website not opened from this brief"}</p><code>{review.sha256}</code><p>This records your saved direction and chosen original. Rellane does not control or observe generation in the website.</p></details>
        <button className="ws-creative-back" disabled={busy} onClick={() => setReview(null)}><Icon name="back" size={14} />Back to briefs</button>
      </> : <>
        <p className="ws-modal-description">Use your favourite image product without losing the brief, references or result.</p>
        <div className="ws-creative-products" aria-label="Creative product">{PRODUCTS.map(value => <button key={value.id} aria-pressed={productId === value.id} disabled={busy || readOnly} className={productId === value.id ? "is-selected" : ""} onClick={() => setProductId(value.id)}><strong>{value.name}{productId === value.id ? <Icon name="check" size={15} /> : null}</strong><span>{value.description}</span></button>)}</div>
        <label className="ws-creative-prompt">What should the image feel like?<textarea value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={8000} rows={5} disabled={busy || readOnly} placeholder="A sunlit paper study for Studio North. Forest green ink, soft shadows, generous empty space. No text or logos. Landscape, 3:2." /></label>
        <details className="ws-creative-sources"><summary>{sourceIds.length} sources selected · choose what travels</summary>{sources.length ? sources.map(value => <label key={value.id}><input type="checkbox" checked={sourceIds.includes(value.id)} disabled={busy || readOnly || (!sourceIds.includes(value.id) && sourceIds.length >= 20)} onChange={() => setSourceIds(ids => ids.includes(value.id) ? ids.filter(id => id !== value.id) : [...ids, value.id])} /><span><strong>{value.label}</strong><span>{value.text.slice(0, 150)}</span></span></label>) : <p>Add reference text to the conversation first if you want it in this brief. Images are added separately in your creative product.</p>}</details>
        <div className="ws-creative-actions"><span>{draftSaved ? "Draft saved on this Mac" : "Draft not saved"}</span><button className="ws-button ws-button--primary" disabled={busy || readOnly || !prompt.trim() || loading} onClick={() => void save()}>{busy ? "Saving…" : "Save and review brief"}<Icon name="arrow" size={15} /></button></div>
        {briefs.length ? <section className="ws-creative-history"><h3>Saved directions</h3>{briefs.map(value => <button key={value.id} disabled={busy} onClick={() => { setReview(value); setImageId(""); }}><Icon name={value.imageId ? "image" : "file"} size={18} /><span><strong>{value.prompt.split("\n")[0]?.slice(0, 110)}</strong><span>{PRODUCTS.find(p => p.id === value.productId)?.name} · {new Date(value.createdAt).toLocaleDateString()} · {value.imageId ? "Image attached" : value.openedAt ? "Website opened" : "Brief saved"}</span></span><Icon name="chevron" size={14} /></button>)}</section> : null}
      </>}
    </div>
  </Modal>;
}
