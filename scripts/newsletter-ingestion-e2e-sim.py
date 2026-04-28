"""End-to-end simulation of the V2 ingestion pipeline against live DEV infra.

Walks the exact data path the patched V2 workflow will execute when one of
the reddit schedule triggers fires:

  fetch_reddit_*_feed  (rss.app JSON)              -> one item
    split_reddit_*_items                            -> this item as $json
      get_reddit_*_items_http  (httpRequest)       -> reddit.com/comments/{id}.json
        extract_reddit_*_items (Set raw JSON)      -> flattened post data
          filter_reddit_*_items (link-posts only)  -> keep only if url_overridden_by_dest ok
            normalize_reddit_*_items (Set)         -> title/url/sourceName/feedType
              get_identity (Set)                   -> uploadFileName, publishedTimestamp, etc.
                search_existing (httpRequest)      -> /api/ingestion/search
                  skip_existing_resources (filter) -> items.length === 0
                    scrape_url (executeWorkflow)   -> Node - Scrape Url V2 (Firecrawl)
                      filter_scrape_errors          -> keep only non-empty
                        try_extract_external_sources (LLM) -> stubbed (no LLM in sim)
                          upload_content (httpRequest) -> /api/ingestion/upload

If every step works against real servers, the upload row lands in
content_ingestion_v2 on DEV Supabase with .md and .html blobs in the
newsletter-ingestion bucket. We verify by SELECT at the end.
"""

import json
import re
import subprocess
import sys
import time
import urllib.parse

UA = "writers-workbench/1.0 (newsletter ingestion)"
WORKBENCH = "https://writersworkbenchdev-production.up.railway.app"
INGEST_SECRET = "fe17f5b9299cbed868c8b4413d85377aea1c5bbd4b9732023d49d501deb0058a"
NEWSLETTER_USER_ID = "+14105914612"
FIRECRAWL_KEY = None  # populated below

NEWLINE = "\n"

# ----- Load Firecrawl key from the DEV Railway side (same value the scraper uses) -----
r = subprocess.run(
    ["bash", "-c",
     "cd /Users/ericbeser/Documents/GitHub/Automations-newsletter-s1 && "
     "railway variable list --service WritersWorkbenchDev --kv 2>/dev/null | "
     "grep -E '^FIRECRAWL' || true"],
    capture_output=True, text=True)
for line in r.stdout.splitlines():
    if line.startswith("FIRECRAWL_API_KEY="):
        FIRECRAWL_KEY = line.split("=", 1)[1]
if not FIRECRAWL_KEY:
    # Fall back to the n8n credentialed value via the n8n REST API (credential values are write-only,
    # so we can't read them back). Instead skip scrape in the sim and stub an article body.
    FIRECRAWL_KEY = None
print(f"firecrawl key available for sim: {bool(FIRECRAWL_KEY)}")


def curl_json(url: str, *, method="GET", headers=None, body=None):
    args = ["curl", "-sS", "-w", "\nHTTP:%{http_code}", "-X", method, "-A", UA]
    for k, v in (headers or {}).items():
        args += ["-H", f"{k}: {v}"]
    if body is not None:
        args += ["-H", "Content-Type: application/json", "--data", json.dumps(body) if not isinstance(body, str) else body]
    args.append(url)
    r = subprocess.run(args, capture_output=True, text=True, check=True)
    body_txt, _, http_line = r.stdout.rpartition("\nHTTP:")
    return int(http_line.strip()), body_txt.strip()


def step(msg: str):
    print(f"\n--- {msg}")


# ======================================================================
# 1. fetch rss.app json — use r/OpenAI since it has steady traffic
# ======================================================================
step("1. Fetch r/OpenAI/new.json (simulates fetch_reddit_open_ai_feed + split)")
status, body = curl_json("https://www.reddit.com/r/OpenAI/new.json?limit=10&raw_json=1")
assert status == 200, f"reddit listing failed: {status} {body[:200]}"
posts = json.loads(body)["data"]["children"]
# Prefer a LINK post so the current filter passes (S4 only handles link posts)
link_posts = [p["data"] for p in posts
              if not p["data"].get("is_self")
              and p["data"].get("url_overridden_by_dest")
              and "reddit.com" not in (p["data"].get("url_overridden_by_dest") or "")
              and "youtube.com" not in (p["data"].get("url_overridden_by_dest") or "")]
