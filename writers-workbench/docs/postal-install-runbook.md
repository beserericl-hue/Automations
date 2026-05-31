# Postal Install Runbook — `N8N-MCP` Railway project

**Reality check:** this runbook has been rewritten after an incorrect first draft. The earlier version had wrong facts about Postal 3.x (it assumed RabbitMQ was needed, that a single service with `postal start` would work, and that env vars alone could configure it). None of that is true. Postal 3.x requires:

- **One** MariaDB service (no RabbitMQ, no Redis)
- **Three** Postal processes each running as its own Railway service: `postal web-server`, `postal worker`, `postal smtp-server`
- **A `/config` volume** on each Postal service holding two files: `postal.yml` and `signing.key`

All values, passwords, and file contents you need are pasted inline below. Nothing to generate yourself.

---

## Existing project state

- **Project:** `N8N-MCP` on Railway
- **Environment:** `production`
- **Already running:** `postal-mariadb` (OK), `postal-rabbitmq` (delete this — not needed in Postal 3.x), `postal` (crashed — will be replaced)
- **DNS:** Cloudflare for `courseworx.media`

---

## Phase 0 — Clean up the bad state

### 0.1 Delete `postal-rabbitmq` and its volume

Postal 3.x doesn't use RabbitMQ. Keeping it just burns money.

1. Click the `postal-rabbitmq` service tile → three-dot menu → **Delete Service**
2. Find the `postal-rabbitmq-volume` tile on the canvas → three-dot menu → **Delete Volume**

### 0.2 Delete the broken `postal` service

1. Click the `postal` service tile → three-dot menu → **Delete Service**
2. If it had any volumes attached, delete those too

### 0.3 Confirm `postal-mariadb` is still healthy

- Tile should show **Online / Active** (green dot)
- `postal-mariad-volume` (or whatever you named it) is mounted at `/var/lib/mysql` — 5 GB

---

## Phase 1 — Create `postal-web` service

This is the Postal admin UI + HTTP API container. The Workbench's `/api/email/send` will call this service.

### 1.1 Add the service

- Add service → Deploy from Docker Image → `ghcr.io/postalserver/postal:3.3.5`
- Rename to `postal-web`
- Do NOT attach a public domain yet

### 1.2 Add the /config volume

- On the service → Settings → (or right-click the tile → Attach Volume)
- Mount path: `/config`
- Size: **1 GB**
- Click Create

### 1.3 Paste these env vars (Raw Editor)

Passwords below are the ones you generated for `postal-mariadb` earlier. If you generated different ones, substitute yours — but `MAIN_DB_PASSWORD` and `MESSAGE_DB_PASSWORD` MUST match whatever `MARIADB_PASSWORD` is on the `postal-mariadb` service.

```
MAIN_DB_HOST=postal-mariadb.railway.internal
MAIN_DB_USERNAME=postal
MAIN_DB_PASSWORD=f4etJ7zFeJKdNHWYxMKvNBKNqBxbxElX
MAIN_DB_DATABASE=postal
MESSAGE_DB_HOST=postal-mariadb.railway.internal
MESSAGE_DB_USERNAME=postal
MESSAGE_DB_PASSWORD=f4etJ7zFeJKdNHWYxMKvNBKNqBxbxElX
MESSAGE_DB_PREFIX=postal
POSTAL_CONFIG_FILE_PATH=/config/postal.yml
POSTAL_SIGNING_KEY_PATH=/config/signing.key
RAILS_ENVIRONMENT=production
WAIT_FOR_TARGETS=postal-mariadb.railway.internal:3306
WAIT_FOR_TIMEOUT=90
BIND_ADDRESS=0.0.0.0
PORT=8080
```

`BIND_ADDRESS=0.0.0.0` makes Puma listen on every network interface (not just loopback) so Railway's edge can reach the container. `PORT=8080` pins Postal's listen port so it matches the Networking target port we set in Phase 3.2.

### 1.4 Set the Custom Start Command (temporary)

In Settings → Deploy → **Custom Start Command**:
```
sleep infinity
```

This keeps the container running while we hand-write the config files into `/config`. We'll change this to `postal web-server` after initialization.

### 1.5 Deploy

Click Deploy (or it auto-deploys on save). Wait for **Active / Running**.

