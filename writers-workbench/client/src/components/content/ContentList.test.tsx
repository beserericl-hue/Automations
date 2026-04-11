import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import ContentList from './ContentList';

describe('ContentList', () => {
  it('renders chapters view without crashing', () => {
    renderWithProviders(<ContentList contentType="chapter" title="Chapters" />);
    expect(screen.getByText('Chapters')).toBeInTheDocument();
  });

  it('renders short stories view without crashing', () => {
    renderWithProviders(<ContentList contentType="short_story" title="Short Stories" />);
    expect(screen.getByText('Short Stories')).toBeInTheDocument();
  });

  it('renders blog posts view without crashing', () => {
    renderWithProviders(<ContentList contentType="blog_post" title="Blog Posts" />);
    expect(screen.getByText('Blog Posts')).toBeInTheDocument();
  });

  it('renders newsletters view without crashing', () => {
    renderWithProviders(<ContentList contentType="newsletter" title="Newsletters" />);
    expect(screen.getByText('Newsletters')).toBeInTheDocument();
  });

  it('shows status filter dropdown', () => {
    renderWithProviders(<ContentList contentType="chapter" title="Chapters" />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });
});
