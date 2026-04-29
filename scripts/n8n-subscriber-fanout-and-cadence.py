"""
Newsletter fan-out + cadence sprint — n8n workflow updates.

Two changes:

1. `Content - Newsletter Agent V2` (id bMvMKyK8obwYZmNb)
     Adds two nodes after save_scheduled_newsletter:
       fetch_subscribers     — GET /api/newsletter/cron/editions/:id/subscribers
       send_to_subscribers   — POST /api/email/send with the rendered HTML
                              and `to: emails[]` from the previous node.
     Re-wires save_scheduled_newsletter to also feed fetch_subscribers
     (parallel to the existing emit_stage_saved + final_notification fork).
     Idempotent: re-runs skip already-present nodes by name.

2. NEW workflow `DEV - Newsletter Cadence Cron` POSTed via REST + activated.
     Hourly schedule trigger -> GET /api/newsletter/cron/editions/due ->
     SplitInBatches -> POST the existing Compose Newsletter webhook with
     {Date, "Edition Id"} for each due edition.

Usage:
    export N8N_API_KEY=$(jq -r '.mcpServers["n8n-mcp"].env.N8N_API_KEY' .mcp.json)
    python3 scripts/n8n-subscriber-fanout-and-cadence.py             # apply
    python3 scripts/n8n-subscriber-fanout-and-cadence.py --dry-run   # write JSON only

After PUT, the n8n 2.x runtime needs a Publish click in the UI before
the changes go live (refresh tab -> Publish becomes enabled).
"""

import json
import os
import sys
import urllib.error
import urllib.request
import uuid as uuid_lib

N8N_API = 'https://n8n.agileadautomation.com'
NEWSLETTER_AGENT_WF_ID = 'bMvMKyK8obwYZmNb'
WORKBENCH_BASE = 'https://writersworkbenchdev-production.up.railway.app'
COMPOSE_WEBHOOK_URL = f'{WORKBENCH_BASE.replace("writersworkbenchdev-production.up.railway.app", "n8n.agileadautomation.com")}/webhook/compose-newsletter-dev'  # placeholder; correct path written below
INGESTION_CRED = {'id': 'jQBRJbmiUeTk8c11', 'name': 'DEV Workbench Ingestion Secret'}
EMAIL_CRED = {'id': 'kxrSg24PIR2Npfvw', 'name': 'DEV Workbench Email Secret'}

API_KEY = os.environ['N8N_API_KEY']
HEADERS = {'X-N8N-API-KEY': API_KEY, 'Accept': 'application/json', 'User-Agent': 'curl/8.0'}


def get_wf(wf_id: str) -> dict:
    req = urllib.request.Request(f'{N8N_API}/api/v1/workflows/{wf_id}', headers=HEADERS)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def put_wf(wf_id: str, wf: dict) -> dict:
    src = wf.get('settings') or {}
    allowed = {'executionOrder', 'callerPolicy', 'saveDataErrorExecution', 'saveDataSuccessExecution',
               'saveExecutionProgress', 'saveManualExecutions', 'timezone', 'errorWorkflow'}
    settings = {k: v for k, v in src.items() if k in allowed}
    body = json.dumps({
        'name': wf['name'],
        'nodes': wf['nodes'],
        'connections': wf['connections'],
        'settings': settings,
    }).encode()
    req = urllib.request.Request(
        f'{N8N_API}/api/v1/workflows/{wf_id}',
        data=body,
        headers={**HEADERS, 'Content-Type': 'application/json'},
        method='PUT',
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f'PUT {e.code}: {e.read().decode("utf-8", errors="replace")[:1000]}')
        raise


