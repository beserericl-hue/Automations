import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import SignupPage from './SignupPage';

describe('SignupPage', () => {
  it('renders without crashing', async () => {
    renderWithProviders(<SignupPage />);
    await waitFor(() => {
      expect(screen.getByText('Create your account')).toBeInTheDocument();
    });
  });

  it('shows email and password fields', async () => {
    renderWithProviders(<SignupPage />);
    await waitFor(() => {
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
    });
  });

  it('shows create account button', async () => {
    renderWithProviders(<SignupPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
    });
  });
});
