// Sprint 8 (S8-9): pricing card grid used in signup / onboarding / upgrade flows.
// Reads from the public GET /api/tiers endpoint (no auth required).

import { useEffect, useState } from 'react';
import type { SubscriptionTier } from '../../types/database';

export interface PricingCardsProps {
  selectedTierName?: string;
  selectedBilling?: 'monthly' | 'annual' | 'none';
  onSelect: (tier: SubscriptionTier, billing: 'monthly' | 'annual' | 'none') => void;
  highlightTrial?: boolean;
  /** Show a "Most Popular" ribbon on the named tier. */
  popularTierName?: string;
}

export default function PricingCards({
  selectedTierName,
  selectedBilling = 'monthly',
  onSelect,
  highlightTrial = true,
  popularTierName = 'pro',
}: PricingCardsProps) {
  const [tiers, setTiers] = useState<SubscriptionTier[]>([]);
  const [billing, setBilling] = useState<'monthly' | 'annual'>(
    selectedBilling === 'annual' ? 'annual' : 'monthly',
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/tiers');
        const json = (await res.json()) as { success: boolean; data?: SubscriptionTier[]; error?: { message?: string } };
        if (!json.success || !json.data) throw new Error(json.error?.message ?? 'Failed to load tiers');
        setTiers(json.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load pricing');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="text-center text-sm text-gray-500">Loading plans…</div>;
  if (error) return <div className="text-center text-sm text-red-700">{error}</div>;

  const trialTier = highlightTrial ? tiers.find((t) => t.trial_days > 0) : null;
  const otherTiers = tiers.filter((t) => t !== trialTier);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => setBilling('monthly')}
          className={`rounded px-3 py-1 text-sm ${billing === 'monthly' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 border border-gray-300'}`}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => setBilling('annual')}
          className={`rounded px-3 py-1 text-sm ${billing === 'annual' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 border border-gray-300'}`}
        >
          Annual <span className="ml-1 text-xs">(save up to 17%)</span>
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {trialTier && (
          <TierCard
            tier={trialTier}
            billing="none"
            selected={selectedTierName === trialTier.name}
            popular={false}
            ctaLabel="Start free trial"
            onSelect={() => onSelect(trialTier, 'none')}
          />
        )}
        {otherTiers.map((t) => (
          <TierCard
            key={t.id}
            tier={t}
            billing={billing}
            selected={selectedTierName === t.name && (t.monthly_price_cents === 0 ? selectedBilling === 'none' : selectedBilling === billing)}
            popular={t.name === popularTierName}
            ctaLabel="Choose"
            onSelect={() => onSelect(t, t.monthly_price_cents === 0 && t.annual_price_cents === 0 ? 'none' : billing)}
          />
        ))}
      </div>
    </div>
  );
}

interface TierCardProps {
  tier: SubscriptionTier;
  billing: 'monthly' | 'annual' | 'none';
  selected: boolean;
  popular: boolean;
  ctaLabel: string;
  onSelect: () => void;
}

function TierCard({ tier, billing, selected, popular, ctaLabel, onSelect }: TierCardProps) {
  const annualMonthly = Math.round(tier.annual_price_cents / 12);
  const priceCents =
    billing === 'annual' && tier.annual_price_cents > 0
      ? annualMonthly
      : tier.monthly_price_cents;
  const priceLabel = priceCents === 0 ? 'Free' : `$${(priceCents / 100).toFixed(2)} / mo`;
  const annualSaving =
    tier.monthly_price_cents > 0 && tier.annual_price_cents > 0 && billing === 'annual'
      ? Math.round((1 - annualMonthly / tier.monthly_price_cents) * 100)
      : 0;

  const features = (tier.features ?? {}) as Record<string, unknown>;

  return (
    <div
      className={`relative flex flex-col rounded-lg border p-5 ${
        selected ? 'border-blue-600 ring-2 ring-blue-200' : 'border-gray-200'
      } ${popular ? 'shadow-md' : ''}`}
    >
      {popular && (
        <div className="absolute -top-3 right-4 rounded-full bg-blue-600 px-3 py-0.5 text-xs font-bold text-white">
          Most popular
        </div>
      )}
      <h3 className="text-lg font-bold">{tier.display_name}</h3>
      {tier.description && <p className="mt-1 text-xs text-gray-500">{tier.description}</p>}

      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-3xl font-extrabold">{priceLabel}</span>
        {billing === 'annual' && tier.annual_price_cents > 0 && (
          <span className="text-xs text-gray-500">billed annually</span>
        )}
      </div>
      {annualSaving > 0 && (
        <div className="text-xs text-green-700">Save {annualSaving}% vs monthly</div>
      )}

      <ul className="mt-4 space-y-1 text-sm">
        <li>
          <strong>{tier.monthly_credits}</strong> credits / month
        </li>
        {tier.trial_days > 0 && (
          <li><strong>{tier.trial_days}</strong> day free trial</li>
        )}
        {features.kdp_export ? <li>✓ KDP export</li> : <li className="text-gray-400">✗ KDP export</li>}
        {features.cover_art ? <li>✓ Cover art generation</li> : <li className="text-gray-400">✗ Cover art generation</li>}
        {features.social_media ? <li>✓ Social media repurposing</li> : <li className="text-gray-400">✗ Social media repurposing</li>}
        {typeof features.max_projects === 'number' && (
          <li>Up to {features.max_projects} projects</li>
        )}
      </ul>

      <button
        type="button"
        onClick={onSelect}
        className={`mt-5 rounded px-4 py-2 text-sm font-semibold ${
          selected ? 'bg-blue-700 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'
        }`}
      >
        {ctaLabel}
      </button>
    </div>
  );
}
