import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useUser } from '../../contexts/UserContext';
import { useTheme } from '../../hooks/useTheme';
import { useToast } from '../../contexts/ToastContext';
import { resetTutorial } from '../onboarding/OnboardingTutorial';

export default function UserSettings() {
  const { user } = useAuth();
  const { profile, refreshProfile } = useUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const { addToast } = useToast();

  const [displayName, setDisplayName] = useState(profile?.display_name || '');
  const [email, setEmail] = useState(profile?.email || '');
  const phone = profile?.phone_number || '';
  const [saving, setSaving] = useState(false);

  // Password change
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');

  // Account deletion
  const [showDeleteSection, setShowDeleteSection] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [cascadeInfo, setCascadeInfo] = useState<{ label: string; count: number }[]>([]);

  // App config
  const { data: config } = useQuery({
    queryKey: ['app-config', profile?.user_id],
    queryFn: async () => {
      const { data } = await supabase
        .from('app_config_v2')
        .select('key, value')
        .eq('user_id', profile!.user_id);
      const map: Record<string, string> = {};
      data?.forEach(r => { map[r.key] = r.value; });
      return map;
    },
    enabled: !!profile?.user_id,
  });

  const [recipientEmail, setRecipientEmail] = useState('');
  const [bccEmail, setBccEmail] = useState('');
  const [configLoaded, setConfigLoaded] = useState(false);

  // Initialize email fields from config ONCE when config loads
  useEffect(() => {
    if (config && !configLoaded) {
      setRecipientEmail(config.recipient_email || '');
      setBccEmail(config.bcc_email || '');
      setConfigLoaded(true);
    }
  }, [config, configLoaded]);

  const saveProfile = async () => {
    setSaving(true);
    await supabase
      .from('users_v2')
      .update({ display_name: displayName.trim(), email: email.trim() })
      .eq('user_id', profile!.user_id);

    // Upsert app_config
    for (const [key, value] of [['recipient_email', recipientEmail], ['bcc_email', bccEmail]] as const) {
      await supabase
        .from('app_config_v2')
        .upsert({ user_id: profile!.user_id, key, value }, { onConflict: 'user_id,key' });
    }

    await refreshProfile();
    queryClient.invalidateQueries({ queryKey: ['app-config'] });
    setSaving(false);
    addToast('Settings saved', 'success');
  };

  const loadCascadeInfo = async () => {
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      const res = await fetch('/api/account/cascade-info', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (json.success) setCascadeInfo(json.data);
    } catch {
      // silently fail — cascade info is informational
    }
  };

  const handleShowDelete = () => {
    setShowDeleteSection(true);
    loadCascadeInfo();
  };

  const deleteAccount = async () => {
    setDeleteError('');
    if (deleteConfirmation !== 'DELETE') {
      setDeleteError('You must type DELETE to confirm.');
      return;
    }
    setDeleting(true);
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      const res = await fetch('/api/account', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ confirmation: 'DELETE' }),
      });
      const json = await res.json();
      if (!json.success) {
        setDeleteError(json.error?.message || 'Failed to delete account');
        setDeleting(false);
        return;
      }
      await supabase.auth.signOut();
      navigate('/login');
    } catch (err) {
      setDeleteError('Network error. Please try again.');
      setDeleting(false);
    }
  };

  const changePassword = async () => {
    setPasswordError('');
    if (newPassword.length < 8) { setPasswordError('Password must be at least 8 characters'); return; }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) { setPasswordError(error.message); return; }
    setNewPassword('');
    addToast('Password updated', 'success');
  };

  return (
    <div className="space-y-8 max-w-xl">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>

      {/* Profile */}
      <Section title="Profile">
        <Field label="Display Name">
          <input value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Email">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Phone Number">
          <input value={phone} disabled className={inputClass + ' opacity-50 cursor-not-allowed'} />
          <p className="text-xs text-gray-400 mt-1">Phone number cannot be changed (links to Eve voice sessions).</p>
        </Field>
        <Field label="Auth Email">
          <input value={user?.email || ''} disabled className={inputClass + ' opacity-50 cursor-not-allowed'} />
        </Field>
      </Section>

      {/* Email Delivery */}
      <Section title="Email Delivery">
        <Field label="Recipient Email">
          <input type="email" value={recipientEmail} onChange={e => setRecipientEmail(e.target.value)} className={inputClass} placeholder="Where writing results are sent" />
        </Field>
        <Field label="BCC Email">
          <input type="email" value={bccEmail} onChange={e => setBccEmail(e.target.value)} className={inputClass} placeholder="Optional BCC address" />
        </Field>
      </Section>

      <div className="flex items-center gap-3">
        <button onClick={saveProfile} disabled={saving} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Appearance */}
      <Section title="Appearance">
        <Field label="Theme">
          <div className="flex gap-2">
            {(['light', 'dark', 'system'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`rounded-lg px-4 py-2 text-sm font-medium capitalize ${
                  theme === t
                    ? 'bg-brand-600 text-white'
                    : 'border border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </Field>
      </Section>

      {/* Password */}
      <Section title="Change Password">
        <Field label="New Password">
          <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} className={inputClass} placeholder="Min 8 characters" />
        </Field>
        {passwordError && <p className="text-sm text-red-600">{passwordError}</p>}
        <button onClick={changePassword} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400">
          Update Password
        </button>
      </Section>

      {/* Replay Tutorial */}
      <Section title="Help">
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          Replay the onboarding tutorial to see a quick overview of the app features.
        </p>
        <button
          onClick={async () => {
            if (profile?.user_id) {
              await resetTutorial(profile.user_id);
              addToast('Tutorial reset — it will appear on your next page load.', 'info');
            }
          }}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          Replay Tutorial
        </button>
      </Section>

      {/* Delete Account */}
      <div className="rounded-lg border border-red-200 bg-red-50/50 p-4 space-y-4 dark:border-red-800 dark:bg-red-950/20">
        <h2 className="text-sm font-semibold text-red-700 dark:text-red-400">Danger Zone</h2>
        {!showDeleteSection ? (
          <button
            onClick={handleShowDelete}
            className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-100 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900"
          >
            Delete Account
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-red-600 dark:text-red-400 font-medium">
              This will permanently delete your account and all associated data. This action cannot be undone.
            </p>

            {cascadeInfo.length > 0 && (
              <div className="rounded-lg bg-red-100 p-3 dark:bg-red-900/30">
                <p className="text-xs font-medium text-red-800 dark:text-red-300 mb-1">
                  The following data will be permanently deleted:
                </p>
                <ul className="list-disc pl-4 text-xs text-red-700 dark:text-red-400 space-y-0.5">
                  {cascadeInfo.map((item, i) => (
                    <li key={i}>{item.count} {item.label}</li>
                  ))}
                </ul>
              </div>
            )}

            <Field label='Type "DELETE" to confirm'>
              <input
                value={deleteConfirmation}
                onChange={e => setDeleteConfirmation(e.target.value)}
                className={inputClass + ' border-red-300 dark:border-red-700'}
                placeholder="DELETE"
                autoComplete="off"
              />
            </Field>

            {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}

            <div className="flex gap-3">
              <button
                onClick={deleteAccount}
                disabled={deleting || deleteConfirmation !== 'DELETE'}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Permanently Delete Account'}
              </button>
              <button
                onClick={() => { setShowDeleteSection(false); setDeleteConfirmation(''); setDeleteError(''); }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inputClass = 'block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4 dark:border-gray-800 dark:bg-gray-900">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
      {children}
    </div>
  );
}
