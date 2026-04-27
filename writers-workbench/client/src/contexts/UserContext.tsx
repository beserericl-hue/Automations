import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { supabase } from '../config/supabase';
import { useAuth } from './AuthContext';
import {
  apiFetch,
  setActiveImpersonation,
  getActiveImpersonation,
  type ApiEnvelope,
  type ImpersonationSession,
} from '../lib/api';
import type {
  AccountStatus,
  EffectiveUserRole,
  UserSubscriptionWithTier,
} from '../types/database';

export interface UserProfile {
  id: string;
  user_id: string; // phone number — the key for all V2 tables
  phone_number: string;
  display_name: string | null;
  email: string | null;
  bcc_email: string | null;
  preferences: Record<string, unknown>;
  role: string;
  isAdmin: boolean;
  // Sprint 8 additions
  effective_role: EffectiveUserRole;
  account_status: AccountStatus;
}

interface UserContextType {
  profile: UserProfile | null;
  /** During impersonation, this is the actually-logged-in superuser's profile. Otherwise null. */
  realProfile: UserProfile | null;
  subscription: UserSubscriptionWithTier | null;
  loading: boolean;
  needsOnboarding: boolean;
  isImpersonating: boolean;
  impersonationSession: ImpersonationSession | null;
  refreshProfile: () => Promise<void>;
  refreshSubscription: () => Promise<void>;
  startImpersonation: (target_user_id: string, reason?: string) => Promise<void>;
  endImpersonation: () => Promise<void>;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

interface RoleMetaRow { role: 'superuser' | 'admin' }
interface AccountMetaRow { account_status: AccountStatus }

async function loadProfileRow(authUid: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('users_v2')
    .select('*')
    .eq('supabase_auth_uid', authUid)
    .maybeSingle();
  if (error || !data) return null;

  // Sprint 8: lift role + account_status from the meta tables.
  const [roleMeta, acctMeta] = await Promise.all([
    supabase.from('user_role_meta_v2').select('role').eq('user_id', data.user_id).maybeSingle(),
    supabase.from('user_account_meta_v2').select('account_status').eq('user_id', data.user_id).maybeSingle(),
  ]);

  const role: EffectiveUserRole =
    (roleMeta.data as RoleMetaRow | null)?.role
    ?? (data.role === 'admin' ? 'admin' : 'user');
  const account_status: AccountStatus =
    (acctMeta.data as AccountMetaRow | null)?.account_status ?? 'active';

  return {
    id: data.id,
    user_id: data.user_id,
    phone_number: data.phone_number,
    display_name: data.display_name,
    email: data.email,
    bcc_email: data.bcc_email,
    preferences: data.preferences || {},
    role: data.role || 'user',
    isAdmin: role === 'admin' || role === 'superuser',
    effective_role: role,
    account_status,
  };
}

async function loadProfileById(userId: string): Promise<UserProfile | null> {
  // For impersonation: the superuser's JWT can read users_v2 rows where
  // is_admin() is true (per the auth migration's RLS). We piggy-back on that.
  const { data, error } = await supabase
    .from('users_v2')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;

  const [roleMeta, acctMeta] = await Promise.all([
    supabase.from('user_role_meta_v2').select('role').eq('user_id', userId).maybeSingle(),
    supabase.from('user_account_meta_v2').select('account_status').eq('user_id', userId).maybeSingle(),
  ]);

  const role: EffectiveUserRole =
    (roleMeta.data as RoleMetaRow | null)?.role
    ?? (data.role === 'admin' ? 'admin' : 'user');
  const account_status: AccountStatus =
    (acctMeta.data as AccountMetaRow | null)?.account_status ?? 'active';

  return {
    id: data.id,
    user_id: data.user_id,
    phone_number: data.phone_number,
    display_name: data.display_name,
    email: data.email,
    bcc_email: data.bcc_email,
    preferences: data.preferences || {},
    role: data.role || 'user',
    isAdmin: role === 'admin' || role === 'superuser',
    effective_role: role,
    account_status,
  };
}

export function UserProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [realProfile, setRealProfile] = useState<UserProfile | null>(null);
  const [impersonatedProfile, setImpersonatedProfile] = useState<UserProfile | null>(null);
  const [subscription, setSubscription] = useState<UserSubscriptionWithTier | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [impersonationSession, setImpersonationSession] = useState<ImpersonationSession | null>(
    () => getActiveImpersonation(),
  );

