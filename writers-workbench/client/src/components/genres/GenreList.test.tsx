import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import GenreList from './GenreList';

describe('GenreList', () => {
  it('renders without crashing', () => {
    renderWithProviders(<GenreList />);
    expect(screen.getByText('Genres')).toBeInTheDocument();
  });

  it('shows new genre button', () => {
    renderWithProviders(<GenreList />);
    expect(screen.getByText('+ New Genre')).toBeInTheDocument();
  });
});
