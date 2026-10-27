/**
 * One Stripe Customer per user (Sprint 9, S9-2), kept in stripe_customers_v2 (users_v2 is a base
 * table and cannot take the column the sprint document asked for).
 *
 * Every call degrades: if Stripe is down or not configured, user creation and profile edits carry
 * on, and the customer is created on the next action that needs one.
 */
import type Stripe from 'stripe';
import { getSupabaseAdmin } from './supabase-admin.js';
import { getStripeClient, stripeConfigured, stripeMode } from './stripe.js';
import { logger } from '../lib/logger.js';

interface UserRow {
  user_id: string;
  email: string | null;
  display_name: string | null;
  phone_number: string | null;
  supabase_auth_uid: string | null;
}

async function loadUser(userId: string): Promise<UserRow | null> {
  const { data } = await getSupabaseAdmin()
    .from('users_v2')
    .select('user_id, email, display_name, phone_number, supabase_auth_uid')
    .eq('user_id', userId)
    .maybeSingle();
  return (data as UserRow | null) ?? null;
}

function customerFields(u: UserRow): Stripe.CustomerCreateParams {
  return {
    email: u.email ?? undefined,
    name: u.display_name ?? undefined,
    // Stripe takes any string; user ids here are phone numbers, which is also the contact number.
    phone: u.phone_number ?? (u.user_id.startsWith('+') ? u.user_id : undefined),
    metadata: { user_id: u.user_id, supabase_auth_uid: u.supabase_auth_uid ?? '' },
  };
}

/** The user's Stripe customer id in this key's mode, if one is on record. */
export async function existingCustomerId(userId: string): Promise<string | null> {
  const { data } = await getSupabaseAdmin()
    .from('stripe_customers_v2')
    .select('stripe_customer_id, mode')
    .eq('user_id', userId)
    .maybeSingle();
  if (!data || data.mode !== stripeMode()) return null;
  return String(data.stripe_customer_id);
}

/**
 * The user's Stripe Customer, created the first time it is needed. Idempotent: a second call
 * returns the same id. A Stripe idempotency key per user makes two concurrent first calls create
 * one customer, not two.
 */
export async function getOrCreateStripeCustomer(userId: string): Promise<string> {
  const known = await existingCustomerId(userId);
  if (known) return known;
  const user = await loadUser(userId);
  if (!user) throw new Error(`no users_v2 row for ${userId}`);
  const customer = await getStripeClient().customers.create(customerFields(user), {
    idempotencyKey: `ww-customer-${stripeMode()}-${userId}`,
  });
  const { error } = await getSupabaseAdmin()
    .from('stripe_customers_v2')
    .upsert({ user_id: userId, stripe_customer_id: customer.id, mode: stripeMode() }, { onConflict: 'user_id' });
  if (error) throw new Error(`could not save the Stripe customer: ${error.message}`);
  logger.info({ userId, customerId: customer.id }, 'stripe: customer created');
  return customer.id;
}

/** Best-effort version for hooks (user creation, signup): never throws. */
export async function ensureStripeCustomer(userId: string): Promise<string | null> {
  if (!stripeConfigured()) return null;
  try {
    return await getOrCreateStripeCustomer(userId);
  } catch (err) {
    logger.warn({ err, userId }, 'stripe: customer not created; will retry on the next billing action');
    return null;
  }
}

/** Push the user's current email / name / phone to their Stripe Customer. Never throws. */
export async function syncCustomerToStripe(userId: string): Promise<boolean> {
  if (!stripeConfigured()) return false;
  try {
    const id = await existingCustomerId(userId);
    const user = await loadUser(userId);
    if (!id || !user) return false;
    const { metadata: _m, ...fields } = customerFields(user);
    await getStripeClient().customers.update(id, fields);
    return true;
  } catch (err) {
    logger.warn({ err, userId }, 'stripe: customer sync failed');
    return false;
  }
}

export async function findUserByStripeCustomerId(customerId: string): Promise<string | null> {
  const { data } = await getSupabaseAdmin()
    .from('stripe_customers_v2')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return data ? String(data.user_id) : null;
}

/** Customers for every user who has none (S9-2 backfill). Returns what was created and what failed. */
export async function backfillStripeCustomers(): Promise<{ created: number; existing: number; failed: string[] }> {
  const { data: users } = await getSupabaseAdmin().from('users_v2').select('user_id');
  const { data: have } = await getSupabaseAdmin().from('stripe_customers_v2').select('user_id, mode');
  const done = new Set((have ?? []).filter((r) => r.mode === stripeMode()).map((r) => String(r.user_id)));
  let created = 0;
  const failed: string[] = [];
  for (const u of users ?? []) {
    const id = String(u.user_id);
    if (done.has(id)) continue;
    try {
      await getOrCreateStripeCustomer(id);
      created++;
    } catch (err) {
      logger.warn({ err, userId: id }, 'stripe: backfill failed for user');
      failed.push(id);
    }
  }
  return { created, existing: done.size, failed };
}
