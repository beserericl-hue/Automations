"""Eve knowledge-base cleanup cron — ``writer_engine.eve.prune_stale_kb_docs`` on the engine clock.

``run_eve_callback`` only removes old "Eve Session:" docs right before it uploads a new one, so a
callback that fails after its upload (or a quiet week) leaves a copy of a user's draft in the
ElevenLabs KB. The scheduled prune removes it. Everything here runs against a MOCKED ElevenLabs API:
the real one is never reached, and no test path may touch an agent (no ``/agents/`` request at all).
"""

from __future__ import annotations

from typing import Any

import pytest

from writer_engine import eve, scheduler

NOW = 1_800_000_000.0
HOUR = 3600.0


class _FakeElevenLabs(eve.EveClient):
    """``EveClient`` with ``_request`` answered from memory: a paginated KB list and deletes.

    Records every request so a test can assert what was (and was not) called."""

    def __init__(self, docs: list[dict[str, Any]], *, page_size: int = 2, in_use: set[str] | None = None):
        super().__init__({"api_key": "k", "agent_id": "agent_x", "phone_number_id": "", "base": "http://el"})
        self.docs = docs
        self.page_size = page_size
        self.in_use = in_use or set()
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    async def _request(self, method: str, path: str, **kw: Any) -> Any:
        self.calls.append((method, path, kw))
        if method == "GET" and path == "/v1/convai/knowledge-base":
            params = kw.get("params") or {}
            start = int(params.get("cursor") or 0)
            matching = [d for d in self.docs if str(d["name"]).startswith(params.get("search", ""))]
            page = matching[start : start + self.page_size]
            more = start + self.page_size < len(matching)
            return {
                "documents": page,
                "has_more": more,
                "next_cursor": str(start + self.page_size) if more else None,
            }
        if method == "DELETE" and path.startswith("/v1/convai/knowledge-base/"):
            doc_id = path.rsplit("/", 1)[-1]
            if doc_id in self.in_use:
                raise RuntimeError("400: document is used by an agent")
            self.docs = [d for d in self.docs if d["id"] != doc_id]
            return {}
        raise AssertionError(f"unexpected ElevenLabs call {method} {path}")


def _doc(doc_id: str, name: str, age_h: float) -> dict[str, Any]:
    return {"id": doc_id, "name": name, "metadata": {"created_at_unix_secs": NOW - age_h * HOUR}}


@pytest.fixture(autouse=True)
def _no_elevenlabs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ELEVENLABS_API_KEY", "")
    monkeypatch.setenv("ELEVENLABS_AGENT_ID", "")


@pytest.mark.asyncio
async def test_unconfigured_is_a_logged_noop_that_constructs_no_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """DEV has no ELEVENLABS_API_KEY: the tick must touch nothing and say why."""

    def _boom(*_a: Any, **_k: Any) -> None:
        raise AssertionError("an ElevenLabs client was built while unconfigured")

    monkeypatch.setattr(eve, "EveClient", _boom)
    out = await eve.prune_stale_kb_docs(max_age_s=24 * HOUR)
    assert out["deleted"] == 0
    assert "not configured" in out["skipped"]


@pytest.mark.asyncio
async def test_deletes_only_stale_session_docs_and_keeps_the_newest() -> None:
    docs = [
        _doc("s-new", "Eve Session: Chapter 3", 1),  # fresh
        _doc("s-old1", "Eve Session: The Burial Mound", 30),
        _doc("s-old2", "Eve Session: Aqueducts blog", 72),
        _doc("manual", "Series style guide", 500),  # not a session doc — never touched
    ]
    fake = _FakeElevenLabs(docs)
    out = await eve.prune_stale_kb_docs(max_age_s=24 * HOUR, client=fake, now=NOW)
    assert out == {"scanned": 3, "deleted": 2, "failed": 0, "kept": 1}
    assert {d["id"] for d in fake.docs} == {"s-new", "manual"}


