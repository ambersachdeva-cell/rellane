import { useState, type FormEvent, type ReactNode } from "react";
import { Icon, Modal } from "./ui.js";

/** One part of a split request, and who is taking it. */
export interface CrewPart {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly seatId: string;
  readonly seatLabel: string;
  readonly dependsOn: readonly string[];
}

export type CrewPartState = "waiting" | "claimed" | "working" | "answered" | "refining" | "done" | "failed" | "stopped";

export interface CrewPartView {
  readonly id: string;
  readonly title: string;
  readonly seatLabel: string;
  readonly state: CrewPartState;
  readonly line: string;
  readonly elapsed: string;
  readonly answerTurnId: string | null;
  readonly refinedFrom: readonly string[];
  readonly canStop: boolean;
}

export interface CrewRunView {
  readonly runId: string;
  readonly caseId: string;
  readonly request: string;
  readonly parts: readonly CrewPartView[];
  readonly round: "splitting" | "working" | "reading-each-other" | "done" | "stopped" | "failed";
  readonly headline: string;
  readonly canStop: boolean;
}

/** What one seat learned, written back so the next round starts with it. */
export interface CrewNote {
  readonly partId: string;
  readonly seatLabel: string;
  readonly finding: string;
  readonly confidence: "stated" | "inferred" | "uncertain";
  readonly at: number;
}

export type TelegramLink =
  | { readonly state: "off" }
  | { readonly state: "no-keychain"; readonly reason: string }
  | { readonly state: "linked"; readonly botName: string | null; readonly pairedChatId: string | null;
      readonly lastHeardAt: number | null }
  | { readonly state: "failed"; readonly reason: string };

/** An unknown chat that messaged the bot, offered so he need not go hunting for his own id. */
export interface TelegramKnock {
  readonly chatId: string;
  readonly from: string;
  readonly at: number;
}

export interface TelegramPanelProps {
  readonly link: TelegramLink;
  readonly knocks: readonly TelegramKnock[];
  readonly now: number;
  readonly mayDo: readonly string[];
  readonly mayNotDo: readonly string[];
  readonly saving: boolean;
  readonly problem: string | null;
  readonly onSaveToken: (token: string) => void;
  readonly onPairChat: (chatId: string) => void;
  readonly onUnpairChat: () => void;
  readonly onForget: () => void;
  /**
   * Says one plain thing to his phone, now.
   *
   * The only way to find out whether a pasted token actually reaches a phone
   * used to be to wait for something to happen and see if it arrived.
   */
  readonly onTestMessage: () => void;
  readonly onClose: () => void;
}

