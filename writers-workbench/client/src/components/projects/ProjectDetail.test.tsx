import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import ProjectDetail from './ProjectDetail';

/**
 * Sprint 1 QA Tests — S1-3: Delete operations for projects
 */
describe('S1-3: Project Delete', () => {
  it('QA: ProjectDetail renders without crashing', () => {
    renderWithProviders(<ProjectDetail />);
    // With no route params and null mock data, shows "Project not found"
    expect(screen.getByText('Project not found.')).toBeInTheDocument();
  });

  it('QA: ProjectDetail shows back to projects button', () => {
    renderWithProviders(<ProjectDetail />);
    expect(screen.getByText('Back to projects')).toBeInTheDocument();
  });
});
