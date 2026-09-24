/**
 * Primitives. Every one is a thin wrapper over a class in app.css — no inline
 * style objects, no literal colours, so the design system stays the one place
 * appearance is decided.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { forwardRef, useEffect } from "react";

type Tone = "default" | "primary" | "danger" | "whatsapp" | "ghost";

/** Forwards its ref so a dialog can put focus on the safe choice. */
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }
>(function Button({ tone = "default", className, ...rest }, ref) {
  const toneClass = tone === "default" ? "" : ` btn--${tone}`;
  return (
    <button
      ref={ref}
      type="button"
      className={`btn${toneClass}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
});

export function Chip({
  tone = "muted",
  children
}: {
  tone?: "ok" | "warn" | "bad" | "info" | "muted";
  children: ReactNode;
}) {
  return <span className={`chip chip--${tone}`}>{children}</span>;
}

export function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint === undefined ? null : <span className="field__hint">{hint}</span>}
    </label>
  );
}

export function Toggle({
  name,
  why,
  checked,
  disabled,
  onChange
}: {
  name: string;
  why: string;
  checked: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <div className="toggle">
      <span className="toggle__text">
        <span className="toggle__name">{name}</span>
        <span className="toggle__why">{why}</span>
      </span>
      <input
        type="checkbox"
        className="switch"
        checked={checked}
        disabled={disabled}
        aria-label={name}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </div>
  );
}

export function Notice({
  tone = "info",
  children
}: {
  tone?: "ok" | "warn" | "bad" | "info";
  children: ReactNode;
}) {
  return <div className={`notice notice--${tone}`} role={tone === "bad" ? "alert" : undefined}>{children}</div>;
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty__title">{title}</span>
      <p className="empty__body">{body}</p>
      {action}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h3 className="section__title">{title}</h3>
      {children}
    </section>
  );
}

export function Tile({
  label,
  value,
  note,
  alert = false
}: {
  label: string;
  value: string;
  note?: string;
  alert?: boolean;
}) {
  return (
    <div className={`tile${alert ? " tile--alert" : ""}`}>
      <span className="tile__label">{label}</span>
      <span className="tile__value">{value}</span>
      {note === undefined ? null : <span className="tile__note">{note}</span>}
    </div>
  );
}

/** A panel over the day. Escape closes it, because undo beats confirm. */
export function Drawer({
  title,
  onClose,
  children
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-label={title} aria-modal="true">
        <header className="drawer__head">
          <h2 className="drawer__title">{title}</h2>
          <Button tone="ghost" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </header>
        <div className="drawer__body">{children}</div>
      </aside>
    </>
  );
}
