# Stripe billing (Sprint 9)

Stripe is the source of truth for billing. Supabase is the source of truth for access. Entitlements
(tier, credits, account access) change only in the signed webhook, `POST /api/webhooks/stripe`.

## What it covers

| What | Where |
|---|---|
| Subscribe, upgrade (prorated now), downgrade (period end), cancel / reactivate, card + invoices | `/billing`, `server/src/routes/billing.ts` |
| Credit packs | Credits page → Stripe Checkout; credits added by the webhook |
| Webhook (signature on the raw body, each event once, 500 on failure) | `server/src/routes/stripe-webhook.ts`, `stripe_events_v2` |
| Billing state rules (status mapping, once-only grants, suspension) | `server/src/services/billing.ts` |
| Admin revenue, subscribers, retry payment, event log; superuser refunds | Admin → Revenue, `server/src/routes/billing-admin.ts` |
| Drift sync, ended cancellations, reader-order retry, trial reminder | `/api/cron/subscription-sync`, `/api/cron/trial-conversion-reminder` (engine lifecycle job, hourly) |
| Reader print orders | `/books/<slug>/print` → Checkout → webhook places the RPI order |

Admins, superusers and the comp tier (`free_full`) are never charged.

## Rules worth knowing

- **The key decides the mode.** An `sk_test_` key means test mode, and `sk_live_` means live.
  A test customer id is never sent to a live key (`stripe_customers_v2.mode`).
- **Payments are refused until the webhook secret is set.** `paymentsReady()` needs both the key and
  `STRIPE_WEBHOOK_SECRET`, because nothing is granted except by the webhook.
- **Credits are granted once per period invoice.** Only `subscription_create` and
  `subscription_cycle` invoices reset the allowance. A proration invoice, from an upgrade, does
  not; the upgrade raises the balance through `customer.subscription.updated` instead, and never
  lowers it.
- **Once-only is enforced by the database.** Grants write their ledger row first under the unique
  index `uq_credit_tx_grant_reference`, so two concurrent webhook deliveries grant once. Purchases
  are unique per PaymentIntent.
- **Three failed payments suspend the account** (`user_account_meta_v2.account_status`). An admin
  lock is never lifted by billing.
- **A paid reader order RPI refuses stays `PAID`** and the sync cron retries it.
- **Never add a second foreign key from `user_subscriptions` to `subscription_tiers`.** It makes
  every `subscription_tiers(...)` embed ambiguous (PGRST201). The auth middleware used to read that
  error as "no subscription" and re-provisioned trials over real plans (DEV, 2026-10-27). The
  middleware now answers 503 instead, but the embed still breaks.

## Setting up an environment (DEV done 2026-10-27; PROD at release)

1. **Run the migrations.** 039 needs the `pending_tier_id` foreign key dropped. Run 040 (RLS on
   `writing_embeddings_v2`).
2. **Set Railway variables on the Workbench service, never in git:**
   - `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`: live keys on PROD.
   - `PUBLIC_APP_URL`, if it differs from `ALLOWED_ORIGINS[0]`.
3. **Register the webhook endpoint** `https://<app>/api/webhooks/stripe` for these events:
   - `checkout.session.completed`, `checkout.session.expired`
   - `invoice.paid`, `invoice.payment_failed`
   - `customer.subscription.created`, `.updated`, `.deleted`
   - `payment_intent.succeeded`, `charge.refunded`

   Set its signing secret as `STRIPE_WEBHOOK_SECRET`. Set this LAST, together with the code that
   handles it.
4. **Create the products and prices:** `cd server && npx tsx scripts/seed-stripe-products.ts`.
   It's idempotent, and it also creates the Customer Portal configuration.
5. **Backfill customers:** `POST /api/superuser/billing/backfill`.

## Testing

- **Server:** `server/src/test/sprint9-qa.test.ts` uses real Stripe signatures and in-memory
  Stripe and Supabase.
- **Client:** `client/src/components/billing/BillingPage.test.tsx`.
- **E2E (heavy pass):** `e2e/regression/sprint9-billing.spec.ts`. It covers a real subscription
  through Stripe's hosted Checkout with test card 4242, and a reader print order. Each run makes
  its own user and deletes it.