  const fetchProfile = useCallback(async () => {
    if (!user) {
      setRealProfile(null);
      setImpersonatedProfile(null);
      setSubscription(null);
      setLoading(false);
      setNeedsOnboarding(false);
      return;
    }

    const real = await loadProfileRow(user.id);
    if (!real) {
      setNeedsOnboarding(true);
      setRealProfile(null);
      setImpersonatedProfile(null);
      setLoading(false);
      return;
    }
    setRealProfile(real);
    setNeedsOnboarding(false);

    // Resolve impersonated user if any
    const imp = getActiveImpersonation();
    if (imp && real.effective_role === 'superuser') {
      const target = await loadProfileById(imp.target_user_id);
      setImpersonatedProfile(target);
    } else {
      setImpersonatedProfile(null);
    }

    setLoading(false);
  }, [user]);

  const fetchSubscription = useCallback(async () => {
    if (!user) {
      setSubscription(null);
      return;
    }
    try {
      const res = await apiFetch<ApiEnvelope<UserSubscriptionWithTier>>('/api/credits/balance');
      setSubscription(res.data ?? null);
    } catch {
      setSubscription(null);
    }
  }, [user]);

  useEffect(() => {
    if (!authLoading) {
      void fetchProfile();
    }
  }, [authLoading, fetchProfile]);

  useEffect(() => {
    if (!loading && realProfile) {
      void fetchSubscription();
    }
  }, [loading, realProfile, impersonationSession, fetchSubscription]);

  const startImpersonation = useCallback(async (target_user_id: string, reason?: string) => {
    if (realProfile?.effective_role !== 'superuser') {
      throw new Error('Only superusers can impersonate');
    }
    interface StartRes { log_id: string; started_at: string; target_user: { user_id: string } }
    const res = await apiFetch<ApiEnvelope<StartRes>>('/api/superuser/impersonate', {
      method: 'POST',
      body: JSON.stringify({ target_user_id, reason }),
      skipImpersonation: true,
    });
    if (!res.success || !res.data) throw new Error(res.error?.message ?? 'Failed to start impersonation');
    const session: ImpersonationSession = {
      log_id: res.data.log_id,
      target_user_id,
      started_at: res.data.started_at,
      reason,
    };
    setActiveImpersonation(session);
    setImpersonationSession(session);
    const target = await loadProfileById(target_user_id);
    setImpersonatedProfile(target);
    await fetchSubscription();
  }, [realProfile, fetchSubscription]);

  const endImpersonation = useCallback(async () => {
    try {
      await apiFetch('/api/superuser/impersonate', { method: 'DELETE', skipImpersonation: true });
    } catch {
      // Even if server call fails, clear local state — superuser shouldn't be stuck
    }
    setActiveImpersonation(null);
    setImpersonationSession(null);
    setImpersonatedProfile(null);
    await fetchSubscription();
  }, [fetchSubscription]);

  const isImpersonating = impersonationSession !== null && impersonatedProfile !== null;
  const profile = isImpersonating ? impersonatedProfile : realProfile;

  return (
    <UserContext.Provider
      value={{
        profile,
        realProfile: isImpersonating ? realProfile : null,
        subscription,
        loading,
        needsOnboarding,
        isImpersonating,
        impersonationSession,
        refreshProfile: fetchProfile,
        refreshSubscription: fetchSubscription,
        startImpersonation,
        endImpersonation,
      }}
    >
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}
