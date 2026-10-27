import { test, expect, type Page } from '@playwright/test';
import { supaGet } from '../pages/api';

/**
 * Sprint 9 (S9-9): real payments in Stripe TEST mode against DEV, through Stripe's own hosted
 * Checkout page with Stripe's test cards. Heavy (Pass B): each run makes Stripe test payments and,
 * for the reader order, an RPI SANDBOX order (never printed or charged).
 *
 * PASS
 *   - a fresh trial user subscribes to Standard: Checkout → the webhook makes the plan active with
 *     its credits, and the billing API shows the plan and the card; deleting the account cancels the
 *     Stripe subscription first;
 *   - a reader buys a printed copy from the public book page with no login and no JavaScript forms:
 *     the order is paid and placed with RPI, and the thank-you page says so.
 *
 * Each run uses its own user, so runs never share state, and the user is deleted at the end.
 */
const BASE = process.env.E2E_BASE_URL || 'http://localhost:5173';
const SUPA_URL = (process.env.SUPABASE_URL || process.env.E2E_SUPA_URL || '').replace(/\/$/, '');
const SERVICE = process.env.E2E_SUPA_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON = process.env.VITE_SUPABASE_ANON_KEY || '';
const HAS_KEYS = Boolean(SUPA_URL && SERVICE && ANON && /gvbvwcnmjkdpclcisqrr/.test(SUPA_URL));
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

