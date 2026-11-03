-- 049: The token_usage_v2 insert trigger also records Gemini under one provider name.
--
-- WHY. Gemini was recorded as provider 'google' by the n8n Hub V2 workflow and by the engine before
-- 2026-05 (repaired on existing rows by 047). The engine (pricing.normalize_provider) and the server
-- (cost-recorder normalizeProvider) now write 'gemini', but n8n workflows still run on PROD and write
-- token_usage_v2 directly, so the database applies the same mapping to anything it receives.
--
-- WHAT. Replaces 048's token_usage_v2_default_labels() with the same body plus one step: after the
-- label defaults, a provider alias (google, google-genai, google_genai, googleai, google-ai -> gemini;
-- claude -> anthropic) is mapped to the canonical name, metadata.provider follows it, and the name
-- received is kept in metadata.provider_from. Same map as the engine and server.
-- The trigger itself (BEFORE INSERT, from 048) is unchanged.
--
-- No ALTER on any table. Idempotent (CREATE OR REPLACE). Requires 048. DEV first; PROD at release.

CREATE OR REPLACE FUNCTION token_usage_v2_default_labels() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    missing text[] := ARRAY[]::text[];
    canonical text;
BEGIN
    IF NEW.provider IS NULL OR btrim(NEW.provider) = '' THEN
        missing := missing || 'provider'::text;
        NEW.provider := COALESCE(NULLIF(btrim(NEW.metadata->>'provider'), ''), 'unknown');
    END IF;
    IF NEW.operation IS NULL OR btrim(NEW.operation) = '' THEN
        missing := missing || 'operation'::text;
        NEW.operation := COALESCE(NULLIF(btrim(NEW.workflow_name), ''), 'unattributed.' || NEW.provider);
    END IF;
    IF array_length(missing, 1) > 0 THEN
        NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
                        || jsonb_build_object('label_defaulted', to_jsonb(missing));
        RAISE WARNING 'token_usage_v2: row written without %, defaulted (provider=%, operation=%, model=%, source=%)',
            array_to_string(missing, ','), NEW.provider, NEW.operation, NEW.model, COALESCE(NEW.source, 'NULL');
    END IF;

    canonical := CASE lower(btrim(NEW.provider))
        WHEN 'google' THEN 'gemini'
        WHEN 'google-genai' THEN 'gemini'
        WHEN 'google_genai' THEN 'gemini'
        WHEN 'googleai' THEN 'gemini'
        WHEN 'google-ai' THEN 'gemini'
        WHEN 'claude' THEN 'anthropic'
    END;
    IF canonical IS NOT NULL THEN
        NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
                        || jsonb_build_object('provider', canonical, 'provider_from', NEW.provider);
        NEW.provider := canonical;
    END IF;
    RETURN NEW;
END;
$$;
