import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { StudioWorkspace, type StudioStage } from './StudioWorkspace';

afterEach(cleanup);

describe('StudioWorkspace', () => {
  it('preserves editing surface mount and child draft edits across all stage transitions', () => {
    function TestHarness() {
      const [stage, setStage] = useState<StudioStage>('design');
      return (
        <StudioWorkspace
          caseId="case-101"
          title="Case Proposal Draft"
          stage={stage}
          onStageChange={setStage}
          direction={<textarea data-testid="direction-input" defaultValue="Initial brief" />}
          editingSurface={<textarea data-testid="editor-input" defaultValue="Initial surface draft" />}
          resources={<div>Resource List</div>}
          onClose={vi.fn()}
        />
      );
    }

    render(<TestHarness />);

    const editor = screen.getByTestId('editor-input') as HTMLTextAreaElement;
    const direction = screen.getByTestId('direction-input') as HTMLTextAreaElement;

    // Edit in design
    fireEvent.change(editor, { target: { value: 'Working draft text' } });
    expect(editor.value).toBe('Working draft text');

    // Switch to review: same mounted surface and draft preserved
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(editor.closest('.ws-studio-pane')).not.toHaveAttribute('hidden');
    expect(editor.value).toBe('Working draft text');

    // Switch to direction: editor hidden but remains mounted, direction visible
    fireEvent.click(screen.getByRole('button', { name: 'Direction' }));
    expect(editor.closest('.ws-studio-pane')).toHaveAttribute('hidden');
    expect(direction.closest('.ws-studio-pane')).not.toHaveAttribute('hidden');
    fireEvent.change(direction, { target: { value: 'Updated prompt brief' } });

    // Switch to deliver: editor visible again with uncorrupted draft, direction hidden with preserved state
    fireEvent.click(screen.getByRole('button', { name: 'Deliver' }));
    expect(editor.closest('.ws-studio-pane')).not.toHaveAttribute('hidden');
    expect(editor.value).toBe('Working draft text');
    expect(direction.closest('.ws-studio-pane')).toHaveAttribute('hidden');
    expect(direction.value).toBe('Updated prompt brief');
  });

  it('keeps resources and heading accessible across all stages', () => {
    const { rerender } = render(
      <StudioWorkspace
        caseId="case-101"
        title="Case Proposal Draft"
        stage="direction"
        onStageChange={vi.fn()}
        direction={<div>Direction</div>}
        editingSurface={<div>Editor</div>}
        resources={<div data-testid="resource-item">Primary Spec Document</div>}
        onClose={vi.fn()}
      />
    );

    const stages: StudioStage[] = ['direction', 'design', 'review', 'deliver'];
    for (const stage of stages) {
      rerender(
        <StudioWorkspace
          caseId="case-101"
          title="Case Proposal Draft"
          stage={stage}
          onStageChange={vi.fn()}
          direction={<div>Direction</div>}
          editingSurface={<div>Editor</div>}
          resources={<div data-testid="resource-item">Primary Spec Document</div>}
          onClose={vi.fn()}
        />
      );
      expect(screen.getByRole('heading', { name: /resources/i })).toBeInTheDocument();
      expect(screen.getByTestId('resource-item')).toBeInTheDocument();
    }
  });

  it('calls onClose without resetting child draft state', () => {
    const onClose = vi.fn();
    render(
      <StudioWorkspace
        caseId="case-101"
        title="Case Proposal Draft"
        stage="design"
        onStageChange={vi.fn()}
        direction={<div>Direction</div>}
        editingSurface={<input data-testid="editor-input" defaultValue="clean draft" />}
        resources={<div>Resources</div>}
        onClose={onClose}
      />
    );

    const input = screen.getByTestId('editor-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'unsaved user work' } });

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('unsaved user work');
  });
});
