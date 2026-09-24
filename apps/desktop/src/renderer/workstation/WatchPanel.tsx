import { useRef, useState } from "react";
import { Icon, Modal } from "./ui.js";

/**
 * One definition, in the module that judges against it. Three copies of these
 * shapes were written in one wave — here, in the runner, and in the plan — and
 * three copies of a type is three places for them to drift apart.
 */
import type { Cadence, Watch, WatchTarget } from "../../main/workstation/watch-plan.js";

export type { Cadence, Watch, WatchTarget };

export interface WatchRow {
  readonly watch: Watch;
  readonly lastFound: string | null;
  readonly failing: boolean;
}

export interface WatchPanelProps {
  readonly rows: readonly WatchRow[];
  readonly now: number;
  readonly checking: string | null;
  readonly onAdd: (target: WatchTarget, cadence: Cadence, tellMeWhen: Watch["tellMeWhen"]) => void;
  readonly onRemove: (id: string) => void;
  readonly onPause: (id: string, paused: boolean) => void;
  readonly onCheckNow: (id: string) => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

/**
 * A fourth copy of the change engine stood here — its own isDue, its own
 * judgeChange, its own number matcher — and no part of this screen ever called
 * any of it. Only its test did. The engine that runs lives in watch-plan.ts,
 * where the runner calls it and its own suite covers it.
 */
export function formatTimeAgo(timestamp: number, now: number): string {
  const elapsedMs = Math.max(0, now - timestamp);
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return "yesterday";
  }
  if (days < 7) {
    return `${days} days ago`;
  }
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
}

function derivePageLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const search = parsed.search;
    return `${parsed.hostname}${path}${search}`;
  } catch {
    return url;
  }
}

export function validatePageAddress(raw: string): { readonly valid: true; readonly url: string } | { readonly valid: false; readonly reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: "Enter a web address to watch." };
  }
  if (/\s/.test(trimmed)) {
    return { valid: false, reason: "Web addresses cannot contain spaces." };
  }
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, reason: "Web addresses must start with http:// or https://" };
    }
    if (!parsed.hostname || parsed.hostname.length === 0) {
      return { valid: false, reason: "Web address is missing a domain name." };
    }
    if (parsed.hostname !== "localhost" && !parsed.hostname.includes(".")) {
      return { valid: false, reason: "Address must include a domain name, such as example.com." };
    }
    return { valid: true, url: withScheme };
  } catch {
    return { valid: false, reason: "Please enter a valid web address, such as https://example.com." };
  }
}

export type TargetValidation =
  | { readonly valid: true; readonly target: WatchTarget }
  | { readonly valid: false; readonly reason: string };

export function validateTarget(
  kind: WatchTarget["kind"],
  value: string
): TargetValidation {
  const trimmed = value.trim();
  switch (kind) {
    case "page": {
      const pageResult = validatePageAddress(trimmed);
      if (!pageResult.valid) {
        return pageResult;
      }
      return {
        valid: true,
        target: {
          kind: "page",
          url: pageResult.url,
          label: derivePageLabel(pageResult.url),
        },
      };
    }
    case "folder": {
      if (trimmed.length === 0) {
        return { valid: false, reason: "Enter a folder path to watch." };
      }
      const parts = trimmed.split("/").filter((part) => part.length > 0);
      const lastPart = parts.length > 0 ? parts[parts.length - 1]! : trimmed;
      return {
        valid: true,
        target: {
          kind: "folder",
          path: trimmed,
          label: lastPart,
        },
      };
    }
    case "routine": {
      if (trimmed.length === 0) {
        return { valid: false, reason: "Enter a routine name to watch." };
      }
      return {
        valid: true,
        target: {
          kind: "routine",
          routineId: trimmed,
          label: trimmed,
        },
      };
    }
  }
}

