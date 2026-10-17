"""The runtime process table, the step apps, and the health-probe registry must all agree.

Cross-package by design, so it lives in the top-level suite rather than any one package's tests.

Two failure modes this prevents:

* a step present in one registry and not another is a step the orchestrator cannot reach, or one
  ``/admin/health`` never probes — so when it breaks, the container still reports healthy (the
  B1+B2 combination);
* B10 regressions: the collapse to one steps process is what makes ``MAX_CONCURRENT_LLM`` (B3) and
  prompt reload (A5) meaningful, so the process count is asserted rather than assumed.
"""

from __future__ import annotations

from orchestrator.write_tools import ALL_STEP_URLS
from steps_app.main import STEP_APPS, mount_path
from writer_engine.config import EngineSettings
from writer_engine.runtime_processes import (
    DEFAULT_ORCHESTRATOR_PORT,
    DEFAULT_STEPS_PORT,
    STEP_NAMES,
    build_runtime_processes,
    step_mount_path,
    step_url_env,
)

EXPECTED_STEPS = 20  # 8 hub-routable write tools + 10 newsletter saga steps + library_retrieve + ingestion


# --- the three registries agree ---------------------------------------------------------------


def test_step_names_match_the_health_probe_registry() -> None:
    assert set(STEP_NAMES) == set(ALL_STEP_URLS), (
        "runtime_processes.STEP_NAMES and write_tools.ALL_STEP_URLS disagree — a step without a "
        "health probe dies invisibly (B1/B2)"
    )


def test_step_names_match_the_mounted_apps() -> None:
    assert set(STEP_NAMES) == set(STEP_APPS), (
        "runtime_processes.STEP_NAMES and steps_app.STEP_APPS disagree — a step that is not mounted "
        "is unreachable even though its URL resolves"
    )


def test_expected_step_count() -> None:
    assert len(STEP_NAMES) == EXPECTED_STEPS
    assert len(STEP_APPS) == EXPECTED_STEPS


def test_no_duplicate_step_names() -> None:
    assert len(set(STEP_NAMES)) == len(STEP_NAMES)


# --- B10: four processes, not twenty-one ------------------------------------------------------


def test_runtime_runs_exactly_four_processes() -> None:
    procs = build_runtime_processes(orchestrator_port=8001)
    names = [p.name for p in procs]
    assert names == [
        "steps_app",
        "arq_worker_heavy",
        "arq_worker_interactive",
        "orchestrator",
    ], (
        "B10 collapsed 21 processes to 3 (+1 for the B4 queue split); a regression here "
        "reintroduces the ~19 independent LLMRouter semaphores (B3) and the unreachable prompt "
        "reload (A5)"
    )


def test_one_worker_per_queue() -> None:
    """B4/B5: arq's job_timeout is per-Worker, so a queue with no worker is a queue that never runs."""
    procs = {p.name: p for p in build_runtime_processes(orchestrator_port=8001)}
    settings_args = {p.argv[1] for p in procs.values() if p.argv and p.argv[0] == "arq"}
    assert settings_args == {
        "orchestrator.worker.WorkerSettingsHeavy",
        "orchestrator.worker.WorkerSettingsInteractive",
    }


def test_consumers_start_after_the_steps_app() -> None:
    """arq and the orchestrator dial the steps, so the steps process is spawned first."""
    names = [p.name for p in build_runtime_processes(orchestrator_port=8001)]
    assert names.index("steps_app") < names.index("arq_worker_heavy")
    assert names.index("steps_app") < names.index("arq_worker_interactive")
    assert names.index("steps_app") < names.index("orchestrator")


def test_steps_app_binds_localhost_and_orchestrator_is_public() -> None:
    procs = {p.name: p for p in build_runtime_processes(orchestrator_port=8001)}
    assert "127.0.0.1" in procs["steps_app"].argv
    assert "0.0.0.0" in procs["orchestrator"].argv


def test_ports_are_configurable_and_distinct() -> None:
    procs = {p.name: p for p in build_runtime_processes(orchestrator_port=9999, steps_port=9001)}
    assert "9999" in procs["orchestrator"].argv
    assert "9001" in procs["steps_app"].argv
    assert DEFAULT_STEPS_PORT != DEFAULT_ORCHESTRATOR_PORT


# --- step URLs --------------------------------------------------------------------------------


def test_step_urls_point_at_the_mounted_paths() -> None:
    env = step_url_env(steps_port=8030)
    for name in STEP_NAMES:
        assert env[f"{name.upper()}_STEP_URL"] == f"http://localhost:8030/steps/{name}"


def test_mount_paths_agree_between_the_table_and_the_app() -> None:
    """The orchestrator's URL and the app's mount must be the same string."""
    for name in STEP_NAMES:
        assert step_mount_path(name) == mount_path(name)


def test_step_url_env_matches_engine_settings_aliases() -> None:
    """A typo here silently leaves the orchestrator on its compiled-in default.

    EngineSettings reads env first, which is also what keeps the per-step split one variable away:
    point any <NAME>_STEP_URL at a hostname and that step runs in its own container.
    """
    aliases = {f.alias for f in EngineSettings.model_fields.values() if f.alias and "_STEP_URL" in f.alias}
    missing = set(step_url_env()) - aliases
    assert not missing, f"exported env vars EngineSettings does not read: {sorted(missing)}"


def test_consumers_receive_every_step_url() -> None:
    procs = {p.name: p for p in build_runtime_processes(orchestrator_port=8001)}
    for consumer in ("arq_worker_heavy", "arq_worker_interactive", "orchestrator"):
        env = procs[consumer].env
        for name in STEP_NAMES:
            assert f"{name.upper()}_STEP_URL" in env, f"{consumer} cannot dial {name}"


# --- B3: one process means one shared concurrency limiter -------------------------------------


def test_all_steps_share_one_llm_router() -> None:
    """The point of B10. Every step in one process = one router = one real MAX_CONCURRENT_LLM."""
    from writer_engine.llm import get_router, reset_router

    reset_router()
    try:
        assert get_router(service="chapter") is get_router(service="media")
    finally:
        reset_router()


def test_all_steps_share_one_prompt_store() -> None:
    """A5: one store means /admin/reload-prompts reaches the code that generates text."""
    from writer_engine.prompt_store import get_prompt_store

    assert get_prompt_store() is get_prompt_store()
