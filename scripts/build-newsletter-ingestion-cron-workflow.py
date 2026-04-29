"""
Builds the n8n workflow JSON for the multi-user cron-driven newsletter
ingestion fan-out, replacing the legacy 17-trigger `AI News Data Ingestion V2`.

Output: writers-workbench/n8n-workflows/newsletter-ingestion-multi-user-cron.json

Design (Sprint 2b — Multi-User Newsletters):

  cron_trigger (every 30 min)
    -> fetch_due_feeds (GET /api/newsletter/cron/feeds/due)
      -> extract_feeds (Code: feeds[] -> items)
        -> split_per_feed (SplitInBatches size=1)
          -> switch_url_type (rss / reddit / source / firecrawl_scrape)
            -> fetch_rss_or_json | fetch_reddit_or_json
              -> normalize_items
                -> build_key
                  -> search_existing (GET /api/ingestion/search)
                    -> drop_existing (IF items.length === 0 -> upload, else skip)
                      -> upload_content (POST /api/ingestion/upload)
                        -> report_run (POST /api/newsletter/cron/feeds/:id/runs)

After this script writes the JSON, deploy via:

    export N8N_API_KEY=$(jq -r '.mcpServers["n8n-mcp"].env.N8N_API_KEY' .mcp.json)
    curl -X POST https://n8n.agileadautomation.com/api/v1/workflows \\
      -H "X-N8N-API-KEY: $N8N_API_KEY" \\
      -H 'Accept: application/json' -H 'Content-Type: application/json' \\
      -A 'curl/8.0' \\
      --data @writers-workbench/n8n-workflows/newsletter-ingestion-multi-user-cron.json

Then in the n8n UI: open the new workflow -> Cmd-R -> Publish.
"""

import json
import os
import uuid

OUT_PATH = 'writers-workbench/n8n-workflows/newsletter-ingestion-multi-user-cron.json'
WORKBENCH_BASE = 'https://writersworkbenchdev-production.up.railway.app'
INGEST_CRED = {'id': 'jQBRJbmiUeTk8c11', 'name': 'DEV Workbench Ingestion Secret'}


def nid() -> str:
    return str(uuid.uuid4())


def add(nodes, name, type_, position, params=None, type_version=1, **extra):
    n = {
        'parameters': params or {},
        'id': nid(),
        'name': name,
        'type': type_,
        'typeVersion': type_version,
        'position': position,
    }
    n.update(extra)
    nodes.append(n)
    return n


def edge(conns, src, tgt, src_idx=0):
    if src not in conns:
        conns[src] = {'main': [[]]}
    while len(conns[src]['main']) <= src_idx:
        conns[src]['main'].append([])
    conns[src]['main'][src_idx].append({'node': tgt, 'type': 'main', 'index': 0})


