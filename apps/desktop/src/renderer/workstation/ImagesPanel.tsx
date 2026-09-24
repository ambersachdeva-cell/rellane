/** Visual work has a place beside the conversation, with clear originals and an explicit way out. */
import { useEffect, useState } from "react";
import type { WorkstationBridge, WorkstationImageAsset } from "@cadrane/contracts";
import { Icon, Modal } from "./ui.js";

type ImageBridge = Pick<WorkstationBridge, "images" | "importImage" | "previewImage" | "exportImage">;
const bytes = (value: number) => value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const problem = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "") : "The image could not be opened. Try again.";

function SavedImage({ asset, bridge, detail = false }: { asset: WorkstationImageAsset; bridge: ImageBridge; detail?: boolean }) {
  const [data, setData] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    setData(""); setError("");
    void bridge.previewImage({ caseId: asset.caseId, id: asset.id, size: detail ? "detail" : "thumbnail" })
      .then(value => { if (!disposed) setData(value.dataUrl); })
      .catch(reason => { if (!disposed) setError(problem(reason)); });
    return () => { disposed = true; };
  }, [asset.id, asset.caseId, bridge, detail]);
  return data ? <img src={data} alt={asset.title} draggable={false} /> : <span className="ws-image-placeholder" role={error ? "alert" : "status"}><Icon name="image" size={24} /><span>{error || "Opening preview…"}</span></span>;
}

