# Postal Install Runbook — one installation, two environments

**Scope:** Newsletter Sprint S7 — install the Postal email server on Railway and wire it into the Writer's Workbench for **both** the `production` and `development` Railway environments.

**Model:** one Postal installation, shared across both environments. Inside Postal we create **two mail servers** (one for prod, one for dev), each with its own API credential, so the two environments cannot use each other's keys or log views. The `courseworx.media` sending domain and DNS records are configured **once** and shared.

**Not in scope here:** migrating n8n workflows off Gmail — that is Sprint 11, which happens after this runbook is complete.

---

## Railway project layout (what you already have)

- **Project:** `bubbly-solace`
- **Environments inside the project:**
  - `production` — hosts `writersworkbench-production.up.railway.app`, Redis service named `Redis`
  - `development` — hosts `writersworkbenchdev-production.up.railway.app`, Redis service named `Redis_Dev`
- **Where Postal will live:** the `production` environment (one copy, shared). Both Workbench services will call it over the public `postal-admin.courseworx.media` URL.

---

## Preflight — collect these before you start

- [ ] DNS admin access for `courseworx.media` (wherever the zone lives — Namecheap, Cloudflare, Route53, etc.)
- [ ] Railway owner/admin access to the `bubbly-solace` project
- [ ] A Gmail (or Outlook/ProtonMail) inbox you can check for test emails
- [ ] Local terminal with `openssl` (for generating secrets) and `curl` (for smoke test)

You will generate several secrets during the install. Keep them in a password manager as you go; Railway hides env var values after save.

---

## Cost + rollback

- **Estimated monthly cost:** ~$34/mo for the three Postal services (MariaDB 5 GB + RabbitMQ 1 GB + Postal app container)
- **Rollback:** delete the three services and the two API keys in Postal. Nothing in the Workbench code paths depends on Postal until Sprint 11 replaces the Gmail node in n8n workflows.

---

## Phase 1 — Deploy the 3 Postal services (Railway `production` environment)

Order matters: MariaDB → RabbitMQ → Postal. Postal needs both running before its first boot.

Switch Railway to the **production** environment before you start. (Top of the project page.)

### 1.1 `postal-mariadb`

- [ ] New → Deploy from Docker Image → `mariadb:10.11`
- [ ] Env vars:
  - `MARIADB_ROOT_PASSWORD` = `openssl rand -base64 24`
  - `MARIADB_DATABASE` = `postal`
  - `MARIADB_USER` = `postal`
  - `MARIADB_PASSWORD` = `openssl rand -base64 24`
- [ ] Storage → New Volume, **5 GB**, mount at `/var/lib/mysql`
- [ ] Networking → Private only (no public domain)
- [ ] Copy the internal hostname — should be `postal-mariadb.railway.internal`
- [ ] Wait for the service to show "Running" before continuing

### 1.2 `postal-rabbitmq`

- [ ] New → Deploy from Docker Image → `rabbitmq:3-management`
- [ ] Env vars:
  - `RABBITMQ_DEFAULT_USER` = `postal`
  - `RABBITMQ_DEFAULT_PASS` = `openssl rand -base64 24`
  - `RABBITMQ_DEFAULT_VHOST` = `postal`
- [ ] Storage → New Volume, **1 GB**, mount at `/var/lib/rabbitmq`
- [ ] Networking → Private only
- [ ] Copy the internal hostname — should be `postal-rabbitmq.railway.internal`
- [ ] Wait for "Running"

### 1.3 `postal`

- [ ] New → Deploy from Docker Image → `ghcr.io/postalserver/postal:3`
- [ ] Env vars (paste in, substituting the values from 1.1 and 1.2):
  ```
  POSTAL_SIGNING_KEY=<openssl rand -hex 64>
  MAIN_DB_HOST=postal-mariadb.railway.internal
  MAIN_DB_USERNAME=postal
  MAIN_DB_PASSWORD=<1.1 MARIADB_PASSWORD>
  MAIN_DB_DATABASE=postal
  MESSAGE_DB_HOST=postal-mariadb.railway.internal
  MESSAGE_DB_USERNAME=postal
  MESSAGE_DB_PASSWORD=<1.1 MARIADB_PASSWORD>
  MESSAGE_DB_PREFIX=postal
  RABBITMQ_HOST=postal-rabbitmq.railway.internal
  RABBITMQ_USERNAME=postal
  RABBITMQ_PASSWORD=<1.2 RABBITMQ_DEFAULT_PASS>
  RABBITMQ_VHOST=postal
  RAILS_ENV=production
  ```
