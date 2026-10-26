"""CR-010 C1/C4 — more than one runtime replica, and the autoscaler that sets how many.

What two replicas broke, each pinned here:

* the per-queue arq heartbeat was overwritten by whichever replica wrote last, so saturation and the
  scaling verdict described one instance, not the fleet;
* each replica ran its own scheduler, and the scheduled publisher does not claim its rows — two
  replicas would publish (and email) the same post twice;

and the autoscaler's rule, which must not add replicas for a token ceiling, must not remove one from
under a running chapter, and must never act on production by default.
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
from typing import Any

import fakeredis.aioredis
import pytest

from writer_engine import autoscale as A
from writer_engine import fleet
from writer_engine import queue_metrics as Q
from writer_engine.queues import QUEUE_HEAVY, QUEUE_INTERACTIVE
from writer_engine.scheduler import Job, Scheduler

KEY = "engine:arq:health-check"


def _beat(ongoing: int, complete: int = 5) -> str:
    return f"Oct-26 20:00:00 j_complete={complete} j_failed=0 j_retried=0 j_ongoing={ongoing} queued=0"


def _redis() -> Any:
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


# --- the fleet-wide sample ----------------------------------------------------------------------


def test_two_replicas_heartbeats_are_added_up_not_overwritten() -> None:
    async def go() -> Q.QueueSample:
        r = _redis()
        for i in range(10):
            await r.zadd(QUEUE_INTERACTIVE, {f"job-{i}": 0})
        await r.set(f"{KEY}:{QUEUE_INTERACTIVE}:replica-a", _beat(6))
        await r.set(f"{KEY}:{QUEUE_INTERACTIVE}:replica-b", _beat(4))
        return await Q.sample_queue(r, QUEUE_INTERACTIVE, health_key=f"{KEY}:{QUEUE_INTERACTIVE}")

    s = asyncio.run(go())
    assert s.instances == 2
    assert s.running == 10
    assert s.completed == 10
    # 24 slots per instance, two instances: 10 running is 10/48, not 10/24.
    assert s.max_jobs == 48
    assert s.saturation == round(10 / 48, 3)
    assert s.waiting == 0


def test_the_previous_releases_bare_key_still_counts_during_a_rollout() -> None:
    async def go() -> Q.QueueSample:
        r = _redis()
        await r.set(f"{KEY}:{QUEUE_HEAVY}", _beat(3))
        await r.set(f"{KEY}:{QUEUE_HEAVY}:replica-a", _beat(2))
        return await Q.sample_queue(r, QUEUE_HEAVY, health_key=f"{KEY}:{QUEUE_HEAVY}")

    s = asyncio.run(go())
    assert (s.instances, s.running, s.max_jobs) == (2, 5, 16)


def test_one_queues_heartbeats_do_not_leak_into_another() -> None:
    async def go() -> Q.QueueSample:
        r = _redis()
        await r.set(f"{KEY}:{QUEUE_HEAVY}:replica-a", _beat(8))
        await r.set(f"{KEY}:{QUEUE_INTERACTIVE}:replica-a", _beat(1))
        return await Q.sample_queue(r, QUEUE_INTERACTIVE, health_key=f"{KEY}:{QUEUE_INTERACTIVE}")

    s = asyncio.run(go())
    assert (s.instances, s.running) == (1, 1)


# --- the registry and the lock ------------------------------------------------------------------


def test_instances_register_with_a_ttl_and_are_listed(monkeypatch: pytest.MonkeyPatch) -> None:
    async def go() -> tuple[list[dict[str, Any]], int]:
        r = _redis()
        monkeypatch.setenv("RAILWAY_REPLICA_ID", "replica-a")
        await fleet.register(r, "orchestrator", running={QUEUE_HEAVY: 1})
        monkeypatch.setenv("RAILWAY_REPLICA_ID", "replica-b")
        await fleet.register(r, "orchestrator")
        await fleet.register(r, "gateway")
        ttl = await r.ttl("engine:fleet:orchestrator:replica-a")
        return await fleet.read_fleet(r), ttl

    rows, ttl = asyncio.run(go())
    assert sorted((x["service"], x["instance"]) for x in rows) == [
        ("gateway", "replica-b"),
        ("orchestrator", "replica-a"),
        ("orchestrator", "replica-b"),
    ]
    assert 0 < ttl <= fleet.REGISTRATION_TTL_S
    assert next(x for x in rows if x["instance"] == "replica-a")["running"] == {QUEUE_HEAVY: 1}


def test_instance_id_is_safe_in_a_redis_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RAILWAY_REPLICA_ID", "abc def:*/x")
    assert fleet.instance_id() == "abc-def---x"


def test_only_one_replica_gets_a_singleton_tick(monkeypatch: pytest.MonkeyPatch) -> None:
    async def go() -> list[bool]:
        r = _redis()
        monkeypatch.setenv("RAILWAY_REPLICA_ID", "replica-a")
        first = await fleet.run_once(r, "publish-scheduled", ttl_s=60)
        monkeypatch.setenv("RAILWAY_REPLICA_ID", "replica-b")
        second = await fleet.run_once(r, "publish-scheduled", ttl_s=60)
        other_job = await fleet.run_once(r, "ingestion", ttl_s=60)
        return [first, second, other_job]

    assert asyncio.run(go()) == [True, False, True]


def test_the_lock_fails_open_when_redis_is_down() -> None:
    class _Down:
        async def set(self, *_a: Any, **_k: Any) -> Any:
            raise ConnectionError("redis down")

    assert asyncio.run(fleet.run_once(_Down(), "ingestion", ttl_s=60)) is True


def test_two_schedulers_sharing_redis_run_a_singleton_once_and_a_local_job_twice() -> None:
    """The publisher bug: two replicas, one due post. One tick runs it; the other skips."""
    calls = {"publish": 0, "metrics": 0}

    async def publish() -> None:
        calls["publish"] += 1

    async def metrics() -> None:
        calls["metrics"] += 1

    async def go() -> list[dict[str, object]]:
        r = _redis()
        out = []
        for replica in ("replica-a", "replica-b"):

            async def lock(name: str, ttl: float, _rep: str = replica) -> bool:
                got = await r.set(f"{fleet.SINGLETON_PREFIX}:{name}", _rep, nx=True, px=int(ttl * 1000))
                return bool(got)

            sched = Scheduler(
                [Job("publish-scheduled", 900, publish), Job("queue-metrics", 30, metrics, singleton=False)],
                lock=lock,
            )
            for job in sched.jobs:
                await sched.tick(job)
            out.append(sched.status())
        return out

    statuses = asyncio.run(go())
    assert calls == {"publish": 1, "metrics": 2}
    b = {j["name"]: j for j in statuses[1]["jobs"]}  # type: ignore[index]
    assert b["publish-scheduled"]["skipped"] == 1
    assert b["queue-metrics"]["skipped"] == 0


# --- the decision rule --------------------------------------------------------------------------

CFG = A.AutoscaleConfig(
    enabled=True,
    min_replicas=2,
    max_replicas=4,
    scale_out_ticks=2,
    scale_in_after_s=900,
    cooldown_s=300,
    token="t",
    service_id="svc",
    environment_id="env",
    environment_name="develop",
)


def _advice(verdict: str, *, heavy_running: int = 0) -> dict[str, Any]:
    return {
        "verdict": verdict,
        "reason": "test",
        "queues": [
            {"queue": QUEUE_HEAVY, "running": heavy_running},
            {"queue": QUEUE_INTERACTIVE, "running": 0},
        ],
    }


def test_scale_out_needs_the_verdict_to_hold_for_the_streak() -> None:
    st = A.AutoscaleState()
    first = A.decide(_advice("scale_out"), current=2, cfg=CFG, state=st, now=1000)
    second = A.decide(_advice("scale_out"), current=2, cfg=CFG, state=st, now=1060)
    assert (first.action, first.target) == ("hold", 2)
    assert (second.action, second.target) == ("scale_out", 3)


def test_a_heavy_backlog_with_no_token_stalls_also_scales_out() -> None:
    st = A.AutoscaleState(out_streak=1)
    d = A.decide(_advice("backlog"), current=2, cfg=CFG, state=st, now=1000)
    assert (d.action, d.target) == ("scale_out", 3)


def test_a_token_ceiling_never_adds_a_replica() -> None:
    st = A.AutoscaleState(out_streak=5)
    d = A.decide(_advice("tpm_bound"), current=2, cfg=CFG, state=st, now=1000)
    assert (d.action, d.target) == ("hold", 2)
    assert st.out_streak == 0


def test_the_ceiling_and_the_cooldown_hold() -> None:
    at_max = A.decide(
        _advice("scale_out"), current=4, cfg=CFG, state=A.AutoscaleState(out_streak=3), now=1000
    )
    assert (at_max.action, at_max.target) == ("hold", 4)
    cooling = A.decide(
        _advice("scale_out"),
        current=2,
        cfg=CFG,
        state=A.AutoscaleState(out_streak=3, last_change_at=900),
        now=1000,
    )
    assert cooling.action == "hold" and "cooling" in cooling.reason


def test_scale_in_waits_for_sustained_idle_and_an_empty_heavy_queue() -> None:
    st = A.AutoscaleState()
    early = A.decide(_advice("scale_in"), current=3, cfg=CFG, state=st, now=1000)
    assert early.action == "hold"
    under_a_chapter = A.decide(_advice("scale_in", heavy_running=1), current=3, cfg=CFG, state=st, now=2000)
    assert under_a_chapter.action == "hold" and "heavy" in under_a_chapter.reason
    later = A.decide(_advice("scale_in"), current=3, cfg=CFG, state=st, now=2000)
    assert (later.action, later.target) == ("scale_in", 2)
    at_floor = A.decide(_advice("scale_in"), current=2, cfg=CFG, state=st, now=5000)
    assert (at_floor.action, at_floor.target) == ("hold", 2)


def test_a_fleet_below_the_floor_goes_back_up_at_once() -> None:
    d = A.decide(_advice("hold"), current=1, cfg=CFG, state=A.AutoscaleState(last_change_at=999), now=1000)
    assert (d.action, d.target) == ("floor", 2)


def test_production_is_refused_unless_explicitly_allowed() -> None:
    prod = A.AutoscaleConfig(**{**CFG.__dict__, "environment_name": "production"})
    assert "production" in prod.refusal()
    allowed = A.AutoscaleConfig(
        **{**CFG.__dict__, "environment_name": "production", "allow_production": True}
    )
    assert allowed.refusal() == ""
    assert "AUTOSCALE_ENABLED" in A.AutoscaleConfig().refusal()
    assert "token" not in json.dumps(CFG.public()).replace("token_set", "")


# --- one tick against a fake Railway ------------------------------------------------------------


class _FakeRailway:
    def __init__(self, replicas: int, *, fail_set: bool = False) -> None:
        self.replicas = replicas
        self.sets: list[int] = []
        self.fail_set = fail_set

    async def current(self) -> int:
        return self.replicas

    async def set_replicas(self, target: int) -> None:
        if self.fail_set:
            raise RuntimeError("railway said no")
        self.sets.append(target)
        self.replicas = target


def test_a_tick_scales_out_once_then_cools_down() -> None:
    async def go() -> tuple[list[dict[str, Any]], _FakeRailway]:
        r = _redis()
        rail = _FakeRailway(2)
        out = []
        for now in (1000, 1060, 1120, 1180):
            out.append(await A.tick(r, _advice("scale_out"), cfg=CFG, scaler=rail, now=now))  # type: ignore[arg-type]
        return out, rail

    out, rail = asyncio.run(go())
    assert [o["action"] for o in out] == ["hold", "scale_out", "hold", "hold"]
    assert rail.sets == [3]
    assert out[1]["acted"] is True


def test_a_refused_tick_never_calls_railway() -> None:
    rail = _FakeRailway(1)
    out = asyncio.run(A.tick(_redis(), _advice("scale_out"), cfg=A.AutoscaleConfig(), scaler=rail))  # type: ignore[arg-type]
    assert out["action"] == "refused"
    assert rail.sets == []


def test_a_failed_set_is_reported_and_does_not_start_the_cooldown() -> None:
    async def go() -> tuple[dict[str, Any], A.AutoscaleState]:
        r = _redis()
        out = await A.tick(r, _advice("hold"), cfg=CFG, scaler=_FakeRailway(1, fail_set=True), now=1000)  # type: ignore[arg-type]
        return out, await A.load_state(r)

    out, st = asyncio.run(go())
    assert out["action"] == "error"
    assert st.last_change_at is None


def test_scan_pattern_matches_what_redis_matches() -> None:
    """The sampler's SCAN pattern must not pick up a sibling queue whose name shares a prefix."""
    pattern = f"{KEY}:{QUEUE_HEAVY}:*"
    assert fnmatch.fnmatch(f"{KEY}:{QUEUE_HEAVY}:replica-a", pattern)
    assert not fnmatch.fnmatch(f"{KEY}:{QUEUE_INTERACTIVE}:replica-a", pattern)