function svc(): Record<string, string> {
  return { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
}

const made: Array<{ userId: string; authId: string; token: string }> = [];

async function makeTrialUser(): Promise<{ userId: string; email: string; token: string }> {
  const email = `billing-e2e+${RUN}@example.com`;
  const userId = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const created = await fetch(`${SUPA_URL}/auth/v1/admin/users`, { method: 'POST', headers: svc(), body: JSON.stringify({ email, email_confirm: true }) });
  if (!created.ok) throw new Error(`create auth user: ${created.status} ${await created.text()}`);
  const auth = (await created.json()) as { id: string };
  const row = await fetch(`${SUPA_URL}/rest/v1/users_v2`, { method: 'POST', headers: { ...svc(), Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: userId, phone_number: userId, display_name: `Billing E2E ${RUN}`, email, role: 'user', supabase_auth_uid: auth.id }) });
  if (!row.ok) throw new Error(`create users_v2: ${row.status} ${await row.text()}`);
  const link = await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: svc(), body: JSON.stringify({ type: 'magiclink', email }) });
  const { hashed_token } = (await link.json()) as { hashed_token: string };
  const verify = await fetch(`${SUPA_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed_token }) });
  const { access_token } = (await verify.json()) as { access_token: string };
  made.push({ userId, authId: auth.id, token: access_token });
  return { userId, email, token: access_token };
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

/** Fill Stripe's hosted Checkout with a test card and submit. Returns where Stripe sent us. */
async function payOnStripe(page: Page, url: string, card = '4242424242424242'): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const label = page.locator('#payment-method-label-card');
  await label.waitFor({ timeout: 60_000 });
  const box = await label.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('#cardNumber').fill(card);
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  await page.locator('#billingName').fill('Billing E2E');
  const zip = page.locator('#billingPostalCode');
  if (await zip.isVisible().catch(() => false)) await zip.fill('21201');
  // Stripe ticks "Save my information with Link" for some customers, and then demands a phone
  // number before it will submit. A test never opts into Link.
  const link = page.getByRole('checkbox', { name: /Save my information/i });
  if (await link.isVisible().catch(() => false) && await link.isChecked().catch(() => false)) await link.uncheck({ force: true });
  await page.locator('[data-testid="hosted-payment-submit-button"]').click();
  await page.waitForURL((u) => !u.href.includes('checkout.stripe.com'), { timeout: 120_000 });
  return page.url();
}

test.describe('Sprint 9 billing on DEV (Stripe test mode)', () => {
  test.skip(!HAS_KEYS, 'needs the DEV service and anon keys');
  test.setTimeout(6 * 60_000);

  test('a trial user subscribes through Stripe Checkout; the webhook activates the plan; deleting cancels it', async ({ page }) => {
    const user = await makeTrialUser();
    const before = await api(user.token, 'GET', '/api/billing/status');
    expect(before.json.data).toMatchObject({ managed: false, payments_ready: true, has_stripe_subscription: false });
    const tiers = (await api(user.token, 'GET', '/api/tiers')).json.data as Array<{ id: string; name: string; monthly_credits: number }>;
    const standard = tiers.find((t) => t.name === 'standard')!;
    // A paid tier cannot be had for free.
    expect((await api(user.token, 'POST', '/api/account/subscribe', { tier_name: 'standard', billing_cycle: 'monthly' })).status).toBe(402);

    const checkout = await api(user.token, 'POST', '/api/billing/checkout', { tier_id: standard.id, billing_cycle: 'monthly' });
    expect(checkout.status).toBe(200);
    const landed = await payOnStripe(page, checkout.json.data.checkout_url);
    expect(landed).toContain('/billing/success?session_id=cs_test_');

    let sub: any;
    await expect.poll(async () => {
      [sub] = await supaGet('user_subscriptions', `user_id=eq.${encodeURIComponent(user.userId)}&select=*,tier:subscription_tiers!user_subscriptions_tier_id_fkey(name)`);
      return sub?.stripe_status;
    }, { timeout: 60_000 }).toBe('active');
    expect(sub).toMatchObject({ status: 'active', billing_cycle: 'monthly', credits_remaining: standard.monthly_credits });
    expect(sub.tier.name).toBe('standard');
    const grants = await supaGet('credit_transactions', `user_id=eq.${encodeURIComponent(user.userId)}&transaction_type=eq.monthly_reset&select=reference_id`);
    expect(grants).toHaveLength(1); // checkout and invoice.paid together grant once

    const after = (await api(user.token, 'GET', '/api/billing/status')).json.data;
    expect(after).toMatchObject({ has_stripe_subscription: true, status: 'active', tier: { name: 'standard' } });
    expect(after.card).toMatchObject({ last4: '4242' });

    // Deleting the account cancels the subscription first: no card is charged after the account is gone.
    const del = await api(user.token, 'DELETE', '/api/account', { confirmation: 'DELETE' });
    expect(del.status).toBe(200);
    await expect.poll(async () => {
      const ev = await supaGet('stripe_events_v2', `object_id=eq.${sub.stripe_subscription_id}&event_type=eq.customer.subscription.deleted&select=id`);
      return ev.length;
    }, { timeout: 60_000 }).toBeGreaterThan(0);
  });

  test('a reader buys a printed copy from the public page: paid, then placed with RPI', async ({ page }) => {
    const offers = await supaGet('print_offers_v2', 'enabled=eq.true&select=project_id&limit=1');
    test.skip(!offers.length, 'no printed copy is offered for sale on DEV');
    const [project] = await supaGet('writing_projects_v2', `id=eq.${offers[0].project_id}&select=outline->_landing_page_public->>slug`);
    const slug = (project as Record<string, string>).slug;
    test.skip(!slug, 'the book with the offer has no public page');

    await page.goto(`/books/${slug}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Order a printed copy' }).first().click();
    await expect(page.getByRole('heading', { name: 'Order a printed copy' })).toBeVisible();
    await page.getByLabel('Full name').fill(`Riley Reader ${RUN}`);
    await page.getByLabel(/^Email/).fill(`reader-e2e+${RUN}@example.com`);
    await page.getByLabel('Address', { exact: true }).fill('100 W Pratt St');
    await page.getByLabel('City').fill('Baltimore');
    await page.getByLabel(/State/).fill('MD');
    await page.getByLabel(/ZIP/).fill('21201');
    await page.getByRole('button', { name: 'See shipping and total' }).click();
    await expect(page.getByRole('heading', { name: 'Shipping and total' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Total \$\d+\.\d{2}/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Pay with Stripe' }).click();
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
    const landed = await payOnStripe(page, page.url());
    expect(landed).toContain(`/books/${slug}/print/thanks`);
    await expect(page.getByRole('heading', { name: /your order is in/ })).toBeVisible();

    let order: any;
    await expect.poll(async () => {
      [order] = await supaGet('print_orders_v2', `order_kind=eq.reader&buyer_name=eq.${encodeURIComponent(`Riley Reader ${RUN}`)}&select=*`);
      return order?.status;
    }, { timeout: 90_000 }).toMatch(/RECEIVED|RECEIVED_BY_PRINTER|VALID/);
    expect(order).toMatchObject({ mode: 'sandbox', destination: { city: 'Baltimore' } });
    expect(order.paid_at).toBeTruthy();
    expect(order.customer_order_id).toBe(`ww-${order.id}`);
  });
});

// Whatever a run created goes, even when a test failed half way: the account delete route cancels a
// Stripe subscription first; a user it could not delete is removed directly.
test.afterAll(async () => {
  for (const u of made) {
    const del = await api(u.token, 'DELETE', '/api/account', { confirmation: 'DELETE' }).catch(() => ({ status: 0 }));
    if (del.status !== 200) {
      await fetch(`${SUPA_URL}/rest/v1/users_v2?user_id=eq.${encodeURIComponent(u.userId)}`, { method: 'DELETE', headers: svc() });
      await fetch(`${SUPA_URL}/auth/v1/admin/users/${u.authId}`, { method: 'DELETE', headers: svc() });
    }
  }
});
