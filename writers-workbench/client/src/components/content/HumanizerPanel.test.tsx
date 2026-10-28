import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import HumanizerPanel from './HumanizerPanel';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(async (path: string) =>
    path.endsWith('/humanize/apply')
      ? { success: true, data: { replaced: true } }
      : { success: true, data: { text: 'Two of them, and the second nearly gone.', changed: true } },
  ),
}));

describe('HumanizerPanel', () => {
  it('hands the new text to the editor once it is in the manuscript, so it can be highlighted', async () => {
    const onReplaced = vi.fn();
    renderWithProviders(
      <HumanizerPanel contentId="c1" getSelection={() => 'There were two of them.'} onReplaced={onReplaced} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use the selected text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run through the humanizer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace in manuscript' }));
    await waitFor(() => expect(onReplaced).toHaveBeenCalledWith('Two of them, and the second nearly gone.'));
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/content/c1/humanize/apply', {
      method: 'POST',
      body: JSON.stringify({ original: 'There were two of them.', replacement: 'Two of them, and the second nearly gone.' }),
    });
    expect(await screen.findByRole('status')).toHaveTextContent('highlighted in the editor');
  });
});
