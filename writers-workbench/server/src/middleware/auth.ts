import { Request, Response, NextFunction } from 'express';
import { getSupabaseAdmin } from '../services/supabase-admin.js';
import { logger } from '../lib/logger.js';

// Sprint 8: extended auth context. Legacy fields (userId, authUid, userRole) stay
// for backward compatibility with code written before Sprint 8.
declare global {
  namespace Express {
    interface Request {
      userId?: string;            // Effective user_id (= impersonatedUserId when impersonating, else realUserId)
      authUid?: string;           // Supabase Auth UUID of the actually-logged-in user
      userRole?: string;          // Legacy users_v2.role of the actually-logged-in user
      // Sprint 8 additions:
      effectiveRole?: 'superuser' | 'admin' | 'user';
      accountStatus?: 'active' | 'locked' | 'suspended' | 'pending';
      subscriptionTier?: SubscriptionTierLite | null;
      creditsRemaining?: number | null;
      realUserId?: string;        // The actually-logged-in user (= req.userId unless impersonating)
      isImpersonating?: boolean;
      impersonationLogId?: string;
    }
  }
}

export interface SubscriptionTierLite {
  id: string;
  name: string;
  display_name: string;
  features: Record<string, unknown>;
  monthly_credits: number;
  credit_purchase_price_cents: number;
}

interface RoleMetaRow { role: 'superuser' | 'admin' }
interface AccountMetaRow { account_status: 'active' | 'locked' | 'suspended' | 'pending' }
interface SubscriptionRow {
  id: string;
  tier_id: string;
  credits_remaining: number;
  status: string;
  tier?: SubscriptionTierLite | SubscriptionTierLite[] | null;
}

