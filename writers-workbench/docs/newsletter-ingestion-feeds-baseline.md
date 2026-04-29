# Newsletter Ingestion Feeds — Baseline Inventory

Snapshot of every feed URL hardcoded into the live n8n `AI News Data Ingestion V2`
workflow (id `2T3TwGHhdGQlTpQ5`) as of **2026-04-29**. Captured from the workflow
JSON via `GET /api/v1/workflows/2T3TwGHhdGQlTpQ5`.

This file exists so the URLs survive the planned migration to a database-driven
multi-user feed system (`newsletter_feed_sources_v2`). When that migration runs
it will seed these 17 rows into the new table owned by `user_id = +14105914612`,
`edition_id = ai-news`. After seeding, the source-of-truth moves to the database;
this file remains as the historical baseline and can be regenerated with:

```bash
python3 -c "
import json
wf = json.load(open('/tmp/wf-ingestion.json'))
for n in wf['nodes']:
    p = n.get('parameters', {})
    if n['type'] == 'n8n-nodes-base.rssFeedReadTrigger':
        print(n['name'], '|', p.get('feedUrl'))
"
```

## Summary

- **Total feed sources:** 17
- **RSS Feed Read Trigger nodes:** 6 (n8n native RSS poller; default cadence)
- **Schedule Trigger → HTTP Request pairs:** 11 (custom polling cadence)
- **Hosting providers:** rss.app (16), rss.beehiiv.com (1)
- **Owner of all ingested rows:** `user_id = +14105914612`
- **All ingested into:** `content_ingestion_v2` table (DEV Supabase: `gvbvwcnmjkdpclcisqrr`) via `POST /api/ingestion/upload`

## Group 1 — RSS Feed Read Trigger nodes (6)

These use n8n's native `n8n-nodes-base.rssFeedReadTrigger` node. The `feedUrl`
parameter is the canonical source. n8n polls these on its default RSS cadence.

| n8n node name | Feed URL | Source name (downstream) |
|---|---|---|
| `the_neuron_trigger` | https://rss.app/feeds/e2QjBpEDLPfVUeoI.xml | The Neuron |
| `futurepedia_trigger` | https://rss.app/feeds/x8T02B3GXYy18pNy.xml | Futurepedia |
| `superhuman_trigger` | https://rss.app/feeds/3tDyvQwHp8cgL7qs.xml | Superhuman |
| `the_rundown_ai_trigger` | https://rss.app/feeds/Kc554BCmk9PUValj.xml | The Rundown AI |
| `taaft_trigger` | https://rss.beehiiv.com/feeds/22I6c0vJXV.xml | There's An AI For That |
| `bens_bites_trigger` | https://rss.app/feeds/O60XfEFYoxJhYVkS.xml | Ben's Bites |

## Group 2 — Schedule Trigger → HTTP Request pairs (11)

