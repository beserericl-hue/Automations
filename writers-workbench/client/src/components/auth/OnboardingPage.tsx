import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '../../config/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useUser } from '../../contexts/UserContext';

export default function OnboardingPage() {
  const { user } = useAuth();
  const { needsOnboarding, refreshProfile } = useUser();
  const [displayName, setDisplayName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState(user?.email || '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!user) return <Navigate to="/login" replace />;
  if (!needsOnboarding) return <Navigate to="/" replace />;

  const formatPhone = (value: string): string => {
    // Strip non-digits except leading +
    const cleaned = value.replace(/[^\d+]/g, '');
    // Add + prefix if missing
    if (cleaned && !cleaned.startsWith('+')) return `+${cleaned}`;
    return cleaned;
  };

  const validatePhone = (phone: string): boolean => {
    // E.164: + followed by 10-15 digits
    return /^\+\d{10,15}$/.test(phone);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const formattedPhone = formatPhone(phoneNumber);

    if (!validatePhone(formattedPhone)) {
      setError('Please enter a valid phone number in E.164 format (e.g., +14105551234)');
      return;
    }

    if (!displayName.trim()) {
      setError('Please enter your name');
      return;
    }

    setSubmitting(true);
    try {
      // Check if a pre-created account exists for this phone number
      const { data: existing } = await supabase
        .from('users_v2')
        .select('id')
        .eq('phone_number', formattedPhone)
        .maybeSingle();

      if (existing) {
        // Link auth to existing pre-created account
        const { error: updateError } = await supabase
          .from('users_v2')
          .update({
            supabase_auth_uid: user.id,
            display_name: displayName.trim(),
            email: email.trim() || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);

        if (updateError) throw updateError;
      } else {
        // Create new users_v2 row
        const { error: insertError } = await supabase
          .from('users_v2')
          .insert({
            user_id: formattedPhone,
            phone_number: formattedPhone,
            supabase_auth_uid: user.id,
            display_name: displayName.trim(),
            email: email.trim() || null,
          });

        if (insertError) throw insertError;

        // Create default app_config entries
        const configEntries = [
          { user_id: formattedPhone, key: 'recipient_email', value: email.trim() || '' },
          { user_id: formattedPhone, key: 'bcc_email', value: '' },
        ];

        await supabase.from('app_config_v2').insert(configEntries);
      }

      await refreshProfile();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Setup failed';
      if (message.includes('duplicate key') && message.includes('phone_number')) {
        setError('This phone number is already registered to another account.');
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Welcome aboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            Set up your profile to get started with The Writers Workbench.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="displayName" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Your name
            </label>
            <input
              id="displayName"
              type="text"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Jane Doe"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
          </div>

          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Phone number
            </label>
            <input
              id="phone"
              type="tel"
              required
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+14105551234"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
            <p className="mt-1 text-xs text-gray-400">
              E.164 format with country code. This links your web account to Eve voice sessions.
            </p>
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Email for content delivery
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
            <p className="mt-1 text-xs text-gray-400">
              Where writing results are emailed. Defaults to your login email.
            </p>
          </div>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {submitting ? 'Setting up...' : 'Complete setup'}
          </button>
        </form>
      </div>
    </div>
  );
}