---

## Phase 2 — Write `postal.yml` and `signing.key` to /config

### 2.1 SSH into postal-web from your Mac

In Terminal (you've already installed and logged into Railway CLI):

```bash
railway ssh --project=dae709fb-7ec3-4e41-aa7a-aa648c0dbd0b --environment=bb1a2dc4-5f0a-4334-90c6-6a5bee6811ff --service=<postal-web service id>
```

To find the service id: click the `postal-web` service in Railway → the URL bar shows `/service/<id>/...` — that's the id.

You should drop into a shell prompt like `postal@container:/opt/postal/app$`.

### 2.2 Write `/config/postal.yml`

Paste this entire block into the shell — it's one multi-line `cat` command that writes the file:

```bash
cat > /config/postal.yml << 'POSTAL_YML_EOF'
version: 2

postal:
  web_hostname: postal-admin.courseworx.media
  web_protocol: https
  smtp_hostname: postal.courseworx.media

main_db:
  host: postal-mariadb.railway.internal
  port: 3306
  username: postal
  password: f4etJ7zFeJKdNHWYxMKvNBKNqBxbxElX
  database: postal

message_db:
  host: postal-mariadb.railway.internal
  port: 3306
  username: postal
  password: f4etJ7zFeJKdNHWYxMKvNBKNqBxbxElX
  prefix: postal

smtp_server:
  default_bind_address: "::"
  port: 25

dns:
  mx_records:
    - mx.postal.courseworx.media
  spf_include: spf.postal.courseworx.media
  return_path_domain: rp.postal.courseworx.media
  route_domain: routes.postal.courseworx.media
  track_domain: track.postal.courseworx.media

smtp:
  host: 127.0.0.1
  port: 2525
  username:
  password:
  from_name: Postal
  from_address: postal@courseworx.media

rails:
  secret_key: 3837d5d5042ddd87afb9f6e0f511202b33682640fc33096efb55c8ea3b526dfb6e6a7b6084dd423953a93b80f25782e10b514a9499b41ba0510ad50842558a76
POSTAL_YML_EOF
```

### 2.3 Write `/config/signing.key`

Paste this entire block:

```bash
cat > /config/signing.key << 'SIGNING_KEY_EOF'
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDeys4Rn3uXR3xb
pZGq/txKdypNMt5v/0wC0jE1ujPiFwyU1uLVXLzECQHwK1nzsiM/JT+KFDbT7fkx
QyYdfIrB9AXxSY0pSn7AnrwRtEa88JWOn2be9zS8DvwuMR8R3bN3pHNcBaUlg9f8
D2ETtMEJMCTbk6ITfQrb2qCWLRgUWHiwkNAHjSsFU3XsBywWyn6Y3ZyXQl6xuN80
h6BTonHs8lJdu1AFIWi1q+OQ0BrXZ5y9wiJNnR0TtAO/PSYmYOmDrZJyyg2q21zE
yAYoR6+Mf9AmjYQWkPBoX8/+Ybk8wpOVPCyEJ40najhVhr9zgtZS9b7x2VGRr+sg
jj0Ko/wxAgMBAAECggEAMLDcFofnZ+mMqS7nRhrLJE8k5JhQeuOtxhQQAzD9s9Tb
wA+ypXTOIH3jeYzP7O2qvFs0psXCMdEZnAWT5+/XF4pwXgp4GmUYjJpkee4PY62k
0fXOcr5OPSd9P88mfi4Y0fYT7DGjpS5KXuExky/23D40X/TFAENcwy3l2MxkLdW7
eiLe+cGqPP0sWwIC0zQQ0DKk7nZDvJYtZZydytOHfn2W4eLl44JzAR6tYcxvQXAk
4vKKNrL4/RPmd8S5s5ayOEQJRQcMvWWls3loHqXPapTFhnZO5M/5CDih88Pk5r4t
+g9MkwT3/jPCb/ggIu+YF6pR3P2W2Xp8+EMaEfIWLQKBgQD+WsY4JHq3+lL88zDv
T3jt5rfdjIqaK+e6k+/SqDCfEPAKj9+cmbuafU7OubCoLcs6iZLTVM/5pw+E5bRB
KtdMfRPiXcjiBIJAq7KwYsz3tLNIA9tChFKuZvTn0LlzlMXQBwt/o6F+RHnP/GCX
T5jh+zSwG6yU4XaaBiR+VKz+xwKBgQDgO8L1mofS4tVEOXpszOo4oRH53HVGdvKn
6S0p7I0umlvNKqSHo/FjIXk5FDecmH+6EU5nvXVeMOlsW1PbF85bkwJBVm7mL5vG
jc/wqS/mLns5WHruh46sPcOXZs0Y30AUdrxBPO/i01ui42hAJKI12A8+kh9xMKxy
7Ix8HSUVRwKBgCnyXm4z1ekxZy5ADPnqaU8SlY/79X+nbfffHdXn1tzktjGHuKDi
2YWI1M5S4UdbBgEJXyVq/0F0w6JvH2L/5bG/jt/uB4r+o1x29GkSYisXqdleiXJW
0Cvi3tC8I1lkV5sPDl5mZeOk91HNlUBe6B+chfvlFHkZFa4hBTOwUzdRAoGBAIcp
fsss6tJjiMonG3SZ0FVyQbOq/8YJzRsJov+yZyfAQ7XYDnT0jXyDoN6XIS5zfgpa
hDhkK2srcIiwREu8fdcVNjbMMuztpah5su4ODaFiQ0S94NwHOij40f1hKh/j8mxj
ZfatFKxVWtdE3IJNkrmCEy5URj+kZ06e58+ogcHhAoGAQyPG/XPa9/p4khB4lN/w
6Mq2S53F0Tat4K2m7t5hlhMfPNOLOHDvppwEzK7rRNygB1fSVeHuYkjdzHaIciU4
vne5rEzs4BOnkW2iO7m+TgALI/gFqNEhd0PLFtlO2O50UasMxQ4PDNeoyB73Pz6W
gz71/wEyH9o2P5Xss7tFIzg=
-----END PRIVATE KEY-----
SIGNING_KEY_EOF
```

### 2.4 Lock down permissions

```bash
chmod 600 /config/signing.key
chmod 644 /config/postal.yml
ls -l /config
```

You should see both files listed with the expected permissions.

### 2.5 Initialize the Postal database

Still inside the SSH session:

```bash
postal initialize-config
postal initialize
```

`initialize-config` validates the config file, `initialize` creates the schema in MariaDB. Both should complete without errors. If they fail, the error message will tell you what's wrong (almost always either a DB connection problem or a malformed postal.yml).

### 2.6 Create the admin user

```bash
postal make-user
```

Answer the prompts:
- Email: your email address (this is your admin login)
- Password: pick a strong one, save it to your password manager
- First name / Last name

### 2.7 Exit the shell

```bash
exit
```

### 2.8 Grant wildcard privileges to the postal user in MariaDB

Postal creates a **separate MySQL database per mail server** named `postal-server-1`, `postal-server-2`, etc. Without a wildcard grant, MariaDB denies the `postal` user when Postal tries to create those databases — you'll see `Access denied for user 'postal'@'%' to database 'postal-server-1'` in the `postal-web` logs and the UI will 500 on Build Server.

SSH into `postal-mariadb`:
```bash
railway ssh --project=<your-project-id> --environment=<your-env-id> --service=<postal-mariadb-service-id>
```

Open MariaDB as root (use the `MARIADB_ROOT_PASSWORD` you set on the `postal-mariadb` service):
```bash
mariadb -uroot -p'<MARIADB_ROOT_PASSWORD>'
```

Run these three SQL statements:
```sql
GRANT ALL PRIVILEGES ON `postal-%`.* TO 'postal'@'%';
FLUSH PRIVILEGES;
EXIT;
```

Exit the container:
```bash
exit
```

This grant uses the `postal-%` wildcard, so it covers every per-mail-server database Postal will ever create (`postal-server-1`, `postal-server-2`, etc.) in one command.

---

## Phase 3 — Switch postal-web to run the web server

### 3.1 Change the Custom Start Command

Back in Railway → `postal-web` → Settings → Deploy → **Custom Start Command**:

Change from:
```
sleep infinity
```
to:
```
postal web-server
```

### 3.2 Generate a public domain and set target port to 8080

Settings → Networking → **Generate Domain**. You'll get something like `postal-web-production-xxxx.up.railway.app`. On the same domain entry, set **Target Port = `8080`** (must match the `PORT` env var). Save.

### 3.3 Redeploy

Top of service → Redeploy.

### 3.4 Verify

- Wait for Active / Running
- Open the Railway-generated URL in your browser
- You should see the Postal login page
- Log in with the admin you created in Step 2.6

If login works, move on. If not, open the `postal-web` Deploy Logs and find the error — it'll be specific.

---

## Phase 4 — Create `postal-worker` service

The worker processes queued outbound messages. Without it, mail just piles up in the DB and never sends.

### 4.1 Add the service

- Add service → Deploy from Docker Image → `ghcr.io/postalserver/postal:3.3.5`
- Rename to `postal-worker`
- No public domain

### 4.2 Add the /config volume

- Attach Volume → Mount at `/config`, size **1 GB**

### 4.3 Paste the same env vars as postal-web

Copy the full env var block from Phase 1.3 into the postal-worker Raw Editor. Identical values.

### 4.4 Start with sleep, populate /config, switch to worker

Same pattern as postal-web:

1. Custom Start Command → `sleep infinity`, deploy, wait for Active
2. `railway ssh --project=... --service=<postal-worker id>`
3. Paste the same `cat > /config/postal.yml` block from Phase 2.2
4. Paste the same `cat > /config/signing.key` block from Phase 2.3
5. `chmod 600 /config/signing.key && chmod 644 /config/postal.yml`
6. `exit`
7. Back in Railway → Custom Start Command → `postal worker`
8. Redeploy
9. Wait for Active

**Do NOT run `postal initialize` here.** The DB is already initialized by postal-web; running it again on the worker is unnecessary (and harmless if you do).

---

## Phase 5 — Alias the admin URL via Cloudflare

- Cloudflare DNS → `courseworx.media` → Add record:
  - Type: **CNAME**
  - Name: `postal-admin`
  - Target: the Railway public URL of `postal-web` (hostname only, no `https://`)
  - Proxy: **DNS only (grey cloud)** — orange-clouding breaks Railway's cert handshake
- Railway → `postal-web` → Settings → Networking → **Custom Domain** → `postal-admin.courseworx.media`
- Wait for Railway to issue a cert (green status)
- Verify: `https://postal-admin.courseworx.media` loads the same login page

---

## Phase 6 — Configure Postal (complete click-by-click flow)

This phase walks you from "logged in as admin for the first time" all the way to "two mail servers with API credentials, dev key pasted into Railway." No skipping, no assumptions.

### 6.1 Log in

Open `https://postal-admin.courseworx.media`. Log in with the admin user you created via `postal make-user` in Phase 2.6.

### 6.2 Create the organization

If this is your first login, you'll see "You are not a member of any organization."

1. Click **Create a new organization**
2. **NAME:** `Courseworx Media`
3. **SHORT NAME:** leave blank (auto-generates `courseworx-media`)
4. Click **Create organization**

### 6.3 Add the sending domain at the organization level

You land on the org root with a dark tab bar: `Mail Servers | Domains | Settings | Delete Organization`.

1. Click **Domains**
2. Click **Add Domain**
3. **NAME:** `courseworx.media`
4. Click **Create Domain**

Postal shows **4 DNS record sections** on the domain's DNS Setup page: SPF, DKIM, Return Path, and MX. Copy the values Postal displays (especially the DKIM public key — it's generated per install and unique to your domain).

