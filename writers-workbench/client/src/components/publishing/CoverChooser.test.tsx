/**
 * Cover: the author chooses the picture the book is printed with, for the whole book and per book.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent } from '../../test/test-utils';
import CoverChooser, { type CoverOption } from './CoverChooser';

const OPTIONS: CoverOption[] = [
  { id: 'new', created_at: '2026-10-20T00:00:00Z', url: 'https://x/new.png', prompt: 'a lantern' },
  { id: 'old', created_at: '2026-10-01T00:00:00Z', url: 'https://x/old.png', prompt: null },
];

const render = (props: Partial<Parameters<typeof CoverChooser>[0]> = {}) => {
  const onChoose = vi.fn();
  renderWithProviders(
    <CoverChooser
      projectId="p1"
      options={OPTIONS}
      chosen={null}
      chosenByBook={{}}
      books={[{ index: 1, title: '' }]}
      saving={false}
      onChoose={onChoose}
      {...props}
    />,
  );
  return onChoose;
};

describe('CoverChooser', () => {
  it('says the newest is in use when nothing is chosen', () => {
    render();
    expect(screen.getByText(/Nothing chosen — the newest picture/)).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');
  });

  it('chooses an older picture as the cover', () => {
    const onChoose = render();
    fireEvent.click(screen.getAllByRole('radio')[1]);
    expect(onChoose).toHaveBeenCalledWith({ cover_image_id: 'old' });
  });

  it('marks the chosen picture and can clear the choice', () => {
    const onChoose = render({ chosen: 'old' });
    expect(screen.getAllByRole('radio')[1]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Clear the choice/ }));
    expect(onChoose).toHaveBeenCalledWith({ cover_image_id: null });
  });

  it('lets each book of a series have its own cover, or go back to the series one', () => {
    const onChoose = render({
      books: [
        { index: 1, title: 'The Pewter Light' },
        { index: 2, title: '' },
      ],
      chosenByBook: { '2': 'old' },
    });
    expect(screen.getByLabelText('Cover for book 2')).toHaveValue('old');
    fireEvent.change(screen.getByLabelText('Cover for book 1'), { target: { value: 'new' } });
    expect(onChoose).toHaveBeenCalledWith({ cover_image_ids: { '1': 'new' } });
    fireEvent.change(screen.getByLabelText('Cover for book 2'), { target: { value: '' } });
    expect(onChoose).toHaveBeenCalledWith({ cover_image_ids: { '2': null } });
  });

  it('points to where covers are made when there are none', () => {
    render({ options: [] });
    expect(screen.getByRole('link', { name: 'Outline' })).toHaveAttribute('href', '/projects/p1?tab=outline');
  });
});
