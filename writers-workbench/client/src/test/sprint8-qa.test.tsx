// Sprint 8 (S8-10) — client unit tests for the RBAC types, the
// `usePermissions` hook (via mocked context), and the `<RequireRole>` /
// `<RequireFeature>` wrappers.
//
// The test setup at `src/test/setup.ts` already mocks `../config/supabase`,
// so any code path that reads from Supabase resolves to empty results without
// network IO.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  EffectiveUserRole,
  AccountStatus,
  UserSubscriptionWithTier,
  SubscriptionTier,
  CreditTransaction,
  ImpersonationLog,
  TierFeatures,
} from '../types/database';

// ---- S8-1: Type shape sanity checks ----

describe('S8-1: Sprint 8 types', () => {
  it('EffectiveUserRole values', () => {
    const roles: EffectiveUserRole[] = ['superuser', 'admin', 'user'];
    expect(roles).toHaveLength(3);
  });

  it('AccountStatus values', () => {
    const all: AccountStatus[] = ['active', 'locked', 'suspended', 'pending'];
    expect(all).toHaveLength(4);
  });

  it('SubscriptionTier shape', () => {
    const tier: SubscriptionTier = {
      id: 't1',
      name: 'pro',
      display_name: 'Professional',
      description: null,
      monthly_credits: 500,
      monthly_price_cents: 4999,
      annual_price_cents: 49900,
      credit_purchase_price_cents: 100,
      features: { kdp_export: true, cover_art: true, social_media: true, max_projects: 50 },
      is_default: false,
      publicly_selectable: true,
      trial_days: 0,
      sort_order: 20,
      active: true,
      created_at: '2026-04-26T00:00:00Z',
      updated_at: '2026-04-26T00:00:00Z',
    };
    expect(tier.features.kdp_export).toBe(true);
  });

  it('CreditTransaction shape', () => {
    const tx: CreditTransaction = {
      id: 'tx1',
      user_id: '+14105914612',
      amount: -5,
      balance_after: 995,
      transaction_type: 'usage',
      description: 'chat.async:write_chapter',
      reference_id: 'job-1',
      metadata: {},
      created_at: '2026-04-26T00:00:00Z',
    };
    expect(tx.transaction_type).toBe('usage');
  });

  it('ImpersonationLog shape', () => {
    const log: ImpersonationLog = {
      id: 'i1',
      superuser_id: '+14105914612',
      target_user_id: '+15551234567',
      started_at: '2026-04-26T00:00:00Z',
      ended_at: null,
      reason: 'Debug user-reported issue',
      actions_taken: [],
    };
    expect(log.ended_at).toBeNull();
  });
});

// ---- S8-8: usePermissions / RequireRole / RequireFeature ----

import { useUser } from '../contexts/UserContext';
import { vi } from 'vitest';

vi.mock('../contexts/UserContext', () => ({
  useUser: vi.fn(),
}));

import { usePermissions } from '../hooks/usePermissions';
import { RequireRole } from '../components/auth/RequireRole';
import { RequireFeature } from '../components/auth/RequireFeature';

interface MockUserState {
  effective_role: EffectiveUserRole;
  account_status: AccountStatus;
  features?: TierFeatures;
  credits_remaining?: number;
  monthly_credits?: number;
  trial_end?: string | null;
}

