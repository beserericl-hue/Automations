"""Queue topology: heavy vs interactive, per-queue timeouts, and the dead-letter queue (B4/B5).

Everything used to run on ONE arq queue named ``newsletter`` with ``max_jobs=16`` and a uniform
``job_timeout=5400`` (90 minutes). Two consequences:

* **B4 — a batch starves interactive work.** A 96-chapter "write all" fills all 16 slots for hours,
  so a Q/A, a chapter plan or a cover-art request queues behind it. Those are the operations a user
  is sitting and waiting on.
* **B5 — the timeout fits the worst case, so it fits nothing.** A chapter write legitimately needs 90
  minutes; a Q/A needs seconds. At 5400s a wedged Q/A holds a slot for an hour and a half, and with
  ``max_tries=2`` it then does it again.

arq's ``job_timeout`` and ``max_jobs`` are properties of a **Worker**, not of a job — so splitting
the queues *is* the mechanism for per-operation timeouts. One worker per queue, each sized for the
work it carries.

Jobs are routed by ``(tool, op)`` rather than by tool, because the spread *within* a tool is the
whole problem: ``chapter.write`` is the longest job in the system and ``chapter.qa`` is one of the
shortest.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any

from writer_engine.telemetry.logging import get_logger

logger = get_logger("queues")

QUEUE_HEAVY = "engine-heavy"
QUEUE_INTERACTIVE = "engine-interactive"

# Poll order matters: a caller holding a job_id does not know which queue took it, so the poller
# tries each in turn. Heavy first because long jobs are the ones actually being polled repeatedly.
ALL_QUEUES: tuple[str, ...] = (QUEUE_HEAVY, QUEUE_INTERACTIVE)

# The legacy single queue. Kept ONLY so jobs enqueued before this split can still be polled and
# drained after a deploy; nothing new is ever enqueued here. Remove once no in-flight job predates
# the split (a few hours of retention).
QUEUE_LEGACY = "newsletter"
POLL_QUEUES: tuple[str, ...] = (*ALL_QUEUES, QUEUE_LEGACY)


@dataclass(frozen=True)
class QueueProfile:
    """Sizing for one queue's worker."""

    name: str
    max_jobs: int
    job_timeout: int
    max_tries: int
    keep_result: int
    drain_wait_s: int = 0
    """How long a SIGTERM'd worker keeps working its in-flight jobs before cancelling them (B7).

    Sized to the queue rather than to its longest job. The platform's shutdown grace period is
    seconds-to-minutes, so a wait matching the 5400s heavy ceiling would be theatre; what it buys is
    that work ALREADY close to done finishes instead of being thrown away, and anything longer is
    re-queued for the next instance."""


# heavy: few slots, long ceiling. The ceiling stays 90 min because a 10-concurrent batch shares one
# account's output-TPM, which genuinely stretches a single chapter well past 30 minutes.
# `drain_wait_s` is 30 here, not 5400: a chapter write cannot be finished inside any platform grace
# period, so the wait only covers a job in its last seconds. The rest are cancelled and re-queued.
HEAVY = QueueProfile(
    name=QUEUE_HEAVY, max_jobs=8, job_timeout=5400, max_tries=2, keep_result=7200, drain_wait_s=30
)
# interactive: more slots, short ceiling. A user is waiting on these, so a wedged job frees its slot
# in minutes rather than occupying it for an hour and a half. max_tries=1 because a retry the user is
# actively waiting through is worse than a prompt error.
#
# RAISED 600 -> 900 after the craft QA started returning evidence. Findings now carry the exact
# quote AND a finished-prose replacement for each one, so a QA answer went from a few hundred output
# tokens to several thousand and the call itself from ~30s to ~140s. Scoring 96 chapters at 24-way
# concurrency, the tail crossed the old ceiling and 23 of them were killed mid-generation and lost
# (max_tries=1). The op is no longer "short"; the ceiling has to reflect what it now does.
#
# The ceiling is NOT merely the ~140s these operations actually take, because a job spends time
# queued on the LLM budget before it spends any time generating: `llm_budget_max_wait_s` is 300, so
# under the very contention this split exists to survive, an interactive job can legitimately wait 5
# minutes for an output-token grant and only then start. A 180s ceiling would kill those jobs
# precisely when the system is busy — the opposite of the intent. 600s leaves the full budget wait
# plus a generation pass, and is still 9x tighter than the one-size-fits-all 5400.
#
# `drain_wait_s` is 20: these ops take ~120s but a user is sitting in front of them, and
# `max_tries=1` means a cancelled one is NOT retried — it is simply lost. So the wait exists to save
# the ones about to return, and is kept short because the platform will not wait long either.
INTERACTIVE = QueueProfile(
    name=QUEUE_INTERACTIVE,
    max_jobs=24,
    job_timeout=900,
    max_tries=1,
    keep_result=3600,
    drain_wait_s=20,
)