- [ ] Networking → attach a Railway-generated public domain (placeholder; we alias it to `postal-admin.courseworx.media` in Phase 3)
- [ ] Do NOT start yet — the first boot needs the init commands in Phase 2

---

## Phase 2 — First-boot initialization

Postal needs its database schema installed and an admin user created before it can serve the UI. Do this once.

- [ ] On the `postal` service, open Railway's **Shell** tab
- [ ] Run:
  ```
  postal initialize-config && postal initialize && postal make-user
  ```
- [ ] `postal make-user` is interactive. Provide:
  - Email address (use your personal email — this is the admin login)
  - Password (save to password manager)
  - First / last name
- [ ] Close the shell
- [ ] Back in the service's **Settings**, change the start command to: `postal start`
- [ ] Restart the service
- [ ] Wait for "Running". Visit the Railway public URL for the `postal` service — you should see the Postal login page.

**Troubleshooting:** if the page doesn't load, check the service logs for DB or RabbitMQ connection errors. The usual cause is a typo in one of the four passwords copied from services 1.1/1.2.

---

## Phase 3 — Alias the Postal admin URL

- [ ] DNS provider → add a **CNAME** record: `postal-admin.courseworx.media` → the Railway-generated public URL of the `postal` service (e.g. `postal-production.up.railway.app`)
- [ ] Railway → `postal` service → Networking → **Add Custom Domain** → `postal-admin.courseworx.media`
- [ ] Wait for DNS propagation (usually under 10 min). Railway's custom domain panel shows green when resolved.

---

## Phase 4 — Postal admin UI configuration (one org, two mail servers)

This is where the "one install, two environments" pattern happens.

### 4.1 Log in and create the organization

- [ ] Visit `https://postal-admin.courseworx.media`
- [ ] Log in with the admin from Phase 2
- [ ] **New Organization** → Name: `Course Worx Media`

### 4.2 Create the sending domain (shared across both mail servers)

- [ ] Organization → **Domains** → Add Domain → `courseworx.media`
- [ ] Keep this tab open — it lists 5–6 DNS records that Phase 5 will publish

### 4.3 Create the PROD mail server

- [ ] Organization → **Mail Servers** → New Mail Server
- [ ] Name: `writers-workbench-mail-prod`
- [ ] Mode: Live (default)
- [ ] Once created: → Credentials → New → Type **API**
- [ ] Label it "prod-api-key". **Copy the key value** — you will use it for `POSTAL_API_KEY` on the production Workbench service.

### 4.4 Create the DEV mail server

