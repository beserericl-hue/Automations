import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../config/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useUser } from '../../contexts/UserContext';

export default function UserSettings() {
  const { user } = useAuth();
  const { profile, refreshProfile } = useUser();
  const queryClient = useQueryClient();

  const [displayName, setDisplayName] = useState(profile?.display_name || '');
  const [email, setEmail] = useState(profile?.email || '');
  const phone = profile?.phone_number || '';
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Password change
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);

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
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const changePassword = async () => {
    setPasswordError('');
    if (newPassword.length < 8) { setPasswordError('Password must be at least 8 characters'); return; }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) { setPasswordError(error.message); return; }
    setPasswordSaved(true);
    setNewPassword('');
    setTimeout(() => setPasswordSaved(false), 3000);
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
        {saved && <span className="text-sm text-green-500">Saved</span>}
      </div>

      {/* Password */}
      <Section title="Change Password">
        <Field label="New Password">
          <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} className={inputClass} placeholder="Min 8 characters" />
        </Field>
        {passwordError && <p className="text-sm text-red-600">{passwordError}</p>}
        <button onClick={changePassword} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400">
          Update Password
        </button>
        {passwordSaved && <span className="ml-3 text-sm text-green-500">Password updated</span>}
      </Section>
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
