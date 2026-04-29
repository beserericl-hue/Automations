"""
Issue #63 — Wire `Content - Newsletter Agent V2` into the new
/api/newsletter/render-html endpoint so the rendered email actually uses
the Course Worx Workbench template instead of `<pre>markdown</pre>`.

Idempotent: re-runs skip nodes already present by name.

Usage:
    export N8N_API_KEY=$(jq -r '.mcpServers["n8n-mcp"].env.N8N_API_KEY' .mcp.json)
    python3 scripts/issue-63-render-html-swap.py             # apply
    python3 scripts/issue-63-render-html-swap.py --dry-run   # write JSON only

After this script PUTs the structure, the runtime needs a Publish action
in the n8n UI (per memory file feedback_n8n_2x_publish_flow.md):

  1. Open https://n8n.agileadautomation.com/workflow/bMvMKyK8obwYZmNb
  2. Refresh the workflow tab (Cmd-R) so the editor reloads from DB
  3. Top-right Published dropdown enables → click Publish (⌘P)
  4. The runtime activeVersion cache refreshes; new node fires on next run

What this script changes
========================

1. Adds one new HTTP Request node `render_html_template`:
   - POST https://writersworkbenchdev-production.up.railway.app/api/newsletter/render-html
   - Auth: httpHeaderAuth via existing `DEV Workbench Ingestion Secret`
     credential (id jQBRJbmiUeTk8c11)
   - Body: edition_id from set_trigger_inputs + structured data including
     `body_md` (the AI-produced markdown) which the template renders via
     the markdown_to_html helper added in PR #62 + migration 015.
   - onError: continueRegularOutput — never block the run on a render
     failure. save_scheduled_newsletter falls back to the existing
     `<pre>markdown</pre>` html_body if rendering didn't produce output.

2. Rewires the edge feeding save_scheduled_newsletter:
       Before: share_newsletter_msg_email → save_scheduled_newsletter
       After:  share_newsletter_msg_email → render_html_template → save_scheduled_newsletter

3. Updates save_scheduled_newsletter's jsonBody so html_body is sourced
   from $('render_html_template').item.json.html when present, with the
   pre-existing inline html_body as a fallback.

Total nodes 99 → 100 after PUT. Schema-governance unaffected (n8n only).
"""

import json
import os
import sys
import urllib.request
import urllib.error
import uuid as uuid_lib


N8N_API = 'https://n8n.agileadautomation.com'
WF_ID = 'bMvMKyK8obwYZmNb'
INGESTION_CRED_ID = 'jQBRJbmiUeTk8c11'
INGESTION_CRED_NAME = 'DEV Workbench Ingestion Secret'
WORKBENCH_BASE = 'https://writersworkbenchdev-production.up.railway.app'

API_KEY = os.environ['N8N_API_KEY']
HEADERS = {
    'X-N8N-API-KEY': API_KEY,
    'Accept': 'application/json',
    'User-Agent': 'curl/8.0',
}


