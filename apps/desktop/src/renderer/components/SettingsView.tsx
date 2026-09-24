/**
 * Settings.
 *
 * macOS conventions, because breaking them is friction with no upside: ⌘,
 * opens it, changes apply the moment they are made, and there is no Save
 * button to forget.
 *
 * Privacy copy describes implemented behavior. Legacy persisted consent fields
 * do not control collection or training, so they are not presented as switches.
 */

import { useState } from "react";
import type { Contact, Settings, UpdateCheck } from "@cadrane/contracts";
import { Button, Chip, Section } from "./ui";
import { ShopName } from "./ShopName.js";
import { TelegramSetting, type TelegramStatus } from "./TelegramSetting.js";

interface Props {
  settings: Settings;
  roots: readonly string[];
  onChange(next: Settings): void;
  onGrantFolder(): void;
  onRevokeFolder(root: string): void;
  onReadDiagnostics(): Promise<string>;
  /** Asks whether a newer build exists. Never called on its own. */
  onCheckForUpdate(): Promise<UpdateCheck>;
  onOpenReleases(): void;
  onGuide?(): void;
  /** Mark's bot token. The token itself never reaches this screen. */
  onTelegramStatus(): Promise<TelegramStatus>;
  onTelegramSave(token: string): Promise<{ saved: boolean; said: string }>;
  onTelegramForget(): Promise<{ saved: boolean; said: string }>;
}

const THEMES: readonly { id: Settings["theme"]; label: string }[] = [
  { id: "system", label: "Match macOS" },
  { id: "dark", label: "Always dark" },
  { id: "light", label: "Always light" }
];

