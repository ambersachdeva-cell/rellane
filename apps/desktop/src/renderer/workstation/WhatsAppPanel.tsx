import { useState } from "react";
import { Icon, Modal } from "./ui.js";

/**
 * Setting up the business number.
 *
 * Five fields, and the two that decide everything are not the token. Whether
 * there is a mailbox decides whether customers can reach you at all; whether the
 * token is the permanent one decides whether this still works tomorrow morning.
 * Both are called out where they are entered rather than in documentation
 * nobody opens.
 */

export interface WhatsAppStatus {
  readonly configured: boolean;
  readonly encryptionAvailable: boolean;
  readonly canReceive: boolean;
  readonly phoneNumberId: string | null;
}

export interface WhatsAppPanelProps {
  readonly status: WhatsAppStatus;
  readonly saving: boolean;
  readonly problem: string | null;
  readonly onSave: (input: {
    readonly token: string;
    readonly phoneNumberId: string;
    readonly businessAccountId: string;
    readonly mailboxUrl: string;
    readonly collectSecret: string;
  }) => void;
  readonly onForget: () => void;
  readonly onClose: () => void;
}

export function WhatsAppPanel({
  status,
  saving,
  problem,
  onSave,
  onForget,
  onClose
}: WhatsAppPanelProps) {
  const [token, setToken] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [mailboxUrl, setMailboxUrl] = useState("");
  const [collectSecret, setCollectSecret] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);

  const canSave =
    token.trim().length > 0 && phoneNumberId.trim().length > 0 && !saving;

  if (!status.encryptionAvailable) {
    return (
      <Modal title="Your business number" eyebrow="WhatsApp" onClose={onClose}>
        <div className="ws-wa-panel">
          <p className="ws-wa-refusal">
            This Mac will not give Rellane an encryption key, so the access token would have to sit
            unencrypted on disk. It refuses to store one at all rather than do that, which means
            WhatsApp stays off until the keychain is available.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Your business number" eyebrow="WhatsApp" onClose={onClose}>
      <div className="ws-wa-panel">
        {status.configured ? (
          <div className="ws-wa-state">
            <p className="ws-wa-state-line">
              <Icon name="check" size={15} />
              Set up{status.phoneNumberId === null ? "" : ` on number ${status.phoneNumberId}`}.
            </p>
            <p className="ws-wa-state-detail">
              {status.canReceive
                ? "Messages from customers are collected from your mailbox."
                : "Sending only. Customers cannot reach you here until a mailbox is set up below."}
            </p>
          </div>
        ) : (
          <p className="ws-wa-intro">
            Paste the three values from Meta. The token goes straight into this Mac&apos;s keychain
            and is never shown again, not even back to this screen.
          </p>
        )}

        <label className="ws-wa-field">
          <span className="ws-wa-label">Access token</span>
          <input
            id="ws-wa-token"
            className="ws-wa-input"
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="EAAG…"
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
          />
          <span className="ws-wa-hint">
            The permanent one from Business Settings → System users. Not the short one on the app
            dashboard — that expires overnight and is why most setups appear to work and then stop.
          </span>
        </label>
        <button
          type="button"
          className="ws-wa-reveal"
          onClick={() => setShowToken((previous) => !previous)}
        >
          {showToken ? "Hide" : "Show"}
        </button>

        <label className="ws-wa-field">
          <span className="ws-wa-label">Phone number ID</span>
          <input
            id="ws-wa-phone-id"
            className="ws-wa-input"
            value={phoneNumberId}
            onChange={(event) => setPhoneNumberId(event.target.value)}
            placeholder="123456789012345"
            inputMode="numeric"
            autoComplete="off"
            disabled={saving}
          />
          <span className="ws-wa-hint">
            From the API Setup page. A long number, not the phone number itself.
          </span>
        </label>

        <label className="ws-wa-field">
          <span className="ws-wa-label">Business account ID</span>
          <input
            id="ws-wa-waba-id"
            className="ws-wa-input"
            value={businessAccountId}
            onChange={(event) => setBusinessAccountId(event.target.value)}
            placeholder="987654321098765"
            inputMode="numeric"
            autoComplete="off"
            disabled={saving}
          />
        </label>

        <div className="ws-wa-mailbox">
          <h3 className="ws-wa-mailbox-title">Receiving messages</h3>
          <p className="ws-wa-mailbox-note">
            WhatsApp only delivers to a public address, which this Mac does not have. Leave these
            empty to send only. With a mailbox, this Mac collects what customers send — it still
            makes every connection itself, and nothing listens here.
          </p>
          <label className="ws-wa-field">
            <span className="ws-wa-label">Mailbox address</span>
            <input
              id="ws-wa-mailbox"
              className="ws-wa-input"
              value={mailboxUrl}
              onChange={(event) => setMailboxUrl(event.target.value)}
              placeholder="https://…workers.dev"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </label>
          <label className="ws-wa-field">
            <span className="ws-wa-label">Collect secret</span>
            <input
              id="ws-wa-collect"
              className="ws-wa-input"
              type="password"
              value={collectSecret}
              onChange={(event) => setCollectSecret(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </label>
        </div>

        {problem === null ? null : (
          <p className="ws-wa-problem" role="alert">
            {problem}
          </p>
        )}

        <div className="ws-wa-actions">
          <button
            type="button"
            className="ws-wa-button ws-wa-button--primary"
            disabled={!canSave}
            onClick={() =>
              onSave({
                token: token.trim(),
                phoneNumberId: phoneNumberId.trim(),
                businessAccountId: businessAccountId.trim(),
                mailboxUrl: mailboxUrl.trim(),
                collectSecret: collectSecret.trim()
              })
            }
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {status.configured ? (
            confirmForget ? (
              <>
                <button
                  type="button"
                  className="ws-wa-button ws-wa-button--danger"
                  disabled={saving}
                  onClick={() => {
                    setConfirmForget(false);
                    onForget();
                  }}
                >
                  Yes, forget it
                </button>
                <button
                  type="button"
                  className="ws-wa-button"
                  disabled={saving}
                  onClick={() => setConfirmForget(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ws-wa-button"
                disabled={saving}
                onClick={() => setConfirmForget(true)}
              >
                Forget this number
              </button>
            )
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
