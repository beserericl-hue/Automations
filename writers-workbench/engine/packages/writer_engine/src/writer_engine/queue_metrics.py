"""Queue-depth metrics and the scaling policy they feed (B12).

Before this, the only queue visibility was `/admin/dashboard`, which is admin-token gated and
computed on demand — so "add an instance" was guesswork, and nothing a scraper or an autoscaler
could read. Two things were missing: a cheap sample, and a rule for what the sample means.

**The sample is cheap on purpose.** `/admin/dashboard` asked Redis for the status of every queued
job — one round trip per job, so a 500-deep queue cost 500 round trips to render an admin page. This
module takes two round trips per queue instead:

* ``ZCARD <queue>`` — the depth. arq keeps a job in the sorted set while it runs, so depth is
  waiting *plus* running, which is why the health record below is needed to tell them apart.
* ``GET <queue>:health-check`` — arq's own worker heartbeat, which already carries
  ``j_ongoing`` (tasks in flight in that worker) and ``j_complete`` / ``j_failed`` counters.

``ZRANGE … WITHSCORES`` adds a third for the oldest score in the set, which is the best single
autoscaling signal: a queue 40 deep that turns over in seconds is healthy; one 3 deep whose oldest
item has sat for four minutes is not.

**The policy matters more than the metric.** The obvious rule — depth up, add replicas — is wrong
here, and expensively so. B9: throughput on the heavy queue is bounded by *account-wide* Anthropic
output TPM, not by this container. A second instance competing for the same token budget adds
scheduling overhead and no chapters. So heavy-queue depth is read as a TPM-bound signal (the levers
are tier, model mix, BYOK) while interactive-queue saturation is read as an instance-bound signal
(the lever is a replica). Those are different verdicts from the same shape of number, which is
exactly why a generic "scale on queue depth" rule would have been a bill rather than a fix.
"""

from __future__ import annotations

import re
import time
from dataclasses import asdict, dataclass
from typing import Any

from prometheus_client import Gauge

from writer_engine.queues import ALL_QUEUES, QUEUE_HEAVY, profile_for
from writer_engine.telemetry.logging import get_logger

logger = get_logger("queue_metrics")

QUEUE_DEPTH = Gauge(
    "engine_queue_depth",
    "Jobs in the queue's sorted set (waiting + running).",
    labelnames=("queue",),
)
QUEUE_RUNNING = Gauge(
    "engine_queue_running",
    "Jobs in flight, from the arq worker's own heartbeat (j_ongoing).",
    labelnames=("queue",),
)
QUEUE_WAITING = Gauge(
    "engine_queue_waiting",
    "Jobs waiting for a slot (depth - running, floored at 0).",
    labelnames=("queue",),
)
QUEUE_SATURATION = Gauge(
    "engine_queue_saturation",
    "Running / max_jobs for the queue's worker. 1.0 means every slot is busy.",
    labelnames=("queue",),
)
BUDGET_STALLS = Gauge(
    "engine_llm_budget_stalls",
    "LLM calls that had to wait for token capacity in the last minute (0 = the token budget is not "
    "the constraint).",
)
QUEUE_OLDEST_WAIT = Gauge(
    "engine_queue_oldest_wait_seconds",
    "Age of the oldest item in the queue, by its arq score (eligible-at time).",
    labelnames=("queue",),
)

_HEALTH_FIELD = re.compile(r"\b(j_complete|j_failed|j_retried|j_ongoing|queued)=(\d+)")


def parse_health(raw: str | bytes | None) -> dict[str, int]:
    """Pull the counters out of an arq health record. ``{}`` when there is no usable record.

    The record is a human-readable line arq writes for logging
    (``Oct-18 17:00:00 j_complete=12 j_failed=0 j_retried=0 j_ongoing=2 queued=3``), so it is parsed
    defensively: a format change must degrade to "running unknown", never raise in a metrics sampler.
    """
    if not raw:
        return {}
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    return {m.group(1): int(m.group(2)) for m in _HEALTH_FIELD.finditer(text)}


@dataclass(frozen=True)
class QueueSample:
    """One queue, one moment."""

    queue: str
    depth: int
    running: int | None
    waiting: int | None
    max_jobs: int
    saturation: float | None
    oldest_wait_s: float | None
    completed: int | None
    failed: int | None
    error: str = ""
    instances: int = 0
    """Workers on this queue with a live heartbeat. ``max_jobs`` is per instance times this."""

    def as_dict(self) -> dict[str, Any]:
        out = asdict(self)
        if not self.error:
            out.pop("error")
        return out