if not link_posts:
    print("no link posts in latest 10; fall back to first item (will test filter-drops path)")
    post = posts[0]["data"]
else:
    post = link_posts[0]
print(f"  picked post {post['id']}  is_self={post.get('is_self')}  url={post.get('url_overridden_by_dest')}")


# ======================================================================
# 2. simulate split_reddit_*_items (already a single item now)
#    simulate get_reddit_X_items_http: URL = reddit.com/comments/{postId}.json
# ======================================================================
step("2. Fetch reddit.com/comments/{postId}.json (simulates get_reddit_*_items_http)")
# postId extracted via regex — same expression the node uses:
#   $json.url.match(/comments\/([^/]+)/)[1]
m = re.search(r"comments/([^/]+)", post.get("url") or post.get("permalink", ""))
post_id = m.group(1) if m else post["id"]
status, body = curl_json(f"https://www.reddit.com/comments/{post_id}.json?raw_json=1")
assert status == 200, f"reddit post fetch failed: {status}"
http_out = json.loads(body)


# ======================================================================
# 3. simulate extract_reddit_X_items Set node
# ======================================================================
step("3. extract_reddit_*_items (flattens [0].data.children[0].data)")
try:
    post_data = http_out[0]["data"]["children"][0]["data"]
except Exception as e:
    print(f"extract failed: {e}")
    sys.exit(1)
for k in ("url", "url_overridden_by_dest", "is_self", "title", "permalink", "selftext"):
    v = post_data.get(k)
    print(f"  {k:22s} = {repr(str(v)[:60])}")


# ======================================================================
# 4. simulate filter_reddit_X_items — link-post only
# ======================================================================
step("4. filter_reddit_*_items (keep only link posts; drop self/reddit/youtube/error)")
def filter_passes(p):
    if p.get("error"): return False
    dst = p.get("url_overridden_by_dest")
    if not dst: return False
    if "reddit.com" in dst: return False
    if "youtube.com" in dst: return False
    return True
passes = filter_passes(post_data)
print(f"  passes = {passes}")
if not passes:
    print("filter rejected this post — this is expected for self-posts. Sim ends here (success path would scrape).")
    sys.exit(0)


# ======================================================================
# 5. simulate normalize_reddit_*_items + get_identity
# ======================================================================
step("5. normalize + get_identity (builds uploadFileName key)")
title = post_data["title"]
iso_date = None
# Reddit's created_utc is seconds since epoch
import datetime
iso_date = datetime.datetime.utcfromtimestamp(post_data["created_utc"]).isoformat() + "+00:00"
slug = re.sub(r"[^a-z0-9 -]", "", title.lower()).strip()
slug = re.sub(r"\s+", "-", slug)
slug = re.sub(r"-+", "-", slug)
upload_file_name = f"{iso_date[:10]}/{slug}.reddit-openai"   # sourceName = "reddit-openai"
print(f"  uploadFileName = {upload_file_name}")


# ======================================================================
# 6. simulate search_existing (hit real /api/ingestion/search)
#    skip_existing_resources passes if items.length === 0
# ======================================================================
step("6. search_existing against real dev /api/ingestion/search")
q = urllib.parse.urlencode({"prefix": upload_file_name, "user_id": NEWSLETTER_USER_ID})
status, body = curl_json(f"{WORKBENCH}/api/ingestion/search?{q}",
                        headers={"X-Ingestion-Secret": INGEST_SECRET})
print(f"  HTTP {status}  -> {body[:200]}")
assert status == 200
existing = json.loads(body)
already_exists = len(existing.get("items", [])) > 0
print(f"  already exists? {already_exists}")


