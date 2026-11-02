import { describe, it, expect, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import GlobalSettings, { type GlobalSetting, type GlobalSettingsApi } from './GlobalSettings';

const ROWS: GlobalSetting[] = [
  { key: 'bcc_email', value: 'ops@x.com', description: 'Operator copy', is_secret: false, masked: false, updated_by: 'a', updated_at: null },
  { key: 'openai_api_key', value: '••••3456', description: '', is_secret: true, masked: true, updated_by: 'a', updated_at: null },
];

function api(): GlobalSettingsApi & { save: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn(async () => ROWS),
    save: vi.fn(async (key: string, body: { value: string }) => ({ ...ROWS[0], key, value: body.value })),
    remove: vi.fn(async () => ({ deleted: true })),
  };
}

describe('GlobalSettings', () => {
  it('lists every setting, with secrets shown masked and labelled', async () => {
    renderWithProviders(<GlobalSettings api={api()} />);
    expect(await screen.findByTestId('global-setting-bcc_email')).toHaveTextContent('ops@x.com');
    const secret = screen.getByTestId('global-setting-openai_api_key');
    expect(secret).toHaveTextContent('••••3456');
    expect(secret).toHaveTextContent('secret');
  });

  it('adds a setting with its description and secret flag', async () => {
    const a = api();
    renderWithProviders(<GlobalSettings api={a} />);
    await screen.findByTestId('global-settings-table');
    const form = screen.getByTestId('global-settings-add');
    const [key, value, desc] = Array.from(form.querySelectorAll('input:not([type=checkbox])')) as HTMLInputElement[];
    fireEvent.change(key, { target: { value: 'story_structure_guidelines' } });
    fireEvent.change(value, { target: { value: 'Three acts.' } });
    fireEvent.change(desc, { target: { value: 'house style' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add setting' }));
    await waitFor(() =>
      expect(a.save).toHaveBeenCalledWith('story_structure_guidelines', { value: 'Three acts.', description: 'house style', is_secret: false }),
    );
    expect(await screen.findByTestId('global-settings-message')).toHaveTextContent('Saved story_structure_guidelines');
  });

  it('will not submit a key that is not a plain identifier', async () => {
    renderWithProviders(<GlobalSettings api={api()} />);
    await screen.findByTestId('global-settings-table');
    const key = screen.getByTestId('global-settings-add').querySelector('input') as HTMLInputElement;
    fireEvent.change(key, { target: { value: 'bad/key' } });
    expect(screen.getByRole('button', { name: 'Add setting' })).toBeDisabled();
  });

  it('edits a secret from blank rather than from its mask', async () => {
    const a = api();
    renderWithProviders(<GlobalSettings api={a} />);
    const row = await screen.findByTestId('global-setting-openai_api_key');
    fireEvent.click(row.querySelector('button') as HTMLButtonElement); // Edit
    const box = screen.getByLabelText('Value for openai_api_key') as HTMLTextAreaElement;
    expect(box.value).toBe('');
    fireEvent.change(box, { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(a.save).toHaveBeenCalledWith('openai_api_key', { value: 'sk-new', description: undefined, is_secret: undefined }));
  });

  it('deletes after confirmation', async () => {
    const a = api();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithProviders(<GlobalSettings api={a} />);
    const row = await screen.findByTestId('global-setting-bcc_email');
    fireEvent.click(Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!);
    await waitFor(() => expect(a.remove).toHaveBeenCalledWith('bcc_email'));
  });
});
