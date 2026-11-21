import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import { apiFetch } from '../../lib/api';
import { FormatBlock } from './FormatBlock';
import FormatBlockPanel from './FormatBlockPanel';
import RichTextEditor from './RichTextEditor';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockFetch = vi.mocked(apiFetch);

const make = (content: string) => new Editor({ extensions: [StarterKit, FormatBlock], content });
/** The saved HTML as a document, so the checks are on what is there and not on how it is spelled. */
const dom = (html: string): HTMLElement => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};
const texts = (el: Element | null | undefined) => Array.from(el?.querySelectorAll('p') ?? []).map((p) => p.textContent);

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (String(path).endsWith('/format-presets')) {
      if (init?.method === 'PUT') return { success: true, data: { presets: JSON.parse(String(init.body)).presets } } as never;
      return { success: true, data: { presets: [{ name: 'Letter', style: { preset: 'Letter', font: 'typewriter', size: 95, align: 'left', indent: 2, spacing: 1.4, italic: false } }] } } as never;
    }
    return { success: true } as never;
  });
});

describe('the formatting block in the chapter', () => {
  it('wraps only the selected paragraph, with its look written into the saved HTML', () => {
    const ed = make('<p>One.</p><p>Dear Marcus,</p><p>Three.</p>');
    ed.commands.setTextSelection(ed.state.doc.child(0).nodeSize + 2);
    ed.commands.setFormatBlock({ font: 'typewriter', size: 95, indent: 2 });
    const root = dom(ed.getHTML());
    const blocks = root.querySelectorAll('div[data-format-block]');
    expect(blocks).toHaveLength(1);
    const b = blocks[0] as HTMLElement;
    expect(b.getAttribute('data-font')).toBe('typewriter');
    expect(b.getAttribute('data-size')).toBe('95');
    expect(b.getAttribute('data-indent')).toBe('2');
    expect(b.style.fontFamily).toContain('Courier');
    expect(texts(b)).toEqual(['Dear Marcus,']);
    expect(texts(root).slice(0, 3)).toEqual(['One.', 'Dear Marcus,', 'Three.']);
    expect(Array.from(root.children).filter((c) => c.tagName === 'P').slice(0, 2).map((c) => c.textContent)).toEqual(['One.', 'Three.']);
  });

  it('is read back from saved HTML with its look intact', () => {
    const ed = make('<div data-format-block="" data-font="sans" data-size="90" data-align="center" data-indent="1" data-spacing="1.8" data-italic="true"><p>A poem.</p></div>');
    ed.commands.setTextSelection(3);
    expect(ed.getAttributes('formatBlock')).toMatchObject({ font: 'sans', size: '90', align: 'center', italic: 'true' });
    const b = dom(ed.getHTML()).querySelector('div[data-format-block]') as HTMLElement;
    expect(b.style.fontStyle).toBe('italic');
    expect(b.style.textAlign).toBe('center');
  });

  it('changes the look of the block only, and removing it keeps the text', () => {
    const ed = make('<p>One.</p><div data-format-block="" data-font="serif" data-size="100"><p>Dear Marcus,</p></div>');
    ed.commands.setTextSelection(ed.state.doc.child(0).nodeSize + 3);
    ed.commands.updateFormatBlock({ align: 'center', size: 120 });
    const b = dom(ed.getHTML()).querySelector('div[data-format-block]') as HTMLElement;
    expect(b.style.textAlign).toBe('center');
    expect(b.style.fontSize).toBe('120%');
    ed.commands.unsetFormatBlock();
    const root = dom(ed.getHTML());
    expect(root.querySelector('div[data-format-block]')).toBeNull();
    expect(texts(root).slice(0, 2)).toEqual(['One.', 'Dear Marcus,']);
  });

  it('cannot carry a font or size the exports do not know', () => {
    const ed = make('<div data-format-block="" data-font="comic; background:red" data-size="99999"><p>x</p></div>');
    const b = dom(ed.getHTML()).querySelector('div[data-format-block]') as HTMLElement;
    expect(b.style.background).toBe('');
    expect(b.style.fontSize).toBe('150%');
  });
});

describe('the formatting-block panel', () => {
  it('is opened from the toolbar and lists the author\'s saved looks', async () => {
    renderWithProviders(<RichTextEditor content="<p>Hello there.</p>" onChange={vi.fn()} />);
    expect(screen.queryByTestId('format-block-panel')).toBeNull();
    fireEvent.click(screen.getByTitle(/Format block/));
    expect(await screen.findByTestId('format-block-panel')).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Letter' })).toBeInTheDocument();
  });

  it('saves the current look under a name, in the author\'s list', async () => {
    const ed = make('<p>Hello there.</p>');
    renderWithProviders(<FormatBlockPanel editor={ed as never} />);
    // Saving waits for the saved list, so a save can never replace looks that have not loaded yet.
    await screen.findByRole('option', { name: 'Letter' });
    fireEvent.change(screen.getByLabelText('Block font'), { target: { value: 'typewriter' } });
    fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: 'Telegram' } });
    fireEvent.click(screen.getByText('Save this look'));
    await waitFor(() => {
      const put = mockFetch.mock.calls.find(([, o]) => (o as { method?: string } | undefined)?.method === 'PUT');
      const body = JSON.parse(String((put![1] as { body: string }).body));
      expect(body.presets.map((p: { name: string }) => p.name)).toEqual(['Letter', 'Telegram']);
      expect(body.presets[1].style.font).toBe('typewriter');
    });
  });

  it('shows the look on the selected words before it is applied', () => {
    const ed = make('<p>Dear Marcus.</p>');
    renderWithProviders(<FormatBlockPanel editor={ed as never} />);
    fireEvent.change(screen.getByLabelText('Block alignment'), { target: { value: 'center' } });
    const preview = screen.getByTestId('format-block-preview').firstElementChild as HTMLElement;
    expect(preview.style.textAlign).toBe('center');
  });
});
