"""Item 9 — the failures that blanket ``except Exception`` blocks used to swallow.

Each test pins one defect found in the audit: a failure that was hidden while the caller saved the
wrong thing or was told it succeeded. The fix in each case either refuses (nothing changed, say so)
or surfaces the failure; these prove it with the failure injected where it really happens (the
``execute()`` of a PostgREST query, a Redis call, an HTTP upload).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from postgrest.exceptions import APIError
from redis.exceptions import ConnectionError as RedisConnectionError

from writer_engine import errors
from writer_engine.persist_helpers import persist_bible
from writer_engine.state_machine import hitl

_TIMEOUT = {"code": "57014", "message": "canceling statement due to statement timeout"}


class _FailingQuery:
    def __init__(self, inner: Any, fail: bool) -> None:
        self.inner, self.fail = inner, fail

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self.inner, name)
        if not callable(attr):
            return attr

        def _wrap(*a: Any, **k: Any) -> Any:
            out = attr(*a, **k)
            return _FailingQuery(out, self.fail) if out is self.inner else out

        return _wrap

    async def execute(self) -> Any:
        if self.fail:
            raise APIError(dict(_TIMEOUT))
        return await self.inner.execute()


class _Flaky:
    """Wraps the shared FakeSupabase; ``fail(table, op)`` makes that table's op raise at execute().
    ``arg`` narrows it to one call shape, e.g. ``fail("t", "select", "name,description")``."""

    def __init__(self, fake: Any) -> None:
        self.fake = fake
        self.failing: set[tuple[str, str, Any]] = set()

    def fail(self, table: str, op: str, arg: Any = None) -> None:
        self.failing.add((table, op, arg))

    def _fails(self, table: str, op: str, args: tuple[Any, ...]) -> bool:
        first = args[0] if args and isinstance(args[0], str) else None
        return (table, op, None) in self.failing or (table, op, first) in self.failing

    def table(self, name: str) -> Any:
        flaky = self

        class _Q(_FailingQuery):
            def __getattr__(self, attr: str) -> Any:
                if attr in {"select", "insert", "update", "upsert", "delete"}:

                    def _op(*a: Any, **k: Any) -> Any:
                        return _FailingQuery(getattr(self.inner, attr)(*a, **k), flaky._fails(name, attr, a))

                    return _op
                return super().__getattr__(attr)

        return _Q(self.fake.table(name), False)


# --- the error tuples ---------------------------------------------------------------------------


def test_the_error_tuples_cover_what_the_clients_raise() -> None:
    import httpx

    assert issubclass(APIError, errors.SUPABASE_ERRORS)
    assert issubclass(httpx.ReadTimeout, errors.SUPABASE_ERRORS)
    # get_supabase_admin() raises RuntimeError when the project is not configured.
    assert issubclass(RuntimeError, errors.SUPABASE_ERRORS)
    assert issubclass(RedisConnectionError, errors.REDIS_ERRORS)
    assert issubclass(TimeoutError, errors.REDIS_ERRORS)  # asyncio.wait_for
    assert issubclass(httpx.InvalidURL, errors.HTTP_ERRORS)  # not an httpx.HTTPError
    # The point of narrowing: a programming error is NOT treated as an outage.
    for bug in (KeyError, AttributeError, TypeError, NameError):
        assert not issubclass(bug, errors.SUPABASE_ERRORS + errors.REDIS_ERRORS + errors.HTTP_ERRORS)


# --- story bible: CR-002 must hold when the roster cannot be read ---------------------------------


@pytest.mark.asyncio
async def test_bible_skips_characters_when_the_roster_is_unreadable(fake_supabase: Any) -> None:
    """Was: a failed roster read returned {} ("no characters yet"), so "Osei Asante" was inserted
    beside "Osei" as a second person."""
    fake_supabase.tables["story_bible_v2"] = [
        {"id": "b1", "project_id": "p1", "entry_type": "character", "name": "Osei", "description": "a"}
    ]
    db = _Flaky(fake_supabase)
    db.fail("story_bible_v2", "select", "name,description")  # the roster read only; writes work
    n = await persist_bible(
        db,
        project_id="p1",
        user_id="u1",
        entries=[
            {"name": "Osei Asante", "entry_type": "character", "description": "b"},
            {"name": "The Accord", "entry_type": "concept", "description": "c"},
        ],
    )
    assert n == 1  # the concept is written; the character waits for a readable roster
    names = sorted(r["name"] for r in fake_supabase.tables["story_bible_v2"])
    assert names == ["Osei", "The Accord"]  # no second person


@pytest.mark.asyncio
async def test_bible_rename_failure_updates_the_existing_entry_not_a_new_one(fake_supabase: Any) -> None:
    """Was: contextlib.suppress(Exception) around the rename, then the full name was inserted."""
    fake_supabase.tables["story_bible_v2"] = [
        {"id": "b1", "project_id": "p1", "entry_type": "character", "name": "Osei", "description": "a"}
    ]
    db = _Flaky(fake_supabase)
    db.fail("story_bible_v2", "update")  # the rename (and the later update) fail; selects work
    await persist_bible(
        db,
        project_id="p1",
        user_id="u1",
        entries=[{"name": "Osei Asante", "entry_type": "character", "description": "b"}],
    )
    characters = [r for r in fake_supabase.tables["story_bible_v2"] if r["entry_type"] == "character"]
    assert [c["name"] for c in characters] == ["Osei"]


# --- HITL: a gate the Workbench cannot see, a decision held only in memory -------------------------


@pytest.fixture
def _supabase_configured(monkeypatch: pytest.MonkeyPatch, fake_supabase: Any) -> _Flaky:
    import writer_engine.config as config
    import writer_engine.supabase.client as sb

    db = _Flaky(fake_supabase)
    settings = SimpleNamespace(supabase_url="https://x.supabase.co", supabase_service_role_key="k")
    monkeypatch.setattr(config, "get_settings", lambda: settings)

    async def _admin() -> _Flaky:
        return db

    monkeypatch.setattr(sb, "get_supabase_admin", _admin)
    hitl._in_memory.clear()
    return db


def _redis_down(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _down() -> Any:
        raise RedisConnectionError("Connection refused")

    monkeypatch.setattr(hitl._redis_module, "get_redis", _down)


@pytest.mark.asyncio
async def test_an_approval_the_workbench_cannot_list_is_an_error_not_a_week_long_wait(
    _supabase_configured: _Flaky, monkeypatch: pytest.MonkeyPatch
) -> None:
    _redis_down(monkeypatch)
    _supabase_configured.fail("newsletter_approvals_v2", "insert")
    with pytest.raises(hitl.ApprovalNotPersisted):
        await hitl.create_approval(execution_id=uuid4(), stage="awaiting_stories_approval", user_id="u1")


@pytest.mark.asyncio
async def test_a_gate_without_a_user_still_needs_no_mirror(
    _supabase_configured: _Flaky, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Tests and the compose demo have no user_id: no mirror row is required there."""
    _redis_down(monkeypatch)
    gate = await hitl.create_approval(execution_id=uuid4(), stage="awaiting_stories_approval")
    assert gate.token in hitl._in_memory


