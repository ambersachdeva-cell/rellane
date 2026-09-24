/** Small, predictable controls keep attention on the work instead of the interface. */
import { useEffect, useId, useRef, type ReactNode } from "react";

export type IconName = "image" | "compare" | "plus" | "search" | "chat" | "grid" | "file" | "folder" | "arrow" | "chevron" | "close" | "check" | "stop" | "copy" | "edit" | "export" | "clock" | "settings" | "sun" | "moon" | "help" | "panel" | "paperclip" | "code" | "spark" | "shield" | "more" | "refresh" | "back" | "minus" | "device";
const paths: Record<IconName, ReactNode> = {
  image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-7 5 8" /></>,
  compare: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 2v20m-5-9 2-2-2-2m10 0-2 2 2 2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  device: <><rect x="6" y="2" width="12" height="20" rx="3" /><circle cx="12" cy="18" r="1" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  chat: <path d="M20 11.5a8 8 0 0 1-8 8H4l1.5-4a8 8 0 1 1 14.5-4Z" />,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></>,
  file: <><path d="M13 3H6a1 1 0 0 0-1 1v16h14V9Z" /><path d="M13 3v6h6M8 13h8M8 16h5" /></>,
  folder: <path d="M3 7V5h6l2 2h10v12H3V7Z" />,
  arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  edit: <><path d="m14 5 5 5M4 20l1-6L16 3l5 5-11 11-6 1Z" /></>,
  export: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2.5" /><circle cx="15" cy="17" r="2.5" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" /></>,
  moon: <path d="M20 14a8 8 0 0 1-10-10A8.5 8.5 0 1 0 20 14Z" />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9 9a3 3 0 1 1 5 2c-1 .6-2 1-2 3M12 17h.01" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  paperclip: <path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9" />,
  code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" />,
  spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />,
  shield: <><path d="m12 3 8 3v5c0 5-8 10-8 10S4 16 4 11V6l8-3Z" /><path d="m8 11 3 3 5-6" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6" /></>,
  back: <path d="M20 12H4m6-6-6 6 6 6" />,
};
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function IconButton({ icon, label, onClick, disabled = false, className = "" }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; className?: string }) {
  return <button type="button" className={`ws-icon-button ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}><Icon name={icon} /></button>;
}
export function Modal({ title, children, onClose, wide = false, eyebrow }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; eyebrow?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    // React's autofocus happens before showModal; opening the native dialog
    // then moves focus to Close. Search should be ready for typing immediately.
    dialog?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className={`ws-modal ${wide ? "ws-modal--wide" : ""}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="ws-modal-panel">
      <header className="ws-modal-heading"><div>{eyebrow ? <p className="ws-eyebrow">{eyebrow}</p> : null}<h2 id={titleId}>{title}</h2></div><IconButton icon="close" label="Close dialog" onClick={onClose} /></header>
      {children}
    </div>
  </dialog>;
}
export function ProviderGlyph({ family, small = false, badge }: { family: string; small?: boolean; badge?: string | number | undefined }) {
  return (
    <span className={`ws-provider-glyph ws-provider-glyph--${family} ${small ? "ws-provider-glyph--small" : ""}`} aria-hidden="true" style={{ position: "relative" }}>
      {family === "gemini" ? <Icon name="spark" size={small ? 12 : 18} /> : family === "claude" ? <span>✳</span> : family === "local" ? <Icon name="shield" size={small ? 12 : 17} /> : <Icon name="code" size={small ? 12 : 18} />}
      {badge ? <span className="ws-glyph-badge">{badge}</span> : null}
    </span>
  );
}
