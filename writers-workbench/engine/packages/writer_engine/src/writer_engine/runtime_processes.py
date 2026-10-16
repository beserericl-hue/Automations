"""The process table for the ``writer-engine-runtime`` container.

Single source of truth for which processes run in the runtime image. Previously this lived as
literals in ``services/runtime/entrypoint.sh``, duplicated across the ``start`` lines and the
``export *_STEP_URL`` lines, with the orchestrator's own defaults as a third copy.

**B10 (2026-10-16): 21 processes → 3.** The container ran 19 step services as separate uvicorns plus
the arq worker and the orchestrator. It now runs:

1. ``steps_app`` — every step app mounted under ``/steps/<name>`` in ONE uvicorn
2. the arq worker
3. the orchestrator (the externally-bound process)

The per-step architecture is unchanged — each step is still its own FastAPI app with its own
``StepInput``/``StepOutput`` contract — only the deployment is unified. What this buys:

* **B3** — one process means one ``LLMRouter`` singleton, so ``MAX_CONCURRENT_LLM`` is finally a real
  per-container cap instead of ~19 independent semaphores.
* **A5** — one ``PromptStore``, so ``/admin/reload-prompts`` reaches the code that generates text.
* ~19 fewer Python interpreters.

**Splitting back out is a config change, not a code change.** The orchestrator dials every step
through ``<NAME>_STEP_URL``; this module just decides what those point at. Override any one of them
to a hostname and that step runs wherever you like — which is exactly what ``docker-compose.yml``
does, running one container per step and so continuously exercising the split topology. Per the B10
decision, the per-service Railway split waits for the Gate 2 load data to say which step needs it.

Keep ``STEP_NAMES`` in sync with ``orchestrator.write_tools.ALL_STEP_URLS`` and
``steps_app.main.STEP_APPS`` — ``tests/test_runtime_processes.py`` asserts all three agree, because a
step missing from any of them is a step the orchestrator cannot reach or health cannot see.
"""

from __future__ import annotations

import os

from writer_engine.supervisor import ManagedProcess

# Every step, in startup/mount order. Names match each step service's STEP_NAME, the keys of
# orchestrator.write_tools.ALL_STEP_URLS, and the keys of steps_app.main.STEP_APPS.
STEP_NAMES: tuple[str, ...] = (
    # F0 vertical-slice demo, superseded by `library` (A9 — remove with its entry here).
    "library_retrieve",
    # Newsletter saga steps (F2).
    "gather",
    "pick",
    "subject",
    "scrape",
    "segment",
    "image",
    "assemble",
    "render",
    "persist",
    "deliver",
    # Write-workshop steps (F1).
    "chapter",
    "research",
    "brainstorm",
    "media",
    "library",
    "story_bible",
    "approval",
    "notify",
)

# All steps share one port now; they are told apart by mount path.
DEFAULT_STEPS_PORT = 8030
DEFAULT_ORCHESTRATOR_PORT = 8001
STEP_MOUNT_PREFIX = "/steps"


def step_mount_path(name: str) -> str:
    """Path a step is mounted at inside the steps process."""
    return f"{STEP_MOUNT_PREFIX}/{name}"


def step_url_env(*, steps_port: int | None = None, host: str = "localhost") -> dict[str, str]:
    """The ``*_STEP_URL`` environment the orchestrator reads to dial each step.

    Set explicitly rather than relying on ``EngineSettings`` defaults so the container is
    self-describing and a default drift cannot silently repoint a step at a port nothing serves.

    ``run_step_via_http`` POSTs ``{url}/run``, so a mounted step's URL is
    ``http://host:port/steps/<name>`` and resolves to that sub-app's own ``/run`` route.
    """
    port = steps_port or DEFAULT_STEPS_PORT
    return {f"{name.upper()}_STEP_URL": f"http://{host}:{port}{step_mount_path(name)}" for name in STEP_NAMES}


def build_runtime_processes(
    *,
    orchestrator_port: int | None = None,
    steps_port: int | None = None,
) -> list[ManagedProcess]:
    """Build the process table: the steps app, the arq worker, then the orchestrator.

    The steps app binds to 127.0.0.1 — the orchestrator is the only externally reachable process.
    The consumers (arq worker, orchestrator) are started last and receive the step URLs.
    """
    s_port = steps_port or DEFAULT_STEPS_PORT
    o_port = orchestrator_port or int(os.environ.get("PORT", DEFAULT_ORCHESTRATOR_PORT))
    step_env = step_url_env(steps_port=s_port)

    return [
        ManagedProcess(
            name="steps_app",
            argv=[
                "uvicorn",
                "steps_app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(s_port),
                "--log-level",
                "warning",
            ],
        ),
        # arq drives the newsletter saga between HITL pauses and runs every async write job.
        ManagedProcess(
            name="arq_worker",
            argv=["arq", "orchestrator.worker.WorkerSettings"],
            env=step_env,
        ),
        # The externally-bound process; Railway routes to $PORT.
        ManagedProcess(
            name="orchestrator",
            argv=[
                "uvicorn",
                "orchestrator.main:app",
                "--host",
                "0.0.0.0",
                "--port",
                str(o_port),
            ],
            env=step_env,
        ),
    ]
