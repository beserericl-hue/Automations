import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import TrashView from './TrashView';

/**
 * Sprint 1 QA Tests — S1-3: Trash view for deleted projects
 */
describe('S1-3: Trash View', () => {
  it('QA: TrashView renders without crashing', () => {
    renderWithProviders(<TrashView />);
    expect(screen.getByText('Trash')).toBeInTheDocument();
  });

  it('QA: TrashView shows description text', () => {
    renderWithProviders(<TrashView />);
    expect(screen.getByText('Deleted projects are kept here. Restore them to bring them back.')).toBeInTheDocument();
  });
});
