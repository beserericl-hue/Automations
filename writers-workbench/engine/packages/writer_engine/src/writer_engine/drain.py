"""Graceful drain (B7): readiness flip → finish in-flight → terminate.

A redeploy used to go straight to SIGTERM. Everything in flight died with the container: a chapter
write 40 minutes in, an interactive job a user was waiting on, a saga mid-step. CR-010 C1 recorded
the consequence; this is the sequence that avoids it.

**The flag is a file, deliberately.** The three processes in the runtime container (steps, workers,
orchestrator) need to agree that *this instance* is going away, and the supervisor that learns it
first is a synchronous process with no Redis client. A file in the container's own filesystem is
exactly the right scope: it is shared by every process in the container and invisible to every other
instance, which is what "this replica is draining" means. A Redis key would be wrong — it would
drain the fleet.

**Draining is not-ready, not unhealthy.** `/admin/ready` returning 503 withdraws the instance from
the load balancer; `/admin/health` keeps returning 200 because the process is fine and a restart
would be the wrong remedy. Conflating the two is how a drain becomes a crash loop.

**What a drain can and cannot save.** The platform's own grace period bounds everything here, and it
is seconds-to-minutes, not the 90 minutes a chapter write may legitimately take. So:

* interactive work (≤600s ceiling, usually ~120s) genuinely finishes;
* heavy work in flight is cancelled, and arq re-queues it (``retry_jobs``) for the next instance to
  pick up. That is safe *because* of B6's run ledger: a replayed ``run_id`` returns the recorded
  result instead of re-running, so a re-queued chapter write does not write the chapter twice.

Without the readiness flip, a drain would still be accepting new work while shutting down, which is
the one state worse than a hard kill.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from writer_engine.telemetry.logging import get_logger

logger = get_logger("drain")

# Container-local, and must be writable by every process in the image.
DEFAULT_FLAG_PATH = "/tmp/engine-draining"

DRAIN_READINESS_DELAY_S = 5.0
"""How long to keep serving after the flip before terminating children.

A load balancer needs to observe at least one failed readiness probe before it stops routing. Five
seconds covers a 2s probe interval with margin; shorter and the LB sends requests into a process
that is already tearing down, which is the exact failure the flip exists to prevent.
"""


def flag_path() -> Path:
    """The drain flag's location. ``DRAIN_FLAG_PATH`` overrides it (tests, and odd filesystems)."""
    return Path(os.environ.get("DRAIN_FLAG_PATH") or DEFAULT_FLAG_PATH)


def begin_drain(*, reason: str = "") -> bool:
    """Mark this instance as draining. Returns False if the flag could not be written.

    Best-effort by design: a container that cannot write its own flag must still shut down. The
    return value exists so the caller can log that the readiness flip did NOT happen, rather than
    waiting out a delay that bought nothing.
    """
    path = flag_path()
    try:
        path.write_text(f"{time.time():.0f} {reason}\n", encoding="utf-8")
    except Exception as exc:
        logger.warning("drain.flag_write_failed", path=str(path), error=f"{type(exc).__name__}: {exc}")
        return False
    logger.info("drain.begin", path=str(path), reason=reason)
    return True


def clear_drain() -> None:
    """Remove the flag. Called at startup: a restarted container must not be born draining.

    This matters more than it looks — the flag lives in the filesystem, and on a platform that
    reuses a volume or restarts a process in place, a leftover flag would make the instance come up
    permanently not-ready and never take traffic again.
    """
    try:
        flag_path().unlink(missing_ok=True)
    except Exception as exc:  # pragma: no cover - unlink of an existing writable file
        logger.warning("drain.flag_clear_failed", error=f"{type(exc).__name__}: {exc}")


def is_draining() -> bool:
    """Is this instance shutting down? Never raises."""
    try:
        return flag_path().exists()
    except Exception:  # pragma: no cover - a stat that fails is not a drain
        return False


def draining_since() -> float | None:
    """Unix seconds at which the drain started, or None. For reporting how long a drain has run."""
    try:
        raw = flag_path().read_text(encoding="utf-8").split()
        return float(raw[0]) if raw else None
    except Exception:
        return None