### 6.4 Publish DNS records in Cloudflare

In another tab: Cloudflare → `courseworx.media` → DNS → Records → **Add record**.

| Section on Postal page | Required? | Cloudflare Type | Cloudflare Name | Cloudflare Content | Proxy |
|------------------------|-----------|-----------------|-----------------|--------------------|-------|
| **SPF Record** | **REQUIRED** | TXT | `@` (root) | Paste the `v=spf1 ... ~all` string exactly as Postal shows | (TXT has no proxy) |
| **DKIM Record** | **REQUIRED** | TXT | Copy ONLY the subdomain portion from Postal (e.g. if Postal shows `postal-iGSiwP._domainkey.courseworx.media`, paste `postal-iGSiwP._domainkey` — Cloudflare auto-appends the root) | Paste the full DKIM string as one line — includes `v=DKIM1; t=s; h=sha256; p=<long key>;` | (TXT has no proxy) |
| **Return Path** | Recommended | CNAME | `psrp` (or whatever subdomain Postal shows) | The target Postal shows, e.g. `rp.postal.courseworx.media` | **grey cloud (DNS only)** |
| **MX Records** | **OPTIONAL** — skip for outbound-only | MX | `@` | `mx.postal.courseworx.media` (or whatever Postal shows) with priority `10` | n/a |

