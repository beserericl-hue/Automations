import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import userEvent from '@testing-library/user-event';
import LoginPage from './LoginPage';

/**
 * Passwordless login. These tests pin the two things that would silently break
 * the only way into the product: that there is no password field anywhere, and
 * that the email step actually calls the request endpoint before showing the
 * code box (an optimistic step change would strand a user waiting for an email
 * that was never sent).
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, expires_in_minutes: 10 }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginPage', () => {
  it('renders without crashing', async () => {
    renderWithProviders(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByText('The Writers Workbench')).toBeInTheDocument();
    });
  });

  it('asks only for an email, and offers no password', async () => {
    renderWithProviders(<LoginPage />);
    await waitFor(() => {
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByText('Forgot password?')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeInTheDocument();
  });

  it('requests a code and then asks for it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));

    await waitFor(() => {
      expect(screen.getByLabelText('6-digit code')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/otp/request',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body).toEqual({ email: 'writer@example.com' });
    expect(screen.getByText(/We sent a code to writer@example.com/)).toBeInTheDocument();
  });

  it('stays on the email step and shows the error when sending fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: { message: 'Could not start sign-in. Try again.' } }),
    });
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));

    await waitFor(() => {
      expect(screen.getByText('Could not start sign-in. Try again.')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('6-digit code')).not.toBeInTheDocument();
  });

  it('keeps only digits in the code box and caps it at six', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));
    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeInTheDocument());

    const codeBox = screen.getByLabelText('6-digit code') as HTMLInputElement;
    await user.type(codeBox, '12a3b456789');
    expect(codeBox.value).toBe('123456');
  });

  it('shows the server message when the code is rejected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));
    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeInTheDocument());

    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({
        success: false,
        error: { code: 'INVALID_CODE', message: 'That code is not valid. Request a new one.' },
      }),
    });
    await user.type(screen.getByLabelText('6-digit code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText('That code is not valid. Request a new one.')).toBeInTheDocument();
    });
    // The box is cleared so the user retypes rather than editing a dead code.
    expect((screen.getByLabelText('6-digit code') as HTMLInputElement).value).toBe('');
  });

  it('lets the user go back and use a different email', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Email'), 'writer@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));
    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Use a different email' }));
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument());
  });
});
