"""Newsletter + ingestion cost rows carry the owner (token_usage_v2.user_id).

Every row written by a newsletter step (pick, subject, segment + its humanize pass, assemble's intro
and roundup) had ``user_id`` NULL on DEV: the saga never told the steps who the edition belonged to,
and the step template takes the owner from the payload. Ingestion had the same gap: one tick walks
feeds owned by different users, and its context had no owner at all.

These tests pin the three links: the saga sends the owner on every step call, the template turns it
into the row's ``user_id`` + metadata, and an ingestion feed bills its calls to the feed's owner.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from writer_engine.ingestion import pipeline, store
from writer_engine.schemas import StepInput, StepOutput
from writer_engine.step_service import build_step_app
from writer_engine.telemetry import token_accounting

SECRET = "test-secret"


@pytest.fixture
def rows(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Capture the rows token_accounting would write to token_usage_v2."""
    captured: list[dict[str, Any]] = []

    async def _write(batch: list[dict[str, Any]]) -> int:
        captured.extend(batch)
        return len(batch)

    monkeypatch.setattr(token_accounting, "_persistence_enabled", lambda: True)
    monkeypatch.setattr(token_accounting, "_write_rows", _write)
    token_accounting.reset()
    return captured


def _record(model: str = "claude-sonnet-4-6") -> None:
    token_accounting.record(provider="anthropic", model=model, input_tokens=10, output_tokens=5)


# ------------------------------------------------------------------------------- attribute()


@pytest.mark.asyncio
async def test_attribute_bills_calls_to_the_named_owner(rows: list[dict[str, Any]]) -> None:
    async with token_accounting.scope(workflow="ingestion.run", run_id="job-1"):
        _record()
        with token_accounting.attribute(user_id="+1", metadata={"edition_id": "ed-a"}):
            _record()
            with token_accounting.attribute(metadata={"feed_source_id": "f-1"}):
                _record()  # inner block keeps the outer owner, adds its own tag
        _record()
    await token_accounting.wait_for_writes()

    assert [r["user_id"] for r in rows] == [None, "+1", "+1", None]
    assert {r["run_id"] for r in rows} == {"job-1"}
    assert rows[1]["metadata"]["edition_id"] == "ed-a"
    assert rows[2]["metadata"]["edition_id"] == "ed-a"
    assert rows[2]["metadata"]["feed_source_id"] == "f-1"
    assert "edition_id" not in rows[3]["metadata"]


@pytest.mark.asyncio
async def test_attribute_is_task_local_under_gather(rows: list[dict[str, Any]]) -> None:
    """Parallel children of one context must not bill each other's owner."""

    async def work(owner: str) -> None:
        with token_accounting.attribute(user_id=owner):
            await asyncio.sleep(0)
            _record()
            await asyncio.sleep(0)
            _record()

    async with token_accounting.scope(workflow="ingestion.run"):
        await asyncio.gather(work("+1"), work("+2"))
    await token_accounting.wait_for_writes()

    by_owner: dict[str, int] = {}
    for r in rows:
        by_owner[r["user_id"]] = by_owner.get(r["user_id"], 0) + 1
    assert by_owner == {"+1": 2, "+2": 2}


@pytest.mark.asyncio
async def test_context_metadata_lands_on_every_row(rows: list[dict[str, Any]]) -> None:
    async with token_accounting.scope(workflow="x", user_id="+9", metadata={"edition_id": "ed-z"}):
        _record()
    await token_accounting.wait_for_writes()
    assert rows[0]["user_id"] == "+9"
    assert rows[0]["metadata"]["edition_id"] == "ed-z"


# ------------------------------------------------------------------------------- step template


def _post(handler: Any, payload: dict[str, Any], name: str = "segment") -> Any:
    client = TestClient(build_step_app(name, handler))
    return client.post(
        "/run",
        headers={"x-service-secret": SECRET},
        json={"execution_id": str(uuid.uuid4()), "step_name": name, "payload": payload},
    )


async def _paid_handler(inp: StepInput) -> StepOutput:
    _record()
    return StepOutput(execution_id=inp.execution_id, step_name=inp.step_name, payload={})


def test_template_takes_the_owner_from_the_accounting_block(rows: list[dict[str, Any]]) -> None:
    resp = _post(
        _paid_handler,
        {
            "story": {},
            "accounting": {
                "user_id": "+14105914612",
                "metadata": {"pipeline": "newsletter", "edition_id": "wasteland-wire"},
            },
        },
    )
    assert resp.status_code == 200
    assert len(rows) == 1
    assert rows[0]["user_id"] == "+14105914612"
    assert rows[0]["metadata"]["edition_id"] == "wasteland-wire"
    assert rows[0]["metadata"]["pipeline"] == "newsletter"
    assert rows[0]["operation"] == "segment"


def test_template_payload_user_id_still_wins(rows: list[dict[str, Any]]) -> None:
    _post(_paid_handler, {"user_id": "+1", "accounting": {"user_id": "+2"}})
    assert rows[0]["user_id"] == "+1"


