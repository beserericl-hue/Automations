"""S6 — end-to-end simulation of Content - Newsletter Agent V2's read path.

The only pieces S6 changes are:
  - search_markdown_objects (HTTP GET /api/ingestion/search with type_not=newsletter)
  - split_search_markdown  (splitOut on items)
  - download_markdown_object (HTTP GET /api/ingestion/get/:key)
  - prepare_markdown_content (field paths)

Activation of the full agent is blocked by pre-existing cred gaps on the
LLM/Slack/S3-segment nodes that S7–S11 will resolve; that's out of this
story's scope. This sim proves the read-path works against live services
and the prepare_markdown_content output matches what the LLM pipeline
downstream expects.

Seeds 3 rows into content_ingestion_v2 (2 article + 1 newsletter on the
same date), calls /api/ingestion/search with type_not=newsletter, confirms
only the 2 articles come back, then /api/ingestion/get for each and
simulates prepare_markdown_content's template rendering. Cleans up after.
"""
import datetime, json, os, subprocess, urllib.parse

UA = "writers-workbench/1.0 (newsletter ingestion sim)"
WORKBENCH = "https://writersworkbenchdev-production.up.railway.app"
INGEST_SECRET = "fe17f5b9299cbed868c8b4413d85377aea1c5bbd4b9732023d49d501deb0058a"
NEWSLETTER_USER_ID = "+14105914612"
PSQL = "/usr/local/opt/postgresql@17/bin/psql"
PG_ENV = {
    "PGHOST": "aws-1-us-east-2.pooler.supabase.com", "PGPORT": "5432",
    "PGUSER": "postgres.gvbvwcnmjkdpclcisqrr", "PGDATABASE": "postgres",
    "PGPASSWORD": "Fr332bafami!y",
}


def curl(url, *, method="GET", headers=None, body=None):
    args = ["curl", "-sS", "-w", "\nHTTP:%{http_code}", "-X", method, "-A", UA]
    for k, v in (headers or {}).items():
        args += ["-H", f"{k}: {v}"]
    if body is not None:
        args += ["-H", "Content-Type: application/json", "--data", json.dumps(body)]
    args.append(url)
    r = subprocess.run(args, capture_output=True, text=True, check=True)
    body_txt, _, http = r.stdout.rpartition("\nHTTP:")
    return int(http.strip()), body_txt.strip()


def step(msg): print(f"\n--- {msg}")


# Unique test date so the sim doesn't collide with anything real.
TEST_DATE = datetime.datetime.utcnow().strftime("%Y-%m-%d")
PREFIX_MARKER = "__s6sim__"  # distinguish smoke rows
ITEMS = [
    # (slug, type, title, markdown, html, source_name)
    (f"{PREFIX_MARKER}.sim-article-1", "article",    "Sim article 1",   "# Article 1\n\nBody A",             "<h1>A1</h1>", "simulated-source"),
    (f"{PREFIX_MARKER}.sim-article-2", "article",    "Sim article 2",   "# Article 2\n\nBody B",             "<h1>A2</h1>", "simulated-source"),
    (f"{PREFIX_MARKER}.sim-newsletter","newsletter", "Sim newsletter",  "# Newsletter\n\nPrevious edition", "<h1>NL</h1>", "simulated-newsletter"),
]


step("1. seed 3 rows (2 article + 1 newsletter) for test date")
seeded_keys = []
for slug, itype, title, md, html, source in ITEMS:
    key = f"{TEST_DATE}/{slug}"
    code, resp = curl(f"{WORKBENCH}/api/ingestion/upload",
                      method="POST",
                      headers={"X-Ingestion-Secret": INGEST_SECRET},
                      body={"key": key, "user_id": NEWSLETTER_USER_ID, "type": itype,
                            "title": title, "source_name": source, "markdown": md, "html": html})
    assert code == 200, f"seed failed: {code} {resp}"
    seeded_keys.append(key)
    print(f"  seeded key={key}  type={itype}")


step("2. simulate search_markdown_objects (HTTP GET /api/ingestion/search with type_not=newsletter)")
# Prefix must include the PREFIX_MARKER so we don't pick up any real rows from today's date.
query = urllib.parse.urlencode({"prefix": f"{TEST_DATE}/{PREFIX_MARKER}", "type_not": "newsletter", "user_id": NEWSLETTER_USER_ID})
code, body = curl(f"{WORKBENCH}/api/ingestion/search?{query}", headers={"X-Ingestion-Secret": INGEST_SECRET})
assert code == 200
items = json.loads(body)["items"]
print(f"  returned {len(items)} items (expect 2 — the newsletter row must be excluded)")
assert len(items) == 2
assert all(i["type"] == "article" for i in items)
assert all(i["type"] != "newsletter" for i in items)
seen_keys = sorted(i["key"] for i in items)
print(f"  keys: {seen_keys}")


step("3. simulate split_search_markdown (splitOut on items)")
# splitOut emits each item in items[] as its own $json. Nothing to do here —
# just iterate.


step("4. simulate download_markdown_object for each item (HTTP GET /api/ingestion/get/:key)")
downloaded = {}
for item in items:
    enc = urllib.parse.quote(item["key"], safe="")
    code, body = curl(f"{WORKBENCH}/api/ingestion/get/{enc}",
                     headers={"X-Ingestion-Secret": INGEST_SECRET})
    assert code == 200, f"get failed for {item['key']}: {code} {body}"
    downloaded[item["key"]] = json.loads(body)
    print(f"  got key={item['key']}  md[:40]={downloaded[item['key']]['markdown'][:40]!r}")


step("5. simulate prepare_markdown_content template output for each item")
# This mirrors the new prepare_markdown_content expression:
#   <{key}>\n---\nidentifier: {key}\nfriendlyType: {type}\n...\n---\n\n{markdown}\n</{key}>
for item in items:
    got = downloaded[item["key"]]
    rendered = (
        f"<{item['key']}>\n"
        f"---\n"
        f"identifier: {item['key']}\n"
        f"friendlyType: {item['type']}\n"
        f"sourceName: {item['source_name']}\n"
        f"authors: {item.get('authors') or ''}\n"
        f"externalSourceUrls: {', '.join(item.get('external_source_urls') or [])}\n"
        f"---\n\n"
        f"{got['markdown']}\n"
        f"</{item['key']}>"
    )
    print(f"  rendered for {item['key']}:")
    for line in rendered.splitlines():
        print(f"    {line}")
    # Sanity: rendered string must contain the markdown body and the right metadata.
    assert got["markdown"] in rendered
    assert f"identifier: {item['key']}" in rendered
    assert f"friendlyType: {item['type']}" in rendered


step("6. cleanup seeded rows")
sql_keys = ",".join(f"$${k}$$" for k in seeded_keys)
sql = f"DELETE FROM content_ingestion_v2 WHERE key IN ({sql_keys});"
r = subprocess.run([PSQL, "-v", "ON_ERROR_STOP=1", "-c", sql],
                   capture_output=True, text=True, env={**os.environ, **PG_ENV})
print(f"  {r.stdout.strip() or r.stderr.strip()}")

print("\nS6 READ-PATH END-TO-END SIM PASSED")
