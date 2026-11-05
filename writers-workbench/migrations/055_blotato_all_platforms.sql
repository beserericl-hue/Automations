-- 055 — Blotato posts to every account on the key, not only LinkedIn.
--
-- WHY. Settings → Integrations asked the owner to type their "LinkedIn account id" even though
-- Test connection already listed every account on the key, with its id, and the key is connected
-- to six platforms (Eric, 2026-11-05: "why do we need the linkedin ID as we are showing the IDs
-- for all services … we also want to be able to use blotato to post our other social media posts").
-- Now the server syncs the accounts (and LinkedIn / Facebook pages, Pinterest boards) from Blotato
-- onto the owner's Blotato row, and each one the owner switches on becomes a channel.
--
-- WHAT.
--   social_channels_v2.kind   widened from ('website','linkedin') to every platform Blotato posts to.
--   A Blotato channel's config now carries everything the publisher needs for that one target:
--     {"account_id": "9115", "platform": "linkedin", "page_id": "104364682",
--      "target_id": "linkedin:9115:104364682", "account_name": "Eric Beser", "page_name": "TechAhir"}
--   target_id is how the Integrations page matches a synced account to its channel. Existing
--   LinkedIn channels (043 moved their account_id onto the user's Blotato row) get it back, plus a
--   target_id, so they show as already switched on. No key values are touched.
--
-- Not a base table (schema-governance): a widened CHECK on a 038 meta table and a JSONB backfill.

ALTER TABLE social_channels_v2 DROP CONSTRAINT IF EXISTS social_channels_v2_kind_check;
ALTER TABLE social_channels_v2 ADD CONSTRAINT social_channels_v2_kind_check CHECK (kind IN (
    'website', 'linkedin', 'facebook', 'instagram', 'threads', 'twitter', 'bluesky', 'pinterest', 'tiktok', 'youtube'
));

-- Each LinkedIn channel carries its own account id again (the user's Blotato account), and a
-- target_id the synced account list can be matched against. Idempotent.
UPDATE social_channels_v2 c
   SET config = c.config
                || jsonb_build_object('account_id', i.config->>'account_id', 'platform', 'linkedin')
                || jsonb_build_object('target_id',
                       'linkedin:' || (i.config->>'account_id')
                       || COALESCE(':' || NULLIF(c.config->>'page_id', ''), ''))
  FROM user_integrations_v2 i
 WHERE i.user_id = c.user_id AND i.provider = 'blotato'
   AND c.kind = 'linkedin'
   AND COALESCE(i.config->>'account_id', '') <> ''
   AND COALESCE(c.config->>'account_id', '') = '';

COMMENT ON COLUMN social_channels_v2.kind IS
    'website, or the Blotato platform this channel posts to (linkedin, facebook, instagram, threads, '
    'twitter, bluesky, pinterest, tiktok, youtube). Migration 055.';
COMMENT ON TABLE user_integrations_v2 IS
    'Per-user integration credentials (Blotato API key, blog tokens). secret_ciphertext is AES-256-GCM '
    '(INTEGRATIONS_ENCRYPTION_KEY, server + engine only). The Blotato row''s config holds the accounts '
    'synced from the key ({"accounts": [...], "synced_at": ...}). No user-facing RLS policy: service role '
    'only. Migrations 043 + 055.';
