/**
 * Mark's Telegram token.
 *
 * The one place in Settings with a Save button, and the exception is
 * deliberate: everything else here is a choice that can be changed back in a
 * second, while this is a credential being typed character by character.
 * Applying it on every keystroke would write dozens of half-tokens to the
 * keychain and reject each one.
 *
 * ## The token is never read back
 *
 * Nothing on this screen can display it. The renderer is told only whether one
 * is saved, because a screen that can show a credential is a screen that can
 * leak it — into a screenshot, a support thread, a diagnostics bundle. To
 * change it, you paste a new one; to stop using it, you forget it.
 *
 * ## It takes effect at the next launch
 *
 * Mark's channels are built once at startup. Saying "saved" while the running
 * app still has no Telegram would be the kind of quiet half-truth this product
 * spends its credibility avoiding, so the screen says which it is.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Chip, Field } from "./ui";

export interface TelegramStatus {
  readonly saved: boolean;
  readonly encryptionAvailable: boolean;
}

export function TelegramSetting({
  onStatus,
  onSave,
  onForget
}: {
  readonly onStatus: () => Promise<TelegramStatus>;
  readonly onSave: (token: string) => Promise<{ saved: boolean; said: string }>;
  readonly onForget: () => Promise<{ saved: boolean; said: string }>;
}) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unreachable, setUnreachable] = useState(false);

  const alive = useRef(true);
  // Monotonic: a status asked for earlier must never overwrite a later answer.
  // Without it the first read can land after a save and put the screen back to
  // "not saved" for a token that is now stored.
  const request = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++request.current;
    try {
      const next = await onStatus();
      if (alive.current && mine === request.current) {
        setStatus(next);
        setUnreachable(false);
      }
    } catch {
      // Without this the screen sits on "Checking…" for ever and can never show
      // the encryption refusal, which is the message that matters most here.
      if (alive.current && mine === request.current) {
        setUnreachable(true);
      }
    }
  }, [onStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const answer = await onSave(token);
      if (!alive.current) return;
      setSaid(answer.said);
      if (answer.saved) {
        // Cleared on success only: a rejected token stays in the box so the
        // owner can see what they pasted rather than fetching it again.
        setToken("");
        await refresh();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function forget(): Promise<void> {
    setBusy(true);
    try {
      const answer = await onForget();
      if (!alive.current) return;
      // Cleared too. A replacement pasted before changing their mind would
      // otherwise sit in state and in the input after the stored one is gone.
      setToken("");
      setSaid(answer.said);
      await refresh();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  if (unreachable) {
    return (
      <p className="muted">
        Rellane could not check whether a bot token is stored. Nothing has changed. Try again after
        restarting.
      </p>
    );
  }

  if (status === null) {
    return <p className="muted">Checking…</p>;
  }

  if (!status.encryptionAvailable) {
    // Refusing, not degrading. DESIGN.md principle 5: a silent fallback is how
    // "encrypted" becomes a lie, so there is no box to type into at all.
    return (
      <p className="muted">
        This Mac will not give Rellane an encryption key, so a bot token cannot be stored safely
        here. Telegram stays off rather than keeping it in plain text.
      </p>
    );
  }

  return (
    <>
      <p className="muted">
        {status.saved ? (
          <>
            <Chip tone="ok">Saved</Chip> Mark uses Telegram from the next time Rellane starts. The
            token is not shown again — paste a new one to change it.
          </>
        ) : (
          <>
            Create a bot with @BotFather in Telegram and paste the token it gives you. Mark answers
            questions and can stop work; it can never approve anything or change a file.
          </>
        )}
      </p>

      <Field label={status.saved ? "Replace the token" : "Bot token"}>
        <input
          type="password"
          value={token}
          autoComplete="off"
          spellCheck={false}
          placeholder="1234567890:AA…"
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>

      <div className="setting-actions">
        <Button tone="primary" disabled={busy || token.trim() === ""} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        {status.saved ? (
          <Button disabled={busy} onClick={() => void forget()}>
            Forget it
          </Button>
        ) : null}
      </div>

      {said === null ? null : (
        <p className="muted" role="status">
          {said}
        </p>
      )}
    </>
  );
}
