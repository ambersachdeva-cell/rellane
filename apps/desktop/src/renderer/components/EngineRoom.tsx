/** Tool detection and local model readiness, with the evidence for each. */
import type { EngineRoomStatus, EngineState, EngineStatus } from "@cadrane/contracts";
import { Button } from "./ui";

interface Props {
  room: EngineRoomStatus | null;
  busy: boolean;
  onRefresh(): void;
  onModels(): void;
}

export function EngineRoom({ room, busy, onRefresh, onModels }: Props) {
  if (room === null) {
    return <p className="er__loading">Checking local models and provider tools.</p>;
  }
  const subscriptions = room.engines.filter(engine => engine.access === "subscription");
  const onDevice = room.engines.filter(engine => engine.access === "on-device");

  return (
    <div className="er">
      <header className="er__head">
        <p className="er__lede">Each result shows the check behind it. Refresh to check again.</p>
        <Button onClick={onRefresh} disabled={busy}>
          {busy ? "Checking…" : "Check again"}
        </Button>
      </header>
      {room.allUnavailable ? (
        <p className="er__none">
          No model is ready for a request. You can still organise sources, write outputs and
          review saved work. View Local models for installation status.
        </p>
      ) : null}
      <section className="er__group">
        <h3 className="er__grouphead">On this Mac</h3>
        <div><Button onClick={onModels}>View local models</Button></div>
        <ul className="er__rows">
          {onDevice.map(engine => <EngineRow key={engine.id} engine={engine} />)}
        </ul>
      </section>
      <section className="er__group">
        <h3 className="er__grouphead">Subscription tools</h3>
        <p className="er__groupwhy">
          Detected means the tool answered a version check. It does not confirm a signed-in
          account, a subscription or access to any model.
        </p>
        <p className="er__groupwhy">
          Subscription requests are not available in this build. They need a verified connection
          and a review of each outgoing message. No model prompts are sent by these checks.
        </p>
        <ul className="er__rows">
          {subscriptions.map(engine => <EngineRow key={engine.id} engine={engine} />)}
        </ul>
      </section>
    </div>
  );
}

function EngineRow({ engine }: { engine: EngineStatus }) {
  return (
    <li className={`erow erow--${engine.state}`}>
      <span className="erow__light" aria-hidden="true" />
      <div className="erow__body">
        <p className="erow__title">
          <span className="erow__name">{engine.label}</span>
          <span className="erow__state">{stateWord(engine.state)}</span>
        </p>
        <p className="erow__summary">{engine.summary}</p>

        {engine.fixHint === null ? null : <p className="erow__fix">{engine.fixHint}</p>}

        {engine.models.length === 0 ? null : (
          <ul className="erow__models">
            {engine.models.map((model) => (
              <li key={model.id} className="emodel">
                <span className="emodel__tier">{model.tierLabel}</span>
                <span className="emodel__name">{model.label}</span>
                <span className="emodel__note">{model.note}</span>
                {/**
                 * Marked only when it is *not* included, which is the same rule
                 * D-027 set for outcome chips: colour goes on the exception. Every
                 * model on a subscription being labelled "included" made the label
                 * carry no information and hid the one that would cost money.
                 */}
                {engine.access === "on-device" || model.includedInSubscription ? null : (
                  <span className="emodel__paid">costs extra</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {/**
         * The probe, on demand. This is the clickable source principle 4 asks
         * for: not a claim that it checked, but what it ran and what came back.
         */}
        {engine.evidence === null ? null : (
          <details className="erow__evidence">
            <summary className="erow__disclosure">How this was decided</summary>
            <dl className="erow__proof">
              <dt>Ran</dt>
              <dd>{engine.evidence.method}</dd>
              <dt>Got back</dt>
              <dd className="erow__result">{engine.evidence.result}</dd>
              {engine.evidence.executablePath === null ? null : (
                <>
                  <dt>Found at</dt>
                  <dd className="erow__path">{engine.evidence.executablePath}</dd>
                </>
              )}
              <dt>Checked</dt>
              <dd>{clock(engine.evidence.checkedAt)}</dd>
            </dl>
          </details>
        )}
      </div>
    </li>
  );
}

/**
 * The word beside the light.
 *
 * A version check cannot prove installation absence or authentication. Keep
 * the state label within the evidence that produced it.
 */
export function stateWord(state: EngineState): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "detected":
      return "Detected";
    case "not-installed":
      return "Not detected";
    case "checking":
      return "Starting";
    case "problem":
      return "Check failed";
  }
}

function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "just now";
  }
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