async def read_heartbeats(redis: Any, health_key: str) -> list[dict[str, int]]:
    """Every live worker heartbeat for one queue: ``<health_key>:<instance>`` per replica (C1), plus
    the bare ``<health_key>`` an instance on the previous release still writes until it is replaced.

    With one key per queue, two replicas overwrote each other and the fleet looked like whichever one
    wrote last — half its real size, or double its real load, depending on timing.
    """
    from writer_engine.fleet import scan_keys

    keys = [health_key, *sorted(await scan_keys(redis, f"{health_key}:*"))]
    beats: list[dict[str, int]] = []
    for key in keys:
        health = parse_health(await redis.get(key))
        if health:
            beats.append(health)
    return beats


def _total(beats: list[dict[str, int]], field: str) -> int | None:
    values = [b[field] for b in beats if field in b]
    return sum(values) if values else None


async def sample_queue(redis: Any, queue: str, *, health_key: str) -> QueueSample:
    """Sample one queue across every instance. Never raises — a metrics read must not break a page.

    Two round trips plus one per live worker: ZCARD, SCAN for the per-instance heartbeats, a GET for
    each, and ZRANGE for the oldest item.
    """
    profile = profile_for(queue)
    try:
        depth = int(await redis.zcard(queue) or 0)
        beats = await read_heartbeats(redis, health_key)
        health: dict[str, int] = {}
        for field in ("j_ongoing", "j_complete", "j_failed"):
            total = _total(beats, field)
            if total is not None:
                health[field] = total
        oldest: float | None = None
        if depth:
            head = await redis.zrange(queue, 0, 0, withscores=True)
            if head:
                # arq's score is the millisecond timestamp at which the job becomes eligible, so a
                # deferred job that is not due yet reads as a NEGATIVE wait. Clamp it: a job waiting
                # for its own schedule is not a backlog.
                score = float(head[0][1])
                oldest = max(0.0, (time.time() * 1000 - score) / 1000)
    except Exception as exc:
        return QueueSample(
            queue=queue,
            depth=0,
            running=None,
            waiting=None,
            max_jobs=profile.max_jobs,
            saturation=None,
            oldest_wait_s=None,
            completed=None,
            failed=None,
            error=f"{type(exc).__name__}: {str(exc)[:120]}",
        )

    running = health.get("j_ongoing")
    waiting = max(0, depth - running) if running is not None else None
    # Slots are per worker, so the fleet has one profile's worth per live instance.
    fleet_slots = profile.max_jobs * max(1, len(beats))
    saturation = (running / fleet_slots) if running is not None and fleet_slots else None
    return QueueSample(
        queue=queue,
        depth=depth,
        running=running,
        waiting=waiting,
        max_jobs=fleet_slots,
        saturation=round(saturation, 3) if saturation is not None else None,
        oldest_wait_s=round(oldest, 1) if oldest is not None else None,
        completed=health.get("j_complete"),
        failed=health.get("j_failed"),
        instances=len(beats),
    )


def publish(sample: QueueSample) -> None:
    """Set the gauges for one sample. Unknown values are left at their previous reading rather than
    written as 0, because a 0 from a failed scrape is indistinguishable from an idle queue."""
    if sample.error:
        return
    QUEUE_DEPTH.labels(queue=sample.queue).set(sample.depth)
    if sample.running is not None:
        QUEUE_RUNNING.labels(queue=sample.queue).set(sample.running)
    if sample.waiting is not None:
        QUEUE_WAITING.labels(queue=sample.queue).set(sample.waiting)
    if sample.saturation is not None:
        QUEUE_SATURATION.labels(queue=sample.queue).set(sample.saturation)
    if sample.oldest_wait_s is not None:
        QUEUE_OLDEST_WAIT.labels(queue=sample.queue).set(sample.oldest_wait_s)


async def budget_stalls(redis: Any) -> int:
    """How many LLM calls actually had to wait for token capacity in the last minute.

    THE signal that separates "the account's token budget is the ceiling" from "somebody queued 96
    jobs into 8 slots". Written by the budgets themselves (`window.record_stall`) because they live
    in another process, so a per-process Prometheus counter could not answer it.
    """
    try:
        from writer_engine.rate_limit import window

        return int(await window.stalls_in_window(redis))
    except Exception:
        return 0