@pytest.mark.asyncio
async def test_the_newest_session_doc_survives_even_when_stale() -> None:
    """It may be the doc a call is using right now; the next callback replaces it anyway."""
    fake = _FakeElevenLabs([_doc("a", "Eve Session: A", 90), _doc("b", "Eve Session: B", 48)])
    out = await eve.prune_stale_kb_docs(max_age_s=24 * HOUR, client=fake, now=NOW)
    assert out["deleted"] == 1
    assert [d["id"] for d in fake.docs] == ["b"]


@pytest.mark.asyncio
async def test_follows_pagination() -> None:
    docs = [_doc(f"s{i}", f"Eve Session: {i}", 25 + i) for i in range(7)]
    fake = _FakeElevenLabs(docs, page_size=2)
    out = await eve.prune_stale_kb_docs(max_age_s=24 * HOUR, client=fake, now=NOW)
    assert out["scanned"] == 7 and out["deleted"] == 6
    gets = [c for c in fake.calls if c[0] == "GET"]
    assert len(gets) == 4  # 7 docs at 2 per page
    assert gets[1][2]["params"]["cursor"] == "2"


@pytest.mark.asyncio
async def test_a_doc_still_in_use_is_counted_not_forced() -> None:
    fake = _FakeElevenLabs(
        [
            _doc("new", "Eve Session: new", 1),
            _doc("busy", "Eve Session: busy", 40),
            _doc("old", "Eve Session: old", 50),
        ],
        in_use={"busy"},
    )
    out = await eve.prune_stale_kb_docs(max_age_s=24 * HOUR, client=fake, now=NOW)
    assert out["deleted"] == 1 and out["failed"] == 1
    deletes = [c for c in fake.calls if c[0] == "DELETE"]
    assert all("force" not in c[1] and not (c[2].get("params") or {}).get("force") for c in deletes)


@pytest.mark.asyncio
async def test_undated_docs_are_left_alone() -> None:
    fake = _FakeElevenLabs([{"id": "x", "name": "Eve Session: no date"}, _doc("y", "Eve Session: y", 2)])
    out = await eve.prune_stale_kb_docs(max_age_s=24 * HOUR, client=fake, now=NOW)
    assert out["deleted"] == 0 and {d["id"] for d in fake.docs} == {"x", "y"}


@pytest.mark.asyncio
async def test_configured_path_never_touches_an_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    """With a key AND agent configured the prune runs for real (against the mock) — and still makes
    no agent request: no PATCH, no first_message, no outbound call. KB documents only."""
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    monkeypatch.setenv("ELEVENLABS_AGENT_ID", "agent_test")
    fake = _FakeElevenLabs([_doc("new", "Eve Session: n", 1), _doc("old", "Eve Session: o", 100)])
    monkeypatch.setattr(eve, "EveClient", lambda cfg: fake)
    out = await eve.prune_stale_kb_docs(max_age_s=24 * HOUR, now=NOW)
    assert out["deleted"] == 1
    assert not [c for c in fake.calls if "/agents/" in c[1] or c[0] in ("PATCH", "POST")]


@pytest.mark.asyncio
async def test_scheduler_shows_the_skip_in_admin_status() -> None:
    """/admin/scheduler reports the job's last result, so 'skipped: not configured' is visible."""

    async def run() -> dict[str, Any]:
        return await eve.prune_stale_kb_docs(max_age_s=24 * HOUR)

    job = scheduler.Job(name="eve-kb-prune", interval_s=21600, run=run)
    sched = scheduler.Scheduler([job])
    await sched.tick(job)
    status = sched.status()["jobs"][0]  # type: ignore[index]
    assert status["name"] == "eve-kb-prune" and status["ticks"] == 1 and status["last_error"] is None
    assert "not configured" in status["last_result"]["skipped"]


def test_orchestrator_registers_the_prune_job() -> None:
    from orchestrator.main import app

    jobs = {j.name: j for j in app.state.cron_jobs}
    assert "eve-kb-prune" in jobs
    assert jobs["eve-kb-prune"].interval_s == 21600.0 and jobs["eve-kb-prune"].singleton
