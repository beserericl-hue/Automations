"""
S3 (Compose Newsletter 2a) — rework `Content - Newsletter Agent V2` (id bMvMKyK8obwYZmNb).

Idempotent: nodes whose names already exist are skipped on re-runs.

Usage:
    export N8N_API_KEY=$(jq -r '.mcpServers["n8n-mcp"].env.N8N_API_KEY' .mcp.json)
    python3 scripts/s3-newsletter-workflow-rewrite.py             # apply
    python3 scripts/s3-newsletter-workflow-rewrite.py --dry-run   # write /tmp/wf-rewritten.json only

After this script PUTs the structure, the runtime needs a Publish action in
the n8n UI to push the draft live for any NEW trigger to register. The
existing form_trigger edit propagates immediately. This n8n is self-hosted
v2.x — the v1.x active/inactive toggle was replaced with publish/unpublish,
and the public REST API exposes neither (`/activate` and `/deactivate` return
403; `/publish` returns 405), so the toggle must happen in the browser:
open the workflow, click the Published dropdown (top-right), pick Publish (⌘P).

Nodes added (12):
  1) webhook_trigger              — POST /webhook/compose-newsletter-dev
  2) respond_to_webhook           — sync {executionId, editionId}
  3) set_trigger_inputs           — normalizes form / webhook payloads
  4) emit_stage_gathering         — after set_trigger_inputs (parallel branch)
  5) emit_stage_picking           — sibling of set_current_stories after pick_top_stories
  6) emit_stage_awaiting_stories  — sibling of send_approval_email_stories
  7) emit_stage_stories_approved  — sibling on TRUE branch of check_stories_feedback
  8) emit_stage_awaiting_subject  — sibling of send_approval_email_subject_line
  9) emit_stage_subject_approved  — sibling on TRUE branch of check_subject_line_feedback
 10) emit_stage_writing_segment   — sibling of iterate_stories after set_story_segment
 11) emit_stage_segments_done     — sibling of write_intro after set_combined_sections_content
 12) emit_stage_saved             — sibling of final_notification after save_scheduled_newsletter

Edits one existing node:
  form_trigger — add 'Edition Id' text field (placeholder 'ai-news', not required)

Emit nodes are spliced as SIBLINGS of the original downstream — never blocking
the product path. Each uses onError: continueRegularOutput so a callback failure
can never stop a run.
"""

import json
import os
import sys
import urllib.request
import uuid


N8N_API = 'https://n8n.agileadautomation.com'
WF_ID = 'bMvMKyK8obwYZmNb'
INGESTION_CRED_ID = 'jQBRJbmiUeTk8c11'
INGESTION_CRED_NAME = 'DEV Workbench Ingestion Secret'
CALLBACK_CRED_ID = '1aF4oDhcjhe8R5sk'
CALLBACK_CRED_NAME = 'DEV Workbench Newsletter Callback Secret'
WORKBENCH_BASE = 'https://writersworkbenchdev-production.up.railway.app'

API_KEY = os.environ['N8N_API_KEY']


