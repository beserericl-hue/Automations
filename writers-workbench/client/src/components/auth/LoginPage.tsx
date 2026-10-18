import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

// Hidden until the Supabase Google provider is configured (Client ID/Secret in
// the dashboard + redirect URI in Google Cloud). Flip the env var once both are
// set up, so the UI never shows a button that errors out.
const googleEnabled = import.meta.env.VITE_GOOGLE_OAUTH_ENABLED === 'true';

/**
 * Sign in with an email and a code. There is no password and no separate signup:
 * a new address and a returning one take the same two steps, because the old
 * split was a dead end whenever a confirmation email failed to arrive.
 */
export default function LoginPage() {
  const { requestCode, verifyCode, signInWithGoogle, user, loading } = useAuth();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Resend is throttled client-side as well as on the server, so the button
  // cannot be hammered into the server's hourly cap by one impatient user.
  const [resendIn, setResendIn] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  if (loading) return null;
  if (user) return <Navigate to="/" replace />;

  const send = async (resend = false) => {
    setError('');
    setNotice('');
    setSubmitting(true);
    try {
      await requestCode(email.trim());
      setStep('code');
      setResendIn(30);
      setNotice(resend ? 'A new code is on its way.' : `We sent a code to ${email.trim()}.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send a code');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await send(false);
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await verifyCode(email.trim(), code.trim());
      // No navigation needed: the session lands in AuthContext and the guard
      // re-renders. Navigating here would race that.
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
      setCode('');
      codeRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="text-center">
          <img src="/assets/logo-blue.png" alt="Course Worx Media" className="mx-auto h-16 dark:hidden" />
          <img src="/assets/logo-white.png" alt="Course Worx Media" className="mx-auto h-16 hidden dark:block" />
          <h1 className="mt-4 text-2xl font-bold text-gray-900 dark:text-white">The Writers Workbench</h1>
          <p className="mt-1 text-sm text-gray-500">
            {step === 'email' ? 'Sign in with your email' : 'Enter the code we emailed you'}
          </p>
        </div>

        {step === 'email' ? (
          <form onSubmit={handleEmailSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />
              <p className="mt-2 text-xs text-gray-500">
                We'll email you a 6-digit code. No password needed — new or returning.
              </p>
            </div>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {submitting ? 'Sending code...' : 'Email me a code'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleCodeSubmit} className="space-y-4">
            <div>
              <label htmlFor="code" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                6-digit code
              </label>
              <input
                id="code"
                ref={codeRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className={`${inputClass} text-center text-2xl tracking-[0.5em]`}
              />
              {notice && <p className="mt-2 text-xs text-gray-500">{notice}</p>}
            </div>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={submitting || code.length !== 6}
              className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {submitting ? 'Signing in...' : 'Sign in'}
            </button>

            <div className="flex items-center justify-between text-xs">
              <button
                type="button"
                onClick={() => {
                  setStep('email');
                  setCode('');
                  setError('');
                  setNotice('');
                }}
                className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Use a different email
              </button>
              <button
                type="button"
                disabled={submitting || resendIn > 0}
                onClick={() => void send(true)}
                className="text-brand-600 hover:text-brand-700 disabled:opacity-50"
              >
                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
              </button>
            </div>
          </form>
        )}

        {googleEnabled && (
          <>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200 dark:border-gray-700" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-white px-2 text-gray-500 dark:bg-gray-900">or</span>
              </div>
            </div>

            <button
              onClick={signInWithGoogle}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Continue with Google
            </button>
          </>
        )}
      </div>
    </div>
  );
}