- [ ] Organization → Mail Servers → New Mail Server
- [ ] Name: `writers-workbench-mail-dev`
- [ ] Mode: Live (default). If you want dev sends to go into a sandbox instead of reaching real inboxes, choose **Development** mode here — Postal swallows outbound mail and just logs it. (Recommended for initial testing; switch to Live later when you're ready for real dev delivery.)
- [ ] Credentials → New → Type **API**
- [ ] Label it "dev-api-key". **Copy the key value** — this is `POSTAL_API_KEY` for the development Workbench service.

**Why two mail servers:** separate API credentials (compromise one, the other is unaffected), separate message logs in the Postal UI (you can tell dev vs prod traffic apart), and separate per-server rate and send limits.

---

## Phase 5 — Publish the DNS records for `courseworx.media`

Do this once. Both mail servers share the same sending domain.

The exact values come from the `courseworx.media` domain page in Postal (from Phase 4.2).

| Type  | Host                                    | Value                                                        |
|-------|-----------------------------------------|--------------------------------------------------------------|
| TXT   | `postal._domainkey.courseworx.media`    | DKIM public key (copy from Postal UI)                        |
| TXT   | `postal-verification.courseworx.media`  | ownership proof (copy from Postal UI)                        |
| TXT   | `@` (root)                              | `v=spf1 include:spf.courseworx.media ~all`                   |
| TXT   | `spf.courseworx.media`                  | SPF detail (copy from Postal UI — contains Railway egress IP)|
| CNAME | `psrp.courseworx.media`                 | return-path target (copy from Postal UI)                     |
| TXT   | `_dmarc.courseworx.media`               | `v=DMARC1; p=quarantine; rua=mailto:dmarc@courseworx.media; pct=100` |

**Do not add an MX record** yet — this runbook covers outbound only. Add MX later when we need bounce / reply handling at a real address.

- [ ] All records published
- [ ] Wait ~30 min for propagation
- [ ] Back in Postal UI → `courseworx.media` domain page → refresh. Every record should show a green checkmark. **Do not proceed past this phase until all rows are green.**

---

## Phase 6 — Wire env vars into Railway

### 6.1 Production Workbench service

Switch Railway to the **production** environment, select the `writers-workbench` service, and add:

```
POSTAL_API_URL=https://postal-admin.courseworx.media/api/v1
POSTAL_API_KEY=<prod-api-key from Phase 4.3>
EMAIL_SECRET=<openssl rand -hex 32>
SENDER_EMAIL=eve@courseworx.media
SENDER_NAME=The Writers Workbench
REPLY_TO_EMAIL=support@courseworx.media
```

### 6.2 Development Workbench service

Switch to **development** environment, select the `writers-workbench-dev` service, and add the same set **except** with the dev API key:

```
POSTAL_API_URL=https://postal-admin.courseworx.media/api/v1
POSTAL_API_KEY=<dev-api-key from Phase 4.4>
EMAIL_SECRET=<same value as prod — or a different one if you prefer>
SENDER_EMAIL=eve@courseworx.media
SENDER_NAME=The Writers Workbench (Dev)
REPLY_TO_EMAIL=support@courseworx.media
DRY_RUN_EMAIL=true
```

Notes:
- `POSTAL_API_URL` is the same in both envs. Only the API key differs — that's how Postal knows which mail server the send came from.
- `DRY_RUN_EMAIL=true` on dev is a safety belt: the Workbench code logs the send instead of calling Postal. Flip it to `false` (or remove the var) once you're confident and ready for dev to send real mail.
- `EMAIL_SECRET` is the shared secret between n8n and the Workbench's `/api/email/send` endpoint (Sprint 11). It's fine to use the same value across envs for now; rotate later if one is exposed.

No Railway restarts are needed — env var changes trigger an automatic redeploy.

---

## Phase 7 — Code work on the Workbench (not yet done)

None of the above calls any Workbench endpoint — Postal is installed but the Workbench doesn't know how to reach it until we add the `/api/email/send` route. That's a separate, stackable PR:

- `server/src/lib/email.ts` — `sendEmail({ to, subject, html, attachments?, bcc?, replyTo?, from? })`
- `server/src/routes/email.ts` — `POST /api/email/send`, gated by `X-Email-Secret` header, per-user rate limit
- `server/src/schemas.ts` — `EmailSendSchema` (zod)
- `server/src/routes/health.ts` — add `checks.postal` to the health payload
- `DRY_RUN_EMAIL=true` short-circuits the send and returns a fake `message_id`
- Unit tests in `server/src/test/email.test.ts`

Ping the assistant when Phases 1–6 are green and the PR will be opened against `develop`.

---

## Phase 8 — Smoke test (once Phase 7 ships)

Test against **dev first**, then prod.

### 8.1 Dev smoke (with `DRY_RUN_EMAIL=true`)

```
curl -X POST https://writersworkbenchdev-production.up.railway.app/api/email/send \
  -H "Content-Type: application/json" \
  -H "X-Email-Secret: <dev EMAIL_SECRET>" \
  -d '{"to":"your@email.com","subject":"Postal dry-run test","html":"<p>hello</p>"}'
```

- Expected: `{ success: true, message_id: "dry-run-..." }`
- Nothing arrives in the inbox (that's intentional with `DRY_RUN_EMAIL=true`)
- `/api/health` reports `checks.postal: ok`

### 8.2 Dev smoke (with `DRY_RUN_EMAIL=false`)

Flip the env var to `false` (or remove it), wait for redeploy, repeat the curl.

- Expected: email arrives at the test inbox within seconds
- Gmail → message details → `Authentication-Results` shows `spf=pass dkim=pass dmarc=pass`
- `From:` shows `eve@courseworx.media`, not a Railway-generated address
- Postal admin UI → `writers-workbench-mail-dev` → Messages — the send is listed as `delivered`

### 8.3 Prod smoke

Repeat 8.2 against the prod Workbench URL using the **prod** `EMAIL_SECRET`. The entry should appear in Postal under `writers-workbench-mail-prod`, not under the dev mail server.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Email lands in Gmail **Spam** | DKIM or SPF not yet green in Postal | Wait for DNS propagation; verify each DNS record matches what Postal shows |
| Email arrives but `From:` is a Railway address | `SENDER_EMAIL` not set on Workbench env | Add `SENDER_EMAIL=eve@courseworx.media` and redeploy |
| `curl` to `/api/email/send` returns 401 | Wrong or missing `X-Email-Secret` header | Match to the Workbench env value |
| `curl` returns 502 / 504 | Postal service down or unreachable | Check `postal` service logs in Railway; visit `postal-admin.courseworx.media` to confirm the UI loads |
| Postal UI won't load | MariaDB or RabbitMQ not running / wrong credentials | Railway logs on the `postal` service; first few lines show DB / MQ errors |
| Dev sends are landing in the prod mail server log | Dev Workbench has the prod API key | Rotate the prod key in Postal, update the prod Workbench env, update the dev Workbench env with the dev key |
| Postal admin UI says DKIM unverified, DNS is live | TTL cache on Postal's side | Click **Verify** on the domain page a second time; or wait 15 min |

---

## What comes after

Once Phase 8 is all green:

1. **Ready to migrate n8n workflows** — Sprint 11 replaces the Gmail node in 15 V2 workflows with an HTTP Request node to `/api/email/send`. That's workflow-editing on the `DEV - <name>` copies, then promotion to PROD via `scripts/promote-dev-to-prod.py` (per `docs/workflow-governance.md`). The Gmail OAuth credential can be decommissioned once the final workflow migrates.
2. **Add MX for inbound** (future, optional) — only needed when we want bounce webhooks pointed at a real mailbox or reply-to to work.
3. **Add Postal webhook for bounces/complaints** — Sprint 11 S11-5; Postal sends those to `/api/email/webhook/postal` once configured.

---

## Notes on the "one install, two environments" choice

- Trade-off accepted: dev and prod share the `courseworx.media` sender reputation. If a runaway dev job sends thousands of test emails, Gmail / Outlook may start scoring the whole domain as spammy.
- Mitigations:
  - `DRY_RUN_EMAIL=true` on dev until tests are known-good
  - A tight per-user rate limit in `/api/email/send` (default 30/min; admin-overridable later)
  - Separate Postal mail-server logs so you can see dev spikes before the reputation cratering
- If we ever do see reputation impact from dev volume, the escape hatch is **Option B**: a second Postal stack in the `development` environment, with its own sending subdomain (`dev.courseworx.media`) and its own DNS records. That's a 3-hour job if we ever need it.

---

## Appendix — why each piece exists

- **MariaDB** — Postal's metadata store (organizations, domains, credentials, message index). 5 GB is plenty for the first year.
- **RabbitMQ** — Postal's internal job queue for outbound message processing. Not to be confused with our BullMQ queue; they are unrelated.
- **Postal** — the app container itself. Serves the admin UI, the HTTP API, and the SMTP outbound workers.
- **Two API credentials** — the unit of isolation between dev and prod inside one Postal installation. If a dev key is leaked in logs or a screenshot, we revoke *only* that key; prod continues working.
- **`EMAIL_SECRET`** — not a Postal thing. It's the shared header that protects our own `/api/email/send` endpoint from being called by anyone who discovers its URL. n8n workflows send it as `X-Email-Secret`.