function formatRelativeTime(at: number, now: number): string {
  const diffMs = Math.max(0, now - at);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) {
    const s = Math.max(1, diffSec);
    return `${s} ${s === 1 ? "second" : "seconds"} ago`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin} ${diffMin === 1 ? "minute" : "minutes"} ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? "hour" : "hours"} ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} ${diffDays === 1 ? "day" : "days"} ago`;
}

function formatLastHeard(lastHeardAt: number | null, now: number): string {
  if (lastHeardAt === null) {
    return "never";
  }
  return `heard from ${formatRelativeTime(lastHeardAt, now)}`;
}

function validateTelegramToken(raw: string): string | null {
  if (raw.length === 0) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "The token cannot be blank.";
  }
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) {
    return "The token must include a colon between the bot ID and the secret.";
  }
  const prefix = trimmed.slice(0, colonIndex);
  const secret = trimmed.slice(colonIndex + 1);
  if (prefix.length === 0 || !/^\d+$/.test(prefix)) {
    return "The part before the colon must be numbers only.";
  }
  if (secret.length < 30) {
    return "The secret after the colon is too short (must be at least 30 characters).";
  }
  if (secret.length > 60) {
    return "The secret after the colon is too long (must be at most 60 characters).";
  }
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) {
    return "The secret after the colon contains invalid characters. Use only letters, numbers, underscores and hyphens.";
  }
  return null;
}

function deriveStatusText(link: TelegramLink, saving: boolean, problem: string | null): string {
  if (saving) {
    return "Saving changes…";
  }
  if (problem) {
    return `Problem: ${problem}`;
  }
  switch (link.state) {
    case "off":
      return "Telegram bot is not configured.";
    case "no-keychain":
      return "Keychain access is unavailable on this Mac.";
    case "linked":
      if (link.pairedChatId) {
        return `Telegram bot is linked to chat ${link.pairedChatId}.`;
      }
      return "Telegram bot is linked. Waiting to pair with a chat.";
    case "failed":
      return `Telegram connection failed: ${link.reason}`;
  }
}

interface PermissionsViewProps {
  readonly mayDo: readonly string[];
  readonly mayNotDo: readonly string[];
}

function PermissionsView({ mayDo, mayNotDo }: PermissionsViewProps): ReactNode {
  return (
    <div className="ws-tg-permissions">
      <div className="ws-tg-permission-col">
        <h3 className="ws-tg-permission-heading">What your phone may do</h3>
        <ul className="ws-tg-permission-list">
          {mayDo.map((item, index) => (
            <li key={index} className="ws-tg-permission-item ws-tg-permission-item--may">
              <Icon name="check" size={14} />
              <span className="ws-tg-permission-text">{item}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="ws-tg-permission-col">
        <h3 className="ws-tg-permission-heading">What your phone may not do</h3>
        <ul className="ws-tg-permission-list">
          {mayNotDo.map((item, index) => (
            <li key={index} className="ws-tg-permission-item ws-tg-permission-item--may-not">
              <Icon name="close" size={14} />
              <span className="ws-tg-permission-text">{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function TelegramPanel({
  link,
  knocks,
  now,
  mayDo,
  mayNotDo,
  saving,
  problem,
  onSaveToken,
  onPairChat,
  onUnpairChat,
  onForget,
  onTestMessage,
  onClose,
}: TelegramPanelProps): ReactNode {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [manualChatId, setManualChatId] = useState("");
  const [confirmForget, setConfirmForget] = useState(false);

  const tokenError = validateTelegramToken(token);
  const isTokenValid = token.trim().length > 0 && tokenError === null;

  const handleSaveTokenSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const clean = token.trim();
    if (!clean || tokenError !== null) {
      return;
    }
    // Credentials must never linger in memory once handed off to secure storage.
    setToken("");
    setShowToken(false);
    onSaveToken(clean);
  };

  const handleManualPairSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const clean = manualChatId.trim();
    if (!clean || saving) {
      return;
    }
    setManualChatId("");
    onPairChat(clean);
  };

  return (
    <Modal title="Your phone" eyebrow="Telegram" onClose={onClose} wide={true}>
      <div className="ws-tg-panel">
        <div role="status" aria-live="polite" className="ws-tg-status-live">
          {deriveStatusText(link, saving, problem)}
        </div>

        {problem ? (
          <div role="alert" className="ws-tg-alert ws-tg-alert--problem">
            <p className="ws-tg-alert-text">{problem}</p>
          </div>
        ) : null}

        {link.state === "off" && (
          <div className="ws-tg-state-block ws-tg-state-block--off">
            <ol className="ws-tg-steps">
              <li className="ws-tg-step">
                <span className="ws-tg-step-number">1</span>
                <span className="ws-tg-step-text">Open Telegram and message @BotFather</span>
              </li>
              <li className="ws-tg-step">
                <span className="ws-tg-step-number">2</span>
                <span className="ws-tg-step-text">Send /newbot and pick a name</span>
              </li>
              <li className="ws-tg-step">
                <span className="ws-tg-step-number">3</span>
                <span className="ws-tg-step-text">Paste the code it gives you here.</span>
              </li>
            </ol>

            <form className="ws-tg-form" onSubmit={handleSaveTokenSubmit}>
              <div className="ws-tg-field">
                <label htmlFor="ws-tg-token-input" className="ws-tg-label">
                  Bot token
                </label>
                <div className="ws-tg-input-wrap">
                  <input
                    id="ws-tg-token-input"
                    name="telegram-token"
                    type={showToken ? "text" : "password"}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="ws-tg-input ws-tg-input--token"
                    placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                  />
                  <button
                    type="button"
                    className="ws-tg-toggle-button"
                    aria-label={showToken ? "Hide token" : "Show token"}
                    onClick={() => setShowToken((prev) => !prev)}
                  >
                    {showToken ? "Hide" : "Show"}
                  </button>
                </div>
                {tokenError ? (
                  <p className="ws-tg-field-error" role="alert">
                    {tokenError}
                  </p>
                ) : null}
              </div>

              <div className="ws-tg-form-actions">
                <button
                  type="submit"
                  className="ws-tg-button ws-tg-button--primary"
                  disabled={!isTokenValid || saving}
                >
                  {saving ? "Saving…" : "Save token"}
                </button>
              </div>
            </form>
          </div>
        )}

        {link.state === "no-keychain" && (
          <div className="ws-tg-state-block ws-tg-state-block--no-keychain">
            <div className="ws-tg-card">
              <p className="ws-tg-notice">
                This Mac will not give an encryption key, so the token is deliberately not stored at all rather than written in the clear.
              </p>
              <p className="ws-tg-reason">{link.reason}</p>
            </div>
            <PermissionsView mayDo={mayDo} mayNotDo={mayNotDo} />
          </div>
        )}

        {link.state === "linked" && (
          <div className="ws-tg-state-block ws-tg-state-block--linked">
            <div className="ws-tg-card ws-tg-linked-card">
              <div className="ws-tg-meta-grid">
                <div className="ws-tg-meta-item">
                  <span className="ws-tg-meta-label">Bot:</span>
                  <span className="ws-tg-meta-value">
                    {link.botName ? link.botName : "Unknown bot"}
                  </span>
                </div>
                <div className="ws-tg-meta-item">
                  <span className="ws-tg-meta-label">Last activity:</span>
                  <span className="ws-tg-meta-value">
                    {formatLastHeard(link.lastHeardAt, now)}
                  </span>
                </div>
              </div>

              {link.pairedChatId === null ? (
                <div className="ws-tg-unpaired-section">
                  <p className="ws-tg-unpaired-notice">
                    Your bot is reading messages and answering nobody, on purpose, until you pair it with your chat.
                  </p>

                  {knocks.length > 0 ? (
                    <div className="ws-tg-knocks">
                      <ul className="ws-tg-knocks-list">
                        {knocks.map((knock) => (
                          <li key={knock.chatId} className="ws-tg-knock-card">
                            <div className="ws-tg-knock-body">
                              <p className="ws-tg-knock-lead">
                                Someone messaged your bot {formatRelativeTime(knock.at, now)}. Is this you?
                              </p>
                              {knock.from ? (
                                <p className="ws-tg-knock-from">
                                  From: <span className="ws-tg-knock-sender">{knock.from}</span>
                                </p>
                              ) : null}
                              <p className="ws-tg-knock-chat-id">Chat ID: {knock.chatId}</p>
                            </div>
                            <button
                              type="button"
                              className="ws-tg-button ws-tg-button--primary"
                              disabled={saving}
                              onClick={() => onPairChat(knock.chatId)}
                            >
                              Pair this chat
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="ws-tg-empty-text">
                      Message your bot on Telegram and this will fill in automatically.
                    </p>
                  )}

                  <form className="ws-tg-manual-form" onSubmit={handleManualPairSubmit}>
                    <label htmlFor="ws-tg-manual-chat-id" className="ws-tg-label">
                      Or enter your chat ID manually
                    </label>
                    <div className="ws-tg-input-row">
                      <input
                        id="ws-tg-manual-chat-id"
                        name="telegram-chat-id"
                        type="text"
                        value={manualChatId}
                        onChange={(e) => setManualChatId(e.target.value)}
                        placeholder="e.g. 987654321"
                        autoComplete="off"
                        spellCheck={false}
                        className="ws-tg-input"
                      />
                      <button
                        type="submit"
                        className="ws-tg-button ws-tg-button--secondary"
                        disabled={!manualChatId.trim() || saving}
                      >
                        {saving ? "Pairing…" : "Pair chat"}
                      </button>
                    </div>
                  </form>
                </div>
              ) : (
                <div className="ws-tg-paired-section">
                  <div className="ws-tg-paired-info">
                    <span className="ws-tg-meta-label">Paired chat ID:</span>
                    <span className="ws-tg-meta-value">{link.pairedChatId}</span>
                  </div>
                  <p className="ws-tg-paired-notice">
                    Only this chat is obeyed. Every other is ignored.
                  </p>
                  <button
                    type="button"
                    className="ws-tg-button ws-tg-button--secondary"
                    disabled={saving}
                    onClick={onUnpairChat}
                  >
                    {saving ? "Unpairing…" : "Unpair chat"}
                  </button>
                </div>
              )}

              <div className="ws-tg-action-row">
                <button
                  type="button"
                  className="ws-tg-button ws-tg-button--secondary"
                  disabled={saving}
                  onClick={onTestMessage}
                >
                  Send a test message
                </button>
              </div>

              <div className="ws-tg-forget-section">
                {!confirmForget ? (
                  <button
                    type="button"
                    className="ws-tg-button ws-tg-button--danger"
                    disabled={saving}
                    onClick={() => setConfirmForget(true)}
                  >
                    Forget bot
                  </button>
                ) : (
                  <div className="ws-tg-confirm-box">
                    <p className="ws-tg-confirm-notice">
                      This removes the stored bot token and disconnects your phone. You will need to paste the token again to reconnect.
                    </p>
                    <div className="ws-tg-confirm-buttons">
                      <button
                        type="button"
                        className="ws-tg-button ws-tg-button--danger"
                        disabled={saving}
                        onClick={() => {
                          setConfirmForget(false);
                          onForget();
                        }}
                      >
                        {saving ? "Forgetting…" : "Yes, forget token"}
                      </button>
                      <button
                        type="button"
                        className="ws-tg-button ws-tg-button--ghost"
                        disabled={saving}
                        onClick={() => setConfirmForget(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <PermissionsView mayDo={mayDo} mayNotDo={mayNotDo} />
          </div>
        )}

        {link.state === "failed" && (
          <div className="ws-tg-state-block ws-tg-state-block--failed">
            <div className="ws-tg-card ws-tg-card--failed">
              <h3 className="ws-tg-failed-heading">Connection failed</h3>
              <p className="ws-tg-reason">{link.reason}</p>
              <div className="ws-tg-action-row">
                <button
                  type="button"
                  className="ws-tg-button ws-tg-button--primary"
                  disabled={saving}
                  onClick={onForget}
                >
                  {saving ? "Resetting…" : "Try again"}
                </button>
              </div>
            </div>
            <PermissionsView mayDo={mayDo} mayNotDo={mayNotDo} />
          </div>
        )}
      </div>
    </Modal>
  );
}