def build():
    nodes = []
    conns: dict = {}

    add(nodes, 'cron_trigger', 'n8n-nodes-base.scheduleTrigger', [240, 240], type_version=1.2, params={
        'rule': {'interval': [{'field': 'minutes', 'minutesInterval': 30}]},
    })

    add(nodes, 'fetch_due_feeds', 'n8n-nodes-base.httpRequest', [480, 240], type_version=4.2, params={
        'method': 'GET',
        'url': f'{WORKBENCH_BASE}/api/newsletter/cron/feeds/due',
        'sendQuery': True,
        'queryParameters': {'parameters': [{'name': 'limit', 'value': '100'}]},
        'authentication': 'genericCredentialType',
        'genericAuthType': 'httpHeaderAuth',
        'options': {},
    }, credentials={'httpHeaderAuth': INGEST_CRED})

    add(nodes, 'extract_feeds', 'n8n-nodes-base.code', [720, 240], type_version=2, params={
        'jsCode': (
            "const r = $input.first().json || {};\n"
            "return (r.feeds || []).map(f => ({json: f}));"
        ),
    })

    add(nodes, 'split_per_feed', 'n8n-nodes-base.splitInBatches', [960, 240], type_version=3, params={
        'batchSize': 1, 'options': {},
    })

    # Switch on url_type. Four named outputs.
    rules_values = []
    for key in ('rss', 'reddit', 'source', 'firecrawl_scrape'):
        rules_values.append({
            'conditions': {
                'options': {'caseSensitive': True, 'leftValue': '', 'typeValidation': 'loose', 'version': 2},
                'conditions': [{
                    'id': nid(),
                    'leftValue': '={{ $json.url_type }}',
                    'rightValue': key,
                    'operator': {'type': 'string', 'operation': 'equals'},
                }],
                'combinator': 'and',
            },
            'renameOutput': True,
            'outputKey': key,
        })

    add(nodes, 'switch_url_type', 'n8n-nodes-base.switch', [1200, 240], type_version=3.2, params={
        'mode': 'rules',
        'rules': {'values': rules_values},
        'options': {'fallbackOutput': 'none'},
    })

    add(nodes, 'fetch_rss_or_json', 'n8n-nodes-base.httpRequest', [1440, 120], type_version=4.2, params={
        'method': 'GET',
        'url': '={{ $json.url }}',
        'options': {'response': {'response': {'responseFormat': 'autodetect'}}},
    })

    add(nodes, 'fetch_reddit_or_json', 'n8n-nodes-base.httpRequest', [1440, 360], type_version=4.2, params={
        'method': 'GET',
        'url': '={{ $json.url }}',
        'sendHeaders': True,
        'headerParameters': {'parameters': [
            {'name': 'User-Agent', 'value': 'writers-workbench/1.0 (newsletter ingestion)'},
        ]},
        'options': {'response': {'response': {'responseFormat': 'autodetect'}}},
    })

    add(nodes, 'normalize_items', 'n8n-nodes-base.code', [1680, 240], type_version=2, params={
        'jsCode': (
            "const feed = $('split_per_feed').item.json;\n"
            "const payload = $json || {};\n"
            "const raw = Array.isArray(payload.items) ? payload.items\n"
            "  : (Array.isArray(payload) ? payload : []);\n"
            "const items = raw.map(it => ({\n"
            "  title: it.title || it.title_text || '(untitled)',\n"
            "  url: it.url || it.link || '',\n"
            "  source_name: it.source || feed.name || '',\n"
            "  source_url: it.url || it.link || '',\n"
            "  feed_url: feed.url,\n"
            "  body_html: it.content_html || it.content || it.description_html || it.description || '',\n"
            "  body_text: it.content_text || it.summary || '',\n"
            "  image_urls: (it.image ? [it.image] : (it.attachments || []).map(a => a.url).filter(Boolean)),\n"
            "  published_timestamp: it.date_published || it.pubDate || it.created_utc || null,\n"
            "  type: feed.url_type === 'reddit' ? 'reddit_post' : 'article',\n"
            "}));\n"
            "return items.map(json => ({json: {...json, _feed: feed}}));\n"
        ),
    })

    add(nodes, 'build_key', 'n8n-nodes-base.code', [1920, 240], type_version=2, params={
        'jsCode': (
            "const it = $json;\n"
            "const today = new Date().toISOString().slice(0,10);\n"
            "const slug = (it.title || 'untitled').toLowerCase()\n"
            "  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g,'').slice(0,80) || 'untitled';\n"
            "const sourceTag = (it._feed.name || 'feed').toLowerCase()\n"
            "  .replace(/[^a-z0-9]+/g,'-').slice(0,40);\n"
            "return [{ json: { ...it, key: `${today}/${slug}.${sourceTag}` } }];\n"
        ),
    })

    add(nodes, 'search_existing', 'n8n-nodes-base.httpRequest', [2160, 240], type_version=4.2, params={
        'method': 'GET',
        'url': f'{WORKBENCH_BASE}/api/ingestion/search',
        'sendQuery': True,
        'queryParameters': {'parameters': [
            {'name': 'prefix', 'value': '={{ $json.key }}'},
            {'name': 'user_id', 'value': '={{ $json._feed.user_id }}'},
        ]},
        'authentication': 'genericCredentialType',
        'genericAuthType': 'httpHeaderAuth',
        'options': {},
    }, credentials={'httpHeaderAuth': INGEST_CRED})

    add(nodes, 'drop_existing', 'n8n-nodes-base.if', [2400, 240], type_version=2.2, params={
        'conditions': {
            'options': {'caseSensitive': True, 'leftValue': '', 'typeValidation': 'loose', 'version': 2},
            'conditions': [{
                'id': nid(),
                'leftValue': '={{ ($json.items || []).length }}',
                'rightValue': 0,
                'operator': {'type': 'number', 'operation': 'equals'},
            }],
            'combinator': 'and',
        },
    })

    upload_body = (
        "={\n"
        '  "key": {{ JSON.stringify($json.key) }},\n'
        '  "user_id": {{ JSON.stringify($json._feed.user_id) }},\n'
        '  "type": {{ JSON.stringify($json.type) }},\n'
        '  "title": {{ JSON.stringify($json.title) }},\n'
        '  "source_name": {{ JSON.stringify($json.source_name) }},\n'
        '  "source_url": {{ JSON.stringify($json.source_url) }},\n'
        '  "feed_url": {{ JSON.stringify($json.feed_url) }},\n'
        '  "image_urls": {{ JSON.stringify($json.image_urls || []) }},\n'
        '  "published_timestamp": {{ JSON.stringify($json.published_timestamp) }},\n'
        '  "markdown": {{ JSON.stringify($json.body_text || $json.body_html || "") }},\n'
        '  "html": {{ JSON.stringify($json.body_html || "") }}\n'
        "}"
    )

    add(nodes, 'upload_content', 'n8n-nodes-base.httpRequest', [2640, 180], type_version=4.2, params={
        'method': 'POST',
        'url': f'{WORKBENCH_BASE}/api/ingestion/upload',
        'authentication': 'genericCredentialType',
        'genericAuthType': 'httpHeaderAuth',
        'sendHeaders': True,
        'headerParameters': {'parameters': [{'name': 'Content-Type', 'value': 'application/json'}]},
        'sendBody': True,
        'specifyBody': 'json',
        'jsonBody': upload_body,
        'options': {},
    }, credentials={'httpHeaderAuth': INGEST_CRED}, onError='continueRegularOutput')

    add(nodes, 'report_run', 'n8n-nodes-base.httpRequest', [2880, 240], type_version=4.2, params={
        'method': 'POST',
        'url': "={{ '" + WORKBENCH_BASE + "/api/newsletter/cron/feeds/' + $('split_per_feed').item.json.id + '/runs' }}",
        'authentication': 'genericCredentialType',
        'genericAuthType': 'httpHeaderAuth',
        'sendHeaders': True,
        'headerParameters': {'parameters': [{'name': 'Content-Type', 'value': 'application/json'}]},
        'sendBody': True,
        'specifyBody': 'json',
        'jsonBody': '={"items_uploaded": 1}',
        'options': {},
    }, credentials={'httpHeaderAuth': INGEST_CRED}, onError='continueRegularOutput')

    # Edges
    edge(conns, 'cron_trigger', 'fetch_due_feeds')
    edge(conns, 'fetch_due_feeds', 'extract_feeds')
    edge(conns, 'extract_feeds', 'split_per_feed')
    edge(conns, 'split_per_feed', 'switch_url_type')

    # Switch has 4 outputs; pre-allocate.
    conns['switch_url_type'] = {'main': [[], [], [], []]}
    conns['switch_url_type']['main'][0].append({'node': 'fetch_rss_or_json', 'type': 'main', 'index': 0})       # rss
    conns['switch_url_type']['main'][1].append({'node': 'fetch_reddit_or_json', 'type': 'main', 'index': 0})    # reddit
    conns['switch_url_type']['main'][2].append({'node': 'fetch_rss_or_json', 'type': 'main', 'index': 0})       # source — same path
    conns['switch_url_type']['main'][3].append({'node': 'fetch_rss_or_json', 'type': 'main', 'index': 0})       # firecrawl_scrape — stub; future: executeWorkflow

    edge(conns, 'fetch_rss_or_json', 'normalize_items')
    edge(conns, 'fetch_reddit_or_json', 'normalize_items')
    edge(conns, 'normalize_items', 'build_key')
    edge(conns, 'build_key', 'search_existing')
    edge(conns, 'search_existing', 'drop_existing')

    # IF outputs: 0=true (drop -> NOT in DB -> upload), 1=false (already exists -> skip)
    conns['drop_existing'] = {'main': [[], []]}
    conns['drop_existing']['main'][0].append({'node': 'upload_content', 'type': 'main', 'index': 0})
    edge(conns, 'upload_content', 'report_run')

    return {
        'name': 'DEV - Newsletter Ingestion (Multi-User Cron)',
        'nodes': nodes,
        'connections': conns,
        'settings': {'executionOrder': 'v1'},
    }


def main() -> None:
    wf = build()
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w') as f:
        json.dump(wf, f, indent=2)
    print(f'Wrote {OUT_PATH} ({len(wf["nodes"])} nodes)')


if __name__ == '__main__':
    main()
