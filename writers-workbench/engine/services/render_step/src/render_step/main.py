"""render-svc — merge the assembled markdown body into the edition's branded HTML template.

For F0/F2 build phase the template falls back to a built-in Playfair-Display masthead so the engine renders
without DB access. The real template fetch from ``newsletter_templates_v2`` happens when Supabase is configured.
"""

from __future__ import annotations

from string import Template

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


async def _fetch_template(edition_id: str) -> str | None:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        return None
    try:
        from writer_engine.supabase.client import get_supabase_admin

        client = await get_supabase_admin()
        resp = await (
            client.table("newsletter_templates_v2")
            .select("html")
            .eq("edition_id", edition_id)
            .limit(1)
            .execute()
        )
        rows = getattr(resp, "data", None) or []
        return rows[0]["html"] if rows else None
    except Exception:
        return None


async def handler(inp: StepInput) -> StepOutput:
    edition_id = str(inp.payload.get("edition_id") or "")
    subject = str(inp.payload.get("subject") or "Newsletter")
    preheader = str(inp.payload.get("pre_header_text") or "")
    masthead = str(inp.payload.get("masthead") or "The Workbench")
    markdown_body = str(inp.payload.get("markdown_body") or "")
    permalink_url = str(inp.payload.get("permalink_url") or "")

    body_html = _markdown_to_html(markdown_body)

    template_html = await _fetch_template(edition_id) if edition_id else None
    if template_html:
        html_body = (
            template_html.replace("{{subject}}", subject)
            .replace("{{preheader}}", preheader)
            .replace("{{masthead}}", masthead)
            .replace("{{body}}", body_html)
            .replace("{{permalink_url}}", permalink_url)
        )
        template_id = edition_id
    else:
        html_body = DEFAULT_TEMPLATE.substitute(
            subject=subject,
            masthead=masthead,
            preheader=preheader,
            body=body_html,
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