def post_create_wf(wf: dict) -> dict:
    """Create a brand-new workflow."""
    body = json.dumps({
        'name': wf['name'],
        'nodes': wf['nodes'],
        'connections': wf['connections'],
        'settings': wf.get('settings') or {'executionOrder': 'v1'},
    }).encode()
    req = urllib.request.Request(
        f'{N8N_API}/api/v1/workflows',
        data=body,
        headers={**HEADERS, 'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def activate_wf(wf_id: str) -> dict:
    req = urllib.request.Request(f'{N8N_API}/api/v1/workflows/{wf_id}/activate', headers=HEADERS, method='POST')
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def find_wf_by_name(name: str) -> str | None:
    req = urllib.request.Request(f'{N8N_API}/api/v1/workflows?limit=250', headers=HEADERS)
    with urllib.request.urlopen(req) as r:
        data = json.loads(r.read())
    for w in data.get('data', []):
        if w.get('name') == name:
            return w.get('id')
    return None


# ---------------------------------------------------------------------------
# Part 1 — modify Content - Newsletter Agent V2
# ---------------------------------------------------------------------------

def fetch_subscribers_node(position: list[int]) -> dict:
    return {
        'parameters': {
            'method': 'GET',
            'url': f'={{{{ "{WORKBENCH_BASE}/api/newsletter/cron/editions/" + ($(\'set_trigger_inputs\').item.json[\'Edition Id\'] || \'ai-news\') + "/subscribers" }}}}',
            'authentication': 'genericCredentialType',
            'genericAuthType': 'httpHeaderAuth',
            'options': {},
        },
        'id': str(uuid_lib.uuid4()),
        'name': 'fetch_subscribers',
        'type': 'n8n-nodes-base.httpRequest',
        'typeVersion': 4.2,
        'position': position,
        'onError': 'continueRegularOutput',
        'credentials': {'httpHeaderAuth': INGESTION_CRED},
    }


def send_to_subscribers_node(position: list[int]) -> dict:
    body = (
        '={{ JSON.stringify({\n'
        '  to: ($json.emails && $json.emails.length > 0) ? $json.emails : [],\n'
        '  subject: $(\'set_selected_stories\').item.json.subject_line,\n'
        '  html: ($(\'render_html_template\').item && $(\'render_html_template\').item.json && $(\'render_html_template\').item.json.html)\n'
        '        || (\'<pre>\' + ($(\'set_full_newsletter\').item.json.full_newsletter_content || \'\') + \'</pre>\'),\n'
        '  user_id: \'+14105914612\'\n'
        '}) }}'
    )
    return {
        'parameters': {
            'method': 'POST',
            'url': f'{WORKBENCH_BASE}/api/email/send',
            'authentication': 'genericCredentialType',
            'genericAuthType': 'httpHeaderAuth',
            'sendHeaders': True,
            'headerParameters': {'parameters': [{'name': 'Content-Type', 'value': 'application/json'}]},
            'sendBody': True,
            'specifyBody': 'json',
            'jsonBody': body,
            'options': {},
        },
        'id': str(uuid_lib.uuid4()),
        'name': 'send_to_subscribers',
        'type': 'n8n-nodes-base.httpRequest',
        'typeVersion': 4.2,
        'position': position,
        'onError': 'continueRegularOutput',
        'credentials': {'httpHeaderAuth': EMAIL_CRED},
    }


def patch_newsletter_agent(dry_run: bool = False) -> None:
    wf = get_wf(NEWSLETTER_AGENT_WF_ID)
    nodes = wf['nodes']
    conns = wf['connections']
    name_to_node = {n['name']: n for n in nodes}

    if 'fetch_subscribers' in name_to_node and 'send_to_subscribers' in name_to_node:
        print('  [idempotent] subscriber fan-out nodes already present — skipping')
    else:
        save_node = name_to_node.get('save_scheduled_newsletter')
        anchor = save_node['position'] if save_node else [3000, 3300]

        if 'fetch_subscribers' not in name_to_node:
            n1 = fetch_subscribers_node([anchor[0] + 240, anchor[1] - 120])
            nodes.append(n1)
            print(f"  [+] added fetch_subscribers at {n1['position']}")
        if 'send_to_subscribers' not in name_to_node:
            n2 = send_to_subscribers_node([anchor[0] + 480, anchor[1] - 120])
            nodes.append(n2)
            print(f"  [+] added send_to_subscribers at {n2['position']}")

        # save_scheduled_newsletter -> [..., fetch_subscribers] (parallel branch)
        save_conns = conns.setdefault('save_scheduled_newsletter', {'main': [[]]})
        save_main = save_conns['main']
        if not save_main:
            save_main.append([])
        already_to_fetch = any(t.get('node') == 'fetch_subscribers' for t in save_main[0])
        if not already_to_fetch:
            save_main[0].append({'node': 'fetch_subscribers', 'type': 'main', 'index': 0})
            print('  [edge] save_scheduled_newsletter -> fetch_subscribers')
        # fetch_subscribers -> send_to_subscribers
        fs_conns = conns.setdefault('fetch_subscribers', {'main': [[]]})
        fs_main = fs_conns['main']
        if not fs_main:
            fs_main.append([])
        if not any(t.get('node') == 'send_to_subscribers' for t in fs_main[0]):
            fs_main[0].append({'node': 'send_to_subscribers', 'type': 'main', 'index': 0})
            print('  [edge] fetch_subscribers -> send_to_subscribers')

    final_names = {n['name'] for n in nodes}
    if 'fetch_subscribers' not in final_names or 'send_to_subscribers' not in final_names:
        print('ABORT — fan-out nodes missing after edits')
        sys.exit(1)
    if len(nodes) < 100:
        print(f'ABORT — only {len(nodes)} nodes after edits (expected ≥100)')
        sys.exit(1)

    print(f'Final node count: {len(nodes)}')
    if dry_run:
        json.dump(wf, open('/tmp/wf-newsletter-agent-patched.json', 'w'), indent=2)
        print('--dry-run: skipping PUT; preview written to /tmp/wf-newsletter-agent-patched.json')
        return

    print('PUTting Content - Newsletter Agent V2...')
    put_wf(NEWSLETTER_AGENT_WF_ID, wf)
    print('PUT ok.')


# ---------------------------------------------------------------------------
# Part 2 — Cadence cron workflow
# ---------------------------------------------------------------------------

def cadence_cron_workflow() -> dict:
    nodes = []
    conns: dict = {}

    def add(name, type_, position, params, type_version=1, **extra):
        n = {'parameters': params, 'id': str(uuid_lib.uuid4()), 'name': name, 'type': type_,
             'typeVersion': type_version, 'position': position}
        n.update(extra)
        nodes.append(n)
        return n

    def edge(src, tgt, idx=0):
        if src not in conns:
            conns[src] = {'main': [[]]}
        while len(conns[src]['main']) <= idx:
            conns[src]['main'].append([])
        conns[src]['main'][idx].append({'node': tgt, 'type': 'main', 'index': 0})

    add('cron_trigger', 'n8n-nodes-base.scheduleTrigger', [240, 240], type_version=1.2,
        params={'rule': {'interval': [{'field': 'hours', 'hoursInterval': 1}]}})

    add('fetch_due_editions', 'n8n-nodes-base.httpRequest', [480, 240], type_version=4.2,
        params={
            'method': 'GET',
            'url': f'{WORKBENCH_BASE}/api/newsletter/cron/editions/due',
            'authentication': 'genericCredentialType',
            'genericAuthType': 'httpHeaderAuth',
            'options': {},
        },
        credentials={'httpHeaderAuth': INGESTION_CRED})

    add('extract_editions', 'n8n-nodes-base.code', [720, 240], type_version=2,
        params={'jsCode':
                "const r = $input.first().json || {};\n"
                "return (r.editions || []).map(e => ({json: e}));"})

    add('split_per_edition', 'n8n-nodes-base.splitInBatches', [960, 240], type_version=3,
        params={'batchSize': 1, 'options': {}})

    # POST to the existing Compose Newsletter webhook with the right body.
    add('post_to_webhook', 'n8n-nodes-base.httpRequest', [1200, 240], type_version=4.2,
        params={
            'method': 'POST',
            'url': 'https://n8n.agileadautomation.com/webhook/compose-newsletter-dev',
            'authentication': 'genericCredentialType',
            'genericAuthType': 'httpHeaderAuth',
            'sendHeaders': True,
            'headerParameters': {'parameters': [{'name': 'Content-Type', 'value': 'application/json'}]},
            'sendBody': True,
            'specifyBody': 'json',
            'jsonBody': (
                '={{ JSON.stringify({\n'
                '  Date: new Date().toISOString().slice(0,10),\n'
                '  "Edition Id": $json.edition_id,\n'
                '  "Previous Newsletter Content": ""\n'
                '}) }}'
            ),
            'options': {},
        },
        credentials={'httpHeaderAuth': INGESTION_CRED},
        onError='continueRegularOutput')

    edge('cron_trigger', 'fetch_due_editions')
    edge('fetch_due_editions', 'extract_editions')
    edge('extract_editions', 'split_per_edition')
    edge('split_per_edition', 'post_to_webhook')

    return {
        'name': 'DEV - Newsletter Cadence Cron',
        'nodes': nodes,
        'connections': conns,
        'settings': {'executionOrder': 'v1'},
    }


def deploy_cadence_cron(dry_run: bool = False) -> None:
    wf = cadence_cron_workflow()
    out_path = 'writers-workbench/n8n-workflows/newsletter-cadence-cron.json'
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(wf, f, indent=2)
    print(f"Wrote {out_path} ({len(wf['nodes'])} nodes)")

    if dry_run:
        print('--dry-run: skipping create + activate')
        return

    existing = find_wf_by_name(wf['name'])
    if existing:
        print(f'  [idempotent] {wf["name"]} already exists with id={existing} — leaving alone')
        return

    created = post_create_wf(wf)
    new_id = created['id']
    print(f"  [+] created cadence cron workflow id={new_id}")
    activate_wf(new_id)
    print(f'  [+] activated id={new_id}')


def main() -> None:
    dry_run = '--dry-run' in sys.argv
    print('=== Part 1: Content - Newsletter Agent V2 subscriber fan-out ===')
    patch_newsletter_agent(dry_run)
    print()
    print('=== Part 2: DEV - Newsletter Cadence Cron ===')
    deploy_cadence_cron(dry_run)
    print()
    if not dry_run:
        print('=== Operator step (n8n 2.x) ===')
        print(f'1. Refresh https://n8n.agileadautomation.com/workflow/{NEWSLETTER_AGENT_WF_ID}')
        print('2. Click Publish in the top-right (the runtime activeVersion needs the new nodes).')
        print('3. The cadence cron is already active and will fire on its hourly schedule.')


if __name__ == '__main__':
    main()
