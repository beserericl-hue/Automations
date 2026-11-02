import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import OutlineReviseBox from './OutlineReviseBox';
import { apiFetch, ApiError } from '../../lib/api';

vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), apiFetch: vi.fn() }));

const api = vi.mocked(apiFetch);

/** Route the mocked apiFetch: the revise POST, then a sequence of job-status answers. */
function engine(statuses: unknown[], start: () => unknown = () => ({ jobId: 'job-9' })) {
  let i = 0;
  api.mockImplementation(async (path: string) => {
    if (path.endsWith('/outline/revise')) return start();
    if (path.includes('/status')) return statuses[Math.min(i++, statuses.length - 1)];
    return {};
  });
}

beforeEach(() => {
  api.mockReset();
  window.sessionStorage.clear();
});

describe('OutlineReviseBox', () => {
  it('keeps Revise disabled until there is a directive, then sends it for the project', async () => {
    engine([{ status: 'queued' }]);
    renderWithProviders(<OutlineReviseBox projectId="p1" chapterCount={4} />);
    const submit = screen.getByTestId('outline-revise-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Outline revision instructions'), { target: { value: 'Add a 1650 timeline.' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/projects/p1/outline/revise', { method: 'POST', body: JSON.stringify({ directive: 'Add a 1650 timeline.' }) }),
    );
    expect(await screen.findByTestId('outline-revise-progress')).toHaveTextContent(/Queued/);
    expect(screen.getByTestId('outline-revise-submit')).toBeDisabled();
    // The running job survives a remount (kept in the session).
    expect(JSON.parse(window.sessionStorage.getItem('ww.outlineRevise.p1')!).jobId).toBe('job-9');
  });

  it('reports the revision when the job completes, and clears the saved job', async () => {
    engine([{ status: 'complete', result: { status: 'ok', payload: { result: { revised: true, chapters_before: 4, chapters_after: 7, persist: { persisted: true } } } } }]);
    renderWithProviders(<OutlineReviseBox projectId="p1" chapterCount={4} />);
    fireEvent.change(screen.getByLabelText('Outline revision instructions'), { target: { value: 'Add three chapters.' } });
    fireEvent.click(screen.getByTestId('outline-revise-submit'));
    expect(await screen.findByTestId('outline-revise-result')).toHaveTextContent('Outline revised: 4 → 7 chapters');
    expect(window.sessionStorage.getItem('ww.outlineRevise.p1')).toBeNull();
    fireEvent.click(screen.getByTestId('outline-revise-dismiss'));
    expect(screen.queryByTestId('outline-revise-result')).toBeNull();
  });

  it('says what the engine said when it completed without revising', async () => {
    engine([{ status: 'complete', result: { payload: { result: { revised: false, error: 'no outline to revise' } } } }]);
    renderWithProviders(<OutlineReviseBox projectId="p1" chapterCount={4} />);
    fireEvent.change(screen.getByLabelText('Outline revision instructions'), { target: { value: 'Add three chapters.' } });
    fireEvent.click(screen.getByTestId('outline-revise-submit'));
    expect(await screen.findByTestId('outline-revise-error')).toHaveTextContent('did not revise the outline: no outline to revise');
  });

  it('shows a credits error from the server', async () => {
    engine([], () => {
      throw new ApiError(402, 'INSUFFICIENT_CREDITS', 'This needs 3 credits; you have 1.');
    });
    renderWithProviders(<OutlineReviseBox projectId="p1" chapterCount={4} />);
    fireEvent.change(screen.getByLabelText('Outline revision instructions'), { target: { value: 'Add three chapters.' } });
    fireEvent.click(screen.getByTestId('outline-revise-submit'));
    expect(await screen.findByTestId('outline-revise-error')).toHaveTextContent('Not enough credits: This needs 3 credits; you have 1.');
  });
});
