import type { ReactNode } from "react";
import { Icon, Modal } from "./ui.js";

export type PairingStatus =
  | { readonly state: "off" }
  | { readonly state: "starting" }
  | {
      readonly state: "listening";
      readonly url: string;
      readonly pin: string;
      readonly expiresAt: number;
      readonly onThisMacOnly: boolean;
    }
  | { readonly state: "failed"; readonly reason: string };

export interface PairingPanelProps {
  readonly status: PairingStatus;
  readonly now: number;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onCopyPin: () => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

// Group digits into triplets so companion entry requires minimal visual tracking.
function formatPin(pin: string): string {
  const clean = pin.trim();
  if (/\s/.test(clean)) {
    return clean;
  }
  if (clean.length === 6 && /^\d{6}$/.test(clean)) {
    return `${clean.slice(0, 3)} ${clean.slice(3)}`;
  }
  if (clean.length === 8 && /^\d{8}$/.test(clean)) {
    return `${clean.slice(0, 4)} ${clean.slice(4)}`;
  }
  return clean;
}

function formatRemaining(remainingMs: number): string {
  const minutes = Math.ceil(remainingMs / 60000);
  if (minutes <= 1) {
    return "expires in 1 minute";
  }
  return `expires in ${minutes} minutes`;
}

export function PairingPanel({
  status,
  now,
  onStart,
  onStop,
  onCopyPin,
  onClose,
  busy,
}: PairingPanelProps): ReactNode {
  const isListening = status.state === "listening";
  const isExpired = isListening && status.expiresAt <= now;

  const dotState =
    status.state === "listening"
      ? isExpired
        ? "off"
        : "listening"
      : status.state;

  const statusLabel =
    status.state === "off"
      ? "Off"
      : status.state === "starting"
        ? "Starting"
        : status.state === "failed"
          ? "Failed"
          : isExpired
            ? "Expired"
            : "Ready";

  return (
    <Modal title="Pair a device" onClose={onClose} eyebrow="Local connection">
      <div className="ws-pairing-panel">
        <div className="ws-pairing-status-bar">
          <span
            className={`ws-pairing-dot ws-pairing-dot--${dotState}`}
            aria-hidden="true"
          />
          <span className="ws-pairing-status-text">{statusLabel}</span>
        </div>

        {status.state === "off" ? (
          <div className="ws-pairing-body">
            <p className="ws-pairing-description">
              Turn on pairing to connect another device on your network.
            </p>
            <div className="ws-pairing-actions">
              <button
                type="button"
                className="ws-pairing-btn ws-pairing-btn--primary"
                onClick={onStart}
                disabled={busy}
              >
                Turn on
              </button>
            </div>
          </div>
        ) : null}

        {status.state === "starting" ? (
          <div className="ws-pairing-body">
            <p className="ws-pairing-description">
              Starting the local connection. This usually takes a moment.
            </p>
            <div className="ws-pairing-actions">
              <button
                type="button"
                className="ws-pairing-btn ws-pairing-btn--stop"
                onClick={onStop}
                disabled={busy}
              >
                Stop
              </button>
            </div>
          </div>
        ) : null}

        {status.state === "listening" ? (
          <div className="ws-pairing-body">
            <div className="ws-pairing-address-wrap">
              <span className="ws-pairing-label">Address</span>
              <code className="ws-pairing-address">{status.url}</code>
            </div>

            {isExpired ? (
              <div className="ws-pairing-expired-wrap">
                <span className="ws-pairing-expiry ws-pairing-expiry--expired">
                  expired
                </span>
                <p className="ws-pairing-description">
                  This pairing code has expired. Start again to create a new one.
                </p>
              </div>
            ) : (
              <div className="ws-pairing-pin-wrap">
                <span className="ws-pairing-label">Pairing code</span>
                <div className="ws-pairing-pin">
                  <span className="ws-pairing-pin-digits" data-pin={status.pin}>
                    {formatPin(status.pin)}
                  </span>
                  <button
                    type="button"
                    className="ws-pairing-copy-btn"
                    onClick={onCopyPin}
                    disabled={busy}
                    aria-label="Copy PIN"
                  >
                    <Icon name="copy" size={16} />
                    <span>Copy PIN</span>
                  </button>
                </div>
                <span className="ws-pairing-expiry">
                  {formatRemaining(status.expiresAt - now)}
                </span>
              </div>
            )}

            <p className="ws-pairing-reachability">
              {status.onThisMacOnly
                ? "Only this Mac can reach it."
                : "Any device on your Wi-Fi can reach it, so stop it when you are done."}
            </p>

            <div className="ws-pairing-actions">
              {isExpired ? (
                <button
                  type="button"
                  className="ws-pairing-btn ws-pairing-btn--primary"
                  onClick={onStart}
                  disabled={busy}
                >
                  Start again
                </button>
              ) : null}
              <button
                type="button"
                className="ws-pairing-btn ws-pairing-btn--stop"
                onClick={onStop}
                disabled={busy}
              >
                Stop
              </button>
            </div>
          </div>
        ) : null}

        {status.state === "failed" ? (
          <div className="ws-pairing-body">
            <div className="ws-pairing-error-box">
              <span className="ws-pairing-label">Reason</span>
              <p className="ws-pairing-error-text">{status.reason}</p>
            </div>
            <div className="ws-pairing-actions">
              <button
                type="button"
                className="ws-pairing-btn ws-pairing-btn--primary"
                onClick={onStart}
                disabled={busy}
              >
                Try again
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