export function WatchPanel({
  rows,
  now,
  checking,
  onAdd,
  onRemove,
  onPause,
  onCheckNow,
  onClose,
  busy,
}: WatchPanelProps) {
  const [kind, setKind] = useState<WatchTarget["kind"]>("page");
  const [targetInput, setTargetInput] = useState("");
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [tellMeWhen, setTellMeWhen] = useState<Watch["tellMeWhen"]>("anything-changes");

  const inputRef = useRef<HTMLInputElement>(null);
  const validation = validateTarget(kind, targetInput);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!validation.valid || busy) {
      return;
    }
    onAdd(validation.target, cadence, tellMeWhen);
    setTargetInput("");
  };

  return (
    <Modal
      title="Keep an eye on it"
      eyebrow="Tell me when it changes"
      wide
      onClose={onClose}
    >
      <div className="ws-watch-panel">
        <form className="ws-watch-add-form" onSubmit={handleSubmit}>
          <div className="ws-watch-add-row">
            <div className="ws-watch-field ws-watch-field--target">
              <select
                className="ws-watch-select ws-watch-kind-select"
                value={kind}
                onChange={(event) => setKind(event.target.value as WatchTarget["kind"])}
                aria-label="What to watch"
              >
                <option value="page">Web page</option>
                <option value="folder">Folder</option>
                <option value="routine">Routine</option>
              </select>
              <input
                ref={inputRef}
                type="text"
                className="ws-watch-input"
                value={targetInput}
                onChange={(event) => setTargetInput(event.target.value)}
                placeholder={
                  kind === "page"
                    ? "https://example.com/prices"
                    : kind === "folder"
                      ? "/Users/amber/Documents"
                      : "Routine name"
                }
                aria-label={
                  kind === "page"
                    ? "Web page address"
                    : kind === "folder"
                      ? "Folder path"
                      : "Routine name"
                }
                data-autofocus
              />
            </div>

            <div className="ws-watch-field ws-watch-field--cadence">
              <select
                className="ws-watch-select"
                value={cadence}
                onChange={(event) => setCadence(event.target.value as Cadence)}
                aria-label="How often"
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>

            <div className="ws-watch-field ws-watch-field--condition">
              <select
                className="ws-watch-select"
                value={tellMeWhen}
                onChange={(event) => setTellMeWhen(event.target.value as Watch["tellMeWhen"])}
                aria-label="Tell me when"
              >
                <option value="anything-changes">anything changes</option>
                <option value="numbers-change">a number changes</option>
                <option value="something-new-appears">something is added or removed</option>
              </select>
            </div>

            <div className="ws-watch-field ws-watch-field--action">
              <button
                type="submit"
                className="ws-watch-button ws-watch-button--add"
                disabled={!validation.valid || busy}
              >
                Add
              </button>
            </div>
          </div>

          {/*
            An empty box is not a mistake, it is an empty box. `role="alert"` is
            announced the instant the panel opens, so using it here told anyone
            on a screen reader that something was wrong before they had done
            anything at all. The words are the same either way; only once they
            have typed something is it an error worth interrupting for.
          */}
          {!validation.valid ? (
            targetInput.trim().length === 0 ? (
              <p className="ws-watch-form-feedback ws-watch-form-feedback--hint">
                {validation.reason}
              </p>
            ) : (
              <p className="ws-watch-form-feedback ws-watch-form-feedback--error" role="alert">
                {validation.reason}
              </p>
            )
          ) : null}
        </form>

        {rows.length === 0 ? (
          <div className="ws-watch-empty">
            <div className="ws-watch-empty-icon" aria-hidden="true">
              <Icon name="clock" size={28} />
            </div>
            <p className="ws-watch-empty-description">
              Rellane can keep an eye on web pages, folders, or routines and tell you when something changes. For example, you can watch a supplier&apos;s price list page every day and receive a notice the moment a price changes.
            </p>
            <p className="ws-watch-empty-hint">
              Enter an address above to set up your first watch.
            </p>
            <button
              type="button"
              className="ws-watch-empty-action"
              onClick={() => inputRef.current?.focus()}
            >
              Add your first watch
            </button>
          </div>
        ) : (
          <ul className="ws-watch-list">
            {rows.map((row) => {
              const isChecking = checking === row.watch.id;
              const targetIcon =
                row.watch.target.kind === "page"
                  ? "search"
                  : row.watch.target.kind === "folder"
                    ? "folder"
                    : "spark";

              const cadenceText =
                row.watch.cadence === "hourly"
                  ? "Hourly"
                  : row.watch.cadence === "daily"
                    ? "Daily"
                    : "Weekly";

              const conditionText =
                row.watch.tellMeWhen === "anything-changes"
                  ? "anything changes"
                  : row.watch.tellMeWhen === "numbers-change"
                    ? "a number changes"
                    : "something new appears";

              const lastLookedText =
                row.watch.lastCheckedAt === null
                  ? "Never checked yet"
                  : `Looked ${formatTimeAgo(row.watch.lastCheckedAt, now)}`;

              const rowClassName = [
                "ws-watch-row",
                row.failing ? "ws-watch-row--failing" : "",
                isChecking ? "ws-watch-row--checking" : "",
                row.watch.paused ? "ws-watch-row--paused" : "",
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <li key={row.watch.id} className={rowClassName}>
                  <div className="ws-watch-row-main">
                    <div className="ws-watch-target">
                      <span className="ws-watch-target-icon" aria-hidden="true">
                        <Icon name={targetIcon} size={16} />
                      </span>
                      <div className="ws-watch-target-details">
                        <span className="ws-watch-target-label">
                          {row.watch.target.label}
                        </span>
                        {row.watch.target.kind === "page" &&
                        row.watch.target.url !== row.watch.target.label ? (
                          <span className="ws-watch-target-sub">
                            {row.watch.target.url}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="ws-watch-meta">
                      <span className="ws-watch-meta-item">{cadenceText}</span>
                      <span className="ws-watch-meta-item">{conditionText}</span>
                      <span className="ws-watch-meta-item">{lastLookedText}</span>
                      {row.watch.paused ? (
                        <span className="ws-watch-badge ws-watch-badge--paused">
                          Paused
                        </span>
                      ) : null}
                    </div>

                    <div className="ws-watch-last-found">
                      {row.lastFound !== null ? (
                        <span>{row.lastFound}</span>
                      ) : (
                        <span className="ws-watch-last-found--empty">
                          No changes found yet
                        </span>
                      )}
                    </div>

                    {row.failing ? (
                      <div className="ws-watch-failure" role="alert">
                        <p className="ws-watch-failure-message">
                          Check failed to run. Check your connection or the address, or select Check now to retry.
                        </p>
                      </div>
                    ) : null}
                  </div>

                  <div className="ws-watch-row-actions">
                    <button
                      type="button"
                      className="ws-watch-action-button ws-watch-action-button--check"
                      onClick={() => onCheckNow(row.watch.id)}
                      disabled={busy || isChecking}
                    >
                      {isChecking ? "Checking..." : "Check now"}
                    </button>

                    <button
                      type="button"
                      className="ws-watch-action-button ws-watch-action-button--pause"
                      onClick={() => onPause(row.watch.id, !row.watch.paused)}
                      disabled={busy}
                    >
                      {row.watch.paused ? "Resume" : "Pause"}
                    </button>

                    <button
                      type="button"
                      className="ws-watch-action-button ws-watch-action-button--remove"
                      onClick={() => onRemove(row.watch.id)}
                      disabled={busy}
                      aria-label={`Remove watch for ${row.watch.target.label}`}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