**Critical rules:**
- The Return Path CNAME **must be grey cloud (DNS only)**. Orange cloud breaks the handshake.
- Skip the MX record unless you need Postal to **receive** inbound mail. For outbound-only API sending, it's not needed.
- Copy DKIM exactly — the string is long (several hundred characters). Cloudflare may split it into multiple quoted segments automatically; that's fine.
- If Cloudflare complains the DKIM value is too long, drop the trailing `;` and try again.

Wait 2–10 min for propagation.

### 6.5 Verify DNS in Postal

Back in Postal's domain page, click **Check my records are correct**. What should turn green:

- SPF row → **must** turn green
- DKIM row → **must** turn green
- Return Path row → ideal but not blocking; mail will still send if this stays red
- MX row → will stay red if you skipped it; that's expected and harmless

**Do not proceed past here until SPF and DKIM are both green.** Postal will not send from a domain where DKIM is unverified.

The domain's overview banner should change to "DKIM & SPF configured correctly on 1 domain" once those two are green.

### 6.6 Create the production mail server

1. Breadcrumb → click **Courseworx Media** to return to org root
2. Dark tab bar → **Mail Servers**
3. Click **Build a new mail server**
4. Form:
   - **NAME:** `writers-workbench-mail-prod`
   - **SHORT NAME:** blank
   - **MODE:** `Live`
