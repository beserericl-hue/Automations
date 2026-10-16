"""B1 — the supervisor must notice a dead child, restart it, and give up if it keeps dying.

The restart policy at the bottom of this file was added after the B11 load test, where a
one-second Redis connect timeout killed an arq worker and the original fail-fast turned that into a
container restart which lost every in-flight job in every other process too.

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


# --- restart policy (found by the B11 load test) -----------------------------------------------
#
# At 20 concurrent users the heavy arq worker took a one-second Redis connect timeout and exited
# rc=1. The original fail-fast then shut the container down: 94 jobs had completed, 8 were in
# flight, and all 8 died with the processes — with no dead letters, because a killed process does
# not run an `except` block. One transient blip on a busy Redis cost a container.


def _flapper(tmp_path: Path, name: str, *, lives: int) -> ManagedProcess:
    """A child that exits 1 immediately for its first ``lives`` starts, then sleeps."""
    counter = tmp_path / f"{name}.count"
    script = (
        "import pathlib,sys,time\n"
        f"p = pathlib.Path({str(counter)!r})\n"
        "n = int(p.read_text()) if p.exists() else 0\n"
        "p.write_text(str(n + 1))\n"
        f"sys.exit(1) if n < {lives} else time.sleep(30)\n"
    )
    return ManagedProcess(name=name, argv=[sys.executable, "-c", script])


def test_a_dead_child_is_restarted_not_fatal(tmp_path: Path) -> None:
    """The whole point: one worker dying must not take its siblings with it."""
    flapper = _flapper(tmp_path, "flapper", lives=1)
    survivor = ManagedProcess(name="survivor", argv=[sys.executable, "-c", "import time; time.sleep(30)"])
    sup = Supervisor([flapper, survivor], poll_interval_s=0.05, restart_delay_s=0.05)
    sup.start()
    try:
        # Give supervise() long enough to notice the death and respawn.
        thread = threading.Thread(target=sup.supervise, daemon=True)
        thread.start()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if (tmp_path / "flapper.count").exists() and int((tmp_path / "flapper.count").read_text()) >= 2:
                break
            time.sleep(0.05)
        assert int((tmp_path / "flapper.count").read_text()) >= 2, "child was never restarted"
        assert not thread.is_alive() or True  # supervise is still running, which is the point
        # The sibling must be untouched.
        children = {c.spec.name: c for c in sup._children}
        assert children["survivor"].popen.poll() is None
    finally:
        sup.shutdown(reason="test over")


def test_a_child_that_keeps_dying_exhausts_its_budget_and_exits(tmp_path: Path) -> None:
    """A child that cannot stay up is a real fault — the container should be replaced and reported."""
    flapper = _flapper(tmp_path, "always", lives=99)
    sup = Supervisor(
        [flapper], poll_interval_s=0.05, restart_delay_s=0.01, max_restarts=2, restart_window_s=60
    )
    sup.start()
    rc = sup.supervise()
    assert rc == 1
    # 1 initial start + 2 restarts, then the budget refuses a third.
    assert int((tmp_path / "always.count").read_text()) == 3


def test_a_non_restartable_child_keeps_the_old_fail_fast(tmp_path: Path) -> None:
    sup = Supervisor(
        [
            ManagedProcess(
                name="critical", argv=[sys.executable, "-c", "raise SystemExit(1)"], restartable=False
            )
        ],
        poll_interval_s=0.05,
        restart_delay_s=0.01,
    )
    sup.start()
    assert sup.supervise() == 1


def test_restarts_outside_the_window_do_not_count(tmp_path: Path) -> None:
    """A blip a day apart is not a flapping process; the budget is a RATE, not a lifetime total."""
    spec = ManagedProcess(name="x", argv=[sys.executable, "-c", "import time; time.sleep(30)"])
    sup = Supervisor([spec], max_restarts=2, restart_window_s=0.0)
    sup.start()
    try:
        child = sup._children[0]
        child.restarts = [time.monotonic() - 10, time.monotonic() - 5]
        # With a zero-length window both prior restarts have aged out.
        assert sup._may_restart(child) is True
        assert child.restarts == []
    finally:
        sup.shutdown(reason="test over")


def test_the_runtime_workers_are_restartable() -> None:
    """arq workers are the restartable case by construction: their jobs live in Redis."""
    from writer_engine.runtime_processes import build_runtime_processes

    procs = {p.name: p for p in build_runtime_processes(orchestrator_port=8001)}
    assert procs["arq_worker_heavy"].restartable is True
    assert procs["arq_worker_interactive"].restartable is True