@pytest.mark.asyncio
async def test_a_decision_nothing_durable_kept_is_refused_and_left_unapplied(
    _supabase_configured: _Flaky, monkeypatch: pytest.MonkeyPatch
) -> None:
    gate = await hitl.create_approval(execution_id=uuid4(), stage="awaiting_stories_approval", user_id="u1")
    _redis_down(monkeypatch)
    _supabase_configured.fail("newsletter_approvals_v2", "update")
    with pytest.raises(hitl.ApprovalNotPersisted):
        await hitl.resolve_approval(gate.token, decision=hitl.ApprovalDecision.APPROVE)
    again = await hitl.get_approval(gate.token)
    assert again is not None and again.resolved_at_ms is None and again.decision is None


@pytest.mark.asyncio
async def test_a_decision_the_mirror_kept_succeeds_even_with_redis_down(
    _supabase_configured: _Flaky, monkeypatch: pytest.MonkeyPatch, fake_supabase: Any
) -> None:
    gate = await hitl.create_approval(execution_id=uuid4(), stage="awaiting_stories_approval", user_id="u1")
    _redis_down(monkeypatch)
    out = await hitl.resolve_approval(gate.token, decision=hitl.ApprovalDecision.APPROVE)
    assert out.decision is hitl.ApprovalDecision.APPROVE
    row = fake_supabase.tables["newsletter_approvals_v2"][0]
    assert row["decision"] == "approve" and row["resolved_at"]


# --- blog / newsletter: never save the model's raw JSON as the article ----------------------------


def test_model_json_tells_prose_from_broken_json() -> None:
    from chapter_step.main import _model_json

    assert _model_json('{"title": "T", "body_markdown": "B"}') == ({"title": "T", "body_markdown": "B"}, None)
    assert _model_json('```json\n{"title": "T"}\n```')[0] == {"title": "T"}
    # Prose with no JSON is used as prose, not refused.
    assert _model_json("# A plain markdown post\n\nNo braces here.") == ({}, None)
    # Prose that merely contains braces is prose too.
    assert _model_json("Use `{name}` in templates; see {docs}.")[1] is None
    # A JSON reply cut off at max_tokens, or malformed: refused, with a reason.
    for broken in (
        '{"title": "T", "body_markdown": "It was a dark and',
        '{"title": "T",, }',
        "```json\n[1, 2]\n```",
    ):
        data, problem = _model_json(broken)
        assert data == {} and problem, broken