5. Click **Build server**

You land on this mail server's Overview page with banner `writers-workbench-mail-prod` and a green LIVE ribbon.

### 6.7 Authorize courseworx.media on the prod mail server

In the horizontal tab bar at the top of this mail server (Overview / Messages / Domains / Routing / Credentials / Webhooks / Settings):

1. Click **Domains**
2. Click **Add Domain**
3. **NAME:** `courseworx.media`
4. Click **Add Domain**

### 6.8 Create the prod API credential

1. Horizontal tab bar → **Credentials**
2. Click **Add new Credential**
3. Form:
   - **Type:** `API`
   - **Name:** `prod-api-key`
   - **Hold?:** unchecked (unchecked = actually send; checked = queue for manual review)
4. Click **Create**
5. **Copy the API key value** from the credential detail page
6. Save in your password manager labeled "Postal prod API key"

### 6.9 Create the dev mail server

1. Breadcrumb → **Courseworx Media**
2. Dark tab bar → **Mail Servers**
3. Click **Build a new mail server**
4. Form:
   - **NAME:** `writers-workbench-mail-dev`
   - **SHORT NAME:** blank
   - **MODE:** **Development** — pay attention to this dropdown. If you leave it at `Live`, the dev server will actually deliver mail to real inboxes instead of swallowing it. If you miss this at creation, Step 6.10 shows how to fix it.
5. Click **Build server**

### 6.10 Verify (or fix) the dev mail server's Mode

**Why:** The green **LIVE** badge you see on the mail server list means "server is active/online" — NOT "Live mode". Both Live-mode and Development-mode servers show a green LIVE badge. The only way to confirm the actual mode is to open the server's settings form.

**To verify / fix:**

1. In your browser, paste this URL and press Enter (replaces any click path):
   ```
   https://postal-admin.courseworx.media/org/courseworx-media/servers/writers-workbench-mail-dev/edit
   ```
2. You land on the mail server's edit form, which shows:
   - **Name:** `writers-workbench-mail-dev`
   - **Permalink:** disabled (auto-generated)
   - **Mode:** dropdown — this is what you're checking
3. Confirm Mode is set to **`Development`**. If it says `Live`, change it:
   - Click the Mode dropdown
   - Pick `Development`
   - Scroll to the bottom of the form
   - Click **Save server**

