// Sprint 8 (S8-8): central permissions hook.
//
// Returns role flags and tier-feature flags derived from UserContext.
// Components use this directly OR via the <RequireRole> / <RequireFeature>
// wrappers. Role hierarchy: superuser > admin > user.

import { useMemo } from 'react';
import { useUser } from '../contexts/UserContext';
import type { EffectiveUserRole, TierFeatures, TierName } from '../types/database';

export type RoleRequirement = 'user' | 'admin' | 'superuser';

export interface Permissions {
  role: EffectiveUserRole;
  tierName: TierName | null;
  tierDisplayName: string | null;
  features: TierFeatures | null;
  creditsRemaining: number;
  creditsMonthly: number;
  // Boolean shortcuts
  isAdmin: boolean;
  isSuperuser: boolean;
  isTrialUser: boolean;
  trialDaysRemaining: number | null;
  isAccountActive: boolean;
  // Feature gates
  canExport: boolean;
  canGenerateArt: boolean;
  canRepurposeSocial: boolean;
  // Role-meets-requirement check
  hasRole: (required: RoleRequirement) => boolean;
  // Feature check
  hasFeature: (feature: string) => boolean;
  // Account-status access (returns false if locked/suspended)
  canMutate: boolean;
}

const ROLE_RANK: Record<EffectiveUserRole, number> = {
  superuser: 3,
  admin: 2,
  user: 1,
};
const REQUIREMENT_RANK: Record<RoleRequirement, number> = {
  superuser: 3,
  admin: 2,
  user: 1,
};

export function usePermissions(): Permissions {
  const { profile, subscription } = useUser();

  return useMemo(() => {
    const role: EffectiveUserRole = profile?.effective_role ?? 'user';
    const accountStatus = profile?.account_status ?? 'active';
    const tier = subscription?.tier ?? null;
    const features = (tier?.features ?? null) as TierFeatures | null;

    const isSuperuser = role === 'superuser';
    const isAdmin = role === 'admin' || isSuperuser;

    // Privileged roles always pass feature gates.
    const hasFeature = (key: string): boolean => {
      if (isAdmin) return true;
      if (!features) return false;
      const v = (features as Record<string, unknown>)[key];
      return v === true;
    };

    const hasRole = (required: RoleRequirement): boolean => ROLE_RANK[role] >= REQUIREMENT_RANK[required];

    let trialDaysRemaining: number | null = null;
    let isTrialUser = false;
    if (subscription?.trial_end) {
      isTrialUser = true;
      const ms = new Date(subscription.trial_end).getTime() - Date.now();
      trialDaysRemaining = ms > 0 ? Math.ceil(ms / (24 * 3600 * 1000)) : 0;
    }

    return {
      role,
      tierName: tier?.name ?? null,
      tierDisplayName: tier?.display_name ?? null,
      features,
      creditsRemaining: subscription?.credits_remaining ?? 0,
      creditsMonthly: tier?.monthly_credits ?? 0,
      isAdmin,
      isSuperuser,
      isTrialUser,
      trialDaysRemaining,
      isAccountActive: accountStatus === 'active',
      canExport: hasFeature('kdp_export'),
      canGenerateArt: hasFeature('cover_art'),
      canRepurposeSocial: hasFeature('social_media'),
      hasRole,
      hasFeature,
      canMutate: accountStatus === 'active',
    };
  }, [profile, subscription]);
}