PROFILES: dict[str, QueueProfile] = {p.name: p for p in (HEAVY, INTERACTIVE)}

# (tool, op) pairs that belong on the heavy queue. Anything not listed is interactive, so a NEW op
# defaults to the short timeout — a wrong-but-fast classification is recoverable, where defaulting a
# new interactive op to a 90-minute ceiling re-creates the B5 problem silently.
# Classified by what the operation actually emits, not by how it feels: an op with a >=16k
# max_tokens call or an upstream poll loop measured in minutes is heavy. Checked against each step's
# OPS dict and its max_tokens arguments rather than assumed.
HEAVY_OPS: frozenset[tuple[str, str]] = frozenset(
    {
        ("chapter", "write"),
        ("chapter", "rewrite"),  # 32768 max_tokens
        ("chapter", "repair"),
        ("chapter", "plan"),  # 32768 max_tokens on the sub-chapter fan-out
        ("chapter", "blog"),
        ("chapter", "short-story"),
        ("chapter", "newsletter"),
        ("brainstorm", "story"),
        ("brainstorm", "short-story"),
        ("brainstorm", "revise-outline"),
        ("brainstorm", "edit-outline"),  # re-emits the whole StoryOutline at 32768
        ("research", "run"),
        ("media", "cover-art"),  # KIE.AI createTask -> poll recordInfo, 180s ceiling of its own
        # E1: one tick walks every due feed, and each item can cost a Firecrawl scrape plus two LLM
        # calls. Nobody is waiting on it, and it must not hold an interactive slot.
        ("ingestion", "run"),
        ("ingestion", "feed"),
        # A radar run is ~30 feed fetches plus two 16k-token Claude calls (Trend Radar); scheduling a
        # week is one 8k-token blog draft per topic, serially. Minutes, and nobody holds a request open.
        ("ingestion", "radar"),
        ("ingestion", "radar_schedule"),
        # E7: one review lens is one chapter-sized Anthropic call (~12s measured on haiku), and a
        # `panel` is four lenses plus a synthesis — serially, on the account-wide TPM that B9 showed
        # is the binding constraint. Under the B11 load conditions that can run past the interactive
        # 600s ceiling. It is also already the heavy pattern: the op persists its report to
        # `metadata.review_report` and the UI polls /api/jobs/engine/:id rather than holding a
        # request open.
        ("chapter", "review"),
    }
)

# Ops that are interactive BY DECISION rather than by default. Functionally identical to leaving
# them out — routing only consults HEAVY_OPS — but recording them means a reader can tell "sized and
# judged short" from "nobody looked at it", and the drift test in tests/test_queues.py can insist
# that every async-dispatched op in the hub catalog appears in one list or the other.
INTERACTIVE_OPS: frozenset[tuple[str, str]] = frozenset(
    {
        ("chapter", "qa"),  # one pass over one chapter
        ("chapter", "scan-drift"),  # single structured call
        ("chapter", "evaluate-genre"),  # 1024 max_tokens
        ("chapter", "extract-bible"),  # 4096 max_tokens
        ("brainstorm", "create-project"),  # a DB insert, no generation
        ("media", "social-posts"),
        ("notify", "eve-callback"),
        ("library", "revert"),  # version swap
        ("library", "email-content"),  # one Postal send
    }
)

