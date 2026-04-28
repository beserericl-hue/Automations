#!/usr/bin/env python3
"""
Sprint 11 migration: replace Gmail send nodes with HTTP Request calls to
the Writer's Workbench /api/email/send endpoint (which fans out to Postal).

Operates on DEV - ... workflows only per Sprint 10.a governance.

Behavior:
  - Fetches each target workflow via n8n API.
  - Finds nodes where type == 'n8n-nodes-base.gmail'.
  - Constructs an equivalent HTTP Request node (type n8n-nodes-base.httpRequest
    v4.2), preserving the node's id/name/position so existing connections
    keep working.
  - Preserves to/subject/html/bcc field expressions verbatim.
  - Drops the Gmail credential reference.
  - Deactivates and re-activates the workflow so n8n rebuilds activeVersion.

Requires env:
  N8N_API_KEY  — admin key for the n8n API

Usage:
  python3 scripts/s11-migrate-gmail-to-postal.py <workflow-id>
  python3 scripts/s11-migrate-gmail-to-postal.py --all-s11-1
  python3 scripts/s11-migrate-gmail-to-postal.py --dry-run <workflow-id>
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin
from urllib.request import Request, urlopen

N8N_BASE = "https://n8n.agileadautomation.com"

# DEV Workbench public URL (used in the rewritten node body).
# Prod promotion step swaps this to the prod Workbench URL.
DEV_WORKBENCH_URL = "https://writersworkbenchdev-production.up.railway.app"
EMAIL_SEND_PATH = "/api/email/send"

# Shared secret between Workbench and n8n. Matches EMAIL_SECRET env var on
# the Workbench service. Read from env so source stays secret-free.
EMAIL_SECRET = os.environ.get("DEV_WORKBENCH_EMAIL_SECRET", "")

WORKFLOW_ID_MAP = {
    # S11-1 — writing tools (6)
    "DEV - Tool - Write Blog Post": "tb4pvwzdHmnBXuPO",
    "DEV - Tool - Write Chapter": "BH4hSN4KPmY0ZGgX",
    "DEV - Tool - Write Short Story": "7DDQM65ZVJ2MqmL2",
    "DEV - Tool - Write Newsletter": "oy8nhCED3njbCep4",
    "DEV - Tool - Brainstorm Story": "G91K85MhwA7Ws9Xh",
    "DEV - Tool - Brainstorm Chapter": "idUcNunGWJX0h5Xu",
    # S11-2 — utility (6) — error notifier lives inside Worker - Write Chapter
    "DEV - Tool - QA Chapter": "Z3M57QWR8FCU3Omb",
    "DEV - Tool - Edit Outline": "PRk9abQLls91rLyQ",
    "DEV - Sub - Manage Library": "uZ4X1OApVdAVwY2R",
    "DEV - 17 Cron: Scheduled Publisher": "rI1UIx7Zjqh04dS0",
    "DEV - Sub - Manage Research Reports": "7n1Fdy7JEqTyziJx",
    "DEV - Worker - Write Chapter": "fsKRGkzphWT62rja",
    # S11-3 — image/social/kindle/research email (4)
    "DEV - Tool - Generate Cover Art": "0sQWPO5fsxnXyiWR",
    "DEV - Tool - Repurpose to Social Posts": "XDZdLA2SxvJJtBnW",
    "DEV - Tool - Format Kindle Book": "wiOuQprPM0GNZE5V",
    "DEV - Tool - Email Research Report": "SXKJ3jn4oLUWwAn4",
}

S11_GROUPS = {
    "s11-1": [
        "DEV - Tool - Write Blog Post",
        "DEV - Tool - Write Chapter",
        "DEV - Tool - Write Short Story",
        "DEV - Tool - Write Newsletter",
        "DEV - Tool - Brainstorm Story",
        "DEV - Tool - Brainstorm Chapter",
    ],
    "s11-2": [
        "DEV - Tool - QA Chapter",
        "DEV - Tool - Edit Outline",
        "DEV - Sub - Manage Library",
        "DEV - 17 Cron: Scheduled Publisher",
        "DEV - Sub - Manage Research Reports",
        "DEV - Worker - Write Chapter",
    ],
    "s11-3": [
        "DEV - Tool - Generate Cover Art",
        "DEV - Tool - Repurpose to Social Posts",
        "DEV - Tool - Format Kindle Book",
        "DEV - Tool - Email Research Report",
    ],
}


@dataclass
class MigrationReport:
    workflow_id: str
    workflow_name: str
    gmail_nodes_found: int
    gmail_nodes_replaced: int
    nodes_with_attachments: list[str]
    note: str = ""


UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"


def _headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    h = {
        "X-N8N-API-KEY": os.environ["N8N_API_KEY"],
        "User-Agent": UA,
        "Accept": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def api_get_workflow(workflow_id: str) -> dict[str, Any]:
    req = Request(
        urljoin(N8N_BASE, f"/api/v1/workflows/{workflow_id}"),
        headers=_headers(),
    )
    with urlopen(req) as resp:
        return json.loads(resp.read())


def api_put_workflow(workflow_id: str, body: dict[str, Any]) -> dict[str, Any]:
    # n8n PUT rejects unknown keys. Strip to the allow-list per MEMORY.
    allowed = {"name", "nodes", "connections", "settings"}
    clean = {k: v for k, v in body.items() if k in allowed}
    req = Request(
        urljoin(N8N_BASE, f"/api/v1/workflows/{workflow_id}"),
        data=json.dumps(clean).encode(),
        method="PUT",
        headers=_headers({"Content-Type": "application/json"}),
    )
    try:
        with urlopen(req) as resp:
            return json.loads(resp.read())
    except Exception as e:
        # Surface server error body for debugging
        body_text = ""
        try:
            body_text = e.read().decode("utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
        raise RuntimeError(f"{e}  |  server body: {body_text[:500]}")


def api_toggle_active(workflow_id: str, active: bool) -> None:
    path = f"/api/v1/workflows/{workflow_id}/{'activate' if active else 'deactivate'}"
    req = Request(
        urljoin(N8N_BASE, path),
        method="POST",
        headers=_headers(),
    )
    with urlopen(req) as resp:
        resp.read()


def gmail_extract_fields(gmail_node: dict[str, Any]) -> dict[str, str]:
    p = gmail_node.get("parameters", {})
    opts = p.get("options") or {}
    return {
        "to": p.get("sendTo", ""),
        "subject": p.get("subject", ""),
        "html": p.get("message", ""),
        "bcc": opts.get("bccList", ""),
        "cc": opts.get("ccList", ""),
    }


def has_attachments(gmail_node: dict[str, Any]) -> bool:
    opts = gmail_node.get("parameters", {}).get("options") or {}
    atts = opts.get("attachmentsUi") or opts.get("attachments") or {}
    if isinstance(atts, dict):
        v = atts.get("attachmentsBinary") or atts.get("attachmentsValues")
        return bool(v)
    return bool(atts)


def n8n_template_to_js(expr: str) -> str:
    """Convert an n8n template expression (starting with '=' and containing
    zero or more {{ ... }} blocks) into a JavaScript expression that can
    be dropped into a JSON.stringify({...}) call.

    Examples:
      "={{ $('x').item.json.y }}" → "$('x').item.json.y"
      "=Blog Draft: {{ title }}"  → "`Blog Draft: ${title}`"
      "literal plain string"      → '"literal plain string"'
    """
    if not expr:
        return "''"
    if not expr.startswith('='):
        return json.dumps(expr)

    body = expr[1:]

    # Whole value is a single {{ }} block → return the inner JS
    single = re.match(r'^\s*\{\{\s*(.*?)\s*\}\}\s*$', body, re.DOTALL)
    if single:
        return single.group(1).strip()

    # Otherwise build a backtick template literal, converting {{ X }} → ${X}
    def escape_literal(s: str) -> str:
        # Order matters — escape backslashes first, then backticks and ${.
        return s.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')

    out: list[str] = []
    i = 0
    for m in re.finditer(r'\{\{\s*(.*?)\s*\}\}', body, re.DOTALL):
        out.append(escape_literal(body[i:m.start()]))
        out.append('${' + m.group(1).strip() + '}')
        i = m.end()
    out.append(escape_literal(body[i:]))
    return '`' + ''.join(out) + '`'


def build_http_request_node(gmail_node: dict[str, Any]) -> dict[str, Any]:
    """Return a node dict that replaces the Gmail node in-place. Same id,
    same name, same position — so existing connections still resolve.

    The HTTP Request body is a single n8n expression that evaluates to a
    JSON string at runtime, via JSON.stringify. This lets us preserve the
    Gmail node's original template expressions (for to / subject / html /
    bcc) without losing their interpolation semantics."""
    fields = gmail_extract_fields(gmail_node)

    body_parts: list[str] = [
        f"to: {n8n_template_to_js(fields['to'])}",
        f"subject: {n8n_template_to_js(fields['subject'])}",
        f"html: {n8n_template_to_js(fields['html'])}",
    ]
    # bcc/cc are optional — wrap in `|| undefined` so empty string becomes
    # undefined, which JSON.stringify drops from the body. Keeps the
    # Workbench email-format validator happy (empty string fails).
    if fields['bcc']:
        body_parts.append(f"bcc: ({n8n_template_to_js(fields['bcc'])}) || undefined")
    if fields['cc']:
        body_parts.append(f"cc: ({n8n_template_to_js(fields['cc'])}) || undefined")

    json_expr = (
        "={{ JSON.stringify({ " + ", ".join(body_parts) + " }) }}"
    )

    params = {
        "method": "POST",
        "url": f"{DEV_WORKBENCH_URL}{EMAIL_SEND_PATH}",
        "sendHeaders": True,
        "headerParameters": {
            "parameters": [
                {"name": "X-Email-Secret", "value": EMAIL_SECRET},
                {"name": "Content-Type", "value": "application/json"},
            ]
        },
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": json_expr,
        "options": {},
    }

    new_node: dict[str, Any] = {
        "id": gmail_node["id"],
        "name": gmail_node["name"],
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": gmail_node["position"],
        "parameters": params,
    }
    for k in ("disabled", "notesInFlow", "notes"):
        if k in gmail_node:
            new_node[k] = gmail_node[k]
    return new_node


def is_already_migrated_node(n: dict[str, Any]) -> bool:
    """True if this node looks like an HTTP Request pointing at our
    /api/email/send endpoint — i.e., a previous run already converted it."""
    if n.get("type") != "n8n-nodes-base.httpRequest":
        return False
    url = n.get("parameters", {}).get("url", "")
    return "/api/email/send" in url


def fake_gmail_from_migrated(n: dict[str, Any]) -> dict[str, Any] | None:
    """Reconstruct a Gmail-shaped node from an already-migrated HTTP
    Request node so build_http_request_node can re-run against it.

    The previous run stored the fields as n8n template strings inside a
    literal JSON body. Parse that back out."""
    p = n.get("parameters", {})
    raw = p.get("jsonBody")
    if not isinstance(raw, str):
        return None
    # Two shapes the previous runs may have produced:
    # 1) literal JSON (from the first, broken pass)
    # 2) an n8n expression (from the second, fixed pass) — we skip these.
    if raw.strip().startswith("="):
        return None
    try:
        body = json.loads(raw)
    except Exception:
        return None

    params: dict[str, Any] = {}
    params["sendTo"] = body.get("to", "")
    params["subject"] = body.get("subject", "")
    params["message"] = body.get("html", "")
    options: dict[str, Any] = {}
    if body.get("bcc"):
        options["bccList"] = body["bcc"]
    if body.get("cc"):
        options["ccList"] = body["cc"]
    if options:
        params["options"] = options

    out = {
        "id": n["id"],
        "name": n["name"],
        "position": n["position"],
        "parameters": params,
    }
    if isinstance(n.get("disabled"), bool):
        out["disabled"] = n["disabled"]
    return out


def migrate_workflow(workflow_id: str, dry_run: bool) -> MigrationReport:
    wf = api_get_workflow(workflow_id)
    name = wf.get("name", "?")

    gmail_nodes = [n for n in wf["nodes"] if n.get("type") == "n8n-nodes-base.gmail"]
    migrated_with_broken_body = [n for n in wf["nodes"] if is_already_migrated_node(n) and fake_gmail_from_migrated(n) is not None]
    with_attachments = [n["name"] for n in gmail_nodes if has_attachments(n)]

    if not gmail_nodes and not migrated_with_broken_body:
        return MigrationReport(workflow_id, name, 0, 0, [], note="no Gmail nodes or broken HTTP nodes found")

    replaced = 0
    new_nodes: list[dict[str, Any]] = []
    for n in wf["nodes"]:
        if n.get("type") == "n8n-nodes-base.gmail":
            new_nodes.append(build_http_request_node(n))
            replaced += 1
        elif is_already_migrated_node(n):
            fake = fake_gmail_from_migrated(n)
            if fake is not None:
                new_nodes.append(build_http_request_node(fake))
                replaced += 1
            else:
                new_nodes.append(n)
        else:
            new_nodes.append(n)

    wf["nodes"] = new_nodes

    if dry_run:
        return MigrationReport(
            workflow_id, name, len(gmail_nodes), replaced, with_attachments, note="dry-run"
        )

    api_put_workflow(workflow_id, wf)
    was_active = wf.get("active", False)
    if was_active:
        try:
            api_toggle_active(workflow_id, False)
        except Exception:
            pass
        api_toggle_active(workflow_id, True)

    return MigrationReport(workflow_id, name, len(gmail_nodes), replaced, with_attachments)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("workflow_id", nargs="?")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--group", choices=sorted(S11_GROUPS.keys()))
    args = parser.parse_args()

    if not os.environ.get("N8N_API_KEY"):
        print("ERROR: N8N_API_KEY env var required", file=sys.stderr)
        return 2
    if not EMAIL_SECRET:
        print(
            "ERROR: DEV_WORKBENCH_EMAIL_SECRET env var required — script writes it "
            "into the X-Email-Secret header of migrated HTTP Request nodes.",
            file=sys.stderr,
        )
        return 2

    ids: list[str] = []
    if args.group:
        ids = [WORKFLOW_ID_MAP[name] for name in S11_GROUPS[args.group]]
    elif args.workflow_id:
        ids = [args.workflow_id]
    else:
        parser.error("provide a workflow_id or --group")
        return 2

    for wf_id in ids:
        try:
            r = migrate_workflow(wf_id, dry_run=args.dry_run)
        except Exception as e:
            print(f"[FAIL] {wf_id}: {e}")
            continue
        att_note = f" (ATTACHMENTS in: {r.nodes_with_attachments})" if r.nodes_with_attachments else ""
        note = f" — {r.note}" if r.note else ""
        print(f"[OK]   {r.workflow_id}  {r.workflow_name:50s}  gmail={r.gmail_nodes_found} replaced={r.gmail_nodes_replaced}{att_note}{note}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
