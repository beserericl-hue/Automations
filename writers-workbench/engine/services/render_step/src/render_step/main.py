"""render-svc — render the edition's branded Handlebars template via the Workbench renderer.

The template (``newsletter_templates_v2``) is what defines the newsletter's look — masthead, lead,
sponsor, trending, footer — and it is a Handlebars template with helpers (``markdown_to_html``,
``rank``, ``format_date``) that only the Workbench ``/api/newsletter/render-html`` endpoint can
render. So render-svc POSTs the assembled content there (the same server-to-server contract the n8n
send path uses) and uses the returned HTML. The decorative sample sections (lead/sponsor/pull_quote/
trending/workbench_section) are sent as ``null`` so the template hides them instead of showing its
``sample_data`` placeholders — that is why an edition with no sponsor renders no sponsor block.

A built-in Playfair-Display fallback template is used only when the Workbench renderer is not
configured/reachable, so the engine still boots and renders in local/dev without WW.
"""

from __future__ import annotations

import datetime as _dt
from string import Template
from typing import Any

import httpx

from writer_engine.config import get_settings
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.schemas.newsletter import RenderedNewsletter
from writer_engine.step_service import build_step_app

STEP_NAME = "render"

DEFAULT_TEMPLATE = Template(
    """<!doctype html>
<html><head>
<meta charset="utf-8">
<title>$subject</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>
body { font-family: Inter, system-ui, sans-serif; max-width: 680px; margin: 0 auto; color: #1a1a1a; padding: 24px; }
.masthead { font-family: 'Playfair Display', serif; font-weight: 700; font-size: 38px; border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 24px; }
.preheader { color: #555; font-size: 14px; margin-bottom: 18px; }
img { max-width: 100%; height: auto; }
.permalink { color: #555; font-size: 12px; margin-top: 32px; }
</style></head>
<body>
<div class="masthead">$masthead</div>
<div class="preheader">$preheader</div>
$body
<div class="permalink">Read on web: $permalink_url</div>
</body></html>
"""
)


def _markdown_to_html(md: str) -> str:
    """Minimal markdown → HTML (headings, paragraphs, images). Good enough for F0 fixtures and real Jinja later."""
    out: list[str] = []
    for line in md.split("\n"):
        line = line.rstrip()
        if not line:
            out.append("")
            continue
        if line.startswith("## "):
            out.append(f"<h2>{line[3:]}</h2>")
        elif line.startswith("# "):
            out.append(f"<h1>{line[2:]}</h1>")
        elif line.startswith("- "):
            out.append(f"<li>{line[2:]}</li>")
        elif line.startswith("![]("):
            url = line[4:].rstrip(")")
            out.append(f'<img src="{url}" alt="">')
        else:
            out.append(f"<p>{line}</p>")
    return "\n".join(out)


def _format_issue_date(send_date: str) -> str:
    """ISO date → "Sunday, May 31, 2026" (matches the n8n render-html payload)."""
    try:
        d = _dt.date.fromisoformat(send_date)
    except (ValueError, TypeError):
        return send_date or ""
    return f"{d.strftime('%A')}, {d.strftime('%B')} {d.day}, {d.year}"


def _render_data(
    *, subject: str, preheader: str, markdown_body: str, send_date: str, view_url: str = ""
) -> dict[str, Any]:
    """The ``data`` object for /api/newsletter/render-html (mirrors the n8n send payload).

    ``body_md`` carries the assembled markdown; the decorative sections are ``None`` (not omitted)
    so the renderer's deepMerge does NOT fall back to the template's ``sample_data`` — that is what
    hides an empty sponsor/lead/trending block instead of showing a sample placeholder. ``view_url``
    feeds the template's "view in browser" link.
    """
    issue: dict[str, Any] = {"date": _format_issue_date(send_date)}
    if view_url:
        issue["view_url"] = view_url
    return {
        "title": subject,
        "preheader": preheader,
        "issue": issue,
        "body_md": markdown_body,
        "lead": None,
        "sponsor": None,
        "pull_quote": None,
        "trending": None,
        "workbench_section": None,
    }


async def _render_via_workbench(
    edition_id: str, *, subject: str, preheader: str, markdown_body: str, send_date: str, view_url: str
) -> str | None:
    """Render the edition's stored Handlebars template through the Workbench renderer.

    Mirrors the production n8n send path's POST to ``/api/newsletter/render-html``. Returns the
    rendered HTML, or ``None`` when WW isn't configured/reachable (caller falls back).
    """
    settings = get_settings()
    base = (settings.workbench_api_url or "").rstrip("/")
    secret = settings.ingestion_secret
    if not base or not secret or not edition_id:
        return None
    data = _render_data(
        subject=subject,
        preheader=preheader,
        markdown_body=markdown_body,
        send_date=send_date,
        view_url=view_url,
    )
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(25.0, connect=8.0)) as client:
            resp = await client.post(
                f"{base}/api/newsletter/render-html",
                headers={"X-Ingestion-Secret": secret, "Content-Type": "application/json"},
                json={"edition_id": edition_id, "data": data},
            )
        if resp.status_code >= 300:
            return None
        body = resp.json()
        html = body.get("html") if isinstance(body, dict) else None
        return html if isinstance(html, str) and html.strip() else None
    except Exception:
        return None


async def handler(inp: StepInput) -> StepOutput:
    edition_id = str(inp.payload.get("edition_id") or "")
    subject = str(inp.payload.get("subject") or "Newsletter")
    preheader = str(inp.payload.get("pre_header_text") or "")
    masthead = str(inp.payload.get("masthead") or "The Workbench")
    markdown_body = str(inp.payload.get("markdown_body") or "")
    permalink_url = str(inp.payload.get("permalink_url") or "")
    send_date = str(inp.payload.get("send_date") or "")

    # The stored template defines the newsletter's look; render it through the Workbench renderer.
    html_body = await _render_via_workbench(
        edition_id,
        subject=subject,
        preheader=preheader,
        markdown_body=markdown_body,
        send_date=send_date,
        view_url=permalink_url,
    )
    if html_body:
        template_id = edition_id
    else:
        # Fallback: self-contained template (WW unreachable / not configured / no edition template).
        html_body = DEFAULT_TEMPLATE.substitute(
            subject=subject,
            masthead=masthead,
            preheader=preheader,
            body=_markdown_to_html(markdown_body),
            permalink_url=permalink_url or "(not yet published)",
        )
        template_id = None

    result = RenderedNewsletter(html_body=html_body, masthead_template_id=template_id)
    return StepOutput(
        execution_id=inp.execution_id,
        step_name=STEP_NAME,
        status=StepStatus.OK,
        payload=result.model_dump(mode="json"),
    )


app = build_step_app(STEP_NAME, handler)
