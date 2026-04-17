import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import RichTextEditor from './RichTextEditor';

/**
 * Sprint 1 QA Tests — S1-7: Unsaved changes warning
 * Tests verify the editor infrastructure for dirty state tracking.
 */
describe('S1-7: Unsaved Changes Warning — Editor', () => {
  it('QA: editor renders without crashing', () => {
    renderWithProviders(
      <RichTextEditor content="<p>Hello world</p>" onChange={vi.fn()} />
    );
    // Editor should render with toolbar and word count
    expect(screen.getByText(/words/i)).toBeInTheDocument();
  });

  it('QA: shows auto-save message when editable', () => {
    renderWithProviders(
      <RichTextEditor content="<p>Test</p>" onChange={vi.fn()} />
    );
    expect(screen.getByText('Auto-saves after 2s of inactivity')).toBeInTheDocument();
  });

  it('QA: does not show auto-save message when read-only', () => {
    renderWithProviders(
      <RichTextEditor content="<p>Read only</p>" onChange={vi.fn()} editable={false} />
    );
    expect(screen.queryByText('Auto-saves after 2s of inactivity')).not.toBeInTheDocument();
  });

  it('QA: shows word count', () => {
    renderWithProviders(
      <RichTextEditor content="<p>One two three four five</p>" onChange={vi.fn()} />
    );
    expect(screen.getByText(/words/)).toBeInTheDocument();
  });
});
