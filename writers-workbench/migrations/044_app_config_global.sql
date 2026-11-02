-- 044 — Global (all-user) settings: app_config_global_v2.
--
-- WHY. app_config_v2 is per-user: user_id is NOT NULL with a FK to users_v2 and the unique key is
-- (user_id, key). There is no way to store a value every account inherits. DEV shows the cost: two
-- recipient_email rows, one copied onto each user; the superuser config route upserted
-- sprint8_superuser_config with onConflict 'key' and no user_id, which the NOT NULL constraint
-- rejects, so that setting has never been saved on DEV; and an API key or an operator bcc had to be
-- pinned to whichever user happened to hold it (MEMORY: "Global App Config Needed", 2026-03-22).
--
-- WHAT. A meta table keyed on `key` alone. Readers resolve user -> global -> default:
--   engine  writer_engine.library_helpers.email_recipients.load_app_config / load_recipient_config
--   server  server/src/lib/app-config.ts (resolveConfig, getGlobalConfig)
-- Admins edit it in the Admin panel's "Global Settings" tab (/api/admin/global-config).
--
-- `value` is TEXT to match app_config_v2, so a user override and a global value are the same type;
-- structured settings (e.g. sprint8_superuser_config) are stored as JSON text.
-- `is_secret` marks values (API keys) the admin API never returns in full.
--
-- RLS: enabled with NO policy for anon/authenticated — only the service role (server, engine) can
-- read or write it. A global value may be a credential, and the browser never needs one.
--
-- Governance (docs/schema-governance.md): a new table; no base table is altered. app_config_v2 is
-- untouched. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS app_config_global_v2 (
    key         TEXT PRIMARY KEY CHECK (key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
    value       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_secret   BOOLEAN NOT NULL DEFAULT false,
    updated_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE app_config_global_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_app_config_global_v2 ON app_config_global_v2;
CREATE POLICY service_role_all_app_config_global_v2
    ON app_config_global_v2
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE app_config_global_v2 IS
    'Settings every user inherits unless app_config_v2 has their own value (user -> global -> default). Service role only. Migration 044.';