@pytest.mark.asyncio
@pytest.mark.parametrize("op", ["_op_blog", "_op_newsletter"])
async def test_a_truncated_reply_is_not_saved_as_the_article(
    monkeypatch: pytest.MonkeyPatch, op: str
) -> None:
    import chapter_step.main as ch

    saved: list[dict[str, Any]] = []
    humanized: list[str] = []

    class _Router:
        async def complete(self, **_k: Any) -> Any:
            return SimpleNamespace(text='{"title": "T", "subject_line": "S", "body_markdown": "Cut off mid')

    async def _research(*_a: Any, **_k: Any) -> tuple[str, list[str]]:
        return "", []

    async def _humanize(body: str, **_k: Any) -> tuple[str, None]:
        humanized.append(body)
        return body, None

    async def _persist(payload: dict[str, Any], **kw: Any) -> dict[str, Any]:
        saved.append(kw)
        return {"persisted": True}

    async def _empty(*_a: Any, **_k: Any) -> Any:
        return ""

    async def _guidelines(_slug: str) -> tuple[str, str]:
        return ("Sci-Fi", "")

    monkeypatch.setattr(ch, "get_router", lambda **_k: _Router())
    monkeypatch.setattr(ch, "_chapter_research", _research)
    monkeypatch.setattr(ch, "humanize_draft", _humanize)
    monkeypatch.setattr(ch, "_persist_simple", _persist)
    monkeypatch.setattr(ch, "_load_genre_guidelines", _guidelines)
    for helper in ("_project_research", "_book_facts"):
        if hasattr(ch, helper):
            monkeypatch.setattr(ch, helper, _empty)
    if hasattr(ch, "_load_author_profile"):

        async def _no_profile(*_a: Any, **_k: Any) -> None:
            return None

        monkeypatch.setattr(ch, "_load_author_profile", _no_profile)

    out = await getattr(ch, op)({"topic": "the topic", "user_id": "u1", "persist": True})
    assert out["written"] is False and "cut off" in out["reason"]
    assert saved == [] and humanized == []  # nothing stored, nothing paid for


# --- brainstorm: no unanchored regeneration -------------------------------------------------------


@pytest.mark.asyncio
async def test_a_rebrainstorm_without_its_anchor_refuses_instead_of_drifting(
    _supabase_configured: _Flaky, monkeypatch: pytest.MonkeyPatch
) -> None:
    import brainstorm_step.main as bs

    monkeypatch.setattr(
        bs, "get_settings", lambda: SimpleNamespace(supabase_url="u", supabase_service_role_key="k")
    )
    _supabase_configured.fail("writing_projects_v2", "select")
    with pytest.raises(RuntimeError, match="nothing was regenerated"):
        await bs._load_project_anchor({"project_id": "p1"})


# --- cover art: a failed upload is not "storage unconfigured" -------------------------------------


@pytest.mark.asyncio
async def test_a_failed_cover_upload_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    import media_step.main as media

    settings = SimpleNamespace(
        kieai_api_key="k",
        openai_api_key="",
        supabase_url="https://x.supabase.co",
        supabase_service_role_key="s",
    )
    monkeypatch.setattr(media, "get_settings", lambda: settings)

    async def _image(*_a: Any, **_k: Any) -> bytes:
        return b"png"

    async def _upload_fails(*_a: Any, **_k: Any) -> tuple[None, None]:
        return None, None

    monkeypatch.setattr(media, "_kieai_cover", _image)
    monkeypatch.setattr(media, "_upload_cover", _upload_fails)
    out = await media._op_cover_art({"title": "T", "user_id": "u1"})
    assert out["persisted"] is False
    assert "upload to storage failed" in out["image_url"]
    assert "unconfigured" not in out["image_url"]


# --- radar: a duplicate week is not an outage ------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(("code", "logged"), [("23505", False), ("57014", True)])
async def test_radar_claim_tells_a_duplicate_week_from_an_outage(
    fake_supabase: Any, monkeypatch: pytest.MonkeyPatch, code: str, logged: bool
) -> None:
    """Was `except Exception: return None  # another tick inserted the same week first` — so an outage
    was silently read as "someone else has it"."""
    from datetime import date

    from writer_engine.radar import run as radar_run

    warnings: list[str] = []
    monkeypatch.setattr(radar_run.logger, "warning", lambda event, **_k: warnings.append(event))
    db = _Flaky(fake_supabase)
    db.fail("radar_runs_v2", "insert")
    _TIMEOUT_CODE = dict(_TIMEOUT)
    monkeypatch.setitem(_TIMEOUT, "code", code)
    try:
        monkeypatch.setattr(radar_run, "RUNS", "radar_runs_v2")
        assert await radar_run._claim_run(db, "u1", "dev", date(2026, 11, 2), force=False) is None
    finally:
        _TIMEOUT.update(_TIMEOUT_CODE)
    assert ("radar.claim_failed" in warnings) is logged


def test_ble001_stays_enabled() -> None:
    """BLE001 is what keeps new blind excepts out; pin it so dropping it from `select` fails a test."""
    import tomllib
    from pathlib import Path

    cfg = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())
    assert "BLE" in cfg["tool"]["ruff"]["lint"]["select"]