def test_template_ignores_a_malformed_accounting_block(rows: list[dict[str, Any]]) -> None:
    resp = _post(_paid_handler, {"accounting": "nonsense"})
    assert resp.status_code == 200
    assert rows[0]["user_id"] is None


# ------------------------------------------------------------------------------- saga


def test_newsletter_accounting_block() -> None:
    from orchestrator.newsletter_saga import newsletter_accounting

    st = {
        "cfg": {"user_id": "+1", "edition_id": "ed", "send_date": "2026-11-02"},
        "send_row": {"id": "send-9"},
    }
    assert newsletter_accounting(st) == {
        "user_id": "+1",
        "metadata": {
            "pipeline": "newsletter",
            "edition_id": "ed",
            "send_date": "2026-11-02",
            "send_id": "send-9",
        },
    }
    assert newsletter_accounting({"cfg": {}})["user_id"] is None


@pytest.mark.asyncio
async def test_saga_sends_the_owner_on_every_step_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every step the saga calls gets the edition owner, whatever stage it is in."""
    from orchestrator import newsletter_saga
    from orchestrator.newsletter_saga import NewsletterSagaDriver
    from writer_engine.state_machine.durable import InMemorySagaRepo

    seen: list[tuple[str, dict[str, Any]]] = []

    def _transport(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append((body["step_name"], body["payload"]))
        return httpx.Response(
            200,
            json={
                "execution_id": body["execution_id"],
                "step_name": body["step_name"],
                "status": "ok",
                "payload": {"articles": []},
            },
        )

    real_init = httpx.AsyncClient.__init__

    def _init(self: httpx.AsyncClient, *args: object, **kwargs: object) -> None:
        kwargs["transport"] = httpx.MockTransport(_transport)
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", _init)
    for name in ("GATHER", "PICK"):
        monkeypatch.setenv(f"{name}_STEP_URL", f"http://{name.lower()}-step")

    driver = NewsletterSagaDriver(InMemorySagaRepo())
    eid = await driver.start(cfg={"edition_id": "ed-1", "send_date": "2026-11-02", "user_id": "+7"})
    await driver.advance(eid)  # gather returns no articles -> SKIPPED_NO_CONTENT

    assert seen and seen[0][0] == "gather"
    acct = seen[0][1]["accounting"]
    assert acct["user_id"] == "+7"
    assert acct["metadata"]["edition_id"] == "ed-1"

    # And the direct helper adds it to an arbitrary step payload without dropping the step's own keys.
    st = {"cfg": {"user_id": "+7", "edition_id": "ed-1"}}
    out = await driver._run_step(
        st, newsletter_saga._step("pick"), execution_id=eid, payload={"articles": [1]}
    )
    assert out.step_name == "pick"
    step, payload = seen[-1]
    assert step == "pick"
    assert payload["articles"] == [1]
    assert payload["accounting"]["user_id"] == "+7"


def test_every_saga_step_call_goes_through_the_accounting_helper() -> None:
    """A step call added later that bypasses _run_step would write owner-less rows again."""
    import inspect

    from orchestrator import newsletter_saga

    src = inspect.getsource(newsletter_saga.NewsletterSagaDriver)
    # The only direct call is the one inside _run_step itself.
    assert src.count("run_step_via_http(") == 1


# ------------------------------------------------------------------------------- ingestion


def _feed(user_id: str = "+14105914612", edition_id: str = "ai-news") -> store.FeedSource:
    return store.FeedSource.from_row(
        {
            "id": "feed-1",
            "user_id": user_id,
            "edition_id": edition_id,
            "name": "TechCrunch",
            "url": "https://example.com/feed.json",
            "url_type": "rss",
            "item_type": "article",
            "fetch_interval_minutes": 180,
        }
    )


@pytest.mark.asyncio
async def test_ingest_feed_bills_the_feed_owner(
    monkeypatch: pytest.MonkeyPatch, rows: list[dict[str, Any]]
) -> None:
    async def _fake(feed: store.FeedSource, **_: Any) -> pipeline.FeedRunResult:
        _record("claude-haiku-4-5")
        return pipeline.FeedRunResult(feed_id=feed.id, feed_name=feed.name)

    monkeypatch.setattr(pipeline, "_ingest_feed", _fake)
    async with token_accounting.scope(workflow="ingestion.run", run_id="tick-1"):
        await pipeline.ingest_feed(_feed("+1", "ed-a"))
        await pipeline.ingest_feed(_feed("+2", "ed-b"))
        _record()  # tick-level work outside any feed stays owner-less
    await token_accounting.wait_for_writes()

    assert [(r["user_id"], r["metadata"].get("edition_id")) for r in rows] == [
        ("+1", "ed-a"),
        ("+2", "ed-b"),
        (None, None),
    ]
    assert rows[0]["metadata"]["feed_source_id"] == "feed-1"
    assert {r["run_id"] for r in rows} == {"tick-1"}
