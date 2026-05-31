# Adding a step service

A step service is a small FastAPI app that implements a single async `handler(StepInput) -> StepOutput`. The
framework gives you `POST /run` (X-Service-Secret), `/admin/health`, `/metrics`, structured logs, and Prometheus
metrics for free.

## 1. Create the service folder

```
services/<my_step>/
├── pyproject.toml
├── Dockerfile
├── src/<my_step>/__init__.py
├── src/<my_step>/main.py
└── tests/
```

Copy `services/library_retrieve_step/` as a starting point.

## 2. Implement `main.py`

```python
from writer_engine.schemas import StepInput, StepOutput, StepStatus
from writer_engine.step_service import build_step_app

STEP_NAME = "my_step"

async def handler(inp: StepInput) -> StepOutput:
    # do the work; reach into inp.payload, call writer_engine.llm / storage / supabase etc.
    return StepOutput(execution_id=inp.execution_id, step_name=STEP_NAME, payload={...})

app = build_step_app(STEP_NAME, handler)
```

## 3. Register in `pyproject.toml` (workspace)

Add the path to `[tool.uv.workspace].members`. uv picks it up next sync.

## 4. Add it to `docker-compose.yml`

Mirror an existing entry — port + env_file + the matching Dockerfile.

## 5. Write tests

Put an L0 (`pytest tests/test_contract.py`) + L1 (`test_handler.py`) test in `services/<my_step>/tests/`. The
fixtures in `engine/packages/writer_engine/tests/conftest.py` are reusable.

That's it. The orchestrator can now invoke your step via `run_step_via_http(StepRef("my_step", "http://my-step:8003"))`.