These pair an `n8n-nodes-base.scheduleTrigger` with an `n8n-nodes-base.httpRequest`
that fetches a JSON-formatted RSS feed (rss.app's `/feeds/v1.1/{id}.json` endpoint).
Cadence is set explicitly on the trigger node.

### News aggregators — every 3 hours

| n8n node name | Feed URL | Cadence |
|---|---|---|
| `google_news_trigger` | https://rss.app/feeds/v1.1/AkOariu1C7YyUUMv.json | every 3h |
| `hacker_news_trigger` | https://rss.app/feeds/v1.1/jf3MZ9ZlVZhrVEjD.json | every 3h |

### Reddit — every 3 hours

| n8n node name | Feed URL | Subreddit | Cadence |
|---|---|---|---|
| `reddit_artificial_inteligence_trigger` | https://rss.app/feeds/v1.1/F3rBf24jLxG6mNoJ.json | r/ArtificialIntelligence | every 3h |
| `reddit_open_ai_trigger` | https://rss.app/feeds/v1.1/1LDBacY8BC2qJaZh.json | r/OpenAI | every 3h |
| `reddit_artificial_trigger` | https://rss.app/feeds/v1.1/upLgfm9lv7RXwzes.json | r/artificial | every 3h |

> Note: the **HTTP variant** of the Reddit feeds (above) is what's currently active
> in V2. The S5 sprint (per `newsletter-migration-workflow-ids.md`) also added a
> parallel **direct-Reddit** path that hits `reddit.com/comments/{postId}.json`
> with a custom User-Agent for self-post extraction. Both paths converge at
> `get_identity` and feed the same upload pipeline.

### Vendor AI blogs — every 4 hours

| n8n node name | Feed URL | Vendor | Cadence |
|---|---|---|---|
| `blog_meta_ai_trigger` | https://rss.app/feeds/v1.1/zqVI3dZrdbmZjbR8.json | Meta AI | every 4h |
| `blog_cloudflare_ai_trigger` | https://rss.app/feeds/v1.1/iLzlJfBHVV0phe2n.json | Cloudflare AI | every 4h |
| `blog_anthropic_ai_trigger` | https://rss.app/feeds/v1.1/OFdSUsziElw0rkpx.json | Anthropic | every 4h |
| `blog_google_ai_trigger` | https://rss.app/feeds/v1.1/2CtvCsOtZS35jJgp.json | Google AI | every 4h |
| `blog_open_ai_trigger` | https://rss.app/feeds/v1.1/6BnoYYEtnCHXfHj0.json | OpenAI | every 4h |
| `blog_nvidia_ai_trigger` | https://rss.app/feeds/v1.1/rXJrh1u8zDwJLUJK.json | NVIDIA AI | every 4h |

## Quick copy block (just the URLs)

```
https://rss.app/feeds/e2QjBpEDLPfVUeoI.xml
https://rss.app/feeds/x8T02B3GXYy18pNy.xml
https://rss.app/feeds/3tDyvQwHp8cgL7qs.xml
https://rss.app/feeds/Kc554BCmk9PUValj.xml
https://rss.beehiiv.com/feeds/22I6c0vJXV.xml
https://rss.app/feeds/O60XfEFYoxJhYVkS.xml
https://rss.app/feeds/v1.1/AkOariu1C7YyUUMv.json
https://rss.app/feeds/v1.1/jf3MZ9ZlVZhrVEjD.json
https://rss.app/feeds/v1.1/F3rBf24jLxG6mNoJ.json
https://rss.app/feeds/v1.1/1LDBacY8BC2qJaZh.json
https://rss.app/feeds/v1.1/upLgfm9lv7RXwzes.json
https://rss.app/feeds/v1.1/zqVI3dZrdbmZjbR8.json
https://rss.app/feeds/v1.1/iLzlJfBHVV0phe2n.json
https://rss.app/feeds/v1.1/OFdSUsziElw0rkpx.json
https://rss.app/feeds/v1.1/2CtvCsOtZS35jJgp.json
https://rss.app/feeds/v1.1/6BnoYYEtnCHXfHj0.json
https://rss.app/feeds/v1.1/rXJrh1u8zDwJLUJK.json
```

## Seed file for `newsletter_feed_sources_v2`

When the multi-user feed migration ships, this is the canonical seed payload
the migration script should use. `url_type` follows the proposed CHECK
constraint (`'rss','reddit','source','firecrawl_scrape'`).

```json
[
  {"name": "The Neuron",                 "url": "https://rss.app/feeds/e2QjBpEDLPfVUeoI.xml",         "url_type": "rss",    "fetch_interval_minutes": 240},
  {"name": "Futurepedia",                "url": "https://rss.app/feeds/x8T02B3GXYy18pNy.xml",         "url_type": "rss",    "fetch_interval_minutes": 240},
  {"name": "Superhuman",                 "url": "https://rss.app/feeds/3tDyvQwHp8cgL7qs.xml",         "url_type": "rss",    "fetch_interval_minutes": 240},
  {"name": "The Rundown AI",             "url": "https://rss.app/feeds/Kc554BCmk9PUValj.xml",         "url_type": "rss",    "fetch_interval_minutes": 240},
  {"name": "There's An AI For That",     "url": "https://rss.beehiiv.com/feeds/22I6c0vJXV.xml",       "url_type": "rss",    "fetch_interval_minutes": 240},
  {"name": "Ben's Bites",                "url": "https://rss.app/feeds/O60XfEFYoxJhYVkS.xml",         "url_type": "rss",    "fetch_interval_minutes": 240},
  {"name": "Google News (AI)",           "url": "https://rss.app/feeds/v1.1/AkOariu1C7YyUUMv.json",   "url_type": "rss",    "fetch_interval_minutes": 180},
  {"name": "Hacker News (AI)",           "url": "https://rss.app/feeds/v1.1/jf3MZ9ZlVZhrVEjD.json",   "url_type": "rss",    "fetch_interval_minutes": 180},
  {"name": "r/ArtificialIntelligence",   "url": "https://rss.app/feeds/v1.1/F3rBf24jLxG6mNoJ.json",   "url_type": "reddit", "fetch_interval_minutes": 180},
  {"name": "r/OpenAI",                   "url": "https://rss.app/feeds/v1.1/1LDBacY8BC2qJaZh.json",   "url_type": "reddit", "fetch_interval_minutes": 180},
  {"name": "r/artificial",               "url": "https://rss.app/feeds/v1.1/upLgfm9lv7RXwzes.json",   "url_type": "reddit", "fetch_interval_minutes": 180},
  {"name": "Meta AI Blog",               "url": "https://rss.app/feeds/v1.1/zqVI3dZrdbmZjbR8.json",   "url_type": "rss",    "fetch_interval_minutes": 240},
  {"name": "Cloudflare AI Blog",         "url": "https://rss.app/feeds/v1.1/iLzlJfBHVV0phe2n.json",   "url_type": "rss",    "fetch_interval_minutes": 240},
  {"name": "Anthropic Blog",             "url": "https://rss.app/feeds/v1.1/OFdSUsziElw0rkpx.json",   "url_type": "rss",    "fetch_interval_minutes": 240},
  {"name": "Google AI Blog",             "url": "https://rss.app/feeds/v1.1/2CtvCsOtZS35jJgp.json",   "url_type": "rss",    "fetch_interval_minutes": 240},
  {"name": "OpenAI Blog",                "url": "https://rss.app/feeds/v1.1/6BnoYYEtnCHXfHj0.json",   "url_type": "rss",    "fetch_interval_minutes": 240},
  {"name": "NVIDIA AI Blog",             "url": "https://rss.app/feeds/v1.1/rXJrh1u8zDwJLUJK.json",   "url_type": "rss",    "fetch_interval_minutes": 240}
]
```

## Caveats

- **The 6 RSS Feed Read Trigger feeds use the n8n native poller.** Their
  cadence isn't stored on the node — it's set globally in n8n's RSS subsystem.
  The `fetch_interval_minutes: 240` value above is a reasonable default for the
  new system, not a verbatim port of n8n's behavior.
- **All URLs above are intermediary feeds** hosted by rss.app or rss.beehiiv.
  The original publishers (Hacker News, Anthropic, etc.) are upstream of those.
  If we want to bypass rss.app some day we'll need to find each publisher's
  native RSS URL — the rss.app-hosted ones above are not the publishers' own
  feeds.
- **rss.app accounts** — the feeds at `rss.app/feeds/{id}.xml` and
  `rss.app/feeds/v1.1/{id}.json` belong to whoever owns that rss.app account
  and could disappear if the account lapses. There's no contingency for that
  today.
- **Reddit** — the 3 r/* feeds above are rss.app-hosted; the parallel
  S5-added direct-Reddit path (`reddit.com/comments/{postId}.json`) is in
  the workflow but not represented in this URL list because it's not a feed
  source per se — it's a per-post body fetcher used after one of the rss.app
  Reddit feeds surfaces a post URL.
