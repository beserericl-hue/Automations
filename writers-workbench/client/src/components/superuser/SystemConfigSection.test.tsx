import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, fireEvent, waitFor } from '../../test/test-utils';
import { SystemConfigSection, validCreditCost } from './SuperuserPanel';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), apiFetch: vi.fn() }));

const catalog = [
  { key: 'write_chapter', default: 5, label: 'Write / rewrite chapter', group: 'Writing' },
  { key: 'qa_chapter', default: 4, label: 'Q/A consistency check', group: 'Editing & QA' },
  { key: 'humanize_passage', default: 4, label: 'Humanize a passage', group: 'Editing & QA', unit: 'per 100 words' },
  { key: 'a_key_added_tomorrow', default: 7, label: 'Something new', group: 'Writing' },
];

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (path === '/api/superuser/config' && !opts?.method) {
      return { data: { maintenance_mode: false, credit_costs: { write_chapter: 5, qa_chapter: 4, humanize_passage: 4, a_key_added_tomorrow: 7 }, credit_cost_catalog: catalog } };
    }
    return { data: { changes: [{ key: 'qa_chapter', from: 4, to: 6 }] } };
  });
});

describe('SystemConfigSection', () => {
  it('accepts only whole numbers 0..1000', () => {
    expect(validCreditCost('0')).toBe(0);
    expect(validCreditCost('12')).toBe(12);
    for (const bad of ['', '-1', '2.5', 'abc', '1001']) expect(validCreditCost(bad)).toBeNull();
  });

  it('renders every key the server lists (not a fixed 8), with defaults and units', async () => {
    renderWithProviders(<SystemConfigSection />);
    expect(await screen.findByTestId('cost-a_key_added_tomorrow')).toHaveValue(7);
    expect(screen.getByTestId('cost-humanize_passage')).toHaveValue(4);
    expect(screen.getByText(/humanize_passage, per 100 words · default 4/)).toBeInTheDocument();
  });

  it('blocks a negative or fractional price and saves the full table otherwise', async () => {
    renderWithProviders(<SystemConfigSection />);
    const qa = await screen.findByTestId('cost-qa_chapter');
    fireEvent.change(qa, { target: { value: '-2' } });
    expect(screen.getByRole('button', { name: 'Save Configuration' })).toBeDisabled();
    fireEvent.change(qa, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/superuser/config', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ maintenance_mode: false, credit_costs: { write_chapter: 5, qa_chapter: 6, humanize_passage: 4, a_key_added_tomorrow: 7 } }),
    })));
    expect(await screen.findByRole('status')).toHaveTextContent('qa_chapter 4 → 6');
  });
});