def get_wf():
    req = urllib.request.Request(
        f'{N8N_API}/api/v1/workflows/{WF_ID}',
        headers={'X-N8N-API-KEY': API_KEY, 'Accept': 'application/json', 'User-Agent': 'curl/8.0'},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def put_wf(wf):
    # Strict-allowlist settings keys: n8n's PUT validator rejects custom
    # fields it doesn't know (`availableInMCP`, `binaryMode`, etc.).
    src_settings = wf.get('settings', {}) or {}
    allowed_settings = {'executionOrder', 'callerPolicy', 'saveDataErrorExecution', 'saveDataSuccessExecution', 'saveExecutionProgress', 'saveManualExecutions', 'timezone', 'errorWorkflow'}
    settings = {k: v for k, v in src_settings.items() if k in allowed_settings}

    body = json.dumps({
        'name': wf['name'],
        'nodes': wf['nodes'],
        'connections': wf['connections'],
        'settings': settings,
    }).encode()
    req = urllib.request.Request(
        f'{N8N_API}/api/v1/workflows/{WF_ID}',
        data=body,
        headers={
            'X-N8N-API-KEY': API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'curl/8.0',
        },
        method='PUT',
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        print(f'PUT {e.code}: {body[:1000]}')
        raise


def deactivate():
    req = urllib.request.Request(
        f'{N8N_API}/api/v1/workflows/{WF_ID}/deactivate',
        headers={'X-N8N-API-KEY': API_KEY, 'Accept': 'application/json', 'User-Agent': 'curl/8.0', 'Content-Length': '0'},
        method='POST',
        data=b'',
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        print(f'deactivate {e.code}: {body[:500]}')
        raise


def activate():
    req = urllib.request.Request(
        f'{N8N_API}/api/v1/workflows/{WF_ID}/activate',
        headers={'X-N8N-API-KEY': API_KEY, 'Accept': 'application/json', 'User-Agent': 'curl/8.0', 'Content-Length': '0'},
        method='POST',
        data=b'',
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        print(f'activate {e.code}: {body[:500]}')
        raise


# ---------------------------------------------------------------------------
# Node templates

def new_uuid():
    return str(uuid.uuid4())


def emit_node(name, stage, detail_expr, position):
    """HTTP Request v4.2 emit_stage_* node template.

    All emit nodes are identical except for name, stage literal, detail
    expression, and position. onError=continueRegularOutput so a failed
    callback never kills the run.
    """
    body_obj = (
        '{\n'
        '  "userId":      "+14105914612",\n'
        f'  "executionId": "{{{{ $execution.id }}}}",\n'
        '  "editionId":   "{{ $(\'set_trigger_inputs\').item.json[\'Edition Id\'] || \'ai-news\' }}",\n'
        f'  "stage":       "{stage}",\n'
        f'  "detail":      "{{{{ {detail_expr} }}}}",\n'
        '  "ts":          "{{ $now.toISO() }}"\n'
        '}'
    )
    return {
        'parameters': {
            'method': 'POST',
            'url': f'{WORKBENCH_BASE}/api/callback/newsletter-stage',
            'authentication': 'genericCredentialType',
            'genericAuthType': 'httpHeaderAuth',
            'sendHeaders': True,
            'headerParameters': {
                'parameters': [
                    {'name': 'Content-Type', 'value': 'application/json'},
                ],
            },
            'sendBody': True,
            'specifyBody': 'json',
            'jsonBody': '=' + body_obj,
            'options': {},
        },
        'id': new_uuid(),
        'name': name,
        'type': 'n8n-nodes-base.httpRequest',
        'typeVersion': 4.2,
        'position': position,
        'onError': 'continueRegularOutput',
        'credentials': {
            'httpHeaderAuth': {
                'id': CALLBACK_CRED_ID,
                'name': CALLBACK_CRED_NAME,
            },
        },
    }


def main():
    wf = get_wf()
    nodes = wf['nodes']
    conns = wf['connections']

    name_to_node = {n['name']: n for n in nodes}

    # ----- 1. Edit form_trigger: add Edition Id field -----
    ft = name_to_node['form_trigger']
    field_values = ft['parameters']['formFields']['values']
    if not any(f.get('fieldLabel') == 'Edition Id' for f in field_values):
        field_values.append({
            'fieldLabel': 'Edition Id',
            'placeholder': 'ai-news',
        })

    # ----- 2. webhook_trigger -----
    webhook = {
        'parameters': {
            'httpMethod': 'POST',
            'path': 'compose-newsletter-dev',
            'responseMode': 'responseNode',
            'authentication': 'headerAuth',
            'options': {},
        },
        'id': new_uuid(),
        'name': 'webhook_trigger',
        'type': 'n8n-nodes-base.webhook',
        'typeVersion': 2.1,
        'position': [-224, 320],
        'webhookId': new_uuid(),
        'credentials': {
            'httpHeaderAuth': {
                'id': INGESTION_CRED_ID,
                'name': INGESTION_CRED_NAME,
            },
        },
    }

    # ----- 3. respond_to_webhook -----
    respond = {
        'parameters': {
            'respondWith': 'json',
            'responseBody':
                '={\n'
                '  "executionId": "{{ $execution.id }}",\n'
                '  "editionId":   "{{ $json.body[\'Edition Id\'] || \'ai-news\' }}"\n'
                '}',
            'options': {'responseCode': 200},
        },
        'id': new_uuid(),
        'name': 'respond_to_webhook',
        'type': 'n8n-nodes-base.respondToWebhook',
        'typeVersion': 1.5,
        'position': [-32, 320],
    }

    # ----- 4. set_trigger_inputs -----
    set_ti = {
        'parameters': {
            'mode': 'manual',
            'duplicateItem': False,
            'assignments': {
                'assignments': [
                    {
                        'id': new_uuid(),
                        'name': 'Date',
                        'value': "={{ $json.body?.Date ?? $json.Date }}",
                        'type': 'string',
                    },
                    {
                        'id': new_uuid(),
                        'name': 'Previous Newsletter Content',
                        'value':
                            "={{ $json.body?.['Previous Newsletter Content'] "
                            "?? $json['Previous Newsletter Content'] ?? '' }}",
                        'type': 'string',
                    },
                    {
                        'id': new_uuid(),
                        'name': 'Edition Id',
                        'value':
                            "={{ $json.body?.['Edition Id'] "
                            "?? $json['Edition Id'] ?? 'ai-news' }}",
                        'type': 'string',
                    },
                ],
            },
            'includeOtherFields': False,
            'options': {},
        },
        'id': new_uuid(),
        'name': 'set_trigger_inputs',
        'type': 'n8n-nodes-base.set',
        'typeVersion': 3.4,
        'position': [128, 200],
    }

    # ----- 5. 9 emit_stage_* nodes -----
    # detail expressions per spec
    emit_specs = [
        ('emit_stage_gathering',          'gathering',                 "'started ingestion search'",                                                                                  [304, 80]),
        ('emit_stage_picking',            'selecting_stories',         "'picked ' + $json.output.top_selected_stories.length + ' stories'",                                           [400, 1000]),
        ('emit_stage_awaiting_stories',   'awaiting_stories_approval', "'approval token ' + $json.token",                                                                             [1376, 1000]),
        ('emit_stage_stories_approved',   'stories_approved',          "'writing subject line'",                                                                                      [1888, 1000]),
        ('emit_stage_awaiting_subject',   'awaiting_subject_approval', "'approval token ' + $json.token",                                                                             [3904, 980]),
        ('emit_stage_subject_approved',   'subject_approved',          "'writing segments'",                                                                                          [4736, 960]),
        ('emit_stage_writing_segment',    'writing_segment',           "'segment ' + ($runIndex + 1)",                                                                                [4960, 2440]),
        ('emit_stage_segments_done',      'segments_done',             "'assembling final'",                                                                                          [4960, 1944]),
        ('emit_stage_saved',              'saved',                     "'issue scheduled ' + $json.scheduled_send_at",                                                                [2336, 3464]),
    ]

    candidate_new = [webhook, respond, set_ti]
    for name, stage, detail, pos in emit_specs:
        candidate_new.append(emit_node(name, stage, detail, pos))

    # Idempotency: only append nodes whose name isn't already present.
    # Re-runs after partial failure must not double up the structure.
    existing = set(name_to_node.keys())
    new_nodes = [n for n in candidate_new if n['name'] not in existing]
    skipped = [n['name'] for n in candidate_new if n['name'] in existing]
    if skipped:
        print(f'  [idempotent] skipping already-present: {skipped}')

    nodes.extend(new_nodes)

    # ----- 6. Rewire connections -----
    # form_trigger now feeds set_trigger_inputs (was: search_markdown_objects)
    conns['form_trigger'] = {'main': [[{'node': 'set_trigger_inputs', 'type': 'main', 'index': 0}]]}

    # webhook_trigger → respond_to_webhook
    conns['webhook_trigger'] = {'main': [[{'node': 'respond_to_webhook', 'type': 'main', 'index': 0}]]}

    # respond_to_webhook → set_trigger_inputs
    conns['respond_to_webhook'] = {'main': [[{'node': 'set_trigger_inputs', 'type': 'main', 'index': 0}]]}

    # set_trigger_inputs → search_markdown_objects + emit_stage_gathering (parallel)
    conns['set_trigger_inputs'] = {'main': [[
        {'node': 'search_markdown_objects', 'type': 'main', 'index': 0},
        {'node': 'emit_stage_gathering',    'type': 'main', 'index': 0},
    ]]}

    # Insert each emit node BETWEEN anchor and its current downstream
    def splice_after(anchor, branch_index, emit_name):
        """Replace anchor.main[branch_index] with [emit, ...prev_targets] keeping execution flow.

        We splice the emit node AS A SIBLING of the original downstream so the
        emit fires in parallel — the original main path continues unchanged. This
        matches the intent of stage emits: never block or alter the product path.
        """
        existing = conns.get(anchor, {}).get('main', [])
        while len(existing) <= branch_index:
            existing.append([])
        existing[branch_index].append({'node': emit_name, 'type': 'main', 'index': 0})
        conns.setdefault(anchor, {})['main'] = existing

    splice_after('pick_top_stories',              0, 'emit_stage_picking')
    splice_after('create_approval_stories',       0, 'emit_stage_awaiting_stories')
    splice_after('check_stories_feedback',        0, 'emit_stage_stories_approved')   # TRUE branch
    splice_after('create_approval_subject_line',  0, 'emit_stage_awaiting_subject')
    splice_after('check_subject_line_feedback',   0, 'emit_stage_subject_approved')   # TRUE branch
    splice_after('set_story_segment',             0, 'emit_stage_writing_segment')
    splice_after('set_combined_sections_content', 0, 'emit_stage_segments_done')
    splice_after('save_scheduled_newsletter',     0, 'emit_stage_saved')

    # ----- 7. Sanity guardrails -----
    node_names = {n['name'] for n in nodes}
    required = {'form_trigger', 'webhook_trigger', 'respond_to_webhook', 'set_trigger_inputs',
                'pick_top_stories', 'create_approval_stories', 'check_stories_feedback',
                'create_approval_subject_line', 'check_subject_line_feedback', 'set_story_segment',
                'set_combined_sections_content', 'save_scheduled_newsletter',
                'emit_stage_gathering', 'emit_stage_picking', 'emit_stage_awaiting_stories',
                'emit_stage_stories_approved', 'emit_stage_awaiting_subject',
                'emit_stage_subject_approved', 'emit_stage_writing_segment',
                'emit_stage_segments_done', 'emit_stage_saved'}
    missing = required - node_names
    if missing:
        print(f'ABORT — missing required nodes: {sorted(missing)}')
        sys.exit(1)
    if len(nodes) < 95:
        print(f'ABORT — sanity check failed: only {len(nodes)} nodes, expected ~99')
        sys.exit(1)

    # ----- 8. PUT -----
    print(f'PUTting workflow: {len(nodes)} nodes (was 87, +{len(nodes) - 87})')
    json.dump(wf, open('/tmp/wf-rewritten.json', 'w'), indent=2)

    if '--dry-run' in sys.argv:
        print('--dry-run: skipping PUT/activate')
        return

    # NOTE: this n8n instance forbids /activate and /deactivate via API
    # (returns 403 "Forbidden" — likely a license/scope restriction).
    # The PUT endpoint IS allowed, so we just push the new structure;
    # activeVersion snapshot may need a manual deactivate→activate via the
    # n8n UI for the new webhook trigger to register. Smoke test will
    # confirm whether that's needed.
    print('PUTting (skipping activate/deactivate — forbidden via API)...')
    res = put_wf(wf)
    print('PUT ok. active:', res.get('active'))
    print('done')


if __name__ == '__main__':
    main()
