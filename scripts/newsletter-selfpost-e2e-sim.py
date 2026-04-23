"""End-to-end simulation of the S5 Reddit self-post branch against live DEV infra.

Walks the exact data path the S5 addition will execute when a self-post is
detected in a Reddit pipeline:

  fetch_reddit_*_feed (rss.app)                  -> one self-post item
    split_reddit_*_items                          -> this item as $json
      get_reddit_*_items_http (httpRequest)      -> reddit.com/comments/{id}.json
        extract_reddit_*_items (Set raw JSON)    -> flattened post data
          filter_reddit_*_self_posts (new)       -> keep is_self + non-empty selftext
            normalize_reddit_*_self_posts (new)  -> body_markdown, body_html, reddit_metadata
              get_identity (existing)            -> uploadFileName, publishedTimestamp
                search_existing                  -> /api/ingestion/search
                  skip_existing_resources        -> items.length === 0
                    route_scrape_or_self (new)   -> TRUE branch (feedType=reddit_post)
                      upload_content_self_post   -> POST /api/ingestion/upload

Verified at the end via psql SELECT on content_ingestion_v2 + reddit_metadata
JSONB shape, then cleanup.
"""
import datetime
import json
import re
import subprocess
import sys
import urllib.parse

UA = "writers-workbench/1.0 (newsletter ingestion)"
WORKBENCH = "https://writersworkbenchdev-production.up.railway.app"
INGEST_SECRET = "fe17f5b9299cbed868c8b4413d85377aea1c5bbd4b9732023d49d501deb0058a"
NEWSLETTER_USER_ID = "+14105914612"

PG_ENV = {
    "PGHOST": "aws-1-us-east-2.pooler.supabase.com",
    "PGPORT": "5432",
    "PGUSER": "postgres.gvbvwcnmjkdpclcisqrr",
    "PGDATABASE": "postgres",
    "PGPASSWORD": "Fr332bafami!y",
}
import os
PSQL = "/usr/local/opt/postgresql@17/bin/psql"


def curl_json(url, *, method="GET", headers=None, body=None):
    args = ["curl", "-sS", "-w", "\nHTTP:%{http_code}", "-X", method, "-A", UA]
    for k, v in (headers or {}).items():
        args += ["-H", f"{k}: {v}"]
    if body is not None:
        args += ["-H", "Content-Type: application/json",
                 "--data", json.dumps(body) if not isinstance(body, str) else body]
    args.append(url)
    r = subprocess.run(args, capture_output=True, text=True, check=True)
    body_txt, _, http_line = r.stdout.rpartition("\nHTTP:")
    return int(http_line.strip()), body_txt.strip()


def step(msg):
    print(f"\n--- {msg}")


def decode_html_entities(s):
    """Mirror the normalize_reddit_*_self_posts Code node."""
    if not s: return ""
    return (s
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#039;", "'")
            .replace("&#x200B;", ""))


# ========================================================================
# 1. r/OpenAI/new.json — find a self-post (is_self=True, non-empty selftext)
# ========================================================================
step("1. r/OpenAI/new.json (find a self-post)")
status, body = curl_json("https://www.reddit.com/r/OpenAI/new.json?limit=25&raw_json=1")
assert status == 200
posts = [p["data"] for p in json.loads(body)["data"]["children"]]
self_posts = [p for p in posts
              if p.get("is_self") and p.get("selftext")
              and p["selftext"] not in ("[removed]", "[deleted]")
              and not p.get("crosspost_parent")]
if not self_posts:
    print("no self-posts in the last 25 new r/OpenAI posts; try different sub")
    for sub in ["artificial", "ArtificialInteligence"]:
        status, body = curl_json(f"https://www.reddit.com/r/{sub}/new.json?limit=25&raw_json=1")
        posts = [p["data"] for p in json.loads(body)["data"]["children"]]
        self_posts = [p for p in posts
                      if p.get("is_self") and p.get("selftext")
                      and p["selftext"] not in ("[removed]", "[deleted]")
                      and not p.get("crosspost_parent")]
        if self_posts:
            print(f"  picked one from r/{sub}")
            break
assert self_posts, "no self-posts anywhere — try again later"
post_listing = self_posts[0]
post_id = post_listing["id"]
sub = post_listing["subreddit"]
print(f"  picked {post_id}  r/{sub}  title={post_listing['title'][:60]!r}")


# ========================================================================
# 2. simulate get_reddit_*_items_http + extract_reddit_*_items
# ========================================================================
step("2. comments/{postId}.json + extract")
status, body = curl_json(f"https://www.reddit.com/comments/{post_id}.json?raw_json=1")
assert status == 200
post = json.loads(body)[0]["data"]["children"][0]["data"]
print(f"  is_self={post['is_self']}  selftext_len={len(post.get('selftext',''))}  crosspost_parent={post.get('crosspost_parent')}")


# ========================================================================
# 3. simulate filter_reddit_*_self_posts
# ========================================================================
step("3. filter_reddit_*_self_posts (keep is_self + non-empty selftext + not [removed/deleted] + not crosspost)")
def filter_self_passes(p):
    if not p.get("is_self"): return False
    st = p.get("selftext")
    if not st: return False
    if st == "[removed]" or st == "[deleted]": return False
    if p.get("crosspost_parent"): return False
    return True
passes = filter_self_passes(post)
print(f"  passes = {passes}")
assert passes


