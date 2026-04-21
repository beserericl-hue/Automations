# Postal Install Runbook — `N8N-MCP` project on Railway

**Scope:** Install the Postal email server on Railway (in the `N8N-MCP` project alongside your existing services) and wire it into the Writer's Workbench service(s).

**Model:** one Postal installation, two mail servers inside it (one for prod, one for dev), shared `courseworx.media` sending domain. Dev and prod Workbench services get **different** API credentials so they can't see each other's message logs or use each other's keys.

**Not in scope here:** migrating n8n workflows off Gmail — that's Sprint 11, after this runbook is complete.

---

## Current project layout (observed from Railway UI)

- **Project:** `N8N-MCP`
- **Environment:** `production` (single — contains everything)
- **Existing services in this environment include:**
  - `WritersWorkbenchDev` — the dev Workbench
  - `DEV Redis` — dev Redis for the Workbench
  - `n8n Pro Stack` (8 services) — the current n8n deployment
  - `Ollama`, `Open WebUI`
  - `Upwork-Risk-Assessment`
- **DNS provider:** Cloudflare (for `courseworx.media`)

The 3 new Postal services will land in this same project and environment.

---

## Preflight

- [ ] Railway admin on `N8N-MCP`
- [ ] Cloudflare admin access for `courseworx.media`
- [ ] A Gmail inbox (or equivalent) you can check for test emails
- [ ] Local terminal with `openssl` and `curl`

**Cost add:** ~$34/mo (3 new services). **Blast radius before Phase 6:** zero — nothing you do in Phases 1–5 touches any existing service or workflow.

---

## Phase 1 — Add 3 Postal services to `N8N-MCP / production`

Order matters: DB → MQ → App. Open Railway, select **N8N-MCP**, ensure you're in **production**.

### 1.1 `postal-mariadb`

- [ ] Add service → **Docker Image** → `mariadb:10.11`
- [ ] Rename to `postal-mariadb`
- [ ] Variables:
  ```
  MARIADB_ROOT_PASSWORD   <run: openssl rand -base64 24>
  MARIADB_DATABASE        postal
  MARIADB_USER            postal
  MARIADB_PASSWORD        <run: openssl rand -base64 24>
  ```
- [ ] Settings → Volumes → New Volume → **5 GB**, mount at `/var/lib/mysql`
- [ ] Settings → Networking → no public domain (private only)
- [ ] Wait for "Active". Internal hostname: `postal-mariadb.railway.internal`
- [ ] **Save the two passwords** — you need them in 1.3

### 1.2 `postal-rabbitmq`

- [ ] Add service → Docker Image → `rabbitmq:3-management`
- [ ] Rename to `postal-rabbitmq`
- [ ] Variables:
  ```
  RABBITMQ_DEFAULT_USER   postal
  RABBITMQ_DEFAULT_PASS   <run: openssl rand -base64 24>
  RABBITMQ_DEFAULT_VHOST  postal
  ```
- [ ] Volume: **1 GB** at `/var/lib/rabbitmq`
- [ ] No public domain
- [ ] Wait for "Active". Internal hostname: `postal-rabbitmq.railway.internal`
- [ ] **Save the RABBITMQ_DEFAULT_PASS**

### 1.3 `postal`

- [ ] Add service → Docker Image → `ghcr.io/postalserver/postal:3`
- [ ] Rename to `postal`
- [ ] Variables (paste, filling in the saved values):
  ```
  POSTAL_SIGNING_KEY      <run: openssl rand -hex 64>
  MAIN_DB_HOST            postal-mariadb.railway.internal
  MAIN_DB_USERNAME        postal
  MAIN_DB_PASSWORD        <1.1 MARIADB_PASSWORD>
  MAIN_DB_DATABASE        postal
  MESSAGE_DB_HOST         postal-mariadb.railway.internal
  MESSAGE_DB_USERNAME     postal
  MESSAGE_DB_PASSWORD     <1.1 MARIADB_PASSWORD>
  MESSAGE_DB_PREFIX       postal
  RABBITMQ_HOST           postal-rabbitmq.railway.internal
  RABBITMQ_USERNAME       postal
  RABBITMQ_PASSWORD       <1.2 RABBITMQ_DEFAULT_PASS>
  RABBITMQ_VHOST          postal
  RAILS_ENV               production
  ```
- [ ] Settings → Networking → **Generate Domain** (placeholder Railway URL). We alias it in Phase 3.
- [ ] **Do not start yet** — Phase 2 runs init first.

---

## Phase 2 — First-boot initialization

The Postal container's default command (`postal start`) will crash on a fresh DB. Init it once by hand.

