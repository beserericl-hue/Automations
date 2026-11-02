"""Every paid call becomes a labelled row — written as it happens, and kept when the job is cancelled."""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from writer_engine.schemas import StepInput, StepOutput
from writer_engine.telemetry import pricing
from writer_engine.telemetry import token_accounting as ta


@pytest.fixture
def sink(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Turn persistence on and capture the rows instead of writing them to Supabase."""
    rows: list[dict[str, Any]] = []

    async def _write(batch: list[dict[str, Any]]) -> int:
        await asyncio.sleep(0)  # a real write yields
        rows.extend(batch)
        return len(batch)

    monkeypatch.setattr(ta, "_persistence_enabled", lambda: True)
    monkeypatch.setattr(ta, "_write_rows", _write)
    ta.reset()
    ta._ORPHAN["pending"].clear()
    yield rows
    ta.reset()


async def test_rows_are_written_as_calls_complete_not_only_at_the_end(sink: list[dict[str, Any]]) -> None:
    ta.begin(user_id="u1", project_id="p1", chapter_number=3, workflow="chapter.qa", run_id="job-1")
    ta.record(
        provider="anthropic",
        model="claude-sonnet-4-6",
        input_tokens=1000,
        output_tokens=500,
        cache_read=2000,
        cache_write=100,
        cache_write_1h=50,
        request_id="msg_1",
    )
    await ta.wait_for_writes()
    assert len(sink) == 1, "the row must be written before the job ends"
    row = sink[0]
    assert row["operation"] == row["workflow_name"] == "chapter.qa"
    assert (row["user_id"], row["project_id"], row["chapter_number"], row["run_id"]) == (
        "u1",
        "p1",
        3,
        "job-1",
    )
    assert (row["provider"], row["model"], row["request_id"]) == ("anthropic", "claude-sonnet-4-6", "msg_1")
    assert row["cost_source"] == "computed" and row["source"] == "engine"
    expected = (1000 * 3 + 500 * 15 + 2000 * 0.3 + 100 * 3.75 + 50 * 6) / 1e6
    assert row["cost_usd"] == pytest.approx(expected)
    assert row["unit_prices"]["per_mtok"]["input"] == 3.0
    assert row["unit_prices"]["source"].startswith("https://platform.claude.com")
    snap = await ta.flush()
    assert snap["calls"] == 1 and len(sink) == 1, "flush must not write the row twice"


async def test_usage_survives_cancellation_of_a_step(sink: list[dict[str, Any]]) -> None:
    """The worker's HTTP call times out -> the step's request task is cancelled. CancelledError is a
    BaseException, so the old except-Exception flush never ran and the job's rows were lost."""
    from writer_engine.step_service import build_step_app

    started = asyncio.Event()

    async def handler(inp: StepInput) -> StepOutput:
        from writer_engine.telemetry import token_accounting

        token_accounting.record(
            provider="anthropic", model="claude-sonnet-4-6", input_tokens=900, output_tokens=400
        )
        started.set()
        await asyncio.sleep(3600)  # the long QA pass the timeout kills
        raise AssertionError("unreachable")

    monkey_rows_before = len(sink)
    app = build_step_app("chapter", handler)
    endpoint = next(r.endpoint for r in app.routes if getattr(r, "path", "") == "/run")  # type: ignore[attr-defined]
    inp = StepInput(
        execution_id=uuid.uuid4(),
        step_name="chapter",
        payload={"op": "qa", "user_id": "u1", "project_id": "p1", "run_id": "job-9"},
    )
    task = asyncio.create_task(endpoint(inp))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await ta.wait_for_writes()
    new = sink[monkey_rows_before:]
    assert len(new) == 1
    assert new[0]["operation"] == "chapter.qa" and new[0]["run_id"] == "job-9"
    assert new[0]["input_tokens"] == 900


async def test_a_failed_write_is_retried_at_flush(monkeypatch: pytest.MonkeyPatch) -> None:
    written: list[dict[str, Any]] = []
    fail = {"left": 1}

    async def flaky(batch: list[dict[str, Any]]) -> int:
        if fail["left"]:
            fail["left"] -= 1
            raise RuntimeError("supabase blip")
        written.extend(batch)
        return len(batch)

    monkeypatch.setattr(ta, "_persistence_enabled", lambda: True)
    monkeypatch.setattr(ta, "_write_rows", flaky)
    ta.begin(user_id="u1", workflow="research.run")
    ta.record(provider="anthropic", model="claude-sonnet-4-6", input_tokens=1, output_tokens=1)
    await ta.wait_for_writes()
    assert written == []
    await ta.flush()
    assert len(written) == 1


async def test_a_call_with_no_context_is_written_as_unattributed(sink: list[dict[str, Any]]) -> None:
    ta.reset()
    ta.record(provider="gemini", model="gemini-2.5-flash", input_tokens=100, output_tokens=10)
    await ta.wait_for_writes()
    assert len(sink) == 1
    assert sink[0]["operation"] == "unattributed.gemini" and sink[0]["user_id"] is None


async def test_unknown_model_is_written_flagged_unpriced(sink: list[dict[str, Any]]) -> None:
    ta.begin(user_id="u1", workflow="chapter.write")
    ta.record(provider="anthropic", model="claude-next", input_tokens=10, output_tokens=10)
    snap = await ta.flush()
    assert sink[0]["cost_source"] == "unpriced" and sink[0]["cost_usd"] == 0.0
    assert snap["unpriced_calls"] == 1


async def test_scope_labels_hub_calls_and_restores_the_outer_context(sink: list[dict[str, Any]]) -> None:
    ta.begin(user_id="u1", workflow="outer.op")
    async with ta.scope(workflow="hub.route.chat", user_id="u2"):
        ta.record(provider="gemini", model="gemini-2.5-flash", input_tokens=5, output_tokens=5)
    assert ta._ctx.get()["workflow"] == "outer.op"  # type: ignore[index]
    await ta.wait_for_writes()
    assert sink[-1]["operation"] == "hub.route.chat" and sink[-1]["user_id"] == "u2"
    await ta.flush()


async def test_unit_rows_for_words_credits_and_images(sink: list[dict[str, Any]]) -> None:
    from media_step.main import _record_kie_cost

    from writer_engine.humanize import _record_humanize_cost
    from writer_engine.scraping import _record_scrape_cost

    ta.begin(user_id="u1", project_id="p1", workflow="media.cover-art")
    _record_humanize_cost({"wordsSpent": 610, "billingMode": "payg"}, model="standard", chunk_words=300)
    _record_scrape_cost(10, render=True, status=200)
    _record_scrape_cost(0, render=False, status=200)
    _record_kie_cost("task-1", {"state": "success", "creditsConsumed": 4}, succeeded=True)
    _record_kie_cost("task-2", {"state": "fail"}, succeeded=False)  # unbilled failure: no row
    await ta.flush()
    by = {(r["provider"], r.get("request_id")): r for r in sink}
    hum = by[("stealthgpt", None)]
    assert (hum["units"], hum["unit_type"], hum["cost_usd"]) == (610.0, "words", pytest.approx(0.122))
    scrapes = [r for r in sink if r["provider"] == "scraperapi"]
    assert [r["units"] for r in scrapes] == [10.0, 1.0]
    assert scrapes[0]["cost_source"] == "computed" and scrapes[1]["cost_source"] == "estimated"
    kie = by[("kieai", "task-1")]
    assert (kie["units"], kie["unit_type"], kie["cost_usd"], kie["cost_source"]) == (
        1.0,
        "images",
        0.02,
        "computed",
    )
    assert kie["metadata"]["credits"] == 4.0
    assert ("kieai", "task-2") not in by


async def test_embeddings_record_billed_tokens(
    sink: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    ta.begin(user_id="u1", workflow="chapter.write")
    ta.record_units(
        provider="openai", model="text-embedding-3-small", units=1500, unit_type="tokens", input_tokens=1500
    )
    await ta.flush()
    assert sink[0]["cost_usd"] == pytest.approx(1500 * 0.02 / 1e6)
    assert sink[0]["input_tokens"] == 1500


async def test_perplexity_adapter_records_the_reported_cost(sink: list[dict[str, Any]]) -> None:
    from writer_engine.llm.perplexity_client import PerplexityAdapter
    from writer_engine.llm.router import LLMRouter

    body = {
        "id": "pplx-1",
        "model": "sonar-pro",
        "choices": [{"message": {"content": "1969."}}],
        "usage": {
            "prompt_tokens": 12,
            "completion_tokens": 16,
            "search_context_size": "low",
            "cost": {
                "input_tokens_cost": 0.00118,
                "output_tokens_cost": 5e-05,
                "request_cost": 0.0025,
                "total_cost": 0.00373,
            },
        },
    }

    async def post(*_a: Any, **_k: Any) -> httpx.Response:
        return httpx.Response(200, json=body, request=httpx.Request("POST", "https://api.perplexity.ai"))

    adapter = PerplexityAdapter(api_key="k")
    adapter._client = SimpleNamespace(post=post)  # type: ignore[assignment]
    router = LLMRouter()
    router.register(adapter)
    ta.begin(user_id="u1", workflow="research.run")
    await router.complete(provider="perplexity", model="sonar-pro", prompt="When?")
    await ta.flush()
    row = sink[0]
    assert (row["cost_usd"], row["cost_source"], row["request_id"]) == (
        0.00373,
        "provider_reported",
        "pplx-1",
    )


async def test_gemini_counts_thinking_tokens_as_output(sink: list[dict[str, Any]]) -> None:
    from writer_engine.llm.gemini_client import GeminiAdapter

    usage = SimpleNamespace(
        prompt_token_count=1000,
        candidates_token_count=50,
        thoughts_token_count=400,
        cached_content_token_count=200,
    )

    async def generate_content(**_kw: Any) -> Any:
        return SimpleNamespace(text="{}", usage_metadata=usage, response_id="g-1")

    client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate_content)))
    out = await GeminiAdapter(client=client).complete(model="gemini-2.5-flash", system=None, prompt="hi")
    assert (out.input_tokens, out.output_tokens, out.cache_read_tokens) == (800, 450, 200)
    cost = pricing.token_cost(
        "gemini", "gemini-2.5-flash", input_tokens=800, output_tokens=450, cache_read=200
    )
    assert cost.cost_usd == pytest.approx((800 * 0.3 + 450 * 2.5 + 200 * 0.03) / 1e6)


def test_persist_token_usage_ignores_a_duplicate_request_id() -> None:
    from writer_engine.persist_helpers import persist_token_usage

    seen: list[dict[str, Any]] = []

    class _Ins:
        def __init__(self, rows: Any) -> None:
            self.rows = rows if isinstance(rows, list) else [rows]

        async def execute(self) -> Any:
            for r in self.rows:
                if r.get("request_id") and any(s.get("request_id") == r["request_id"] for s in seen):
                    raise RuntimeError("duplicate key value violates unique constraint (23505)")
                seen.append(r)
            return SimpleNamespace(data=self.rows)

    class _Client:
        def table(self, _name: str) -> Any:
            return SimpleNamespace(insert=lambda rows: _Ins(rows))

    row = {"provider": "kieai", "request_id": "t1", "cost_usd": 0.02}
    asyncio.run(persist_token_usage(_Client(), rows=[row]))
    asyncio.run(persist_token_usage(_Client(), rows=[dict(row)]))  # KIE status polled twice
    assert len(seen) == 1