# Whole tools that are heavy regardless of op.
HEAVY_TOOLS: frozenset[str] = frozenset()


def queue_for(tool: str, op: str | None = None) -> str:
    """Which queue a ``(tool, op)`` belongs on.

    Defaults to the interactive queue, deliberately — see ``HEAVY_OPS``.
    """
    if tool in HEAVY_TOOLS:
        return QUEUE_HEAVY
    return QUEUE_HEAVY if (tool, str(op or "")) in HEAVY_OPS else QUEUE_INTERACTIVE


def profile_for(queue: str) -> QueueProfile:
    return PROFILES.get(queue, INTERACTIVE)


# --- dead-letter queue -------------------------------------------------------------------------
#
# arq has no DLQ: when a job exhausts max_tries it is simply gone, which is how a failed chapter
# write becomes a user asking "where is my chapter?" with nothing in the system to point at. Record
# terminal failures to a capped Redis list so they are inspectable.

DLQ_KEY = "engine:dlq"
DLQ_MAX = 500


KIND_CRASH = "crash"
"""The job raised. arq stores the exception as the result and forgets it after keep_result."""

KIND_STEP_ERROR = "step_error"
"""The step returned StepOutput(status=error). The job "succeeded" — nothing crashed — but the
user's chapter/report still did not get made, and the only record was a job result that expires.
Found by probing DEV: two failing chapter ops left an empty DLQ and a 2-hour paper trail."""


async def record_dead_letter(
    *,
    queue: str,
    function: str,
    args: Any,
    error: str,
    job_id: str | None = None,
    kind: str = KIND_CRASH,
) -> None:
    """Push a terminal job failure onto the DLQ. Never raises — a DLQ write must not mask the error."""
    try:
        from writer_engine.redis_client.client import get_redis

        client = await get_redis()
        entry = json.dumps(
            {
                "ts": time.time(),
                "kind": kind,
                "queue": queue,
                "function": function,
                "job_id": job_id,
                "error": str(error)[:1000],
                "args": str(args)[:2000],
            }
        )
        # redis-py's sync/async stubs are a union, so the awaitable is bound to Any first.
        push: Any = client.lpush(DLQ_KEY, entry)
        await push
        trim: Any = client.ltrim(DLQ_KEY, 0, DLQ_MAX - 1)
        await trim
        logger.error("queue.dead_letter", kind=kind, queue=queue, function=function, job_id=job_id)
    except Exception as exc:  # pragma: no cover - best effort by design
        logger.warning("queue.dead_letter_write_failed", error=str(exc)[:160])


async def read_dead_letters(limit: int = 50) -> list[dict[str, Any]]:
    """Most-recent-first DLQ entries, for ``/admin/dlq``."""
    try:
        from writer_engine.redis_client.client import get_redis

        client = await get_redis()
        pending: Any = client.lrange(DLQ_KEY, 0, max(limit, 1) - 1)
        raw = await pending
    except Exception as exc:
        logger.warning("queue.dead_letter_read_failed", error=str(exc)[:160])
        return []
    out: list[dict[str, Any]] = []
    for item in raw or []:
        try:
            out.append(json.loads(item.decode() if isinstance(item, bytes) else item))
        except Exception:
            continue
    return out


__all__ = [
    "ALL_QUEUES",
    "DLQ_KEY",
    "HEAVY",
    "HEAVY_OPS",
    "INTERACTIVE",
    "INTERACTIVE_OPS",
    "KIND_CRASH",
    "KIND_STEP_ERROR",
    "POLL_QUEUES",
    "QUEUE_HEAVY",
    "QUEUE_INTERACTIVE",
    "QUEUE_LEGACY",
    "QueueProfile",
    "profile_for",
    "queue_for",
    "read_dead_letters",
    "record_dead_letter",
]