- [ ] Railway → `postal` service → Redeploy once so a container exists
- [ ] Open the **Shell** tab on the `postal` service
- [ ] Run:
  ```
  postal initialize-config && postal initialize && postal make-user
  ```
- [ ] `postal make-user` is interactive:
  - Email = your personal email (this is the admin login)
  - Password = generate a strong one; save it to a password manager
  - First / last name
- [ ] Close the shell
- [ ] Settings → **Custom Start Command** → `postal start`
- [ ] Redeploy
- [ ] Visit the Railway-generated public URL for the `postal` service → you should see the Postal login page. Log in → you land on the empty dashboard.

**If it fails:** Deploy Logs on `postal` usually show the cause in the first 20 lines. Most common is a typo in the MariaDB password between 1.1 and 1.3.

---

## Phase 3 — Alias `postal-admin.courseworx.media` via Cloudflare

- [ ] Cloudflare → `courseworx.media` → DNS → Add record:
  - Type: **CNAME**
  - Name: `postal-admin`
  - Target: the Railway public URL of the `postal` service (without `https://`)
  - Proxy status: **DNS only (grey cloud)** — orange-clouding breaks Railway's cert handshake
- [ ] Railway → `postal` → Settings → Networking → **Custom Domain** → `postal-admin.courseworx.media` → wait for "Active" (green)
- [ ] Visit `https://postal-admin.courseworx.media` → same login page as the Railway URL

---

## Phase 4 — Postal admin UI (one org, two mail servers)

### 4.1 Organization
- [ ] Log in → New Organization → `Course Worx Media`

### 4.2 Sending domain (shared across mail servers)
- [ ] Organization → Domains → Add Domain → `courseworx.media`
- [ ] Keep this page open — its DNS records list is Phase 5's input

### 4.3 Prod mail server
- [ ] Mail Servers → New → name `writers-workbench-mail-prod`, mode **Live**
- [ ] Open it → Credentials → New → type **API**, label `prod-api-key`
- [ ] **Copy the key value** → this becomes `POSTAL_API_KEY` on your production Workbench service

### 4.4 Dev mail server
- [ ] Mail Servers → New → name `writers-workbench-mail-dev`
- [ ] Mode: **Development** (Postal swallows outbound mail and only logs it — safer for initial testing; switch to Live when ready)
- [ ] Credentials → New → type **API**, label `dev-api-key`
- [ ] **Copy the key value** → this becomes `POSTAL_API_KEY` on `WritersWorkbenchDev`

---

## Phase 5 — Publish DNS records on Cloudflare for `courseworx.media`

Values come from the Postal domain page (Phase 4.2).

| Cloudflare Type | Name                     | Value                                                        | Proxy |
|-----------------|--------------------------|--------------------------------------------------------------|-------|
| TXT             | `postal._domainkey`      | (DKIM public key from Postal UI)                             | n/a   |
| TXT             | `postal-verification`    | (ownership proof from Postal UI)                             | n/a   |
| TXT             | `@`                      | `v=spf1 include:spf.courseworx.media ~all`                   | n/a   |
| TXT             | `spf`                    | (SPF detail from Postal UI)                                  | n/a   |
| CNAME           | `psrp`                   | (return-path target from Postal UI)                          | **DNS only (grey cloud)** |
| TXT             | `_dmarc`                 | `v=DMARC1; p=quarantine; rua=mailto:dmarc@courseworx.media; pct=100` | n/a |

**Cloudflare quirks:**
- `psrp` CNAME must be **grey cloud** — orange-clouding breaks return-path
- If Cloudflare warns the root `v=spf1` conflicts with an existing SPF, merge them into one record; never publish two SPF records at the root
- Paste TXT values in quotes if Cloudflare truncates them

Verify:
- [ ] Wait ~30 min for propagation
- [ ] Postal UI → `courseworx.media` → refresh → every row must turn green
- [ ] **Do not move on until all green**

---

## Phase 6 — Wire env vars into your Workbench service(s)

### 6.1 `WritersWorkbenchDev` (visible in your current Railway view)

Select the service → Variables → add:
```
POSTAL_API_URL        https://postal-admin.courseworx.media/api/v1
POSTAL_API_KEY        <dev-api-key from 4.4>
EMAIL_SECRET          <run: openssl rand -hex 32>
SENDER_EMAIL          eve@courseworx.media
SENDER_NAME           The Writers Workbench (Dev)
REPLY_TO_EMAIL        support@courseworx.media
DRY_RUN_EMAIL         true
```
Railway auto-redeploys on env var change.

### 6.2 Production Workbench service (when/if present in `N8N-MCP`)

Same set, **except**:
- `POSTAL_API_KEY` = the prod-api-key from 4.3
- `SENDER_NAME` = `The Writers Workbench`
- **Omit** `DRY_RUN_EMAIL` (or set to `false`)

