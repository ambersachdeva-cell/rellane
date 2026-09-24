import { useState, type ReactNode } from "react";
import { Icon, ProviderGlyph } from "./ui.js";

export interface CrewSeatChoice {
  readonly id: string;
  readonly label: string;
  readonly family: string;
  readonly detail: string;
  readonly usable: boolean;
}

/** The picker itself, used inside the existing Modal by the caller. */
export interface CrewPickerProps {
  readonly seats: readonly CrewSeatChoice[];
  readonly chosen: readonly string[];
  readonly onToggle: (id: string) => void;
  readonly onClear: () => void;
  readonly max: number;
}

interface ChosenSeatSummary {
  readonly id: string;
  readonly label: string;
  readonly family: string;
  readonly position: number;
}

/** The strip in the composer showing who is coming, in order. */
export interface CrewStripProps {
  readonly seats: readonly CrewSeatChoice[];
  readonly chosen: readonly string[];
  readonly onOpen: () => void;
  readonly onRemove: (id: string) => void;
  readonly disabled: boolean;
}

export function CrewPicker(props: CrewPickerProps): ReactNode {
  const [limitNotice, setLimitNotice] = useState<string | null>(null);

  const handleToggle = (seat: CrewSeatChoice) => {
    if (!seat.usable) {
      return;
    }
    const isAlreadyChosen = props.chosen.includes(seat.id);
    if (isAlreadyChosen) {
      // Deselection never breaches a quota boundary, so clear any notice.
      setLimitNotice(null);
      props.onToggle(seat.id);
      return;
    }
    if (props.chosen.length >= props.max) {
      // State quota limits plainly so the interface does not silently drop clicks.
      const noun = props.max === 1 ? "subscription" : "subscriptions";
      setLimitNotice(`You can choose up to ${props.max} ${noun}.`);
      return;
    }
    setLimitNotice(null);
    props.onToggle(seat.id);
  };

  const handleClear = () => {
    setLimitNotice(null);
    props.onClear();
  };

  const chosenLabels: string[] = [];
  for (const id of props.chosen) {
    const seat = props.seats.find((candidate) => candidate.id === id);
    if (seat) {
      chosenLabels.push(seat.label);
    } else {
      chosenLabels.push(id);
    }
  }

  let statusSummary = "No subscriptions chosen.";
  if (chosenLabels.length === 1) {
    const label = chosenLabels[0]!;
    statusSummary = `1 subscription chosen: ${label}.`;
  } else if (chosenLabels.length > 1) {
    statusSummary = `${chosenLabels.length} subscriptions chosen in order: ${chosenLabels.join(", ")}.`;
  }

  return (
    <div className="ws-crew-picker">
      <div className="ws-crew-picker-header">
        <div role="status" className="ws-crew-status" aria-live="polite">
          {statusSummary}
        </div>
        <p className="ws-crew-order-hint">The first bot takes the first part.</p>
        {limitNotice ? (
          <p role="alert" className="ws-crew-limit-warning">
            {limitNotice}
          </p>
        ) : null}
      </div>

      {props.seats.length === 0 ? (
        <p className="ws-crew-empty">No subscriptions available.</p>
      ) : (
        <div className="ws-crew-seat-list">
          {props.seats.map((seat) => {
            const chosenIndex = props.chosen.indexOf(seat.id);
            const isChosen = chosenIndex !== -1;
            const position = chosenIndex + 1;

            return (
              <button
                key={seat.id}
                type="button"
                className={`ws-crew-seat-option ${isChosen ? "ws-crew-seat-option--chosen" : ""} ${!seat.usable ? "ws-crew-seat-option--disabled" : ""}`}
                disabled={!seat.usable}
                aria-pressed={isChosen}
                onClick={() => handleToggle(seat)}
              >
                <div className="ws-crew-seat-main">
                  <ProviderGlyph
                    family={seat.family}
                    {...(position > 0 ? { badge: position } : {})}
                  />
                  <div className="ws-crew-seat-copy">
                    <div className="ws-crew-seat-header">
                      <span className="ws-crew-seat-name">{seat.label}</span>
                      {position > 0 ? (
                        <>
                          <span className="ws-crew-position-badge">
                            Position {position}
                          </span>
                          <span className="ws-crew-part-badge">
                            Part {position}
                          </span>
                        </>
                      ) : null}
                    </div>
                    <span className="ws-crew-seat-detail">{seat.detail}</span>
                  </div>
                </div>
                <div className="ws-crew-seat-state" aria-hidden="true">
                  {isChosen ? (
                    <span className="ws-crew-check-icon">
                      <Icon name="check" size={16} />
                    </span>
                  ) : seat.usable ? (
                    <span className="ws-crew-plus-icon">
                      <Icon name="plus" size={16} />
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="ws-crew-picker-footer">
        <button
          type="button"
          className="ws-crew-clear-button"
          onClick={handleClear}
          disabled={props.chosen.length === 0}
        >
          Clear selection
        </button>
      </div>
    </div>
  );
}

export function CrewStrip(props: CrewStripProps): ReactNode {
  if (props.chosen.length === 0) {
    return (
      <div className="ws-crew-strip ws-crew-strip--empty">
        <button
          type="button"
          className="ws-crew-strip-open"
          onClick={props.onOpen}
          disabled={props.disabled}
          aria-label="Choose bots"
        >
          <Icon name="plus" size={14} />
          <span>Choose bots</span>
        </button>
      </div>
    );
  }

  if (props.chosen.length === 1) {
    const firstId = props.chosen[0]!;
    const seat = props.seats.find((candidate) => candidate.id === firstId);
    const label = seat ? seat.label : firstId;
    const family = seat ? seat.family : "local";

    return (
      <div className="ws-crew-strip ws-crew-strip--single">
        <div className="ws-crew-strip-seat">
          <button
            type="button"
            className="ws-crew-strip-seat-trigger"
            onClick={props.onOpen}
            disabled={props.disabled}
            aria-label={`${label}. Choose subscriptions`}
          >
            <ProviderGlyph family={family} small={true} />
            <span className="ws-crew-strip-seat-label">{label}</span>
          </button>
          <button
            type="button"
            className="ws-crew-strip-remove"
            onClick={() => props.onRemove(firstId)}
            disabled={props.disabled}
            aria-label={`Remove ${label}`}
            title={`Remove ${label}`}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
        <button
          type="button"
          className="ws-crew-strip-add"
          onClick={props.onOpen}
          disabled={props.disabled}
          aria-label="Add bot"
          title="Add bot"
        >
          <Icon name="plus" size={12} />
        </button>
      </div>
    );
  }

  // Order reflects assignment priority: the first chosen bot takes part one.
  const chosenSeats: ChosenSeatSummary[] = [];
  for (const [index, id] of props.chosen.entries()) {
    const seat = props.seats.find((candidate) => candidate.id === id);
    chosenSeats.push({
      id,
      label: seat ? seat.label : id,
      family: seat ? seat.family : "local",
      position: index + 1,
    });
  }

  return (
    <div className="ws-crew-strip ws-crew-strip--multiple">
      <div className="ws-crew-strip-list">
        {chosenSeats.map((seat) => (
          <div key={seat.id} className="ws-crew-strip-seat">
            <button
              type="button"
              className="ws-crew-strip-seat-trigger"
              onClick={props.onOpen}
              disabled={props.disabled}
              aria-label={`Position ${seat.position}: ${seat.label}. Choose subscriptions`}
            >
              <ProviderGlyph family={seat.family} small={true} badge={seat.position} />
              <span className="ws-crew-position-badge">Position {seat.position}</span>
              <span className="ws-crew-part-badge">Part {seat.position}</span>
              <span className="ws-crew-strip-seat-label">{seat.label}</span>
            </button>
            <button
              type="button"
              className="ws-crew-strip-remove"
              onClick={() => props.onRemove(seat.id)}
              disabled={props.disabled}
              aria-label={`Remove ${seat.label}`}
              title={`Remove ${seat.label}`}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
      <span className="ws-crew-strip-hint">The first bot takes the first part.</span>
      <button
        type="button"
        className="ws-crew-strip-add"
        onClick={props.onOpen}
        disabled={props.disabled}
        aria-label="Change subscriptions"
        title="Change subscriptions"
      >
        <Icon name="plus" size={12} />
      </button>
    </div>
  );
}