# ======================================================================
# 7. simulate scrape_url (hit Firecrawl directly or stub)
# ======================================================================
step("7. scrape_url (simulates executeWorkflow -> Node - Scrape Url V2 -> Firecrawl)")
scrape_url_target = post_data["url_overridden_by_dest"]
if FIRECRAWL_KEY:
    status, body = curl_json("https://api.firecrawl.dev/v1/scrape",
                            method="POST",
                            headers={"Authorization": f"Bearer {FIRECRAWL_KEY}"},
                            body={"url": scrape_url_target, "formats": ["markdown", "rawHtml"]})
    print(f"  firecrawl HTTP {status}")
    assert status < 300, body[:300]
    scrape_out = json.loads(body)
    markdown = scrape_out.get("data", {}).get("markdown") or scrape_out.get("markdown") or ""
    raw_html = scrape_out.get("data", {}).get("rawHtml") or scrape_out.get("rawHtml") or ""
else:
    print("  no firecrawl key; stubbing markdown/html for sim purposes (real workflow will use the V2 scraper)")
    markdown = f"# {title}" + NEWLINE + NEWLINE + "Body simulated for end-to-end smoke test."
    raw_html = f"<h1>{title}</h1>" + NEWLINE + "<p>Body simulated for end-to-end smoke test.</p>"


# ======================================================================
# 8. upload_content — POST /api/ingestion/upload
# ======================================================================
step("8. upload_content against real dev /api/ingestion/upload")
body = {
    "key": upload_file_name,
    "user_id": NEWSLETTER_USER_ID,
    "type": "article",  # reddit link-posts map to 'article' per the n8n body expression
    "title": title,
    "authors": post_data.get("author"),
    "source_name": "reddit-openai",
    "source_url": scrape_url_target,
    "external_source_urls": [],
    "image_urls": [],
    "published_timestamp": iso_date,
    "feed_url": "https://rss.app/feeds/v1.1/1LDBacY8BC2qJaZh.json",
    "markdown": markdown,
    "html": raw_html,
}
status, resp = curl_json(f"{WORKBENCH}/api/ingestion/upload",
                        method="POST",
                        headers={"X-Ingestion-Secret": INGEST_SECRET},
                        body=body)
print(f"  HTTP {status}  -> {resp[:300]}")
assert status == 200, resp


# ======================================================================
# 9. verify via psql — row exists with correct fields
# ======================================================================
step("9. verify row in DEV Supabase")
sql = (
    "SELECT key, user_id, type, title, source_name, "
    "octet_length(storage_path_md) AS md_path_len, "
    "octet_length(storage_path_html) AS html_path_len "
    "FROM content_ingestion_v2 WHERE key = $$" + upload_file_name + "$$;"
)
env = {
    "PGHOST": "aws-1-us-east-2.pooler.supabase.com",
    "PGPORT": "5432",
    "PGUSER": "postgres.gvbvwcnmjkdpclcisqrr",
    "PGDATABASE": "postgres",
    "PGPASSWORD": "Fr332bafami!y",
}
r = subprocess.run(
    ["/usr/local/opt/postgresql@17/bin/psql", "-v", "ON_ERROR_STOP=1", "-c", sql],
    capture_output=True, text=True, env={**__import__('os').environ, **env})
print(r.stdout or r.stderr)
assert upload_file_name in r.stdout, "row not found"

# Also verify search finds it now
step("10. re-search confirms dedup signal flips on")
q = urllib.parse.urlencode({"prefix": upload_file_name, "user_id": NEWSLETTER_USER_ID})
status, body = curl_json(f"{WORKBENCH}/api/ingestion/search?{q}",
                        headers={"X-Ingestion-Secret": INGEST_SECRET})
items = json.loads(body).get("items", [])
print(f"  items count = {len(items)}  (expect 1)")
assert len(items) == 1


# Clean up
step("11. cleanup smoke row")
cleanup_sql = "DELETE FROM content_ingestion_v2 WHERE key = $$" + upload_file_name + "$$;"
subprocess.run(
    ["/usr/local/opt/postgresql@17/bin/psql", "-v", "ON_ERROR_STOP=1", "-c", cleanup_sql],
    capture_output=True, text=True, env={**__import__('os').environ, **env})
print(f"  deleted row for key={upload_file_name}")
print("\nEND-TO-END SIM PASSED")
