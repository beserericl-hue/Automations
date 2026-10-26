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

describe('a refetch does not erase what is being typed', () => {
  it('keeps unsaved edits when the saved copy comes back, and loads new content when there are none', async () => {
    const { fireEvent } = await import('../../test/test-utils');
    const onChange = vi.fn();
    const { rerender, container } = renderWithProviders(<RichTextEditor content="<p>Saved text</p>" onChange={onChange} />);
    const doc = () => container.querySelector('.ProseMirror')!;
    // An edit the author has made and not yet saved (the toolbar turns the paragraph into a heading).
    fireEvent.click(screen.getByRole('button', { name: 'H1' }));
    expect(doc().innerHTML).toContain('<h1>');
    // The save's refetch lands with the server's copy: the edit must survive it.
    rerender(<RichTextEditor content="<p>Saved text, as stored</p>" onChange={onChange} />);
    expect(doc().innerHTML).toContain('<h1>Saved text</h1>');
    expect(doc().textContent).not.toContain('as stored');
  });

  it('with nothing unsaved, new content from the server replaces the document', () => {
    const { rerender, container } = renderWithProviders(<RichTextEditor content="<p>Old</p>" onChange={vi.fn()} />);
    rerender(<RichTextEditor content="<p>Rewritten by the engine</p>" onChange={vi.fn()} />);
    expect(container.querySelector('.ProseMirror')!.textContent).toBe('Rewritten by the engine');
  });
});
