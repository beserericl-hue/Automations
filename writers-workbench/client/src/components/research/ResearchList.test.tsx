import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import ResearchList from './ResearchList';

describe('ResearchList', () => {
  it('renders without crashing', () => {
    renderWithProviders(<ResearchList />);
    expect(screen.getByText('Research Reports')).toBeInTheDocument();
  });
});
