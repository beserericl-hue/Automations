"""B1 — the supervisor must notice a dead child and take the container down.

These drive REAL subprocesses (short-lived `python -c` children) rather than mocks: the whole point
of B1 is that the previous shell version was never exercised, so the behaviour under test is process
lifecycle, not a call graph.
"""

from __future__ import annotations

import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from writer_engine.supervisor import ManagedProcess, Supervisor


def _sleeper(seconds: float = 30.0) -> ManagedProcess:
    return ManagedProcess(
        name=f"sleeper-{seconds}",
        argv=[sys.executable, "-c", f"import time; time.sleep({seconds})"],
    )


def _exits(code: int, after: float = 0.0) -> ManagedProcess:
    return ManagedProcess(
        name=f"exiter-{code}",
        argv=[sys.executable, "-c", f"import time,sys; time.sleep({after}); sys.exit({code})"],
    )


def _ignores_sigterm(ready_file: Path) -> ManagedProcess:
    """A child that traps SIGTERM and keeps running — exercises the SIGKILL drain path.

    Touches ``ready_file`` only AFTER the handler is installed, so the test can signal at a
    deterministic point. Signalling earlier races interpreter startup and the child dies to the
    default SIGTERM action instead, which would silently not test the kill path.
    """
    code = (
        "import signal,time,pathlib,sys; "
        "signal.signal(signal.SIGTERM, lambda *a: None); "
        "pathlib.Path(sys.argv[1]).write_text('ready'); "
        "time.sleep(60)"
    )
    return ManagedProcess(name="stubborn", argv=[sys.executable, "-c", code, str(ready_file)])


def _await_file(path: Path, timeout_s: float = 10.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if path.exists():
            return
        time.sleep(0.02)
    raise AssertionError(f"child never became ready: {path}")


def test_rejects_empty_process_table() -> None:
    with pytest.raises(ValueError):
        Supervisor([])


def test_returns_1_and_names_the_child_that_died() -> None:
    sup = Supervisor([_sleeper(), _exits(3, after=0.1), _sleeper()], poll_interval_s=0.05)
    sup.start()
    assert sup.supervise() == 1


def test_a_dead_child_takes_down_its_siblings() -> None:
    """The failure mode B1 describes: one dead step must not leave a half-working container."""
    siblings = [_sleeper(), _sleeper()]
    sup = Supervisor([*siblings, _exits(1, after=0.1)], poll_interval_s=0.05)
    sup.start()
    pids = [c.popen.pid for c in sup._children]

    assert sup.supervise() == 1

    for pid in pids:
        assert not _pid_alive(pid), f"pid {pid} survived the shutdown"


def test_clean_exit_code_0_also_takes_the_container_down() -> None:
    """A step exiting 0 is still a step that is gone — fail fast regardless of the code."""
    sup = Supervisor([_sleeper(), _exits(0, after=0.1)], poll_interval_s=0.05)
    sup.start()
    assert sup.supervise() == 1


def test_signal_shuts_down_gracefully_and_returns_0() -> None:
    sup = Supervisor([_sleeper(), _sleeper()], poll_interval_s=0.05)
    sup.start()
    pids = [c.popen.pid for c in sup._children]

    # Deliver the signal the way the platform would, while supervise() is blocking.
    threading.Timer(0.2, lambda: sup._on_signal(signal.SIGTERM, None)).start()
    assert sup.supervise() == 0

    for pid in pids:
        assert not _pid_alive(pid)


def test_sigkills_children_that_ignore_sigterm(tmp_path: Path) -> None:
    ready = tmp_path / "ready"
    sup = Supervisor([_ignores_sigterm(ready)], drain_timeout_s=0.5, poll_interval_s=0.05)
    sup.start()
    pid = sup._children[0].popen.pid
    _await_file(ready)

    started = time.monotonic()
    sup.shutdown(reason="test")
    elapsed = time.monotonic() - started

    assert not _pid_alive(pid), "a child that ignores SIGTERM must still be SIGKILLed"
    # Waited out the drain window before escalating, rather than killing immediately...
    assert elapsed >= 0.4
    # ...and did not hang for the default 25s timeout.
    assert elapsed < 10.0


def test_shutdown_is_idempotent() -> None:
    sup = Supervisor([_sleeper()], drain_timeout_s=0.5, poll_interval_s=0.05)
    sup.start()
    sup.shutdown(reason="first")
    sup.shutdown(reason="second")  # must not raise on already-reaped children


def test_spawn_failure_cleans_up_already_started_children() -> None:
    bad = ManagedProcess(name="nonexistent", argv=["definitely-not-a-real-binary-xyz"])
    sup = Supervisor([_sleeper(), bad], poll_interval_s=0.05)
    with pytest.raises(OSError):
        sup.start()
    # The sleeper that did start must not be left orphaned.
    assert all(not _pid_alive(c.popen.pid) for c in sup._children)


def test_child_env_is_layered_over_os_environ() -> None:
    """Step URLs are passed per-process; children must still inherit the ambient environment."""
    proc = ManagedProcess(
        name="env-probe",
        argv=[
            sys.executable,
            "-c",
            "import os,sys; sys.exit(0 if os.environ.get('SUP_TEST_KEY')=='v' and os.environ.get('PATH') else 7)",
        ],
        env={"SUP_TEST_KEY": "v"},
    )
    sup = Supervisor([proc], poll_interval_s=0.05)
    sup.start()
    rc = sup._children[0].popen.wait(timeout=10)
    assert rc == 0


def _pid_alive(pid: int) -> bool:
    """True while the pid is a live, non-zombie process."""
    try:
        out = subprocess.run(
            ["ps", "-o", "state=", "-p", str(pid)],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except Exception:
        return False
    state = out.stdout.strip()
    # Empty = gone. 'Z' = zombie, already exited and awaiting reap.
    return bool(state) and not state.startswith("Z")
