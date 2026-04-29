"""
Seed `newsletter_feed_sources_v2` (migration 016) with the 17 hardcoded URLs
that lived inside the legacy `AI News Data Ingestion V2` n8n workflow
(id `2T3TwGHhdGQlTpQ5`).

After this seed runs and the new multi-user cron workflow is published, the
legacy ingestion workflow can be deactivated. Both will write the same rows
to content_ingestion_v2 in the meantime; the cron worker is idempotent
because /api/ingestion/upload's caller (the new workflow) checks
`/api/ingestion/search?prefix=…` before each upload.

Owner: `+14105914612` (the user who owns these feeds in the legacy workflow).
Edition: `ai-news`.

Idempotent: re-runs skip rows that already exist (the (user_id, edition_id,
lower(url)) unique index in migration 016 makes the INSERT a no-op via
`ON CONFLICT DO NOTHING`).

Usage:
    export DEV_SUPABASE_URL=https://gvbvwcnmjkdpclcisqrr.supabase.co
    export DEV_SUPABASE_SERVICE_ROLE_KEY=...
    python3 scripts/seed-newsletter-feed-sources.py             # apply
    python3 scripts/seed-newsletter-feed-sources.py --dry-run   # print SQL only
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


# ---------------------------------------------------------------------------
# Inventory — extracted 2026-04-29 from the live workflow JSON. Source of
# truth: writers-workbench/docs/newsletter-ingestion-feeds-baseline.md
# ---------------------------------------------------------------------------

OWNER_USER_ID = '+14105914612'
EDITION_ID = 'ai-news'

FEEDS: list[dict] = [
    # --- Native RSS triggers (6) — n8n's default ~4h cadence ---
    {'name': 'The Neuron',                'url': 'https://rss.app/feeds/e2QjBpEDLPfVUeoI.xml',         'url_type': 'rss',    'fetch_interval_minutes': 240},
    {'name': 'Futurepedia',               'url': 'https://rss.app/feeds/x8T02B3GXYy18pNy.xml',         'url_type': 'rss',    'fetch_interval_minutes': 240},
    {'name': 'Superhuman',                'url': 'https://rss.app/feeds/3tDyvQwHp8cgL7qs.xml',         'url_type': 'rss',    'fetch_interval_minutes': 240},
    {'name': 'The Rundown AI',            'url': 'https://rss.app/feeds/Kc554BCmk9PUValj.xml',         'url_type': 'rss',    'fetch_interval_minutes': 240},
    {'name': "There's An AI For That",    'url': 'https://rss.beehiiv.com/feeds/22I6c0vJXV.xml',       'url_type': 'rss',    'fetch_interval_minutes': 240},
    {'name': "Ben's Bites",               'url': 'https://rss.app/feeds/O60XfEFYoxJhYVkS.xml',         'url_type': 'rss',    'fetch_interval_minutes': 240},

    # --- News aggregators (every 3h) ---
    {'name': 'Google News (AI)',          'url': 'https://rss.app/feeds/v1.1/AkOariu1C7YyUUMv.json',   'url_type': 'rss',    'fetch_interval_minutes': 180},
    {'name': 'Hacker News (AI)',          'url': 'https://rss.app/feeds/v1.1/jf3MZ9ZlVZhrVEjD.json',   'url_type': 'rss',    'fetch_interval_minutes': 180},

    # --- Reddit (every 3h) ---
    {'name': 'r/ArtificialIntelligence',  'url': 'https://rss.app/feeds/v1.1/F3rBf24jLxG6mNoJ.json',   'url_type': 'reddit', 'fetch_interval_minutes': 180},
    {'name': 'r/OpenAI',                  'url': 'https://rss.app/feeds/v1.1/1LDBacY8BC2qJaZh.json',   'url_type': 'reddit', 'fetch_interval_minutes': 180},
    {'name': 'r/artificial',              'url': 'https://rss.app/feeds/v1.1/upLgfm9lv7RXwzes.json',   'url_type': 'reddit', 'fetch_interval_minutes': 180},

    # --- Vendor AI blogs (every 4h) ---
    {'name': 'Meta AI Blog',              'url': 'https://rss.app/feeds/v1.1/zqVI3dZrdbmZjbR8.json',   'url_type': 'rss',    'fetch_interval_minutes': 240},
    {'name': 'Cloudflare AI Blog',        'url': 'https://rss.app/feeds/v1.1/iLzlJfBHVV0phe2n.json',   'url_type': 'rss',    'fetch_interval_minutes': 240},
    {'name': 'Anthropic Blog',            'url': 'https://rss.app/feeds/v1.1/OFdSUsziElw0rkpx.json',   'url_type': 'rss',    'fetch_interval_minutes': 240},
    {'name': 'Google AI Blog',            'url': 'https://rss.app/feeds/v1.1/2CtvCsOtZS35jJgp.json',   'url_type': 'rss',    'fetch_interval_minutes': 240},
    {'name': 'OpenAI Blog',               'url': 'https://rss.app/feeds/v1.1/6BnoYYEtnCHXfHj0.json',   'url_type': 'rss',    'fetch_interval_minutes': 240},
    {'name': 'NVIDIA AI Blog',            'url': 'https://rss.app/feeds/v1.1/rXJrh1u8zDwJLUJK.json',   'url_type': 'rss',    'fetch_interval_minutes': 240},
]


def main() -> None:
    dry_run = '--dry-run' in sys.argv
    supabase_url = os.environ.get('DEV_SUPABASE_URL', 'https://gvbvwcnmjkdpclcisqrr.supabase.co')
    service_key = os.environ.get('DEV_SUPABASE_SERVICE_ROLE_KEY')

    if not service_key and not dry_run:
        print('ABORT: DEV_SUPABASE_SERVICE_ROLE_KEY not set. Use --dry-run to preview SQL.')
        sys.exit(1)

    if dry_run:
        print('-- Dry-run; equivalent SQL:')
        for f in FEEDS:
            url_escaped = f['url'].replace("'", "''")
            name_escaped = f['name'].replace("'", "''")
            print(
                f"INSERT INTO newsletter_feed_sources_v2 (user_id, edition_id, name, url, url_type, fetch_interval_minutes) "
                f"VALUES ('{OWNER_USER_ID}', '{EDITION_ID}', '{name_escaped}', '{url_escaped}', '{f['url_type']}', {f['fetch_interval_minutes']}) "
                f"ON CONFLICT (user_id, edition_id, lower(url)) DO NOTHING;"
            )
        return

    # Use Supabase REST API (PostgREST) with service-role key to insert. We
    # intentionally rely on the unique-index ON CONFLICT for idempotency by
    # passing Prefer: resolution=ignore-duplicates — that way a re-run is a
    # no-op for existing rows but inserts genuinely new ones.
    url = f'{supabase_url}/rest/v1/newsletter_feed_sources_v2'
    payload = [
        {
            'user_id': OWNER_USER_ID,
            'edition_id': EDITION_ID,
            'name': f['name'],
            'url': f['url'],
            'url_type': f['url_type'],
            'fetch_interval_minutes': f['fetch_interval_minutes'],
        }
        for f in FEEDS
    ]
    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=body,
        method='POST',
        headers={
            'apikey': service_key,
            'Authorization': f'Bearer {service_key}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=ignore-duplicates,return=representation',
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            inserted = json.loads(resp.read())
            print(f'Seeded {len(inserted)} rows (skipped {len(FEEDS) - len(inserted)} existing).')
            for row in inserted:
                print(f"  + {row['name']:30s} ({row['url_type']:18s}) {row['url']}")
    except urllib.error.HTTPError as e:
        body_text = e.read().decode('utf-8', errors='replace')
        print(f'HTTP {e.code}: {body_text[:500]}')
        raise


if __name__ == '__main__':
    main()
