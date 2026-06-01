"""persist-svc maps the engine domain row to real newsletter_sends_v2 columns.

The table column is ``preheader`` (not ``pre_header_text``), ``status`` is a constrained enum that
does NOT include the engine's "saved", and ``user_id`` is ``NOT NULL``. Before this mapping the
upsert failed with PGRST204 (unknown column) / a CHECK violation. The ON CONFLICT target is
``(edition_id, send_date)`` — see migration 024.
"""

from __future__ import annotations

from persist_step.main import _DB_STATUS, _to_db_row

from writer_engine.schemas.newsletter import NewsletterSendRow


def _row(**over: object) -> NewsletterSendRow:
    base: dict[str, object] = {
        "user_id": "+14105914612",
        "edition_id": "ai-news",
        "send_date": "2026-05-31",
        "subject": "S",
        "pre_header_text": "PH",
        "markdown_body": "md",
        "html_body": "<p>h</p>",
        "status": "saved",
        "metadata": {"k": "v"},
    }
    base.update(over)
    return NewsletterSendRow.model_validate(base)


def test_maps_pre_header_text_to_preheader() -> None:
    db = _to_db_row(_row(), "exec-1")
    assert db["preheader"] == "PH"
    assert "pre_header_text" not in db


def test_saved_status_becomes_draft() -> None:
    assert _to_db_row(_row(status="saved"), "x")["status"] == "draft"
    assert _DB_STATUS["saved"] == "draft"


def test_known_statuses_pass_through() -> None:
    for s in ("draft", "scheduled", "sending", "sent", "failed", "cancelled"):
        assert _to_db_row(_row(status=s), "x")["status"] == s


def test_unknown_status_falls_back_to_draft() -> None:
    assert _to_db_row(_row(status="weird"), "x")["status"] == "draft"


def test_user_id_and_execution_id_present() -> None:
    db = _to_db_row(_row(), "exec-42")
    assert db["user_id"] == "+14105914612"
    assert db["metadata"]["execution_id"] == "exec-42"
    assert db["metadata"]["k"] == "v"


def test_db_row_columns_are_exactly_the_table_columns() -> None:
    db = _to_db_row(_row(), "x")
    assert set(db) == {
        "user_id",
        "edition_id",
        "send_date",
        "subject",
        "preheader",
        "markdown_body",
        "html_body",
        "status",
        "metadata",
    }
