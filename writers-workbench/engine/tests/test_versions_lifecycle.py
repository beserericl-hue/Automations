"""E2E-2 — unit tests for library.versions, library.revert, and the lifecycle trash actions
(delete / published-delete guard / undelete / list_deleted), with a recording fake Supabase client.

Proves the snapshot-before-overwrite, no-mutation-on-error, and soft-delete behaviors offline; the
live DEV run validates the real tables + Postal.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import library_step.main as lib


class _Resp:
    def __init__(self, data):
        self.data = data


class _Table:
    def __init__(self, name, store):
        self.name, self.store = name, store
        self._filters: dict = {}
        self._op = "select"
        self._payload = None

    def select(self, *a, **k):
        self._op = "select"
        return self

    def insert(self, row):
        self._op, self._payload = "insert", row
        return self

    def update(self, row):
        self._op, self._payload = "update", row
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def __getattr__(self, _name):  # neq/in_/is_/order/limit — no-ops for the fake
        return lambda *a, **k: self

    async def execute(self):
        rows = self.store.rows.setdefault(self.name, [])
        if self._op == "select":
            return _Resp([r for r in rows if all(r.get(c) == v for c, v in self._filters.items())])
        if self._op == "insert":
            self.store.inserts.append((self.name, self._payload))
            if isinstance(self._payload, dict):
                rows.append(self._payload)
            return _Resp([self._payload])
        if self._op == "update":
            self.store.updates.append((self.name, dict(self._filters), self._payload))
            for r in rows:
                if all(r.get(c) == v for c, v in self._filters.items()):
                    r.update(self._payload)
            return _Resp([self._payload])
        return _Resp([])


class _Store:
    def __init__(self, rows):
        self.rows = rows
        self.inserts: list = []
        self.updates: list = []


class _Client:
    def __init__(self, store):
        self.store = store

    def table(self, name):
        return _Table(name, self.store)


def _patch(monkeypatch, rows):
    store = _Store(rows)
    sent: list = []

    async def fake_supabase():
        return _Client(store)

    async def fake_send_email(*, to, from_addr, subject, html, bcc=None):
        sent.append({"to": to, "subject": subject})
        return SimpleNamespace(message_id="m1")

    monkeypatch.setattr(lib, "_supabase_or_none", fake_supabase)
    monkeypatch.setattr("writer_engine.postal.send_email", fake_send_email)
    # send_lifecycle_email binds send_email at task_email module load, so patch that name too.
    monkeypatch.setattr("writer_engine.notifications.task_email.send_email", fake_send_email)
    return store, sent


_APP_CONFIG = [{"key": "recipient_email", "value": "eric@agileadtesting.com"}]


# --------------------------------------------------------------------------- versions

def test_versions_outline_list_counts_chapters(monkeypatch):
    _patch(monkeypatch, {
        "writing_projects_v2": [{"id": "p1", "title": "The Accord", "user_id": "u1"}],
        "outline_versions_v2": [
            {"project_id": "p1", "version_number": 1, "outline": {"chapters": [{}, {}]},
             "revision_note": "snap", "created_at": "t1"},
        ],
    })
    out = asyncio.run(lib._op_versions(
        {"scope": "outline", "project_title": "The Accord", "user_id": "u1", "mode": "list"}))
    assert out["count"] == 1
    assert out["versions"][0]["version_number"] == 1
    assert out["versions"][0]["chapter_count"] == 2


def test_versions_content_get_returns_body(monkeypatch):
    _patch(monkeypatch, {
        "content_versions_v2": [
            {"content_id": "c1", "version_number": 1, "content_text": "v1 body",
             "changed_by": "engine", "change_note": "n", "created_at": "t1"},
        ],
    })
    out = asyncio.run(lib._op_versions(
        {"scope": "content", "content_id": "c1", "mode": "get", "version_number": 1}))
    assert out["version"]["content_text"] == "v1 body"


# --------------------------------------------------------------------------- revert

def test_revert_outline_snapshots_then_overwrites(monkeypatch):
    store, _ = _patch(monkeypatch, {
        "writing_projects_v2": [
            {"id": "p1", "title": "The Accord", "user_id": "u1", "outline": {"chapters": [{}, {}, {}]}},
        ],
        "outline_versions_v2": [
            {"project_id": "p1", "version_number": 1, "outline": {"chapters": [{}, {}]}},
        ],
    })
    out = asyncio.run(lib._op_revert(
        {"scope": "outline", "project_title": "The Accord", "version_number": 1, "user_id": "u1"}))
    assert out["reverted"] is True and out["chapter_count"] == 2
    # current (3-ch) outline snapshotted before overwrite
    snaps = [p for (t, p) in store.inserts if t == "outline_versions_v2"]
    assert any(len((p.get("outline") or {}).get("chapters") or []) == 3 for p in snaps)
    # project outline overwritten to the v1 (2-ch) outline
    proj_updates = [p for (t, f, p) in store.updates if t == "writing_projects_v2"]
    assert proj_updates and len(proj_updates[-1]["outline"]["chapters"]) == 2


def test_revert_invalid_version_no_mutation(monkeypatch):
    store, _ = _patch(monkeypatch, {
        "writing_projects_v2": [{"id": "p1", "title": "The Accord", "user_id": "u1", "outline": {"chapters": [{}]}}],
        "outline_versions_v2": [{"project_id": "p1", "version_number": 1, "outline": {"chapters": [{}]}}],
    })
    out = asyncio.run(lib._op_revert(
        {"scope": "outline", "project_title": "The Accord", "version_number": 99, "user_id": "u1"}))
    assert out["reverted"] is False and out["error_message"]
    assert not [u for u in store.updates if u[0] == "writing_projects_v2"]  # nothing overwritten
    assert not [i for i in store.inserts if i[0] == "outline_versions_v2"]  # no snapshot


def test_revert_project_not_found(monkeypatch):
    _patch(monkeypatch, {"writing_projects_v2": []})
    out = asyncio.run(lib._op_revert(
        {"scope": "outline", "project_title": "Nope", "version_number": 1, "user_id": "u1"}))
    assert out["reverted"] is False and "not found" in out["error_message"].lower()


# --------------------------------------------------------------------------- lifecycle trash

def test_delete_draft_snapshots_soft_deletes_and_emails(monkeypatch):
    store, sent = _patch(monkeypatch, {
        "app_config_v2": _APP_CONFIG,
        "published_content_v2": [{
            "id": "c1", "user_id": "u1", "title": "The Forgotten Engineers of Rome",
            "status": "draft", "content_text": "body", "content_type": "blog_post", "metadata": {},
        }],
    })
    out = asyncio.run(lib._op_lifecycle(
        {"action": "delete", "search_term": "The Forgotten Engineers of Rome", "user_id": "u1"}))
    assert out["status"] == "deleted"
    snaps = [p for (t, p) in store.inserts if t == "content_versions_v2"]
    assert snaps and snaps[-1]["change_note"] == "Auto-snapshot before delete"
    assert len(sent) == 1  # deletion email


def test_delete_published_is_rejected(monkeypatch):
    store, sent = _patch(monkeypatch, {
        "app_config_v2": _APP_CONFIG,
        "published_content_v2": [{
            "id": "c2", "user_id": "u1", "title": "Why It Matters", "status": "published",
            "content_text": "body", "content_type": "blog_post", "metadata": {},
        }],
    })
    out = asyncio.run(lib._op_lifecycle(
        {"action": "delete", "search_term": "Why It Matters", "user_id": "u1"}))
    assert "error" in out and "unpublish" in out["error"].lower()
    assert not store.inserts  # no snapshot
    assert sent == []  # no email
    assert not [u for u in store.updates if u[0] == "published_content_v2"]  # status unchanged


def test_undelete_restores_to_draft(monkeypatch):
    _store, sent = _patch(monkeypatch, {
        "app_config_v2": _APP_CONFIG,
        "published_content_v2": [{
            "id": "c3", "user_id": "u1", "title": "The Forgotten Engineers of Rome",
            "status": "deleted", "content_text": "body", "content_type": "blog_post", "metadata": {},
        }],
    })
    out = asyncio.run(lib._op_lifecycle(
        {"action": "undelete", "search_term": "The Forgotten Engineers of Rome", "user_id": "u1"}))
    assert out["status"] == "draft"
    assert len(sent) == 1  # restore email


def test_list_deleted_filters_by_type(monkeypatch):
    _patch(monkeypatch, {
        "published_content_v2": [
            {"id": "a", "user_id": "u1", "title": "Del Blog", "status": "deleted", "content_type": "blog_post"},
            {"id": "b", "user_id": "u1", "title": "Del Chapter", "status": "deleted", "content_type": "chapter"},
        ],
    })
    out = asyncio.run(lib._op_lifecycle(
        {"action": "list_deleted", "content_type_filter": "blog_post", "user_id": "u1"}))
    assert out["count"] == 1 and out["items"][0]["title"] == "Del Blog"
