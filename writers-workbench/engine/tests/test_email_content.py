"""E2E-1 — unit tests for library.email-content (`_op_email_content`).

Covers the two modes + not-found with a fake Supabase client and a captured `send_email`, so the op's
resolution / rendering / recipient precedence is proven offline (the live DEV run validates the real
DB + Postal). Mirrors the offline style of test_hub_router (plain functions + asyncio.run).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import library_step.main as lib


class _Resp:
    def __init__(self, data):
        self.data = data


class _Query:
    """Chainable no-op query — ignores filters and returns the table's canned rows on execute().
    The op does its own keyword matching in Python, so filter fidelity isn't needed here."""

    def __init__(self, data):
        self._data = data

    def __getattr__(self, _name):
        return lambda *a, **k: self

    async def execute(self):
        return _Resp(self._data)


class _Client:
    def __init__(self, tables):
        self.tables = tables

    def table(self, name):
        return _Query(self.tables.get(name, []))


def _patch(monkeypatch, tables):
    sent: list[dict] = []

    async def fake_supabase():
        return _Client(tables)

    async def fake_send_email(*, to, from_addr, subject, html, bcc=None):
        sent.append({"to": to, "from": from_addr, "subject": subject, "html": html, "bcc": bcc})
        return SimpleNamespace(message_id="msg_1")

    monkeypatch.setattr(lib, "_supabase_or_none", fake_supabase)
    monkeypatch.setattr("writer_engine.postal.send_email", fake_send_email)
    return sent


_APP_CONFIG = [{"key": "recipient_email", "value": "eric@agileadtesting.com"}]


def test_inline_content_renders_and_sends(monkeypatch):
    sent = _patch(monkeypatch, {"app_config_v2": _APP_CONFIG})
    out = asyncio.run(lib._op_email_content({
        "user_id": "u1",
        "subject": "Regression Test: Email Report",
        "content": "# Heading\n\n- bullet one\n- bullet two\n\n1. first\n2. second",
    }))
    assert out["emailed"] is True
    assert out["to"] == "eric@agileadtesting.com"
    assert len(sent) == 1
    html = sent[0]["html"]
    assert "<h1>Heading</h1>" in html
    assert "<ul>" in html and "<li>bullet one</li>" in html
    assert "<ol>" in html and "<li>first</li>" in html
    assert sent[0]["subject"] == "Regression Test: Email Report"


def test_explicit_recipient_overrides_app_config(monkeypatch):
    sent = _patch(monkeypatch, {"app_config_v2": _APP_CONFIG})
    out = asyncio.run(lib._op_email_content({
        "user_id": "u1", "content": "hello", "recipient": "override@example.com",
    }))
    assert out["emailed"] is True
    assert out["to"] == "override@example.com"
    assert sent[0]["to"] == ["override@example.com"]


def test_resolve_outline_renders_structure_not_json(monkeypatch):
    tables = {
        "app_config_v2": _APP_CONFIG,
        "writing_projects_v2": [{
            "title": "The Seed Vault",
            "outline": {
                "premise": "Seeds outlast the fall.",
                "characters": [{"name": "Mara", "description": "the seed-keeper"}],
                "chapters": [{"chapter_number": 1, "title": "The Vault", "beat": "Mara descends"}],
            },
        }],
    }
    sent = _patch(monkeypatch, tables)
    out = asyncio.run(lib._op_email_content({
        "user_id": "u1", "content_type": "outline", "title": "The Seed Vault",
    }))
    assert out["emailed"] is True
    assert "Outline" in out["subject"]
    html = sent[0]["html"]
    assert "Characters" in html and "Mara" in html
    assert "Chapters" in html and "The Vault" in html
    assert "{" not in html  # rendered structure, not raw JSON


def test_not_found_sends_nothing(monkeypatch):
    tables = {
        "app_config_v2": _APP_CONFIG,
        "published_content_v2": [{
            "title": "An Entirely Different Tale", "content_text": "irrelevant",
            "content_type": "short_story", "chapter_number": None,
        }],
    }
    sent = _patch(monkeypatch, tables)
    out = asyncio.run(lib._op_email_content({
        "user_id": "u1", "content_type": "short_story",
        "search_term": "A Story That Definitely Does Not Exist",
    }))
    assert out["emailed"] is False
    assert out.get("error_message")
    assert sent == []  # no email on not-found


def test_allow_recent_research_falls_back_to_most_recent(monkeypatch):
    # V03: "email me a summary of that research" with no concrete title → allow_recent picks the
    # most-recent report (research_reports_v2 is queried created_at desc, so rows[0] is newest).
    tables = {
        "app_config_v2": _APP_CONFIG,
        "research_reports_v2": [
            {"topic": "The fall of the Roman Empire", "content": "Rome fell because…", "created_at": "2026-07-02T00:00:00Z"},
            {"topic": "An older unrelated report", "content": "stale", "created_at": "2026-01-01T00:00:00Z"},
        ],
    }
    sent = _patch(monkeypatch, tables)
    out = asyncio.run(lib._op_email_content({
        "user_id": "u1", "content_type": "research",
        "subject": "voice test research report", "allow_recent": True,
    }))
    assert out["emailed"] is True
    assert sent[0]["subject"] == "voice test research report"
    assert "Rome fell because" in sent[0]["html"]


def test_research_without_allow_recent_and_no_match_is_not_found(monkeypatch):
    # A named-but-absent report must still be not-found (never email the wrong report).
    tables = {
        "app_config_v2": _APP_CONFIG,
        "research_reports_v2": [
            {"topic": "The fall of the Roman Empire", "content": "Rome fell…", "created_at": "2026-07-02T00:00:00Z"},
        ],
    }
    sent = _patch(monkeypatch, tables)
    out = asyncio.run(lib._op_email_content({
        "user_id": "u1", "content_type": "research", "search_term": "Quantum Widgets of Neptune",
    }))
    assert out["emailed"] is False
    assert sent == []
