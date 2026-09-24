import { Icon, Modal, ProviderGlyph } from "./ui.js";

export type CapabilityId =
  | "long-context"
  | "reads-files"
  | "asks-before-acting"
  | "reasons-in-steps"
  | "reads-images"
  | "writes-code"
  | "stays-on-this-mac"
  | "picks-effort";

export interface Capability {
  readonly id: CapabilityId;
  readonly title: string;
  readonly line: string;
  readonly observed: boolean;
  readonly because: string;
}

export interface ProviderMenu {
  readonly id: string;
  readonly label: string;
  readonly family: string;
  readonly usable: boolean;
  readonly unusableBecause: string | null;
  readonly capabilities: readonly Capability[];
  readonly models: readonly {
    readonly id: string;
    readonly label: string;
    readonly note: string;
  }[];
  readonly effortLevels: readonly {
    readonly id: string;
    readonly label: string;
    readonly line: string;
  }[];
  readonly summary: string;
}

export interface ModelMenuProps {
  readonly menus: readonly ProviderMenu[];
  readonly chosenId: string | null;
  readonly chosenModelId: string;
  readonly chosenEffort: string | null;
  readonly onChoose: (providerId: string) => void;
  readonly onModel: (modelId: string) => void;
  readonly onEffort: (effort: string | null) => void;
  readonly onClose: () => void;
  readonly disabled: boolean;
}

export function ModelMenu({
  menus,
  chosenId,
  chosenModelId,
  chosenEffort,
  onChoose,
  onModel,
  onEffort,
  onClose,
  disabled,
}: ModelMenuProps) {
  return (
    <Modal title="Choose your AI" eyebrow="What each one can do" wide onClose={onClose}>
      <div className="ws-menu-container">
        <div className="ws-menu-card-list" role="list">
          {menus.map((menu) => {
            const isChosen = chosenId === menu.id;
            const triggerId = `ws-menu-trigger-${menu.id}`;
            const panelId = `ws-menu-panel-${menu.id}`;

            return (
              <div
                key={menu.id}
                className={`ws-menu-card ${isChosen ? "ws-menu-card--chosen" : ""} ${!menu.usable ? "ws-menu-card--unusable" : ""}`}
                role="listitem"
              >
                <button
                  type="button"
                  id={triggerId}
                  className={`ws-menu-card-trigger ${isChosen ? "ws-menu-card-trigger--chosen" : ""} ${!menu.usable ? "ws-menu-card-trigger--unusable" : ""}`}
                  onClick={() => {
                    if (!menu.usable || disabled) {
                      return;
                    }
                    onChoose(menu.id);
                  }}
                  disabled={!menu.usable || disabled}
                  aria-expanded={menu.usable ? isChosen : false}
                  {...(menu.usable && isChosen ? { "aria-controls": panelId } : {})}
                >
                  <div className="ws-menu-card-identity">
                    <ProviderGlyph family={menu.family} />
                    <div className="ws-menu-card-header-text">
                      <div className="ws-menu-card-title-row">
                        <span className="ws-menu-card-title">{menu.label}</span>
                        <span
                          className={`ws-menu-card-status ${menu.usable ? "ws-menu-card-status--usable" : "ws-menu-card-status--unusable"}`}
                        >
                          {menu.usable ? "Ready" : "Unavailable"}
                        </span>
                      </div>
                      <p className="ws-menu-card-summary">{menu.summary}</p>
                    </div>
                  </div>
                  {!menu.usable && menu.unusableBecause ? (
                    <div className="ws-menu-card-unusable-reason">
                      {menu.unusableBecause}
                    </div>
                  ) : null}
                </button>

                {menu.usable && isChosen ? (
                  <div
                    id={panelId}
                    className="ws-menu-expanded-panel"
                    role="region"
                    aria-labelledby={triggerId}
                  >
                    <div className="ws-menu-section ws-menu-capabilities-section">
                      <h3 className="ws-menu-section-title">Capabilities</h3>
                      <div
                        className="ws-menu-capabilities-grid"
                        role="list"
                        aria-label={`Capabilities for ${menu.label}`}
                      >
                        {menu.capabilities.map((cap) => (
                          <div
                            key={cap.id}
                            className={`ws-menu-capability-chip ${cap.observed ? "ws-menu-capability-chip--observed" : "ws-menu-capability-chip--unobserved ws-menu-capability-chip--quiet"}`}
                            title={cap.because}
                            role="listitem"
                          >
                            <span className="ws-menu-capability-icon" aria-hidden="true">
                              <Icon name={cap.observed ? "check" : "minus"} size={13} />
                            </span>
                            <span className="ws-menu-capability-name">{cap.title}</span>
                            <span className="ws-menu-capability-state-tag">
                              {cap.observed ? "Observed" : "Unchecked"}
                            </span>
                            {cap.line ? (
                              <span className="ws-menu-capability-line">{cap.line}</span>
                            ) : null}
                            {/* Keep reason readable in DOM for assistive tech when not yet verified */}
                            {!cap.observed ? (
                              <span className="ws-menu-capability-because">
                                {cap.because}
                              </span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>

                    {menu.models.length > 0 ? (
                      <div className="ws-menu-section ws-menu-models-section">
                        <h3 className="ws-menu-section-title">Model</h3>
                        <div className="ws-menu-models-list">
                          {menu.models.map((model, index) => {
                            const isSelected =
                              chosenModelId === model.id ||
                              (chosenModelId === "" && index === 0);
                            return (
                              <button
                                key={model.id}
                                type="button"
                                className={`ws-menu-model-option ${isSelected ? "ws-menu-model-option--selected" : ""}`}
                                onClick={() => onModel(model.id)}
                                disabled={disabled}
                                aria-pressed={isSelected}
                              >
                                <span className="ws-menu-model-label">{model.label}</span>
                                {model.note ? (
                                  <span className="ws-menu-model-note">{model.note}</span>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}

                    {menu.effortLevels.length > 0 ? (
                      <div className="ws-menu-section ws-menu-effort-section">
                        <h3 className="ws-menu-section-title">Thinking effort</h3>
                        <div className="ws-menu-effort-options">
                          {menu.effortLevels.map((effort) => {
                            const isSelected = chosenEffort === effort.id;
                            return (
                              <button
                                key={effort.id}
                                type="button"
                                className={`ws-menu-effort-option ${isSelected ? "ws-menu-effort-option--selected" : ""}`}
                                onClick={() => onEffort(effort.id)}
                                disabled={disabled}
                                aria-pressed={isSelected}
                              >
                                <span className="ws-menu-effort-label">{effort.label}</span>
                                <span className="ws-menu-effort-line">{effort.line}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
