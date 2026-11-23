import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import ExportDraftButton from './ExportDraftButton';

vi.mock('../../config/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } },
}));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:x');
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
});

describe('Export Draft', () => {
  it('asks for the outline draft with the session token and downloads the Word file the server names', async () => {
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']), headers: new Headers({ 'Content-Disposition': 'attachment; filename="The_Ossuary_outline_draft.docx"' }) });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderWithProviders(<ExportDraftButton projectId="p1" part="outline" />);
    fireEvent.click(screen.getByTestId('export-draft-outline'));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/export/project/p1/draft/outline');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok');
    expect(await screen.findByText(/outline draft is downloading/)).toBeInTheDocument();
  });

  it('asks for the manuscript for the chapter list, and shows the reason when the server refuses', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'This project has no chapters with text yet.' } }) });
    renderWithProviders(<ExportDraftButton projectId="p1" part="manuscript" />);
    fireEvent.click(screen.getByTestId('export-draft-manuscript'));
    expect(await screen.findByText('This project has no chapters with text yet.')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/export/project/p1/draft/manuscript');
    expect(screen.getByTestId('export-draft-manuscript')).not.toBeDisabled();
  });

  it('in a series: one book, or several chosen books, or the whole manuscript', async () => {
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']), headers: new Headers() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const books = [1, 2, 3].map((i) => ({ index: i, title: `T${i}`, first_chapter: i * 10, last_chapter: i * 10 + 9 })) as never;
    renderWithProviders(<ExportDraftButton projectId="p1" part="manuscript" books={books} />);
    fireEvent.click(screen.getByTestId('export-draft-manuscript'));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('export-draft-only-2'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/export/project/p1/draft/manuscript?books=2');
    fireEvent.click(screen.getByTestId('export-draft-manuscript'));
    fireEvent.click(screen.getByTestId('export-draft-book-3'));
    fireEvent.click(screen.getByTestId('export-draft-book-1'));
    fireEvent.click(screen.getByTestId('export-draft-selected'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe('/api/export/project/p1/draft/manuscript?books=1,3');
    fireEvent.click(screen.getByTestId('export-draft-manuscript'));
    fireEvent.click(screen.getByTestId('export-draft-all'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2][0]).toBe('/api/export/project/p1/draft/manuscript');
  });
});