function mockUser(state: MockUserState) {
  const useUserMock = useUser as unknown as ReturnType<typeof vi.fn>;
  const tierStub = state.features
    ? ({
        id: 't',
        name: 'mock',
        display_name: 'Mock',
        description: null,
        monthly_credits: state.monthly_credits ?? 0,
        monthly_price_cents: 0,
        annual_price_cents: 0,
        credit_purchase_price_cents: 100,
        features: state.features,
        is_default: false,
        publicly_selectable: true,
        trial_days: 0,
        sort_order: 0,
        active: true,
        created_at: '',
        updated_at: '',
      } satisfies SubscriptionTier)
    : null;
  const subscription: UserSubscriptionWithTier | null = state.features
    ? ({
        id: 's',
        user_id: '+1',
        tier_id: 't',
        status: 'active',
        billing_cycle: 'monthly',
        current_period_start: '',
        current_period_end: null,
        trial_start: null,
        trial_end: state.trial_end ?? null,
        credits_remaining: state.credits_remaining ?? 0,
        credits_used_this_period: 0,
        auto_renew: true,
        trial_warnings_sent: [],
        created_by: null,
        created_at: '',
        updated_at: '',
        tier: tierStub!,
      } satisfies UserSubscriptionWithTier)
    : null;

  useUserMock.mockReturnValue({
    profile: {
      id: 'p',
      user_id: '+1',
      phone_number: '+1',
      display_name: 'Test',
      email: null,
      bcc_email: null,
      preferences: {},
      role: state.effective_role === 'admin' ? 'admin' : 'user',
      isAdmin: state.effective_role === 'admin' || state.effective_role === 'superuser',
      effective_role: state.effective_role,
      account_status: state.account_status,
    },
    realProfile: null,
    subscription,
    loading: false,
    needsOnboarding: false,
    isImpersonating: false,
    impersonationSession: null,
    refreshProfile: async () => undefined,
    refreshSubscription: async () => undefined,
    startImpersonation: async () => undefined,
    endImpersonation: async () => undefined,
  });
}

// Tiny wrapper to call the hook from a component, for assertion.
function HookProbe({ children }: { children: (p: ReturnType<typeof usePermissions>) => ReactNode }) {
  return <>{children(usePermissions())}</>;
}

describe('S8-8: usePermissions hook', () => {
  it('superuser passes every role check and bypasses feature gates', () => {
    mockUser({ effective_role: 'superuser', account_status: 'active' });
    let snapshot: ReturnType<typeof usePermissions>;
    render(
      <HookProbe>
        {(p) => {
          snapshot = p;
          return null;
        }}
      </HookProbe>,
    );
    expect(snapshot!.isSuperuser).toBe(true);
    expect(snapshot!.isAdmin).toBe(true);
    expect(snapshot!.hasRole('admin')).toBe(true);
    expect(snapshot!.hasRole('superuser')).toBe(true);
    // Features bypass even with no subscription
    expect(snapshot!.hasFeature('kdp_export')).toBe(true);
    expect(snapshot!.hasFeature('cover_art')).toBe(true);
  });

  it('admin passes admin checks but is not superuser', () => {
    mockUser({ effective_role: 'admin', account_status: 'active' });
    let snapshot: ReturnType<typeof usePermissions>;
    render(<HookProbe>{(p) => { snapshot = p; return null; }}</HookProbe>);
    expect(snapshot!.isAdmin).toBe(true);
    expect(snapshot!.isSuperuser).toBe(false);
    expect(snapshot!.hasRole('superuser')).toBe(false);
  });

  it('standard user without subscription has no features', () => {
    mockUser({ effective_role: 'user', account_status: 'active' });
    let snapshot: ReturnType<typeof usePermissions>;
    render(<HookProbe>{(p) => { snapshot = p; return null; }}</HookProbe>);
    expect(snapshot!.hasFeature('kdp_export')).toBe(false);
    expect(snapshot!.canExport).toBe(false);
  });

  it('user with pro tier has all features unlocked', () => {
    mockUser({
      effective_role: 'user',
      account_status: 'active',
      features: { kdp_export: true, cover_art: true, social_media: true, max_projects: 50 },
      credits_remaining: 250,
      monthly_credits: 500,
    });
    let snapshot: ReturnType<typeof usePermissions>;
    render(<HookProbe>{(p) => { snapshot = p; return null; }}</HookProbe>);
    expect(snapshot!.canExport).toBe(true);
    expect(snapshot!.canGenerateArt).toBe(true);
    expect(snapshot!.canRepurposeSocial).toBe(true);
    expect(snapshot!.creditsRemaining).toBe(250);
    expect(snapshot!.creditsMonthly).toBe(500);
  });

  it('locked account: canMutate is false', () => {
    mockUser({ effective_role: 'user', account_status: 'locked' });
    let snapshot: ReturnType<typeof usePermissions>;
    render(<HookProbe>{(p) => { snapshot = p; return null; }}</HookProbe>);
    expect(snapshot!.isAccountActive).toBe(false);
    expect(snapshot!.canMutate).toBe(false);
  });

  it('trial user: trialDaysRemaining derived from trial_end', () => {
    const trialEnd = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
    mockUser({
      effective_role: 'user',
      account_status: 'active',
      features: { kdp_export: true, cover_art: true, social_media: true, max_projects: 10 },
      trial_end: trialEnd,
      monthly_credits: 200,
      credits_remaining: 200,
    });
    let snapshot: ReturnType<typeof usePermissions>;
    render(<HookProbe>{(p) => { snapshot = p; return null; }}</HookProbe>);
    expect(snapshot!.isTrialUser).toBe(true);
    expect(snapshot!.trialDaysRemaining).toBeGreaterThanOrEqual(4);
    expect(snapshot!.trialDaysRemaining).toBeLessThanOrEqual(5);
  });
});