export function ImagesPanel({ caseId, title, bridge, readOnly, onCreate, onClose }: {
  caseId: string; title: string; bridge: ImageBridge; readOnly: boolean; onCreate: () => void; onClose: () => void;
}) {
  const [images, setImages] = useState<readonly WorkstationImageAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [compared, setCompared] = useState<readonly string[]>([]);
  const [zoom, setZoom] = useState(false);
  const selectedImage = images.find(value => value.id === selected);
  const comparison = images.filter(value => compared.includes(value.id));
  useEffect(() => {
    let disposed = false;
    void bridge.images({ caseId }).then(value => { if (!disposed) setImages(value); })
      .catch(error => { if (!disposed) setNotice(problem(error)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [caseId, bridge]);
  async function add() {
    if (busy || readOnly) return;
    setBusy(true); setNotice("");
    try {
      const image = await bridge.importImage({ caseId });
      if (image) {
        const alreadySaved = images.some(value => value.id === image.id);
        setImages(await bridge.images({ caseId })); setSelected(image.id); setCompare(false); setZoom(false);
        setNotice(alreadySaved ? "This exact image is already saved here. Opened its original." : "Original saved with this work. It stays on this Mac.");
      }
    } catch (error) { setNotice(problem(error)); }
    finally { setBusy(false); }
  }
  async function exportImage(image: WorkstationImageAsset) {
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      const result = await bridge.exportImage({ caseId, id: image.id });
      if (result.written) setNotice(`Exported ${result.fileName}. Original bytes preserved.`);
    } catch (error) { setNotice(problem(error)); }
    finally { setBusy(false); }
  }
  function choose(id: string) {
    if (compare) setCompared(previous => previous.includes(id) ? previous.filter(value => value !== id) : previous.length < 2 ? [...previous, id] : [previous[1]!, id]);
    else { setSelected(id); setZoom(false); }
  }
  return <Modal title="A place for the visual work" eyebrow="Images" wide onClose={() => { if (!busy) onClose(); }}>
    <div className="ws-image-workspace">
      <div className="ws-image-toolbar"><p>{title}<span>Keep images from your creative tools, compare directions, and export the originals.</span></p><button className="ws-button" disabled={busy || readOnly} onClick={onCreate}><Icon name="spark" size={16} />Make an image</button><button className="ws-button ws-button--primary" disabled={busy || readOnly || images.length >= 64} onClick={() => void add()}><Icon name="plus" size={16} />{busy ? "Working…" : "Add image"}</button></div>
      {notice ? <p className="ws-image-notice" role="status">{notice}</p> : null}
      {loading ? <p className="ws-empty-message" role="status">Finding your saved images…</p> : images.length === 0 ? <div className="ws-image-empty"><div className="ws-image-paper-stack" aria-hidden="true"><span /><span /><span><Icon name="image" size={42} /></span></div><h3>Keep the direction. Keep the original.</h3><p>Made something in Gemini, ChatGPT, or another creative tool? Save the image there, then bring it into this work.</p><div className="ws-image-steps"><span><b>1</b> Make it in your tool</span><span><b>2</b> Add it here</span><span><b>3</b> Compare and export</span></div></div> : <>
        <div className="ws-image-view-controls"><span>{images.length} {images.length === 1 ? "image" : "images"} · saved locally</span><button className={`ws-button ws-button--small ${compare ? "is-active" : ""}`} aria-pressed={compare} disabled={images.length < 2} onClick={() => { setCompare(value => !value); setSelected(null); setCompared([]); }}><Icon name="compare" size={15} />{compare ? "Done comparing" : "Compare two"}</button></div>
        <div className="ws-image-contact-sheet" aria-label="Saved images">{images.map(asset => <button key={asset.id} className={`ws-image-tile ${selected === asset.id || compared.includes(asset.id) ? "is-selected" : ""}`} onClick={() => choose(asset.id)} aria-pressed={compare ? compared.includes(asset.id) : selected === asset.id}><span className="ws-image-tile-art"><SavedImage asset={asset} bridge={bridge} />{compare ? <span className="ws-image-selection">{compared.includes(asset.id) ? <Icon name="check" size={14} /> : null}</span> : null}</span><strong>{asset.title}</strong><span>{asset.width.toLocaleString()} × {asset.height.toLocaleString()} · {bytes(asset.byteLength)}</span></button>)}</div>
        {compare ? <div className="ws-image-comparison"><p>{comparison.length < 2 ? "Choose two images above to see them together." : "Two directions, side by side. Originals stay unchanged."}</p>{comparison.length ? <div>{comparison.map(asset => <figure key={asset.id}><div className="ws-image-stage"><SavedImage asset={asset} bridge={bridge} detail /></div><figcaption>{asset.title}<button className="ws-button ws-button--small" disabled={busy} onClick={() => void exportImage(asset)}>Export original</button></figcaption></figure>)}</div> : null}</div> : selectedImage ? <section className="ws-image-inspector" aria-label="Image detail"><div className="ws-image-detail-heading"><div><h3>{selectedImage.title}</h3><p>{selectedImage.fileName} · {selectedImage.mime === "image/png" ? "PNG" : "JPEG"} · imported original</p></div><button className="ws-button ws-button--small" aria-pressed={zoom} onClick={() => setZoom(value => !value)}><Icon name="search" size={14} />{zoom ? "Fit preview" : "Zoom preview"}</button><button className="ws-button ws-button--small" disabled={busy} onClick={() => void exportImage(selectedImage)}><Icon name="export" size={14} />Export original</button></div><div className={`ws-image-stage ${zoom ? "is-zoomed" : ""}`}><SavedImage asset={selectedImage} bridge={bridge} detail /></div><details className="ws-image-integrity"><summary>Original file details</summary><dl><dt>Saved</dt><dd>{new Date(selectedImage.createdAt).toLocaleString()}</dd><dt>Original size</dt><dd>{selectedImage.width.toLocaleString()} × {selectedImage.height.toLocaleString()} pixels · {selectedImage.byteLength.toLocaleString()} bytes</dd><dt>SHA-256</dt><dd><code>{selectedImage.sha256}</code></dd></dl><p>Previews are resized for this window. Export keeps every original byte, including embedded metadata.</p></details></section> : null}
      </>}
      <footer className="ws-image-footer"><Icon name="shield" size={14} /><span>PNG or JPEG · up to 8 MB and 4,096 px per side. Images here are not included in model requests.</span></footer>
    </div>
  </Modal>;
}
