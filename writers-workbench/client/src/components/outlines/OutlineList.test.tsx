import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import OutlineList from './OutlineList';

describe('OutlineList', () => {
  it('renders without crashing', () => {
    renderWithProviders(<OutlineList />);
    expect(screen.getByText('Outlines')).toBeInTheDocument();
  });
});
