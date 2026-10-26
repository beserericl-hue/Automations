/**
 * Print copies: build the files, price shipping to an address, place the order, see it move.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '../../test/test-utils';
import PrintCopies from './PrintCopies';
import { apiFetch } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: vi.fn(),
}));
const mockFetch = vi.mocked(apiFetch);

const INFO = {
  configured: true,
  mode: 'sandbox',
  page_range: [24, 672],
  editions: [
    { key: 'softcover_matte', label: 'Softcover, matte', sku: 's1', outside: 'cover', trim: '6x9' },
    { key: 'hardcover_jacket', label: 'Hardcover, dust jacket', sku: 's4', outside: 'jacket', trim: '6x9' },
  ],
};
const DRAFT = {
  id: 'o1', edition: 'hardcover_jacket', edition_label: 'Hardcover, dust jacket', volume_index: 1, quantity: 1,
  page_count: 593, rpi_page_count: 594, spine_in: 1.789, status: 'DRAFT', mode: 'sandbox', customer_order_id: null,
  quote: { unit_price: 33.22 }, pricing: null, validations: [], tracking: [], last_event: null,
  created_at: '2026-10-25T12:00:00Z', submitted_at: null, cancellable: false,
  files: { preview: 'https://x/preview.jpg', interior: 'https://x/interior.pdf', outside: 'https://x/jacket.pdf' },
};
let orders: unknown[] = [];

beforeEach(() => {
  orders = [];
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (p, o) => {
    const path = String(p);
    const method = (o as { method?: string } | undefined)?.method ?? 'GET';
    if (path === '/api/print/editions') return { success: true, data: INFO } as never;
    if (path.endsWith('/orders') && method === 'GET') return { success: true, data: { orders } } as never;
    if (path.endsWith('/prepare')) return { success: true, data: { order: DRAFT } } as never;
    if (path.endsWith('/shipping'))
      return { success: true, data: { options: [
        { methodClassification: 'standard', methodName: 'Ground', price: 7.2, estimatedDeliveryDateUTC: null },
        { methodClassification: 'rush', methodName: 'Air', price: 31.5, estimatedDeliveryDateUTC: null },
      ] } } as never;
    if (path.endsWith('/submit')) {
      orders = [{ ...DRAFT, status: 'RECEIVED', submitted_at: '2026-10-25T12:05:00Z', last_event: 'OrderSubmitted', cancellable: true, quantity: 2 }];
      return { success: true, data: { order: orders[0] } } as never;
    }
    return { success: true, data: {} } as never;
  });
});

const bodyOf = (suffix: string) => {
  const call = mockFetch.mock.calls.find(([p, o]) => String(p).endsWith(suffix) && (o as { method?: string })?.method === 'POST');
  expect(call, `no POST to ${suffix}`).toBeTruthy();
  return JSON.parse(String((call![1] as { body: string }).body));
};

describe('PrintCopies', () => {
  it('says it is sandbox, and builds the chosen edition’s files before showing a price', async () => {
    renderWithProviders(<PrintCopies projectId="p1" volumeCount={3} />);
    expect(await screen.findByTestId('print-mode')).toHaveTextContent('never printed or charged');
    fireEvent.click(screen.getByText('Hardcover, dust jacket'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Build the print files' }));
    const draft = await screen.findByTestId('print-draft');
    expect(bodyOf('/prepare')).toEqual({ edition: 'hardcover_jacket', volume_index: 2 });
    expect(draft).toHaveTextContent('593 pages (printed as 594) · spine 1.789″ · $33.22 a copy before shipping');
    expect(screen.getByText('Dust jacket PDF')).toHaveAttribute('href', 'https://x/jacket.pdf');
  });

  it('prices shipping to the address and places the order with the tier chosen', async () => {
    renderWithProviders(<PrintCopies projectId="p1" volumeCount={1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Build the print files' }));
    await screen.findByTestId('print-draft');
    for (const [label, value] of [
      ['Name', 'Eric Beser'], ['Street address', '1 Main St'], ['City', 'Owings Mills'],
      ['State or province (e.g. MD)', 'MD'], ['ZIP or postal code', '21117'],
    ]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.change(screen.getByLabelText('Copies'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Get shipping options' }));
    await screen.findByText('Ground', { exact: false });
    expect(bodyOf('/shipping')).toEqual({
      destination: { name: 'Eric Beser', address1: '1 Main St', city: 'Owings Mills', regionCode: 'MD', postal: '21117', country: 'US' },
      quantity: 2,
    });
    expect(screen.getByText(/2 × \$33.22 \+ \$7.20 shipping = \$73.64 before tax/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('rush'));
    fireEvent.click(screen.getByRole('button', { name: 'Place sandbox order' }));
    await waitFor(() => expect(bodyOf('/submit')).toMatchObject({ quantity: 2, shipping_classification: 'rush' }));
    expect(await screen.findByTestId('print-orders')).toHaveTextContent('Received by RPI');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('tells the author when the server has no RPI key, and does not offer to build', async () => {
    mockFetch.mockImplementation(async (p) =>
      (String(p) === '/api/print/editions' ? { success: true, data: { ...INFO, configured: false } } : { success: true, data: { orders: [] } }) as never,
    );
    renderWithProviders(<PrintCopies projectId="p1" volumeCount={1} />);
    expect(await screen.findByText(/no RPI API key/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build the print files' })).toBeDisabled();
  });
});

describe('printStatusLabel', () => {
  it('says what RPI\'s state means, and falls back to readable words for one it adds later', async () => {
    const { printStatusLabel } = await import('./PrintCopies');
    expect(printStatusLabel('RECEIVED_BY_PRINTER')).toBe('Accepted by the printer');
    expect(printStatusLabel('VALID_HOLDING_BIN')).toBe('Paid, in the holding bin');
    expect(printStatusLabel('ON_HOLD_FOR_REVIEW')).toBe('On hold for review');
  });
});
