-- 058 — A user's own ElevenLabs account as an integration.
--
-- WHY. The audiobook can be narrated in the author's own cloned voice through their own ElevenLabs
-- account. Like Blotato and a blog website, that account is the USER'S (their plan, their characters,
-- their voices), so its API key is stored the same way: one row in user_integrations_v2, AES-256-GCM
-- encrypted by the server before it is written, never a Railway variable (docs: migration 043).
--
-- user_integrations_v2 is a meta table (043), not a base table, so widening its two CHECKs is within
-- docs/schema-governance.md. 'elevenlabs' has no channel, like 'blotato'. Idempotent.

BEGIN;

ALTER TABLE user_integrations_v2 DROP CONSTRAINT IF EXISTS user_integrations_v2_provider_check;
ALTER TABLE user_integrations_v2
    ADD CONSTRAINT user_integrations_v2_provider_check
    CHECK (provider IN ('blotato', 'website', 'elevenlabs'));

ALTER TABLE user_integrations_v2 DROP CONSTRAINT IF EXISTS user_integrations_v2_check;
ALTER TABLE user_integrations_v2
    ADD CONSTRAINT user_integrations_v2_check
    CHECK (
        (provider IN ('blotato', 'elevenlabs') AND channel IS NULL)
        OR (provider = 'website' AND channel IS NOT NULL)
    );

COMMIT;
