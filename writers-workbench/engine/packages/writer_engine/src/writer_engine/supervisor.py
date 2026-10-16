"""Process supervisor for multi-process engine containers.

B1 (remaining-work inventory): ``services/runtime/entrypoint.sh`` launched 19 step services and the
arq worker as bare ``&`` background jobs and then ``exec``ed the orchestrator. Nothing watched the
background jobs, so a step service that died was never restarted and never noticed — the container
stayed up, the orchestrator kept answering, and every job routed through the dead step failed.
Combined with ``/admin/health`` returning a flat "ok" (B2), a half-dead container could serve
failures indefinitely.

**Policy: fail fast.** Any child exiting is fatal. All children are stopped and the process exits
non-zero so the platform (``restartPolicyType = "ALWAYS"``) restarts the container clean. Individual
children are deliberately NOT restarted in place:

* the step services are stateless, so restarting one in place preserves nothing; and
* each process holds its own in-process caches (``LLMRouter``, ``PromptStore``), so a partial
  restart yields a container whose processes disagree about configuration — harder to reason about
  than a clean restart.

Written in Python rather than shell on purpose: the supervision logic is the part that must not be
wrong, and here it is unit-testable, type-checked, and free of bash-version differences (``wait -n``
and ``declare -A`` need bash >= 4.3, which macOS does not ship — so a shell implementation could not
be exercised outside the container).

Once B10 collapses the 21 processes into 3, the process table shrinks; this contract does not.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from writer_engine.telemetry.logging import get_logger

logger = get_logger("supervisor")

DEFAULT_DRAIN_TIMEOUT_S = 25.0
DEFAULT_POLL_INTERVAL_S = 0.5

# Restart budget. Measured need, not a guess: during the B11 load test at 20 users the heavy arq
# worker took a `redis.exceptions.TimeoutError: Timeout connecting to server` (arq's socket connect
# timeout is ONE second) and exited rc=1. The original fail-fast then shut the whole container down
# — 94 jobs had completed, 8 were in flight, and all 8 died with the processes, leaving no dead
# letters because nothing got to run an `except` block. One transient Redis blip cost a container.
#
# 5 restarts in 5 minutes tolerates a blip per worker without tolerating a genuinely broken child:
# past the budget the container still exits 1, so the platform replaces and reports it.
DEFAULT_MAX_RESTARTS = 5
DEFAULT_RESTART_WINDOW_S = 300.0
# Enough to not hot-loop a child that fails instantly at startup; short enough that a worker is back
# before a user notices.
DEFAULT_RESTART_DELAY_S = 1.0


@dataclass(frozen=True)
class ManagedProcess:
    """One child process to run and watch."""

    name: str
    argv: Sequence[str]
    env: Mapping[str, str] = field(default_factory=dict)
    restartable: bool = True
    """Whether a lone death of this child is worth retrying in place (see Supervisor)."""


@dataclass
class _Child:
    spec: ManagedProcess
    popen: subprocess.Popen[bytes]
    restarts: list[float] = field(default_factory=list)
    """Monotonic timestamps of this child's restarts, for the rate cap."""


