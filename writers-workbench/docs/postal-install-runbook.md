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

## Phase 6 — Configure the sending domain in Postal admin

Now that you're logged into Postal:

1. **New Organization** → name `Course Worx Media`
2. Organization → **Domains** → **Add Domain** → `courseworx.media`
3. Keep this page open — it lists 4-6 DNS records Postal wants on `courseworx.media`

### Publish these DNS records in Cloudflare

Values come from Postal's domain page. Publish each:

| Type  | Name (Cloudflare)                 | Value                                        | Proxy   |
|-------|-----------------------------------|----------------------------------------------|---------|
| TXT   | `postal._domainkey`               | (DKIM key from Postal UI)                    | n/a     |
| TXT   | `@`                               | `v=spf1 include:spf.postal.courseworx.media ~all` | n/a |
| TXT   | `spf.postal`                      | (SPF detail from Postal UI)                  | n/a     |
| CNAME | `rp.postal`                       | (return-path target from Postal UI)          | **DNS only** |
| TXT   | `_dmarc`                          | `v=DMARC1; p=quarantine; rua=mailto:dmarc@courseworx.media; pct=100` | n/a |

Wait ~15–30 min. Refresh the Postal UI → every record should turn green. Don't proceed past here until all green.

---

## Phase 7 — Create the two mail servers + API credentials

Postal uses a two-level domain model:
- Organization domain (done in Phase 6) — holds the DKIM/SPF/return-path DNS records
- Mail-server-level domain — authorizes a specific mail server to send FROM that domain

You have to associate the domain at both levels. Phase 6 did the first. Below does the second, plus the API credential.

### 7.1 Production mail server

1. Organization sidebar → **Mail Servers** → **New Mail Server**
2. Form fields:
   - **Name:** `writers-workbench-mail-prod`
   - **Short name:** leave blank (auto-generated)
   - **Mode:** `Live`
3. Click **Build server** — you land on the mail server's overview page

4. In the mail server's own sidebar, click **Domains**
5. Click **Add Domain**
   - **Domain:** `courseworx.media`
6. Save — this authorizes this mail server to send from `courseworx.media`

7. Mail server sidebar → **Credentials** → **Add new Credential**
   - **Name:** `prod-api-key`
   - **Type:** `API`
   - **Hold:** leave unchecked (unchecked = actually send; checked = pile into hold queue for debugging)
8. Save
9. **Copy the key value shown on the credential page now** — this is your `POSTAL_API_KEY` for production Workbench. Some Postal versions partially hide it after first view.

### 7.2 Dev mail server

Go back to the organization (top breadcrumb `Course Worx Media`) and repeat the full flow:

1. **New Mail Server**
   - **Name:** `writers-workbench-mail-dev`
   - **Mode:** `Development` (Postal swallows sends and only logs them — safe for testing)
   - **Build server**
2. **Domains** → **Add Domain** → `courseworx.media`
3. **Credentials** → **Add new Credential**
   - **Name:** `dev-api-key`
   - **Type:** `API`
   - **Hold:** unchecked
4. Save → **copy the key value** — this is `POSTAL_API_KEY` for the dev Workbench

---

## Phase 8 — Wire env vars into your Workbench service(s)

### 8.1 On `WritersWorkbenchDev`

Add these env vars:
```
POSTAL_API_URL=https://postal-admin.courseworx.media/api/v1
POSTAL_API_KEY=<dev-api-key from Phase 7.2>
EMAIL_SECRET=30c8dc2b3a1339a996c1dff20e5ea28d6e466870cef7635a9a4723819877431d
SENDER_EMAIL=eve@courseworx.media
SENDER_NAME=The Writers Workbench (Dev)
REPLY_TO_EMAIL=support@courseworx.media
DRY_RUN_EMAIL=true
```

### 8.2 On production Workbench (when/if present in `N8N-MCP`)

Same block, differences:
- `POSTAL_API_KEY` = `prod-api-key` from Phase 7.1
- `SENDER_NAME` = `The Writers Workbench`
- **Remove** `DRY_RUN_EMAIL` (or set to `false`)

---

## Phase 9 — Workbench code work (my follow-up PR)

Nothing in what you've built so far is being called by the Workbench yet — that's code I'll add in a stacked PR on `develop`:

- `server/src/lib/email.ts` — Postal client
- `server/src/routes/email.ts` — `POST /api/email/send` gated by `X-Email-Secret`, per-user rate limit
- `server/src/schemas.ts` — `EmailSendSchema`
- `/api/health` → `checks.postal` reachability
- `DRY_RUN_EMAIL=true` short-circuits the Postal call
- Unit tests

Ping me when Phase 8 is done and I'll open that PR.

---

## Phase 10 — Smoke test (after Phase 9 deploys)

```bash
# Dev dry-run
curl -X POST https://writersworkbenchdev-production-*.up.railway.app/api/email/send \
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
| Custom domain stuck "Awaiting DNS" | Cloudflare CNAME is orange-clouded | Switch to grey (DNS only) |
| DKIM row stays red 30 min after publishing | CF truncated TXT value, or you need to click Verify again in Postal | Quote the TXT value in CF; re-click Verify |
| Mail queues but never sends | `postal-worker` not running | Check worker service Active + logs |
| `postal make-user` already ran, created wrong user | Run `postal make-user` again and create a second admin, then delete the first from the admin UI | — |

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