### Notes
- Same `POSTAL_API_URL` on both services — only `POSTAL_API_KEY` differs, and that's what identifies which mail server the send belongs to
- `DRY_RUN_EMAIL=true` on dev is a safety belt. The Workbench code (shipped in Phase 7) logs payloads instead of calling Postal. Flip to `false` when you're ready to send real test mail from dev.
- `EMAIL_SECRET` can be identical in both; it's the shared secret between n8n and `/api/email/send`

---

## Phase 7 — Workbench code work (my PR)

Nothing above adds `/api/email/send` to the Workbench — that's a separate, stackable PR against `develop` that adds:

- `server/src/lib/email.ts` — Postal client (`sendEmail({ to, subject, html, attachments?, bcc?, replyTo?, from? })`)
- `server/src/routes/email.ts` — `POST /api/email/send`, gated by `X-Email-Secret`, per-user rate limit
- `server/src/schemas.ts` — `EmailSendSchema`
- `/api/health` → new `checks.postal`
- `DRY_RUN_EMAIL=true` honored (short-circuits the Postal call, returns a synthetic message_id)
- Unit tests

Ping the assistant when Phases 1–6 are green and this PR will be opened.

---

## Phase 8 — Smoke test (after Phase 7 deploys)

### 8.1 Dev dry-run
```
curl -X POST https://writersworkbenchdev-production-*.up.railway.app/api/email/send \
  -H "Content-Type: application/json" \
  -H "X-Email-Secret: <dev EMAIL_SECRET>" \
  -d '{"to":"your@email.com","subject":"Postal dry-run","html":"<p>hi</p>"}'
```
Expect `{ success: true, message_id: "dry-run-..." }`. Nothing in inbox. `/api/health` shows `checks.postal: ok`.

### 8.2 Dev live
- [ ] Flip `DRY_RUN_EMAIL=false` on `WritersWorkbenchDev`, wait for redeploy
- [ ] Repeat the curl
- [ ] Email arrives in your Gmail inbox within seconds
- [ ] Gmail → show original → `Authentication-Results: spf=pass dkim=pass dmarc=pass`
- [ ] `From:` shows `eve@courseworx.media`
- [ ] Postal UI → `writers-workbench-mail-dev` → Messages — the send is `delivered`

### 8.3 Prod (if you have a prod Workbench in `N8N-MCP`)
Same curl against the prod URL with the **prod** `EMAIL_SECRET`. The entry appears under `writers-workbench-mail-prod` in Postal, **not** dev.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Postal UI won't load after Phase 2 | Bad DB/MQ password mismatch | Deploy Logs on `postal` → fix env vars on the service |
| Custom domain never goes green in Railway | Cloudflare CNAME is orange-clouded | Switch to DNS-only (grey cloud) |
| Postal DKIM row stays red after 30 min | CF cached / TXT value truncated | Click Verify again; wrap the TXT value in quotes in CF if it was |
| Email lands in Gmail Spam | SPF/DKIM/DMARC not all green yet | Wait; check each row |
| `From:` is a Railway address | `SENDER_EMAIL` not set on the Workbench service | Add it; auto-redeploys |
| 401 on `/api/email/send` | `X-Email-Secret` missing or wrong | Match to the Workbench env value |
| 502/504 on `/api/email/send` | Postal unreachable | `postal` service logs + admin UI reachable? |
| Dev sends under prod mail server | Wrong API key on `WritersWorkbenchDev` | Regenerate both, re-paste |

---

## What you're building, one-paragraph recap

Three new Railway services in `N8N-MCP / production` (MariaDB + RabbitMQ + Postal) plus 6 Cloudflare DNS records for `courseworx.media`. Inside Postal, one organization with two mail servers — one for your dev Workbench, one for production — each with its own API key and its own message logs. Shared sending domain, shared sender reputation. Dev starts in Postal's Development mode and `DRY_RUN_EMAIL=true` so the first weeks of testing can't hurt inbox placement. Once the Phase 7 code PR ships, `/api/email/send` is live, both Workbench services can send via Postal, and Sprint 11 can start migrating the 15 n8n V2 workflows off the Gmail OAuth credential.

---

## After this runbook

1. **Sprint 11** — swap the Gmail node in 15 V2 n8n workflows for an HTTP Request node to `/api/email/send`. Workflow-editing on `DEV - <name>` copies first, then promoted to PROD via `scripts/promote-dev-to-prod.py`. Gmail OAuth decommissioned when the last workflow flips.
2. **Add MX record** (future, optional) — when we want bounce webhooks or reply-to at a real mailbox
3. **Postal bounce/complaint webhook** → Sprint 11 S11-5
