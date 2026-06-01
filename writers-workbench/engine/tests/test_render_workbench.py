"""render-svc → Workbench render-html payload contract.

The stored Handlebars template defines the newsletter's look; render-svc sends the assembled
markdown as `body_md` and nulls the decorative sections so the template hides them rather than
falling back to its sample_data (the no-empty-sponsor fix). These lock the payload shape + date.
"""

from __future__ import annotations

from render_step.main import _format_issue_date, _render_data


def test_issue_date_format() -> None:
    assert _format_issue_date("2026-05-31") == "Sunday, May 31, 2026"
    assert _format_issue_date("2026-01-01") == "Thursday, January 1, 2026"


def test_issue_date_bad_input_passthrough() -> None:
    assert _format_issue_date("") == ""
    assert _format_issue_date("not-a-date") == "not-a-date"


def test_render_data_carries_body_and_nulls_decorative() -> None:
    d = _render_data(subject="S", preheader="P", markdown_body="## Story\n\nBody.", send_date="2026-05-31")
    assert d["body_md"] == "## Story\n\nBody."
    assert d["title"] == "S"
    assert d["preheader"] == "P"
    assert d["issue"]["date"] == "Sunday, May 31, 2026"
    # The decorative sections MUST be present and null (not absent) to override sample_data.
    for k in ("lead", "sponsor", "pull_quote", "trending", "workbench_section"):
        assert k in d, f"{k} must be sent so deepMerge overrides the template sample_data"
        assert d[k] is None, f"{k} must be null to hide its block (e.g. no empty sponsor)"


def test_render_data_view_url_feeds_issue() -> None:
    d = _render_data(
        subject="S",
        preheader="P",
        markdown_body="b",
        send_date="2026-05-31",
        view_url="https://ww.example/api/newsletter/view/ai-news/2026-05-31",
    )
    assert d["issue"]["view_url"] == "https://ww.example/api/newsletter/view/ai-news/2026-05-31"


def test_render_data_omits_view_url_when_blank() -> None:
    d = _render_data(subject="S", preheader="P", markdown_body="b", send_date="2026-05-31")
    assert "view_url" not in d["issue"]
