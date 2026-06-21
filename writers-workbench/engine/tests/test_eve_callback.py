"""E2E-5 — notify.eve-callback (KB injection + outbound call) with SIMULATED input.

Every real ElevenLabs call is gated behind config that is NOT set here, so the op runs as a dry run
(returns the planned callback payload) and never touches the baseline-protected PROD agent. We verify:
content resolution + the callback payload shape, not-found → no callback (V30), and the WF-16 KB-cleanup
ordering (V29) via a mock Eve client.
"""

from __future__ import annotations

import asyncio

import notify_step.main as nt

from writer_engine.eve import run_eve_callback


class _Resp:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, data):
        self._data = data

    def __getattr__(self, _n):
        return lambda *a, **k: self

    async def execute(self):
        return _Resp(self._data)


class _Client:
    def __init__(self, tables):
        self.tables = tables

    def table(self, name):
        return _Query(self.tables.get(name, []))


def _patch(monkeypatch, tables):
    async def fake_supabase():
        return _Client(tables)

    monkeypatch.setattr(nt, "_supabase_or_none", fake_supabase)
    # ensure the ElevenLabs path stays a dry run (no agent configured) regardless of the env
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("ELEVENLABS_AGENT_ID", raising=False)


def test_callback_resolves_and_builds_payload_dry_run(monkeypatch):
    _patch(monkeypatch, {
        "published_content_v2": [
            {"title": "Roman Aqueducts", "content_text": "How aqueducts carried water.",
             "content_type": "blog_post"},
        ],
    })
    out = asyncio.run(nt._op_eve_callback({
        "content_type": "blog", "search_term": "draft blog post about aqueducts",
        "callback_mode": "review", "user_id": "+14105914612",
    }))
    assert out["invoked"] is True and out["found"] is True
    assert out["callback_mode"] == "review"
    assert out["content_type"] == "blog"  # routed label preserved
    assert out["phone"] == "+14105914612"
    assert out["eve"]["dry_run"] is True  # never touched a real agent
    assert out["eve"]["planned"]["content_text"].startswith("How aqueducts")


def test_callback_brainstorm_research_report(monkeypatch):
    _patch(monkeypatch, {
        "research_reports_v2": [
            {"topic": "Post-Apocalyptic Trends 2026", "content": "Solarpunk is rising."},
        ],
    })
    out = asyncio.run(nt._op_eve_callback({
        "content_type": "research_report", "search_term": "research report on post apocalyptic trends",
        "callback_mode": "brainstorm", "user_id": "+14105914612",
    }))
    assert out["invoked"] is True
    assert out["callback_mode"] == "brainstorm"
    assert out["content_type"] == "research_report"


def test_callback_resolve_only_returns_found_without_eve(monkeypatch):
    # V30 sync pre-check: resolve_only returns the resolved content + found, never runs the ElevenLabs flow.
    _patch(monkeypatch, {
        "published_content_v2": [
            {"title": "Roman Aqueducts", "content_text": "body", "content_type": "blog_post"},
        ],
    })
    out = asyncio.run(nt._op_eve_callback({
        "content_type": "blog", "search_term": "aqueducts", "callback_mode": "review",
        "user_id": "+14105914612", "resolve_only": True,
    }))
    assert out["found"] is True and out["content_title"] == "Roman Aqueducts"
    assert "eve" not in out  # no callback performed during a resolve-only pre-check


def test_callback_not_found_does_not_invoke(monkeypatch):
    _patch(monkeypatch, {"published_content_v2": [
        {"title": "Something Unrelated", "content_text": "x", "content_type": "short_story"},
    ]})
    out = asyncio.run(nt._op_eve_callback({
        "content_type": "short_story", "search_term": "alien wizards on Neptune",
        "callback_mode": "review", "user_id": "+14105914612",
    }))
    assert out["invoked"] is False and out["found"] is False
    assert "couldn't find" in out["message"].lower()


# --------------------------------------------------------------------------- WF-16 KB ordering (V29)

class _MockEve:
    def __init__(self):
        self.calls: list[str] = []

    async def remove_session_docs(self):
        self.calls.append("remove")
        return 1

    async def upload_kb_doc(self, name, text):
        self.calls.append(f"upload:{name}")
        return "doc1"

    async def attach_kb_doc(self, doc_id):
        self.calls.append("attach")

    async def set_first_message(self, mode, title):
        self.calls.append(f"first_message:{mode}")

    async def outbound_call(self, phone):
        self.calls.append(f"call:{phone}")
        return "call1"


def test_kb_cleanup_runs_before_upload():
    mock = _MockEve()
    out = asyncio.run(run_eve_callback(
        content_type="blog", content_title="Aqueducts", content_text="body",
        callback_mode="review", phone="+14105914612", client=mock,
    ))
    assert out["dry_run"] is False
    # cleanup must precede upload so only the current "Eve Session:" doc remains
    assert mock.calls.index("remove") < mock.calls.index("upload:Eve Session: Aqueducts")
    assert mock.calls[-1] == "call:+14105914612"  # outbound call is last
    assert "first_message:review" in mock.calls
