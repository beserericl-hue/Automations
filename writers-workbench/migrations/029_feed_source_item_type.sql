-- ============================================
-- Migration 029 — newsletter_feed_sources_v2.item_type
--
-- Tier: DEV first (gvbvwcnmjkdpclcisqrr). PROD waits for the n8n cutover,
-- which the user has deferred. Do NOT apply to PROD in this sprint.
--
-- Governance: additive. One nullable column with a default on a FEATURE
-- table (added by migration 016), plus one data backfill. No base-table
-- mutation — the nine protected base tables are untouched, so
-- scripts/check-base-table-immutability.py still passes.
--
-- Why this exists (E1 — ingestion moves from n8n into the engine):
--
--   content_ingestion_v2.type distinguishes 'article' | 'reddit_post' |
--   'tweet' | 'newsletter', and it is load-bearing: gather_step selects
--   with `.neq("type", "newsletter")`, so anything typed 'newsletter' is
--   excluded from the story candidates for OUR edition. That is correct
--   and deliberate — six of the ai-news feeds are *other people's*
--   newsletters (The Neuron, Ben's Bites, Superhuman, The Rundown AI,
--   Futurepedia, There's An AI For That). They are ingested as market
--   reading, not as stories to republish.
--
--   In n8n that distinction lived in a hardcoded `feedType` Set node per
--   feed — six nodes on a canvas. The engine reads its feed list from
--   newsletter_feed_sources_v2 instead, and that table had nowhere to say
--   it. Without this column the engine would type those six feeds
--   'article' and their archives would start appearing as candidate
--   stories inside the edition they were supposed to inform.
--
--   url_type cannot carry it: url_type says how to FETCH ('rss', 'reddit',
--   'source', 'firecrawl_scrape'), item_type says what the result IS. The
--   six newsletter feeds are plain 'rss' fetches.
--
-- Rollback: ALTER TABLE newsletter_feed_sources_v2 DROP COLUMN item_type;
-- ============================================

ALTER TABLE newsletter_feed_sources_v2
  ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'article';

-- Same value set as content_ingestion_v2.type (migration 009 documents it
-- in a comment; this is the first place it is enforced).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_feed_sources_v2_item_type_check'
  ) THEN
    ALTER TABLE newsletter_feed_sources_v2
      ADD CONSTRAINT newsletter_feed_sources_v2_item_type_check
      CHECK (item_type IN ('article', 'reddit_post', 'tweet', 'newsletter'));
  END IF;
END $$;

COMMENT ON COLUMN newsletter_feed_sources_v2.item_type IS
  'content_ingestion_v2.type to write for this feed''s items. ''newsletter'' marks a competitor '
  'newsletter: ingested for market reading, excluded from story candidates by gather_step.';

-- Backfill: the six competitor-newsletter feeds, by the names the seed used
-- (docs/newsletter-ingestion-feeds-baseline.md, Group 1). Matched on name
-- rather than URL so a re-pointed rss.app feed id still backfills.
UPDATE newsletter_feed_sources_v2
   SET item_type = 'newsletter'
 WHERE item_type = 'article'
   AND name IN (
     'The Neuron',
     'Futurepedia',
     'Superhuman',
     'The Rundown AI',
     'There''s An AI For That',
     'Ben''s Bites'
   );

-- Reddit feeds produce reddit_post rows for self posts; link posts are
-- retyped 'article' per item by the pipeline, because a link post's body
-- comes from the destination site and not from Reddit.
UPDATE newsletter_feed_sources_v2
   SET item_type = 'reddit_post'
 WHERE item_type = 'article'
   AND url_type = 'reddit';