def get_wf():
    req = urllib.request.Request(
        f'{N8N_API}/api/v1/workflows/{WF_ID}',
        headers=HEADERS,
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def put_wf(wf):
    src_settings = wf.get('settings') or {}
    allowed_settings = {
        'executionOrder', 'callerPolicy', 'saveDataErrorExecution',
        'saveDataSuccessExecution', 'saveExecutionProgress',
        'saveManualExecutions', 'timezone', 'errorWorkflow',
    }
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
        headers={**HEADERS, 'Content-Type': 'application/json'},
        method='PUT',
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        print(f'PUT {e.code}: {body[:1000]}')
        raise


# ---------------------------------------------------------------------------
# Node template

def render_html_template_node(position):
    """HTTP Request v4.2 node POSTing to /api/newsletter/render-html.

    The body picks up data from existing nodes: subject_line and pre_header
    from set_selected_stories, intro markdown from write_intro, full
    markdown body from set_full_newsletter, edition slug from
    set_trigger_inputs (default 'ai-news'), date from set_trigger_inputs.
    Everything else is left null so the template falls back to its
    sample_data — except markdown body, which is the workhorse.
    """
    body_obj = (
        '{\n'
        '  "edition_id": "{{ $(\'set_trigger_inputs\').item.json[\'Edition Id\'] || \'ai-news\' }}",\n'
        '  "data": {\n'
        '    "title":            "{{ $(\'set_selected_stories\').item.json.subject_line }}",\n'
        '    "preheader":        "{{ $(\'set_selected_stories\').item.json.pre_header_text }}",\n'
        '    "issue": {\n'
        '      "date": "{{ DateTime.fromISO(new Date($(\'set_trigger_inputs\').item.json.Date).toISOString()).toFormat(\'EEEE, LLLL d, yyyy\') }}"\n'
        '    },\n'
        '    "body_md":          {{ JSON.stringify($(\'set_full_newsletter\').item.json.full_newsletter_content) }},\n'
        '    "lead":             null,\n'
        '    "sponsor":          null,\n'
        '    "pull_quote":       null,\n'
        '    "trending":         null,\n'
        '    "workbench_section": null,\n'
        '    "signoff": {\n'
        '      "signature_name": "Eric",\n'
        '      "role": "Editor, The Workbench"\n'
        '    }\n'
        '  }\n'
        '}'
    )
    return {
        'parameters': {
            'method': 'POST',
            'url': f'{WORKBENCH_BASE}/api/newsletter/render-html',
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
        'id': str(uuid_lib.uuid4()),
        'name': 'render_html_template',
        'type': 'n8n-nodes-base.httpRequest',
        'typeVersion': 4.2,
        'position': position,
        'onError': 'continueRegularOutput',
        'credentials': {
            'httpHeaderAuth': {
                'id': INGESTION_CRED_ID,
                'name': INGESTION_CRED_NAME,
            },
        },
    }


def patch_save_scheduled_newsletter_body(node):
    """Update the jsonBody so html_body uses render_html_template when
    present, with the existing inline `<pre>` form as a fallback. Idempotent —
    if the body already contains the render reference, leave it alone.
    """
    body = node['parameters'].get('jsonBody', '')
    if "$('render_html_template').item.json.html" in body:
        return False  # already patched
    # The existing body line we're replacing:
    # html_body: '<pre>' + ($('set_full_newsletter').item.json.full_newsletter_content || '') + '</pre>',
    new_html_body = (
        "html_body: ($('render_html_template').item && $('render_html_template').item.json && $('render_html_template').item.json.html)"
        " || ('<pre>' + ($('set_full_newsletter').item.json.full_newsletter_content || '') + '</pre>'),"
    )
    old_html_body_marker = "html_body: '<pre>' + ($('set_full_newsletter').item.json.full_newsletter_content || '') + '</pre>',"
    if old_html_body_marker not in body:
        raise RuntimeError(
            'save_scheduled_newsletter jsonBody does not contain the expected '
            'html_body line. Manual review needed before patching.'
        )
    node['parameters']['jsonBody'] = body.replace(old_html_body_marker, new_html_body)
    return True


def main():
    wf = get_wf()
    nodes = wf['nodes']
    conns = wf['connections']
    name_to_node = {n['name']: n for n in nodes}

    # 1. Add render_html_template if absent.
    if 'render_html_template' in name_to_node:
        print('  [idempotent] render_html_template already present — skipping insert')
        new_node_added = False
    else:
        # Place to the right of share_newsletter_msg_email so the new edge
        # is visually obvious in the editor.
        sender = name_to_node.get('share_newsletter_msg_email')
        anchor_pos = sender['position'] if sender else [2400, 3312]
        position = [anchor_pos[0] + 240, anchor_pos[1]]
        nodes.append(render_html_template_node(position))
        new_node_added = True
        print(f'  [+] added render_html_template at {position}')

    # 2. Rewire share_newsletter_msg_email → render_html_template → save_scheduled_newsletter
    sender_conns = conns.get('share_newsletter_msg_email', {})
    sender_main = sender_conns.get('main', [])
    while len(sender_main) < 1:
        sender_main.append([])
    branch = sender_main[0]
    feeds_save_directly = any(t.get('node') == 'save_scheduled_newsletter' for t in branch)
    feeds_render = any(t.get('node') == 'render_html_template' for t in branch)
    if feeds_save_directly and not feeds_render:
        # Replace save_scheduled_newsletter target with render_html_template.
        sender_main[0] = [
            t for t in branch if t.get('node') != 'save_scheduled_newsletter'
        ] + [{'node': 'render_html_template', 'type': 'main', 'index': 0}]
        sender_conns['main'] = sender_main
        conns['share_newsletter_msg_email'] = sender_conns
        print('  [edge] share_newsletter_msg_email now feeds render_html_template (was save_scheduled_newsletter)')
    elif feeds_render:
        print('  [idempotent] share_newsletter_msg_email already feeds render_html_template — skipping rewire')
    else:
        print('  [warn] share_newsletter_msg_email did not feed save_scheduled_newsletter directly; leaving edges alone')

    render_conns = conns.get('render_html_template', {'main': [[]]})
    render_main = render_conns.get('main', [[]])
    if not render_main:
        render_main = [[]]
    if not any(t.get('node') == 'save_scheduled_newsletter' for t in render_main[0]):
        render_main[0].append({'node': 'save_scheduled_newsletter', 'type': 'main', 'index': 0})
        render_conns['main'] = render_main
        conns['render_html_template'] = render_conns
        print('  [edge] render_html_template → save_scheduled_newsletter wired')
    else:
        print('  [idempotent] render_html_template already feeds save_scheduled_newsletter')

    # 3. Patch save_scheduled_newsletter jsonBody.
    save_node = name_to_node.get('save_scheduled_newsletter')
    if not save_node:
        print('ABORT — save_scheduled_newsletter node not found')
        sys.exit(1)
    body_patched = patch_save_scheduled_newsletter_body(save_node)
    if body_patched:
        print('  [patched] save_scheduled_newsletter jsonBody now uses render_html_template.html with <pre> fallback')
    else:
        print('  [idempotent] save_scheduled_newsletter jsonBody already references render_html_template')

    # Sanity guardrail
    final_names = {n['name'] for n in nodes}
    if 'render_html_template' not in final_names:
        print('ABORT — render_html_template not in workflow after edits')
        sys.exit(1)
    if len(nodes) < 99:
        print(f'ABORT — only {len(nodes)} nodes after edits (expected ≥99)')
        sys.exit(1)

    print(f'Final node count: {len(nodes)} (was 99; +1 if new_node_added={new_node_added})')

    json.dump(wf, open('/tmp/wf-issue-63.json', 'w'), indent=2)

    if '--dry-run' in sys.argv:
        print('--dry-run: skipping PUT')
        return

    print('PUTting...')
    put_wf(wf)
    print('PUT ok.')
    print('')
    print('=== OPERATOR STEP ===')
    print('1. Open https://n8n.agileadautomation.com/workflow/bMvMKyK8obwYZmNb')
    print('2. Refresh the tab (Cmd-R)')
    print('3. Top-right Published dropdown → Publish (or ⌘P)')
    print('4. Tell me when done and I run the live smoke test')


if __name__ == '__main__':
    main()
