"""CR-007 — per-call token + cost accounting (token_usage_v2) and research topic-focus."""

from __future__ import annotations

import asyncio

from writer_engine.telemetry import token_accounting as ta


def test_cost_usd_sonnet_rates() -> None:
    # 1M output on Sonnet = $15; 1M cache-read = $0.30
    assert ta.cost_usd("claude-sonnet-4-6", 0, 1_000_000, 0, 0) == 15.0
    assert ta.cost_usd("claude-sonnet-4-6", 0, 0, 1_000_000, 0) == 0.30
    assert ta.cost_usd("claude-sonnet-4-6", 1_000_000, 0, 0, 0) == 3.0


def test_unknown_model_uses_fallback_rate() -> None:
    assert ta.cost_usd("some-future-model", 0, 1_000_000, 0, 0) == 15.0  # sonnet-class fallback


def test_record_and_snapshot_accumulate() -> None:
    ta.reset()
    ta.begin(user_id="u1", project_id="p1", chapter_number=5, workflow="chapter.write")
    ta.record(provider="anthropic", model="claude-sonnet-4-6",
              input_tokens=1000, output_tokens=2000, cache_read=5000, cache_write=1000)
    ta.record(provider="perplexity", model="sonar-pro",
              input_tokens=500, output_tokens=800)
    snap = ta.snapshot()
    assert snap["calls"] == 2
    assert snap["input_tokens"] == 1500 and snap["output_tokens"] == 2800
    assert snap["total_tokens"] == 1500 + 2800 + 5000 + 1000
    assert snap["cost_usd"] > 0


def test_record_noop_without_context() -> None:
    # recording with no active context must not raise and must not accumulate
    ta.reset()
    ta.record(provider="anthropic", model="claude-sonnet-4-6", input_tokens=10, output_tokens=10)
    assert ta.snapshot()["calls"] == 0


def test_flush_skips_without_user_id() -> None:
    ta.reset()
    ta.begin(user_id=None, workflow="chapter.write")
    ta.record(provider="anthropic", model="claude-sonnet-4-6", input_tokens=10, output_tokens=10)
    snap = asyncio.run(ta.flush())  # no user_id -> skip DB write, still returns totals
    assert snap["calls"] == 1 and snap["output_tokens"] == 10


def test_persist_token_usage_builds_rows() -> None:
    from writer_engine.persist_helpers import persist_token_usage

    class _Resp:
        def __init__(self) -> None:
            self.data = [{"id": "x"}]

    class _Ins:
        def __init__(self, sink, rows):
            self.sink = sink
            self.rows = rows

        async def execute(self):
            self.sink.extend(self.rows)
            return _Resp()

    class _Tbl:
        def __init__(self, sink):
            self.sink = sink

        def insert(self, rows):
            return _Ins(self.sink, rows)

    class _Client:
        def __init__(self):
            self.sink = []

        def table(self, name):
            assert name == "token_usage_v2"
            return _Tbl(self.sink)

    c = _Client()
    n = asyncio.run(persist_token_usage(
        c, user_id="u1", workflow="chapter.write",
        calls=[{"provider": "anthropic", "model": "claude-sonnet-4-6",
                "input_tokens": 100, "output_tokens": 200, "cache_read_tokens": 50,
                "cache_write_tokens": 10, "cost_usd": 0.01}],
        metadata={"project_id": "p1", "chapter_number": 5},
    ))
    assert n == 1
    row = c.sink[0]
    assert row["model"] == "claude-sonnet-4-6"
    assert row["total_tokens"] == 100 + 200 + 50 + 10
    assert row["metadata"]["project_id"] == "p1" and row["metadata"]["chapter_number"] == 5


def test_research_focus_anchors_to_premise() -> None:
    from chapter_step.main import _research_focus

    f = _research_focus({
        "outline": {"premise": "A Piscataway burial mound on the Maryland tidewater"},
        "genre_slug": "ancient-history",
        "roster": [{"name": "Tayak", "description": "Piscataway archaeologist"}],
    })
    assert "Piscataway" in f and "Maryland" in f
    assert "ancient-history" in f


def test_repair_weaves_research() -> None:
    # repair (_drift_correct_pass weave_research=True) must fetch + pass research into the correction
    import inspect

    from chapter_step import main
    # _correct_drift accepts research_facts and builds a weave block
    cd = inspect.getsource(main._correct_drift)
    assert "research_facts" in cd and "weave" in cd.lower()
    # _drift_correct_pass fetches research when weave_research is set and passes it through
    dc = inspect.getsource(main._drift_correct_pass)
    assert "weave_research" in dc and "_chapter_research" in dc and "research_facts=research_facts" in dc
    # repair op turns it on
    rep = inspect.getsource(main._op_repair)
    assert "weave_research=True" in rep


def test_research_prompt_has_topic_constraint() -> None:
    # the focus block must forbid Old-World analogues when a focus is supplied
    import inspect

    from chapter_step import main
    src = inspect.getsource(main._chapter_research)
    assert "HARD CONSTRAINT" in src and "Old-World" in src
