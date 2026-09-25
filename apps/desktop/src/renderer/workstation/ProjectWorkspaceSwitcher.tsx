/** Compact identity controls keep a case's project separate from its granted folder. */
import type { ChangeEvent } from "react";
import type { WorkstationProject, WorkstationWorkspace } from "@cadrane/contracts";
import "./project-workspace-switcher.css";

export interface ProjectWorkspaceSwitcherProps {
  readonly projects: readonly WorkstationProject[];
  readonly projectId: string | null;
  readonly workspace: WorkstationWorkspace | null;
  readonly disabled: boolean;
  onSelectProject(id: string | null): void;
  onManageProjects(): void;
  onChooseWorkspace(): void;
  onUseDefaultWorkspace(): void;
}

const PERSONAL_PROJECT_SENTINEL = "__personal__";
const CURRENT_WORKSPACE_SENTINEL = "__current_workspace__";
const ACTION_CHOOSE_WORKSPACE = "__action_choose_workspace__";
const ACTION_DEFAULT_WORKSPACE = "__action_default_workspace__";

export function ProjectWorkspaceSwitcher({
  projects,
  projectId,
  workspace,
  disabled,
  onSelectProject,
  onManageProjects,
  onChooseWorkspace,
  onUseDefaultWorkspace,
}: ProjectWorkspaceSwitcherProps) {
  const handleProjectChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    onSelectProject(value === PERSONAL_PROJECT_SENTINEL ? null : value);
  };

  const handleWorkspaceChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value === ACTION_CHOOSE_WORKSPACE) {
      onChooseWorkspace();
    } else if (value === ACTION_DEFAULT_WORKSPACE) {
      onUseDefaultWorkspace();
    }
  };

  return (
    <div className="ws-switcher-bar" role="region" aria-label="Project and workspace switcher">
      <div className="ws-switcher-field">
        <label htmlFor="ws-project-select" className="ws-switcher-label">
          Project
        </label>
        <div className="ws-switcher-control-row">
          <select
            id="ws-project-select"
            className="ws-switcher-select"
            value={projectId ?? PERSONAL_PROJECT_SENTINEL}
            onChange={handleProjectChange}
            disabled={disabled}
          >
            <option value={PERSONAL_PROJECT_SENTINEL}>Personal</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ws-switcher-manage-btn"
            onClick={onManageProjects}
            disabled={disabled}
            title="Manage projects"
          >
            Manage
          </button>
        </div>
      </div>

      <div className="ws-switcher-field">
        <label htmlFor="ws-workspace-select" className="ws-switcher-label">
          Workspace folder
        </label>
        <select
          id="ws-workspace-select"
          className="ws-switcher-select"
          value={CURRENT_WORKSPACE_SENTINEL}
          onChange={handleWorkspaceChange}
          disabled={disabled}
          title={workspace?.path ?? undefined}
        >
          <option value={CURRENT_WORKSPACE_SENTINEL}>
            {workspace ? workspace.label : "Work's default folder"}
          </option>
          <option value={ACTION_CHOOSE_WORKSPACE}>Choose a folder</option>
          <option value={ACTION_DEFAULT_WORKSPACE}>Use work's default folder</option>
        </select>
      </div>
    </div>
  );
}