class Supervisor:
    """Start a set of child processes, restart a child that dies, and give up if one keeps dying.

    The original version exited as soon as ANY child did. That is right for a child whose death
    makes the container useless, and wrong for an arq worker: a worker's jobs live in Redis, so a
    replacement picks them up, and arq re-queues whatever was cancelled. Killing the container
    instead loses every in-flight job in every OTHER process too.

    So: restart a dead child in place, up to ``max_restarts`` within ``restart_window_s``, then
    fall back to the original behaviour and exit 1 so the platform replaces the container. A child
    marked ``restartable=False`` keeps the old semantics.

    Usage::

        sup = Supervisor(processes)
        sup.start()
        raise SystemExit(sup.supervise())
    """

    def __init__(
        self,
        processes: Sequence[ManagedProcess],
        *,
        drain_timeout_s: float = DEFAULT_DRAIN_TIMEOUT_S,
        poll_interval_s: float = DEFAULT_POLL_INTERVAL_S,
        max_restarts: int = DEFAULT_MAX_RESTARTS,
        restart_window_s: float = DEFAULT_RESTART_WINDOW_S,
        restart_delay_s: float = DEFAULT_RESTART_DELAY_S,
    ) -> None:
        if not processes:
            raise ValueError("Supervisor needs at least one process")
        self._specs = list(processes)
        self._drain_timeout_s = drain_timeout_s
        self._poll_interval_s = poll_interval_s
        self._max_restarts = max_restarts
        self._restart_window_s = restart_window_s
        self._restart_delay_s = restart_delay_s
        self._children: list[_Child] = []
        self._signalled: int | None = None

    # --- lifecycle ------------------------------------------------------------------------

    def start(self) -> None:
        """Spawn every child. On a spawn failure, stop whatever already started and re-raise."""
        for spec in self._specs:
            env = {**os.environ, **spec.env}
            try:
                popen = subprocess.Popen(list(spec.argv), env=env)
            except Exception:
                logger.error("supervisor.spawn_failed", name=spec.name, argv=list(spec.argv))
                self.shutdown(reason=f"spawn of {spec.name} failed")
                raise
            self._children.append(_Child(spec=spec, popen=popen))
            logger.info("supervisor.started", name=spec.name, pid=popen.pid)
        logger.info("supervisor.supervising", count=len(self._children))

    def install_signal_handlers(self) -> None:
        """Forward SIGTERM/SIGINT instead of dying as PID 1 and orphaning the children."""
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, self._on_signal)

    def _on_signal(self, signum: int, _frame: object) -> None:
        self._signalled = signum

    def supervise(self) -> int:
        """Block until a child exits or a shutdown signal arrives.

        Returns the process exit code: ``0`` for a signalled (expected) shutdown, ``1`` when a child
        died on its own — which is what makes the platform restart the container.
        """
        while True:
            if self._signalled is not None:
                name = signal.Signals(self._signalled).name
                logger.info("supervisor.signalled", signal=name)
                self.shutdown(reason=f"received {name}")
                return 0

            dead = self._first_dead()
            if dead is not None:
                rc = dead.popen.returncode
                logger.error(
                    "supervisor.child_exited",
                    name=dead.spec.name,
                    pid=dead.popen.pid,
                    returncode=rc,
                    restarts=len(dead.restarts),
                )
                if self._may_restart(dead):
                    self._restart(dead)
                    continue
                self.shutdown(reason=f"{dead.spec.name} exited (rc={rc})")
                return 1

            time.sleep(self._poll_interval_s)

    def _may_restart(self, child: _Child) -> bool:
        """Is this death worth retrying in place rather than replacing the container?

        Yes for a FIRST (or occasional) death of a restartable child. No once it has died
        ``max_restarts`` times inside ``restart_window_s`` — a child that keeps dying is a real
        fault, and a container that silently loops a broken process forever is worse than one the
        platform replaces and reports.
        """
        if not child.spec.restartable:
            return False
        cutoff = time.monotonic() - self._restart_window_s
        child.restarts = [t for t in child.restarts if t >= cutoff]
        if len(child.restarts) >= self._max_restarts:
            logger.error(
                "supervisor.restart_budget_exhausted",
                name=child.spec.name,
                restarts=len(child.restarts),
                window_s=self._restart_window_s,
            )
            return False
        return True

    def _restart(self, child: _Child) -> None:
        """Respawn one child in place, leaving its siblings running."""
        time.sleep(self._restart_delay_s)
        env = {**os.environ, **child.spec.env}
        try:
            child.popen = subprocess.Popen(list(child.spec.argv), env=env)
        except Exception:
            # Cannot respawn: fall back to the old behaviour rather than pretending it is alive.
            logger.error("supervisor.restart_failed", name=child.spec.name)
            self.shutdown(reason=f"restart of {child.spec.name} failed")
            raise
        child.restarts.append(time.monotonic())
        logger.warning(
            "supervisor.child_restarted",
            name=child.spec.name,
            pid=child.popen.pid,
            restarts=len(child.restarts),
            budget=self._max_restarts,
        )

    def _first_dead(self) -> _Child | None:
        for child in self._children:
            if child.popen.poll() is not None:
                return child
        return None

    def shutdown(self, *, reason: str) -> None:
        """SIGTERM every live child, wait up to the drain timeout, then SIGKILL the remainder.

        The drain timeout is NOT long enough to finish a chapter write (arq's job_timeout is 90 min);
        it only avoids killing processes mid-syscall on a routine redeploy. Real graceful drain needs
        the readiness flip tracked as B7.
        """
        live = [c for c in self._children if c.popen.poll() is None]
        logger.info("supervisor.shutdown", reason=reason, live=len(live))
        for child in live:
            with _suppress_process_errors():
                child.popen.terminate()

        deadline = time.monotonic() + self._drain_timeout_s
        while time.monotonic() < deadline:
            if all(c.popen.poll() is not None for c in self._children):
                return
            time.sleep(self._poll_interval_s)

        stubborn = [c for c in self._children if c.popen.poll() is None]
        if stubborn:
            logger.warning(
                "supervisor.drain_timeout",
                timeout_s=self._drain_timeout_s,
                killing=[c.spec.name for c in stubborn],
            )
            for child in stubborn:
                with _suppress_process_errors():
                    child.popen.kill()
            for child in stubborn:
                with _suppress_process_errors():
                    child.popen.wait(timeout=5)


class _suppress_process_errors:
    """Signalling an already-reaped child raises; that is not an error worth propagating."""

    def __enter__(self) -> None:
        return None

    def __exit__(self, exc_type: object, *_: object) -> bool:
        return isinstance(exc_type, type) and issubclass(exc_type, (OSError, ValueError))


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point for the runtime container: ``python -m writer_engine.supervisor``."""
    from writer_engine.runtime_processes import build_runtime_processes

    _ = argv
    processes = build_runtime_processes()
    sup = Supervisor(
        processes,
        drain_timeout_s=float(os.environ.get("DRAIN_TIMEOUT_S", DEFAULT_DRAIN_TIMEOUT_S)),
    )
    sup.install_signal_handlers()
    sup.start()
    return sup.supervise()


if __name__ == "__main__":  # pragma: no cover - exercised via the container CMD
    sys.exit(main())
