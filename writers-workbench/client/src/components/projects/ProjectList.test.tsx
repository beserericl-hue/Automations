import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import ProjectList from './ProjectList';

describe('ProjectList', () => {
  it('renders without crashing', () => {
    renderWithProviders(<ProjectList />);
    expect(screen.getByText('Projects')).toBeInTheDocument();
  });
});
