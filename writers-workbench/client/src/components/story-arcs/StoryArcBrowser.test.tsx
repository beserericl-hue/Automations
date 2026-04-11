import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import StoryArcBrowser from './StoryArcBrowser';

describe('StoryArcBrowser', () => {
  it('renders without crashing', () => {
    renderWithProviders(<StoryArcBrowser />);
    expect(screen.getByText('Story Arcs')).toBeInTheDocument();
  });
});
