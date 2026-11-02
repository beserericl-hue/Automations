-- 043 — Per-user integration credentials (Blotato, blog websites).
--
-- WHY. The post calendar (038) read the Blotato API key and the TechAhir blog token from Railway
-- variables (BLOTATO_API_KEY, and the variable named by a website channel's config.auth_env). That
-- is a company key shared by every user: another customer's posts would go out through our Blotato
-- account and our blog's token. Blotato and a blog are the USER's accounts, so their keys are user
-- settings — entered in Settings → Integrations, stored here, one row per user per integration.
--
-- WHAT.
--   user_integrations_v2   one row per (user, provider[, channel]):
--     provider 'blotato'   channel NULL;   config {"account_id": "<Blotato account id>"};
--                          secret = the user's Blotato API key
--     provider 'website'   channel = the social_channels_v2 website channel it belongs to
--                          (deleted with it); secret = that blog's auth token
--   The secret is AES-256-GCM ciphertext made by the Workbench server with INTEGRATIONS_ENCRYPTION_KEY
--   (a Railway variable on the server and the engine runtime only). Plaintext never reaches the
--   database. secret_last4 is shown in the UI so the owner can tell which key is saved.
--
-- ACCESS. RLS on, and NO policy for signed-in users: a browser cannot read this table through
-- PostgREST at all, not even its own rows. Only the service role (the Workbench server, the
-- engine) reads it, and the server's API returns only set / not set, last4 and updated_at.
--
-- DATA. Existing channels are moved over (idempotent): each website channel's `auth_env` (the name
-- of a Railway variable) is dropped, and a LinkedIn channel's Blotato `account_id` moves to the
-- user's 'blotato' row (one account per user; the first one found wins) and off the channel. No
-- key values are copied — there are none in the database to copy; owners enter them in the UI.
--
-- Base tables are untouched (schema-governance): this is a new meta table plus a JSONB tidy of
-- social_channels_v2 (038).

CREATE TABLE IF NOT EXISTS user_integrations_v2 (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            TEXT NOT NULL REFERENCES users_v2(user_id) ON DELETE CASCADE,
    provider           TEXT NOT NULL CHECK (provider IN ('blotato', 'website')),
    channel            TEXT,
    config             JSONB NOT NULL DEFAULT '{}'::jsonb,
    secret_ciphertext  TEXT CHECK (secret_ciphertext IS NULL OR secret_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
    secret_last4       TEXT CHECK (secret_last4 IS NULL OR char_length(secret_last4) = 4),
    secret_updated_at  TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((provider = 'blotato' AND channel IS NULL) OR (provider = 'website' AND channel IS NOT NULL)),
    FOREIGN KEY (user_id, channel) REFERENCES social_channels_v2(user_id, channel)
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS user_integrations_v2_one_per_target
    ON user_integrations_v2 (user_id, provider, COALESCE(channel, ''));

DROP TRIGGER IF EXISTS trg_user_integrations_touch ON user_integrations_v2;
CREATE TRIGGER trg_user_integrations_touch BEFORE UPDATE ON user_integrations_v2
    FOR EACH ROW EXECUTE FUNCTION newsletter_touch_updated_at();

ALTER TABLE user_integrations_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_integrations_v2 FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON user_integrations_v2;
CREATE POLICY service_role_all ON user_integrations_v2 FOR ALL TO service_role USING (true) WITH CHECK (true);
-- Belt and braces: even a future permissive policy added by mistake finds no table privilege.
REVOKE ALL ON user_integrations_v2 FROM anon, authenticated;

COMMENT ON TABLE user_integrations_v2 IS
    'Per-user integration credentials (Blotato API key + account id, blog tokens). secret_ciphertext is '
    'AES-256-GCM (INTEGRATIONS_ENCRYPTION_KEY, server + engine only). No user-facing RLS policy: '
    'service role only. Migration 043.';

-- ---------------------------------------------------------------------------
-- Move existing channel config over (idempotent).
-- ---------------------------------------------------------------------------
INSERT INTO user_integrations_v2 (user_id, provider, channel, config)
SELECT DISTINCT ON (c.user_id) c.user_id, 'blotato', NULL,
       jsonb_build_object('account_id', c.config->>'account_id')
  FROM social_channels_v2 c
 WHERE c.kind = 'linkedin' AND COALESCE(c.config->>'account_id', '') <> ''
 ORDER BY c.user_id, c.channel
ON CONFLICT DO NOTHING;

UPDATE social_channels_v2 SET config = config - 'account_id'
 WHERE kind = 'linkedin' AND config ? 'account_id'
   AND EXISTS (SELECT 1 FROM user_integrations_v2 i
                WHERE i.user_id = social_channels_v2.user_id AND i.provider = 'blotato'
                  AND i.config->>'account_id' = social_channels_v2.config->>'account_id');

UPDATE social_channels_v2 SET config = config - 'auth_env'
 WHERE kind = 'website' AND config ? 'auth_env';
