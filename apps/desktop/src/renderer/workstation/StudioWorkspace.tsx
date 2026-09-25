/** A Studio stage changes the view of one case without replacing its editor or resources. */
import type { ReactNode } from 'react';
import './studio-workspace.css';

export type StudioStage = 'direction' | 'design' | 'review' | 'deliver';

export interface StudioWorkspaceProps {
  caseId: string;
  title: string;
  stage: StudioStage;
  onStageChange(stage: StudioStage): void;
  direction: ReactNode;
  editingSurface: ReactNode;
  resources: ReactNode;
  onClose(): void;
}

const STAGES: { id: StudioStage; label: string }[] = [
  { id: 'direction', label: 'Direction' },
  { id: 'design', label: 'Design' },
  { id: 'review', label: 'Review' },
  { id: 'deliver', label: 'Deliver' },
];

export function StudioWorkspace({
  caseId,
  title,
  stage,
  onStageChange,
  direction,
  editingSurface,
  resources,
  onClose,
}: StudioWorkspaceProps) {
  return (
    <div className="ws-studio" data-case-id={caseId}>
      <header className="ws-studio-header">
        <h2 className="ws-studio-title">{title}</h2>
        <nav className="ws-studio-nav" aria-label="Studio stages">
          {STAGES.map((s) => (
            <button
              key={s.id}
              type="button"
              className="ws-studio-tab"
              aria-pressed={stage === s.id}
              onClick={() => onStageChange(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="ws-studio-close"
          aria-label="Close studio"
          onClick={onClose}
        >
          Close
        </button>
      </header>
      <div className="ws-studio-body">
        <div className="ws-studio-main">
          <div className="ws-studio-pane" hidden={stage !== 'direction'}>
            {direction}
          </div>
          <div className="ws-studio-pane" hidden={stage === 'direction'}>
            {editingSurface}
          </div>
        </div>
        <aside className="ws-studio-resources" aria-label="Resources">
          <header className="ws-studio-resources-header">
            <h3>Resources</h3>
          </header>
          <div className="ws-studio-resources-body">
            {resources}
          </div>
        </aside>
      </div>
    </div>
  );
}