async def sample_all(redis: Any, *, health_key_for: Any) -> list[QueueSample]:
    """Sample every live queue and publish the gauges. ``health_key_for(queue) -> str``."""
    samples = [await sample_queue(redis, q, health_key=health_key_for(q)) for q in ALL_QUEUES]
    for s in samples:
        publish(s)
    stalls = await budget_stalls(redis)
    BUDGET_STALLS.set(stalls)
    return samples


# --- the policy ---------------------------------------------------------------------------------

SATURATION_SCALE_OUT = 0.9
"""Every slot busy. Below this there is spare capacity in the instance already running."""

INTERACTIVE_WAIT_SCALE_OUT_S = 60.0
"""A user is sitting in front of an interactive op. A minute in the queue — before any generation —
is the point at which a replica is cheaper than the complaint."""

HEAVY_WAIT_TPM_BOUND_S = 300.0
"""Past this, heavy work is waiting on tokens, not on slots. The llm budget's own max wait is 300s
(`llm_budget_max_wait_s`), so a heavy job queued longer than that is queued behind the account's TPM
and a second instance would share the same ceiling."""

SCALE_IN_SATURATION = 0.25
"""Sustained headroom. Deliberately far below SCALE_OUT so the two cannot oscillate."""


def scaling_advice(samples: list[QueueSample], *, stalls: int = 0) -> dict[str, Any]:
    """Turn samples into one verdict with a reason, for an operator or an autoscaler.

    Verdicts: ``scale_out`` (add a runtime replica — B7's drain must land first), ``tpm_bound``
    (adding replicas will not help; the levers are the Anthropic tier, a cheaper model mix per B9's
    `hybrid-draft-polish`, or BYOK), ``backlog`` (the queue is simply deeper than its slots — the
    work is arriving faster than it can be done, and nothing is throttling), ``hold``, ``scale_in``,
    and ``unknown`` when no worker heartbeat was readable.

    ``stalls`` is how many LLM calls actually waited for token capacity in the last minute, and
    ``tpm_bound`` now REQUIRES it to be non-zero. Measured during a 96-chapter run: 89 jobs queued
    for 8 slots, oldest wait 429s, and zero stalls — the old rule read queue age as token pressure
    and would have sent somebody to buy a higher Anthropic tier for a queue that was merely deep.
    Queue age under a bulk submission is depth, not throttling.
    """
    usable = [s for s in samples if not s.error and s.running is not None]
    if not usable:
        return {
            "verdict": "unknown",
            "reason": "no readable worker heartbeat — cannot tell a busy queue from a dead worker",
            "queues": [s.as_dict() for s in samples],
        }

    reasons: list[str] = []
    verdict = "hold"
    for s in usable:
        waited = s.oldest_wait_s or 0.0
        if s.queue == QUEUE_HEAVY:
            # Depth here is expected and fine: the heavy queue exists to absorb a 96-chapter batch.
            if waited >= HEAVY_WAIT_TPM_BOUND_S and (s.saturation or 0) >= SATURATION_SCALE_OUT:
                if stalls > 0:
                    verdict = "tpm_bound"
                    reasons.append(
                        f"{s.queue}: {s.waiting} waiting, oldest {waited:.0f}s, every slot busy, and "
                        f"{stalls} call(s) waited for token capacity in the last minute — bounded by "
                        "the account's output budget, so another replica shares the same ceiling (B9)"
                    )
                else:
                    verdict = "backlog"
                    reasons.append(
                        f"{s.queue}: {s.waiting} waiting, oldest {waited:.0f}s, every slot busy, and "
                        "NO call waited for token capacity — this is depth, not throttling. The work "
                        f"is arriving faster than {s.max_jobs} slots can finish it; the levers are "
                        "more slots, more instances, or simply waiting"
                    )
        elif (s.saturation or 0) >= SATURATION_SCALE_OUT and waited >= INTERACTIVE_WAIT_SCALE_OUT_S:
            verdict = "scale_out"
            reasons.append(
                f"{s.queue}: {s.running}/{s.max_jobs} slots busy and the oldest job has waited "
                f"{waited:.0f}s — interactive work a user is waiting on is queueing"
            )

    if verdict == "hold" and all(
        (s.saturation or 0) <= SCALE_IN_SATURATION and not (s.waiting or 0) for s in usable
    ):
        verdict = "scale_in"
        reasons.append("every queue idle with slots to spare")

    return {
        "verdict": verdict,
        "reason": "; ".join(reasons) or "within capacity",
        "queues": [s.as_dict() for s in samples],
    }