**Alternative click path (if you don't want to use the URL):**

1. Left sidebar → click the `writers-workbench-mail-dev` service
2. Horizontal tab bar at top of content area → click **Settings**
3. A SECOND nav bar appears below the first, showing: `Server Settings | Spam | Retention | Send Limit | Advanced Settings | Delete`
4. Click **Server Settings** in that second bar
5. Edit form loads — change Mode dropdown to `Development`, click **Save server**

In Postal 3.3.5 the top-level Settings tab is a gateway to a secondary nav. Don't expect Mode to be on the first page you see after clicking Settings — it's one level deeper, under "Server Settings".

### 6.11 Authorize courseworx.media on the dev mail server

Horizontal tab bar on THIS dev mail server (confirm the banner says `writers-workbench-mail-dev`, not `-prod`):

1. Click **Domains**
2. Click **Add Domain**
3. **NAME:** `courseworx.media`
4. Click **Add Domain**

### 6.12 Create the dev API credential

1. Click **Credentials** tab
2. Click **Add new Credential**
3. Form:
   - **Type:** `API`
   - **Name:** `dev-api-key`
   - **Hold?:** unchecked
4. Click **Create**
5. **Copy the API key value** from the credential detail page
6. Save in your password manager labeled "Postal dev API key"

### 6.13 Confirm both mail servers exist

Breadcrumb → **Courseworx Media** → **Mail Servers**. The list should show two entries:
- `writers-workbench-mail-prod`
- `writers-workbench-mail-dev`

Both will show a green **LIVE** badge — that badge means "online", not "Live mode". The actual mode is what you verified in Step 6.10.

Postal configuration is done.

---

## Phase 7 — Wire env vars into your Workbench service(s)

### 7.1 On `WritersWorkbenchDev`

Open Railway → `N8N-MCP` project → `WritersWorkbenchDev` service → Variables → Raw Editor. Append these lines (do not delete existing vars):

```
POSTAL_API_URL=https://postal-admin.courseworx.media/api/v1
POSTAL_API_KEY=<dev-api-key from Step 6.12>
EMAIL_SECRET=30c8dc2b3a1339a996c1dff20e5ea28d6e466870cef7635a9a4723819877431d
SENDER_EMAIL=eve@courseworx.media
SENDER_NAME=The Writers Workbench (Dev)
REPLY_TO_EMAIL=support@courseworx.media
DRY_RUN_EMAIL=true
```

Click **Update Variables**. Railway auto-redeploys.

### 7.2 On production Workbench (when/if present in `N8N-MCP`)

Same block, differences:
- `POSTAL_API_KEY` = `prod-api-key` from Step 6.8
- `SENDER_NAME` = `The Writers Workbench`
- **Remove** `DRY_RUN_EMAIL` (or set to `false`)

---

## Phase 8 — Workbench code work (follow-up PR)

Nothing in what you've built so far is being called by the Workbench yet — that's code I'll add in a stacked PR on `develop`:

- `server/src/lib/email.ts` — Postal client
- `server/src/routes/email.ts` — `POST /api/email/send` gated by `X-Email-Secret`, per-user rate limit
- `server/src/schemas.ts` — `EmailSendSchema`
- `/api/health` → `checks.postal` reachability
- `DRY_RUN_EMAIL=true` short-circuits the Postal call
- Unit tests

Ping me when Phase 7 is done and I'll open that PR.

---

## Phase 9 — Smoke test (after Phase 8 deploys)

```bash
# Dev dry-run
curl -X POST https://writersworkbench-develop.up.railway.app/api/email/send \
  -H "Content-Type: application/json" \
  -H "X-Email-Secret: 30c8dc2b3a1339a996c1dff20e5ea28d6e466870cef7635a9a4723819877431d" \
  -d '{"to":"your@email.com","subject":"Postal smoke test","html":"<p>hi</p>"}'
```

Expect `{ success: true, message_id: "dry-run-..." }`. Nothing in inbox.

Then flip `DRY_RUN_EMAIL=false` on `WritersWorkbenchDev`, wait for redeploy, repeat the curl:
- Email arrives within seconds
- Gmail → show original → `Authentication-Results: spf=pass dkim=pass dmarc=pass`
- From: `eve@courseworx.media`
- Postal UI → `writers-workbench-mail-dev` → Messages — shows `delivered`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Can't SSH into a service | Service is crashed or sleeping | Set Custom Start Command to `sleep infinity`, redeploy, then SSH in |
| `postal initialize` says "can't connect to DB" | `MAIN_DB_PASSWORD` / `MESSAGE_DB_PASSWORD` don't match what MariaDB has | Match them. Passwords are in `postal-mariadb` env |
| `postal initialize` says "signing key not readable" | Wrong permissions | `chmod 600 /config/signing.key` |
| Postal login page won't load | `postal web-server` crashed — check Deploy Logs | Usually either postal.yml syntax error or DB not reachable |
| Railway shows "Application failed to respond" | Postal bound to `127.0.0.1` instead of `0.0.0.0` | Ensure `BIND_ADDRESS=0.0.0.0` and `PORT=8080` are set on `postal-web`; Networking Target Port = 8080 |
| Logs show `Listening on http://127.0.0.1:8080` | Missing `BIND_ADDRESS=0.0.0.0` env var | Add it, redeploy; logs should show `0.0.0.0:8080` |
| Postal UI 403 or "host not allowed" | The hostname you're hitting is not in `postal.yml` `web_hostname` | SSH in, edit `/config/postal.yml`, update `web_hostname` to match the URL you're using; restart service |
| Custom domain stuck "Awaiting DNS" | Cloudflare CNAME is orange-clouded | Switch to grey (DNS only) |
| Building a mail server in Postal UI returns 500 | MariaDB `postal` user lacks privileges on per-server databases | See Phase 2.8 — run `GRANT ALL PRIVILEGES ON \`postal-%\`.* TO 'postal'@'%'; FLUSH PRIVILEGES;` |
| DKIM row stays red 30 min after publishing | CF truncated TXT value, or you need to click Verify again in Postal | Quote the TXT value in CF; re-click Verify |
| Dev mail server shows green LIVE badge — am I in Live mode? | The LIVE badge means "online", not "Live mode". Modes look identical externally. | Verify via Settings → Server Settings (the two-level nav) — see Step 6.10 |
| Can't find the Mode field after creating a mail server | Postal's top-level Settings tab is a gateway to a sub-nav with `Server Settings`, `Spam`, `Retention`, etc. | URL shortcut: `/org/<slug>/servers/<server>/edit` — Mode is on that form |
| `postal make-user` password doesn't work at login | Typo during interactive entry | Run `postal make-user` again and create a second admin. Multiple admins are harmless. |
| Mail queues but never sends | `postal-worker` not running, or its `/config` files are missing | Worker must be Active AND its `/config/postal.yml` + `/config/signing.key` must exist (same content as `postal-web`) |

---

## Architecture recap

```
                          Writers Workbench
                                 |
                                 | POST /api/email/send
                                 v
              +--- postal-web (postal web-server) ---+
              |         mounts /config volume        |
              |         public: postal-admin.courseworx.media
              +--------------------------------------+
                                 |
                                 |  (enqueues via MariaDB)
                                 v
              +--- postal-mariadb (MariaDB 10.11) --+
              |         mounts /var/lib/mysql (5GB) |
              +-------------------------------------+
                                 ^
                                 |  (picks up from MariaDB)
                                 |
              +--- postal-worker (postal worker) ---+
              |         mounts /config volume        |
              +--------------------------------------+
                                 |
                                 v
                         outbound SMTP relay
```

Three services for Postal + one for MariaDB = four total. Optionally add a 5th (`postal-smtp` running `postal smtp-server`) if you ever want to accept inbound mail or allow external SMTP relay; not needed for API-based sending.

---

## Sources (verified 2026-04-22)

- [Postal prerequisites — official docs](https://docs.postalserver.io/getting-started/prerequisites/)
- [Postal container image — official docs](https://docs.postalserver.io/other/containers/)
- [Postal v3 postal.yml example — postalserver/install](https://github.com/postalserver/install/blob/main/examples/postal.v3.yml)
- [Postal Dockerfile — postalserver/postal](https://github.com/postalserver/postal/blob/main/Dockerfile)
- [Postal docker-compose.yml — postalserver/postal](https://github.com/postalserver/postal/blob/main/docker-compose.yml)
- [railway ssh — Railway Docs](https://docs.railway.com/cli/ssh)