# ========================================================================
# 4. simulate normalize_reddit_*_self_posts (matches the Code node's logic)
# ========================================================================
step("4. normalize_reddit_*_self_posts")
iso = datetime.datetime.fromtimestamp(post["created_utc"], datetime.UTC).isoformat().replace("+00:00","+00:00")
normalized = {
    "sourceName": f"reddit-{sub}",
    "feedType": "reddit_post",
    "title": post["title"],
    "link": f"https://reddit.com{post.get('permalink','')}",
    "url":  f"https://reddit.com{post.get('permalink','')}",
    "creator": post.get("author"),
    "pubDate": iso,
    "isoDate": iso,
    "feedUrl": "https://rss.app/feeds/v1.1/1LDBacY8BC2qJaZh.json",  # OpenAI feed (matches node)
    "body_markdown": post.get("selftext") or "",
    "body_html": decode_html_entities(post.get("selftext_html")),
    "reddit_metadata": {
        "score": post.get("score"),
        "num_comments": post.get("num_comments"),
        "author": post.get("author"),
        "subreddit": post.get("subreddit"),
        "reddit_id": post.get("id"),
        "flair": post.get("link_flair_text"),
    },
}
print(f"  sourceName={normalized['sourceName']}  feedType={normalized['feedType']}")
print(f"  body_markdown[:80]={normalized['body_markdown'][:80]!r}")
print(f"  reddit_metadata keys={list(normalized['reddit_metadata'].keys())}")


# ========================================================================
# 5. simulate get_identity (builds uploadFileName)
# ========================================================================
step("5. get_identity")
title = normalized["title"]
slug = re.sub(r"[^a-z0-9 -]", "", title.lower()).strip()
slug = re.sub(r"\s+", "-", slug)
slug = re.sub(r"-+", "-", slug)
upload_file_name = f"{iso[:10]}/{slug}.{normalized['sourceName']}"
print(f"  uploadFileName = {upload_file_name}")


# ========================================================================
# 6. search_existing against real dev
# ========================================================================
step("6. /api/ingestion/search (dev)")
q = urllib.parse.urlencode({"prefix": upload_file_name, "user_id": NEWSLETTER_USER_ID})
status, body = curl_json(f"{WORKBENCH}/api/ingestion/search?{q}",
                        headers={"X-Ingestion-Secret": INGEST_SECRET})
assert status == 200
items = json.loads(body).get("items", [])
print(f"  items count = {len(items)} (expect 0)")
assert len(items) == 0


# ========================================================================
# 7. simulate route_scrape_or_self decision — feedType=reddit_post → TRUE
#    (self-post path bypasses scrape_url entirely)
# ========================================================================
step("7. route_scrape_or_self: feedType=reddit_post -> TRUE branch (upload_content_self_post)")
assert normalized["feedType"] == "reddit_post"


# ========================================================================
# 8. upload_content_self_post (POST /api/ingestion/upload with type=reddit_post)
# ========================================================================
step("8. upload_content_self_post (dev)")
body = {
    "key": upload_file_name,
    "user_id": NEWSLETTER_USER_ID,
    "type": "reddit_post",
    "title": title,
    "authors": normalized["creator"],
    "source_name": normalized["sourceName"],
    "source_url": normalized["url"],
    "external_source_urls": [],
    "image_urls": [],
    "reddit_metadata": normalized["reddit_metadata"],
    "published_timestamp": iso,
    "feed_url": normalized["feedUrl"],
    "markdown": normalized["body_markdown"],
    "html": normalized["body_html"],
}
status, resp = curl_json(f"{WORKBENCH}/api/ingestion/upload",
                        method="POST",
                        headers={"X-Ingestion-Secret": INGEST_SECRET},
                        body=body)
print(f"  HTTP {status}  -> {resp[:220]}")
assert status == 200, resp


# ========================================================================
# 9. verify in DEV Supabase — correct type + reddit_metadata populated
# ========================================================================
step("9. psql verify")
sql = (
    "SELECT key, type, source_name, title, reddit_metadata "
    "FROM content_ingestion_v2 WHERE key = $$" + upload_file_name + "$$;"
)
r = subprocess.run([PSQL, "-v", "ON_ERROR_STOP=1", "-A", "-F|", "-c", sql],
                   capture_output=True, text=True, env={**os.environ, **PG_ENV})
print(r.stdout.strip())
assert upload_file_name in r.stdout, "row missing"
assert "reddit_post" in r.stdout
assert "\"score\"" in r.stdout and "\"subreddit\"" in r.stdout

# Also verify the blob really landed — read metadata via the /get endpoint
step("10. /api/ingestion/get/:key (full round-trip)")
enc = urllib.parse.quote(upload_file_name, safe="")
status, body = curl_json(f"{WORKBENCH}/api/ingestion/get/{enc}",
                        headers={"X-Ingestion-Secret": INGEST_SECRET})
assert status == 200
d = json.loads(body)
print(f"  type={d['type']}  markdown[:80]={d['markdown'][:80]!r}")
assert d["type"] == "reddit_post"
assert d["markdown"]  # non-empty body
assert d["reddit_metadata"]["reddit_id"] == post["id"]


# ========================================================================
# 11. cleanup
# ========================================================================
step("11. cleanup smoke row")
cleanup = "DELETE FROM content_ingestion_v2 WHERE key = $$" + upload_file_name + "$$;"
subprocess.run([PSQL, "-v", "ON_ERROR_STOP=1", "-c", cleanup],
               capture_output=True, text=True, env={**os.environ, **PG_ENV})
print(f"  deleted {upload_file_name}")

print("\nS5 SELF-POST END-TO-END SIM PASSED")
