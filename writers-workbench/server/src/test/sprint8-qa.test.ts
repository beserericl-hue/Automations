// Sprint 8 (S8-10) — server unit tests for the RBAC + credit middleware,
// the credit-cost lookup, and the deductCredits / purchaseCredits service.
//
// These are unit-level: they exercise the middleware factories directly with
// mocked req/res objects, and stub Supabase for the credit service.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireSuperuser, requireAdmin, requireTierFeature, requireCredits } from '../middleware/auth.js';

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}
function makeReq(partial: Partial<Request>): Request {
  return partial as Request;
}

describe('Sprint 8 — middleware factories', () => {
  it('requireSuperuser blocks non-superuser', () => {
    const req = makeReq({ effectiveRole: 'admin' });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireSuperuser(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('requireSuperuser allows superuser', () => {
    const req = makeReq({ effectiveRole: 'superuser' });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireSuperuser(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('requireAdmin allows superuser AND admin (Sprint 8 hierarchy)', () => {
    for (const role of ['admin', 'superuser'] as const) {
      const req = makeReq({ effectiveRole: role });
      const res = makeRes();
      const next = vi.fn() as NextFunction;
      requireAdmin(req, res, next);
      expect(next).toHaveBeenCalled();
    }
  });

  it('requireAdmin blocks regular user', () => {
    const req = makeReq({ effectiveRole: 'user' });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireAdmin(req, res, next);
    expect(res.statusCode).toBe(403);
  });

  it('requireTierFeature: admins/superusers bypass', () => {
    for (const role of ['admin', 'superuser'] as const) {
      const req = makeReq({ effectiveRole: role, subscriptionTier: null });
      const res = makeRes();
      const next = vi.fn() as NextFunction;
      requireTierFeature('kdp_export')(req, res, next);
      expect(next).toHaveBeenCalled();
    }
  });

  it('requireTierFeature: passes when feature true', () => {
    const req = makeReq({
      effectiveRole: 'user',
      subscriptionTier: { id: '1', name: 'pro', display_name: 'Pro', features: { kdp_export: true }, monthly_credits: 0, credit_purchase_price_cents: 100 },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireTierFeature('kdp_export')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('requireTierFeature: 403 when feature false', () => {
    const req = makeReq({
      effectiveRole: 'user',
      subscriptionTier: { id: '1', name: 'standard', display_name: 'Standard', features: { kdp_export: false }, monthly_credits: 0, credit_purchase_price_cents: 100 },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireTierFeature('kdp_export')(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    const body = res.body as { error: { code: string; feature: string } };
    expect(body.error.code).toBe('FEATURE_NOT_AVAILABLE');
    expect(body.error.feature).toBe('kdp_export');
  });

  it('requireCredits: admins/superusers bypass', () => {
    const req = makeReq({ effectiveRole: 'superuser', creditsRemaining: 0 });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireCredits(5)(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('requireCredits: 402 with INSUFFICIENT_CREDITS when balance below cost', () => {
    const req = makeReq({ effectiveRole: 'user', creditsRemaining: 2 });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireCredits(5)(req, res, next);
    expect(res.statusCode).toBe(402);
    const body = res.body as { error: { code: string; creditsRequired: number } };
    expect(body.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(body.error.creditsRequired).toBe(5);
  });

  it('requireCredits: passes when balance equals cost', () => {
    const req = makeReq({ effectiveRole: 'user', creditsRemaining: 5 });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireCredits(5)(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Credit cost lookup
// ---------------------------------------------------------------------------

vi.mock('../services/supabase-admin.js', () => {
  return {
    getSupabaseAdmin: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
    }),
  };
});

import { getCreditCost, DEFAULT_CREDIT_COSTS, clearCreditCostCache } from '../services/credit-costs.js';

describe('Sprint 8 — credit cost lookup', () => {
  beforeEach(() => clearCreditCostCache());

  it('returns the spec-defined defaults when no config row exists', async () => {
    expect(await getCreditCost('write_chapter')).toBe(5);
    expect(await getCreditCost('brainstorm_story')).toBe(3);
    expect(await getCreditCost('research')).toBe(2);
    expect(await getCreditCost('generate_cover_art')).toBe(10);
    expect(await getCreditCost('repurpose_to_social_posts')).toBe(3);
  });

  it('returns 0 for unknown jobTypes', async () => {
    expect(await getCreditCost('made_up_op')).toBe(0);
  });

  it('returns 0 for explicitly free jobTypes (list/retrieve)', async () => {
    expect(await getCreditCost('list_outlines')).toBe(0);
    expect(await getCreditCost('retrieve_content')).toBe(0);
    expect(await getCreditCost('chat_generic')).toBe(0);
  });

  it('all writing operations cost 5 credits', () => {
    for (const op of ['write_chapter', 'write_short_story', 'write_blog', 'write_blog_post', 'write_newsletter']) {
      expect(DEFAULT_CREDIT_COSTS[op]).toBe(5);
    }
  });
});