describe('S8-8: <RequireRole>', () => {
  it('renders children when user satisfies requirement', () => {
    mockUser({ effective_role: 'admin', account_status: 'active' });
    render(
      <RequireRole role="admin" fallback={<p>denied</p>}>
        <p>granted</p>
      </RequireRole>,
    );
    expect(screen.getByText('granted')).toBeInTheDocument();
  });

  it('renders fallback when role is below requirement', () => {
    mockUser({ effective_role: 'user', account_status: 'active' });
    render(
      <RequireRole role="superuser" fallback={<p>denied</p>}>
        <p>granted</p>
      </RequireRole>,
    );
    expect(screen.getByText('denied')).toBeInTheDocument();
    expect(screen.queryByText('granted')).toBeNull();
  });

  it('superuser inherits admin permission', () => {
    mockUser({ effective_role: 'superuser', account_status: 'active' });
    render(
      <RequireRole role="admin">
        <p>granted</p>
      </RequireRole>,
    );
    expect(screen.getByText('granted')).toBeInTheDocument();
  });
});

describe('S8-8: <RequireFeature>', () => {
  it('renders children when tier includes feature', () => {
    mockUser({
      effective_role: 'user',
      account_status: 'active',
      features: { kdp_export: true, cover_art: false, social_media: false, max_projects: 5 },
    });
    render(
      <RequireFeature feature="kdp_export">
        <p>has-feature</p>
      </RequireFeature>,
    );
    expect(screen.getByText('has-feature')).toBeInTheDocument();
  });

  it('renders default upgrade prompt when feature is missing', () => {
    mockUser({
      effective_role: 'user',
      account_status: 'active',
      features: { kdp_export: false, cover_art: false, social_media: false, max_projects: 5 },
    });
    render(
      <RequireFeature feature="kdp_export">
        <p>has-feature</p>
      </RequireFeature>,
    );
    expect(screen.queryByText('has-feature')).toBeNull();
    expect(screen.getByText(/requires an upgraded plan/i)).toBeInTheDocument();
  });

  it('honours explicit null fallback (silent hide)', () => {
    mockUser({
      effective_role: 'user',
      account_status: 'active',
      features: { kdp_export: false, cover_art: false, social_media: false, max_projects: 5 },
    });
    render(
      <RequireFeature feature="kdp_export" fallback={null}>
        <p>has-feature</p>
      </RequireFeature>,
    );
    expect(screen.queryByText('has-feature')).toBeNull();
    expect(screen.queryByText(/requires an upgraded plan/i)).toBeNull();
  });

  it('admins/superusers always pass feature gates', () => {
    mockUser({ effective_role: 'admin', account_status: 'active' });
    render(
      <RequireFeature feature="kdp_export">
        <p>admin-can-see</p>
      </RequireFeature>,
    );
    expect(screen.getByText('admin-can-see')).toBeInTheDocument();
  });
});
