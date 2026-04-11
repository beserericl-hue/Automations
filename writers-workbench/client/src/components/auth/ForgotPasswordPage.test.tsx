import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import ForgotPasswordPage from './ForgotPasswordPage';

describe('ForgotPasswordPage', () => {
  it('renders without crashing', () => {
    renderWithProviders(<ForgotPasswordPage />);
    expect(screen.getByText('Reset your password')).toBeInTheDocument();
  });

  it('shows email field and submit button', () => {
    renderWithProviders(<ForgotPasswordPage />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeInTheDocument();
  });
});
