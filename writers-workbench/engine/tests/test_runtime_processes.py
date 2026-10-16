"""The runtime process table and the health-probe registry must agree.

Cross-package by design, so it lives in the top-level suite rather than either package's own tests.

The failure this prevents is the B1+B2 combination: a step service started by the runtime container
but missing from ``orchestrator.write_tools.ALL_STEP_URLS`` is a step ``/admin/health`` never probes,
so when that process dies the container still reports healthy — exactly the invisible-failure mode
both fixes exist to close.
"""

from __future__ import annotations

from orchestrator.write_tools import ALL_STEP_URLS
from writer_engine.config import EngineSettings
from writer_engine.runtime_processes import (
    STEP_PORTS,
    build_runtime_processes,
    step_url_env,
)


def test_every_started_step_is_health_probed() -> None:
    assert set(STEP_PORTS) == set(ALL_STEP_URLS), (
        "runtime_processes.STEP_PORTS and write_tools.ALL_STEP_URLS disagree — a step started "
        "without a health probe dies invisibly (B1/B2)"
    )


def test_step_count_is_the_expected_19() -> None:
    # 8 hub-routable write tools + 10 newsletter saga steps + the library_retrieve F0 slice.
    assert len(STEP_PORTS) == 19


def test_ports_are_unique() -> None:
    assert len(set(STEP_PORTS.values())) == len(STEP_PORTS), "two steps share a port"


def test_orchestrator_port_not_reused_by_a_step() -> None:
    from writer_engine.runtime_processes import DEFAULT_ORCHESTRATOR_PORT

    assert DEFAULT_ORCHESTRATOR_PORT not in STEP_PORTS.values()


def test_step_url_env_matches_engine_settings_field_names() -> None:
    """The exported names must be the aliases EngineSettings actually reads.

    A typo here silently leaves the orchestrator on its compiled-in default instead of the port the
    container really bound.
    """
    aliases = {f.alias for f in EngineSettings.model_fields.values() if f.alias and "_STEP_URL" in f.alias}
    exported = set(step_url_env())
    missing = exported - aliases
    assert not missing, f"exported env vars EngineSettings does not read: {sorted(missing)}"


def test_step_url_env_covers_every_step() -> None:
    env = step_url_env()
    for name, port in STEP_PORTS.items():
        assert env[f"{name.upper()}_STEP_URL"] == f"http://localhost:{port}"


def test_process_table_order_starts_steps_before_consumers() -> None:
    """arq and the orchestrator dial the steps, so they must be spawned last."""
    names = [p.name for p in build_runtime_processes(orchestrator_port=8001)]
    assert names[-2:] == ["arq_worker", "orchestrator"]
    assert len(names) == len(STEP_PORTS) + 2


def test_consumers_receive_the_step_urls() -> None:
    procs = {p.name: p for p in build_runtime_processes(orchestrator_port=8001)}
    for consumer in ("arq_worker", "orchestrator"):
        env = procs[consumer].env
        assert env["CHAPTER_STEP_URL"] == f"http://localhost:{STEP_PORTS['chapter']}"


def test_steps_bind_localhost_only() -> None:
    """Only the orchestrator may be externally reachable."""
    for proc in build_runtime_processes(orchestrator_port=8001):
        if proc.name.endswith("_step"):
            assert "127.0.0.1" in proc.argv, f"{proc.name} is not bound to localhost"
        if proc.name == "orchestrator":
            assert "0.0.0.0" in proc.argv


def test_orchestrator_port_is_configurable() -> None:
    procs = {p.name: p for p in build_runtime_processes(orchestrator_port=9999)}
    assert "9999" in procs["orchestrator"].argv
