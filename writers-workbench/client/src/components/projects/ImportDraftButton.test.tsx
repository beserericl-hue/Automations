import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import ImportDraftButton from './ImportDraftButton';

vi.mock('../../config/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } },
}));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

const preview = {
  items: [
    { chapter_number: 0, title: 'Surface', words: 100, action: 'replace', status: 'draft', existing_words: 90, has_blocks: false },
    { chapter_number: 2, title: 'Box', words: 200, action: 'new_version', status: 'approved', existing_words: 180, has_blocks: true },
    { chapter_number: 97, title: 'New', words: 300, action: 'add', status: null, existing_words: 0, has_blocks: false },
  ],
  counts: { replace: 1, new_version: 1, add: 1, untouched: 93 },
  qa_cost_each: 5,
  qa_cost_total: 15,
  credits_remaining: 100,
};

describe('Import Draft', () => {
  it('previews first, changes nothing until confirmed, then imports with the Q/A choice', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: preview }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { imported: 3, failed: 0, qa_started: 3, qa_failed: 0, results: [] } }) });
    renderWithProviders(<ImportDraftButton projectId="p1" />);
    const file = new File(['x'], 'edited.docx');
    fireEvent.change(screen.getByTestId('import-draft-file'), { target: { files: [file] } });
    expect(await screen.findByTestId('import-draft-summary')).toHaveTextContent('3 chapters in the file');
    expect(screen.getByText(/Has formatted blocks/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/draft-import/project/p1/preview');
    fireEvent.click(screen.getByTestId('import-draft-apply'));
    expect(await screen.findByTestId('import-draft-done')).toHaveTextContent('Imported 3 chapters');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/draft-import/project/p1/apply');
    expect((fetchMock.mock.calls[1][1].body as FormData).get('run_qa')).toBe('true');
  });

  it('shows the reason when the file has no chapters, and blocks Q/A the credits cannot cover', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: 'No chapters found.' } }) });
    renderWithProviders(<ImportDraftButton projectId="p1" />);
    fireEvent.change(screen.getByTestId('import-draft-file'), { target: { files: [new File(['x'], 'a.docx')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('No chapters found.');
    fireEvent.click(screen.getByText('Cancel'));
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { ...preview, credits_remaining: 4 } }) });
    fireEvent.change(screen.getByTestId('import-draft-file'), { target: { files: [new File(['x'], 'b.docx')] } });
    await waitFor(() => expect(screen.getByTestId('import-draft-apply')).toBeDisabled());
    fireEvent.click(screen.getByTestId('import-draft-qa'));
    expect(screen.getByTestId('import-draft-apply')).not.toBeDisabled();
  });
});