/**
 * Verifies the Supabase JWT and loads the user's full Sprint 8 auth context
 * (effective role, account status, subscription tier, credits). Blocks
 * non-active accounts. Supports superuser impersonation via X-Impersonate-User.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header' } });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const supabase = getSupabaseAdmin();

    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authUser) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      return;
    }

    const { data: userRecord, error: userError } = await supabase
      .from('users_v2')
      .select('user_id, role')
      .eq('supabase_auth_uid', authUser.id)
      .single();

    if (userError || !userRecord) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User profile not found' } });
      return;
    }

    const realUserId: string = userRecord.user_id;
    const legacyRole: string = userRecord.role || 'user';

    // Load Sprint 8 meta tables in parallel
    const [roleMetaRes, accountMetaRes, subRes] = await Promise.all([
      supabase.from('user_role_meta_v2').select('role').eq('user_id', realUserId).maybeSingle(),
      supabase.from('user_account_meta_v2').select('account_status').eq('user_id', realUserId).maybeSingle(),
      supabase
        .from('user_subscriptions')
        .select('id, tier_id, credits_remaining, status, tier:subscription_tiers!inner(id, name, display_name, features, monthly_credits, credit_purchase_price_cents)')
        .eq('user_id', realUserId)
        .maybeSingle(),
    ]);

    const roleMeta = (roleMetaRes.data ?? null) as RoleMetaRow | null;
    const accountMeta = (accountMetaRes.data ?? null) as AccountMetaRow | null;
    const subscription = (subRes.data ?? null) as SubscriptionRow | null;

    const effectiveRole: 'superuser' | 'admin' | 'user' = roleMeta?.role
      ?? (legacyRole === 'admin' ? 'admin' : 'user');
    const accountStatus = accountMeta?.account_status ?? 'active';

    // Block locked/suspended accounts. Superusers bypass this so they can
    // never lock themselves out (e.g. via a bad admin action).
    if (accountStatus !== 'active' && effectiveRole !== 'superuser') {
      const code = accountStatus === 'locked' ? 'ACCOUNT_LOCKED'
        : accountStatus === 'suspended' ? 'ACCOUNT_SUSPENDED'
        : 'ACCOUNT_PENDING';
      const message = accountStatus === 'locked' ? 'Account is locked. Contact support.'
        : accountStatus === 'suspended' ? 'Account is suspended.'
        : 'Account pending activation.';
      res.status(403).json({ success: false, error: { code, message } });
      return;
    }

    // Tier from joined subscription. Supabase's PostgREST nests it as either
    // an object (single FK) or array (depending on join shape) — normalise.
    let tier: SubscriptionTierLite | null = null;
    if (subscription?.tier) {
      tier = Array.isArray(subscription.tier) ? subscription.tier[0] ?? null : subscription.tier;
    }

    req.authUid = authUser.id;
    req.realUserId = realUserId;
    req.userId = realUserId;
    req.userRole = legacyRole;
    req.effectiveRole = effectiveRole;
    req.accountStatus = accountStatus;
    req.subscriptionTier = tier;
    req.creditsRemaining = subscription?.credits_remaining ?? null;
    req.isImpersonating = false;

    // ===== Impersonation: superuser-only =====
    const impersonateHeader = req.headers['x-impersonate-user'];
    const impersonateTarget = typeof impersonateHeader === 'string' ? impersonateHeader.trim() : '';

    if (impersonateTarget && effectiveRole === 'superuser' && impersonateTarget !== realUserId) {
      // Verify there is an active impersonation_log row for this superuser/target pair.
      const { data: activeImp } = await supabase
        .from('impersonation_log')
        .select('id, target_user_id')
        .eq('superuser_id', realUserId)
        .is('ended_at', null)
        .maybeSingle();

      if (activeImp && activeImp.target_user_id === impersonateTarget) {
        req.userId = impersonateTarget;
        req.isImpersonating = true;
        req.impersonationLogId = activeImp.id as string;
      }
      // If header is set but no matching active session, we silently keep
      // req.userId = realUserId. Caller should call POST /api/superuser/impersonate first.
    }

    next();
  } catch (err) {
    logger.error({ err }, 'requireAuth failed');
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication failed' } });
  }
}

/**
 * Admin-or-superuser. Replaces the pre-Sprint-8 admin check. The legacy
 * users_v2.role='admin' still resolves to admin via effectiveRole.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.effectiveRole !== 'admin' && req.effectiveRole !== 'superuser') {
    res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    return;
  }
  next();
}

/** Superuser only. */
export function requireSuperuser(req: Request, res: Response, next: NextFunction): void {
  if (req.effectiveRole !== 'superuser') {
    res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Superuser access required' } });
    return;
  }
  next();
}

/**
 * Tier-feature gate. Apply after requireAuth. Superuser/admin bypass.
 *
 *   router.post('/export', requireAuth, requireTierFeature('kdp_export'), handler);
 */
export function requireTierFeature(feature: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.effectiveRole === 'superuser' || req.effectiveRole === 'admin') {
      next();
      return;
    }
    const features = (req.subscriptionTier?.features ?? {}) as Record<string, unknown>;
    if (features[feature] === true) {
      next();
      return;
    }
    res.status(403).json({
      success: false,
      error: {
        code: 'FEATURE_NOT_AVAILABLE',
        message: `This feature requires a higher subscription tier`,
        feature,
        currentTier: req.subscriptionTier?.name ?? null,
      },
    });
  };
}

/**
 * Credit gate. Apply after requireAuth. Superuser/admin bypass — they are
 * not credit-limited. The check here is BEFORE the operation runs; deduction
 * happens after success via deductCredits().
 */
export function requireCredits(amount: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.effectiveRole === 'superuser' || req.effectiveRole === 'admin') {
      next();
      return;
    }
    const remaining = req.creditsRemaining ?? 0;
    if (remaining >= amount) {
      next();
      return;
    }
    res.status(402).json({
      success: false,
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message: `Insufficient credits. This operation requires ${amount} credits; you have ${remaining}. Purchase more or wait for monthly reset.`,
        creditsRequired: amount,
        creditsRemaining: remaining,
      },
    });
  };
}