export function SettingsView({
  settings,
  roots,
  onChange,
  onGrantFolder,
  onRevokeFolder,
  onReadDiagnostics,
  onCheckForUpdate,
  onOpenReleases,
  onGuide,
  onTelegramStatus,
  onTelegramSave,
  onTelegramForget
}: Props) {
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);

  return (
    <div className="stack">
      {onGuide ? <Section title="Using Rellane">
        <p className="field__hint">Follow a task from its brief and selected sources to a reviewed, exported result.</p>
        <Button onClick={onGuide}>Open workroom walkthrough</Button>
      </Section> : null}
      {/* First, because it is the only setting on this screen that a customer
          ever sees. Everything below it changes how the owner works; this
          changes what somebody else reads. */}
      <Section title="Your shop">
        <ShopName
          name={settings.trading.name}
          onSave={(name) =>
            onChange({ ...settings, trading: { ...settings.trading, name } })
          }
        />
      </Section>

      <Section title="Appearance">
        <div className="segmented" role="group" aria-label="Theme">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className="segmented__btn"
              aria-pressed={settings.theme === theme.id}
              onClick={() => onChange({ ...settings, theme: theme.id })}
            >
              {theme.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Shortcuts">
        <div className="keyrow">
          <span className="keyrow__what">Open the command bar</span>
          <kbd className="keyrow__key">{prettyKey(settings.overlayHotkey)}</kbd>
        </div>
        <div className="keyrow">
          <span className="keyrow__what">Reshape the clipboard</span>
          <kbd className="keyrow__key">{prettyKey(settings.pasteHotkey)}</kbd>
        </div>
        <p className="field__hint">
          If another app already owns one of these, Rellane says so at startup rather than
          failing quietly. Custom shortcuts are not editable here yet.
        </p>
      </Section>

      <Section title="Folders Rellane may work in">
        {roots.length === 0 ? (
          <p className="field__hint">
            No folders granted. You can still work with pasted notes or explicitly choose one document in a workroom. Grant a folder when a task needs ongoing access to its files.
          </p>
        ) : (
          <ul className="rootlist">
            {roots.map((root) => (
              <li key={root} className="rootlist__row">
                <span className="rootlist__path mono">{root}</span>
                <Button onClick={() => onRevokeFolder(root)}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
        <Button tone="primary" onClick={onGrantFolder}>
          Grant a folder…
        </Button>
      </Section>

      {/**
        * Who this Mac will talk to, and take instructions from.
        *
        * Deliberately placed directly under the folders list, because the two
        * answer the same question in different directions — what Rellane can
        * reach, and who can reach Rellane — and reading them together is how a
        * person forms an accurate picture of the blast radius.
        */}
      <Section title="People Rellane may contact">
        {settings.contacts.length === 0 ? (
          <p className="field__hint">
            Nobody yet. Until you add someone, Rellane will not open a message addressed to
            anyone — and will ignore anything sent to it.
          </p>
        ) : (
          <ul className="rootlist">
            {settings.contacts.map((contact) => (
              <li key={`${contact.channel}:${contact.address}`} className="rootlist__row">
                <span className="rootlist__path">
                  {contact.label || contact.address}{" "}
                  <span className="contact__where mono">
                    {contact.channel} · {contact.address}
                  </span>
                </span>
                <Button
                  onClick={() =>
                    onChange({
                      ...settings,
                      contacts: settings.contacts.filter(
                        (other) =>
                          !(other.channel === contact.channel && other.address === contact.address)
                      )
                    })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <ContactAdder
          onAdd={(contact) => onChange({ ...settings, contacts: [...settings.contacts, contact] })}
        />
      </Section>

      <Section title="Mark on Telegram">
        <TelegramSetting
          onStatus={onTelegramStatus}
          onSave={onTelegramSave}
          onForget={onTelegramForget}
        />
      </Section>

      <Section title="Privacy on this Mac">
        <p className="field__hint">
          Rellane has no telemetry service. It does not send us crash reports,
          usage counts or the contents of your work. Workrooms, source snapshots
          and output versions are saved on this Mac.
        </p>
        <p className="field__hint">
          The bundled model uses the sources you select locally. A connected
          provider is a separate destination for the work you choose to send.
          Model training is not part of this build.
        </p>
      </Section>

      <Section title="This build">
        <p className="field__hint">
          Rellane never updates itself. It can tell you whether a newer build exists — when you
          ask it to — and then hand you the link. Downloading and installing stays yours.
        </p>
        <div className="row">
          <Button
            disabled={checking}
            onClick={() => {
              setChecking(true);
              void onCheckForUpdate()
                .then(setUpdate)
                .finally(() => setChecking(false));
            }}
          >
            {checking ? "Looking…" : "Is there a newer version?"}
          </Button>
          {update?.behind === true ? <Chip tone="warn">{update.latest} is out</Chip> : null}
        </div>
        {update === null ? null : (
          <>
            <p className="field__hint">{update.said}</p>
            {update.behind ? (
              <>
                <ul className="update__costs">
                  {update.costs.map((cost) => (
                    <li key={cost}>{cost}</li>
                  ))}
                </ul>
                <div className="row">
                  <Button tone="primary" onClick={onOpenReleases}>
                    Open the releases page
                  </Button>
                </div>
              </>
            ) : null}
          </>
        )}
      </Section>

      <Section title="When something goes wrong">
        <p className="field__hint">
          The diagnostic log keeps up to 500 events in memory. Open it below to
          review the redacted text before copying or sharing it. Folder and file
          paths are replaced by their depth and extension.
        </p>
        <p className="field__hint">
          Separately, an unhandled app error can save a redacted crash report on
          this Mac. Up to five reports are kept. These files are never uploaded
          automatically. A local report may not be available after every kind of
          crash.
        </p>
        <div className="row">
          <Button
            onClick={() => {
              void onReadDiagnostics().then(setReport);
            }}
          >
            {report === null ? "Open the report" : "Refresh"}
          </Button>
          {report === null ? null : (
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(report).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1_800);
                });
              }}
            >
              {copied ? "Copied" : "Copy it"}
            </Button>
          )}
        </div>
        {report === null ? null : (
          <pre className="report" aria-label="Diagnostic report">
            {report}
          </pre>
        )}
      </Section>
    </div>
  );
}

/** "Alt+Space" as a person reads it on a Mac keyboard. */
export function prettyKey(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => {
      switch (part.toLowerCase()) {
        case "alt":
        case "option":
          return "⌥";
        case "cmd":
        case "command":
        case "commandorcontrol":
          return "⌘";
        case "shift":
          return "⇧";
        case "ctrl":
        case "control":
          return "⌃";
        case "space":
          return "Space";
        default:
          return part.toUpperCase();
      }
    })
    .join("");
}

const CHANNELS: readonly Contact["channel"][] = ["whatsapp", "email", "telegram"];

/**
 * Adding one person to the list.
 *
 * Adding is a form and removing is a single button, on purpose. This list is
 * what stands between an agent and a stranger, so growing it should take a
 * moment of deliberate typing and shrinking it should be instant.
 */
function ContactAdder({ onAdd }: { readonly onAdd: (contact: Contact) => void }) {
  const [channel, setChannel] = useState<Contact["channel"]>("whatsapp");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const ready = address.trim().length > 0;

  const add = () => {
    if (!ready) {
      return;
    }
    onAdd({ channel, address: address.trim(), label: label.trim() || address.trim() });
    setAddress("");
    setLabel("");
  };

  return (
    <div className="contact__add">
      <div className="segmented" role="group" aria-label="Channel">
        {CHANNELS.map((option) => (
          <button
            key={option}
            type="button"
            className={channel === option ? "segmented__on" : undefined}
            aria-pressed={channel === option}
            onClick={() => setChannel(option)}
          >
            {option === "whatsapp" ? "WhatsApp" : option === "email" ? "Email" : "Telegram"}
          </button>
        ))}
      </div>
      <input
        className="input"
        value={label}
        placeholder="What you call them"
        onChange={(event) => setLabel(event.target.value)}
      />
      <input
        className="input"
        value={address}
        placeholder={
          channel === "whatsapp"
            ? "Phone number with country code"
            : channel === "email"
              ? "name@example.com"
              : "Telegram chat id"
        }
        onChange={(event) => setAddress(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            add();
          }
        }}
      />
      <Button tone="primary" onClick={add} disabled={!ready}>
        Add
      </Button>
    </div>
  );
}
