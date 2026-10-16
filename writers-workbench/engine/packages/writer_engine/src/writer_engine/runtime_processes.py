"""The process table for the ``writer-engine-runtime`` container.

Single source of truth for which processes run in the runtime image and on which ports. Previously
this lived as literals in ``services/runtime/entrypoint.sh``, duplicated across the ``start`` lines
and the ``export *_STEP_URL`` lines, with the orchestrator's own defaults as a third copy.

Keep in sync with ``orchestrator.write_tools.ALL_STEP_URLS`` — a step started here but missing from
that registry is a step ``/admin/health`` will not probe (B2), which is how a dead process stays
invisible. ``tests/test_runtime_processes.py`` asserts the two agree.

B10 note: when the 21 processes collapse to 3, this table becomes the mount map for the single steps
process rather than a list of uvicorn invocations. The port-per-step convention is preserved as the
path prefix so ``*_STEP_URL`` indirection keeps working.
"""

from __future__ import annotations

import os

from writer_engine.supervisor import ManagedProcess

# step name -> localhost port. Step names match the step service's STEP_NAME and the orchestrator's
# ALL_STEP_URLS keys.
STEP_PORTS: dict[str, int] = {
    "library_retrieve": 8002,
    # Newsletter saga steps (F2).
    "gather": 8010,
    "pick": 8011,
    "subject": 8012,
    "scrape": 8013,
    "segment": 8014,
    "image": 8015,
    "assemble": 8016,
    "render": 8017,
    "persist": 8018,
    "deliver": 8019,
    # Write-workshop steps (F1).
    "chapter": 8020,
    "research": 8021,
    "brainstorm": 8022,
    "media": 8023,
    "library": 8024,
    "story_bible": 8025,
    "approval": 8026,
    "notify": 8027,
}

DEFAULT_ORCHESTRATOR_PORT = 8001


def step_module(name: str) -> str:
    """ASGI import path for a step service. Every step package follows ``<name>_step.main:app``."""
    return f"{name}_step.main:app"


def step_url_env(ports: dict[str, int] | None = None) -> dict[str, str]:
    """The ``*_STEP_URL`` environment the orchestrator reads to dial each step.

    Set explicitly rather than relying on ``EngineSettings`` defaults so the container is
    self-describing and a default drift cannot silently repoint a step.
    """
    ports = ports or STEP_PORTS
    return {f"{name.upper()}_STEP_URL": f"http://localhost:{port}" for name, port in ports.items()}


def build_runtime_processes(
    *,
    orchestrator_port: int | None = None,
    ports: dict[str, int] | None = None,
) -> list[ManagedProcess]:
    """Build the full process table: every step service, the arq worker, then the orchestrator.

    Step services bind to 127.0.0.1 — the orchestrator is the only externally reachable process.
    """
    ports = ports or STEP_PORTS
    orch_port = orchestrator_port or int(os.environ.get("PORT", DEFAULT_ORCHESTRATOR_PORT))
    step_env = step_url_env(ports)

    procs: list[ManagedProcess] = [
        ManagedProcess(
            name=f"{name}_step",
            argv=[
                "uvicorn",
                step_module(name),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--log-level",
                "warning",
            ],
        )
        for name, port in ports.items()
    ]

    # arq drives the newsletter saga between HITL pauses and runs every async write job.
    procs.append(
        ManagedProcess(
            name="arq_worker",
            argv=["arq", "orchestrator.worker.WorkerSettings"],
            env=step_env,
        )
    )
    # The externally-bound process; Railway routes to $PORT.
    procs.append(
        ManagedProcess(
            name="orchestrator",
            argv=[
                "uvicorn",
                "orchestrator.main:app",
                "--host",
                "0.0.0.0",
                "--port",
                str(orch_port),
            ],
            env=step_env,
        )
    )
    return procs
