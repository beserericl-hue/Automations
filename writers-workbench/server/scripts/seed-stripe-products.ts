/**
 * Mirror the subscription tiers into Stripe (Sprint 9, S9-1), and set up the Customer Portal.
 *
 *   cd server && npx tsx scripts/seed-stripe-products.ts            # create / update
 *   cd server && npx tsx scripts/seed-stripe-products.ts --dry-run  # say what it would do
 *
 * Env (never in the repo): STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * Idempotent. Each paid tier gets one Product (metadata.tier_id) and two recurring Prices found by
 * lookup key `ww_<tier>_<monthly|annual>`. Stripe Prices cannot change amount, so a tier whose price
 * changed gets a new Price that takes over the lookup key; existing subscribers stay on the old one
 * until they change plan. The Price ids are written back to subscription_tiers.
 */
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const dry = process.argv.includes('--dry-run');

function env(name: string): string {
  const v = (process.env[name] || '').trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

interface Tier {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  monthly_price_cents: number;
  annual_price_cents: number;
  monthly_credits: number;
  publicly_selectable: boolean;
  active: boolean;
  stripe_product_id: string | null;
}

async function main(): Promise<void> {
  const key = env('STRIPE_SECRET_KEY');
  const stripe = new Stripe(key);
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
  console.log(`mode: ${key.includes('_live_') ? 'LIVE' : 'test'}${dry ? ' (dry run)' : ''}`);

  const { data, error } = await sb.from('subscription_tiers')
    .select('id, name, display_name, description, monthly_price_cents, annual_price_cents, monthly_credits, publicly_selectable, active, stripe_product_id')
    .order('sort_order');
  if (error) throw new Error(error.message);

  for (const tier of (data ?? []) as Tier[]) {
    if (!(tier.monthly_price_cents > 0 || tier.annual_price_cents > 0)) {
      console.log(`- ${tier.name}: free, not in Stripe`);
      continue;
    }
    let productId = tier.stripe_product_id;
    if (productId) {
      try {
        const p = await stripe.products.retrieve(productId);
        if (p.deleted) productId = null;
      } catch {
        productId = null;
      }
    }
    if (!productId) {
      const found = await stripe.products.search({ query: `metadata['tier_id']:'${tier.id}'` });
      productId = found.data[0]?.id ?? null;
    }
    const productFields = {
      name: `Writers Workbench — ${tier.display_name}`,
      description: tier.description || `${tier.monthly_credits} credits a month`,
      metadata: { tier_id: tier.id, tier_name: tier.name },
      active: tier.active,
    };
    if (dry) {
      console.log(`- ${tier.name}: product ${productId ?? '(new)'}`);
    } else if (productId) {
      await stripe.products.update(productId, productFields);
    } else {
      productId = (await stripe.products.create(productFields)).id;
    }

    const ids: Record<'monthly' | 'annual', string | null> = { monthly: null, annual: null };
    for (const cycle of ['monthly', 'annual'] as const) {
      const amount = cycle === 'annual' ? tier.annual_price_cents : tier.monthly_price_cents;
      if (!(amount > 0)) continue;
      const lookup = `ww_${tier.name}_${cycle}`;
      const existing = (await stripe.prices.list({ lookup_keys: [lookup], active: true, limit: 1 })).data[0];
      if (existing && existing.unit_amount === amount && existing.product === productId) {
        ids[cycle] = existing.id;
        console.log(`  ${cycle}: ${existing.id} $${(amount / 100).toFixed(2)} (unchanged)`);
        continue;
      }
      if (dry) {
        console.log(`  ${cycle}: would ${existing ? 'replace' : 'create'} price $${(amount / 100).toFixed(2)}`);
        continue;
      }
      const price = await stripe.prices.create({
        product: productId!,
        currency: 'usd',
        unit_amount: amount,
        recurring: { interval: cycle === 'annual' ? 'year' : 'month' },
        lookup_key: lookup,
        transfer_lookup_key: true,
        metadata: { tier_id: tier.id, cycle },
      });
      if (existing) await stripe.prices.update(existing.id, { active: false });
      ids[cycle] = price.id;
      console.log(`  ${cycle}: ${price.id} $${(amount / 100).toFixed(2)} (${existing ? 'replaced' : 'new'})`);
    }
    if (!dry) {
      const { error: upErr } = await sb.from('subscription_tiers').update({
        stripe_product_id: productId, stripe_price_monthly_id: ids.monthly, stripe_price_annual_id: ids.annual,
      }).eq('id', tier.id);
      if (upErr) throw new Error(upErr.message);
      console.log(`- ${tier.name}: saved (${productId})`);
    }
  }

  // The Customer Portal refuses to open until a configuration exists in this mode.
  const configs = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
  if (configs.data.length) {
    console.log(`portal: configuration ${configs.data[0].id} exists`);
  } else if (dry) {
    console.log('portal: would create the default configuration');
  } else {
    const c = await stripe.billingPortal.configurations.create({
      business_profile: { headline: 'Writers Workbench billing' },
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        customer_update: { enabled: true, allowed_updates: ['email', 'name', 'address'] },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
      },
    });
    console.log(`portal: created ${c.id}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
