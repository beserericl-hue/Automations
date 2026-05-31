# syntax=docker/dockerfile:1.7
# Combined runtime — runs the orchestrator + arq worker + all 10 step services as background processes on a
# single container. The orchestrator calls each step at http://localhost:PORT via the *_STEP_URL env vars.
# Trades the engine-framework per-step deployment for a ~$10/mo Railway footprint while preserving the per-step
# *architecture* (each step is still its own FastAPI app with its own port). Split to per-service when traffic
# justifies it.
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:0.5.13 /uv /usr/local/bin/uv

# Workspace metadata + the library and every step service.
COPY pyproject.toml ./
COPY packages/writer_engine/pyproject.toml packages/writer_engine/README.md ./packages/writer_engine/
COPY services/orchestrator/pyproject.toml ./services/orchestrator/
COPY services/library_retrieve_step/pyproject.toml ./services/library_retrieve_step/
COPY services/gather_step/pyproject.toml ./services/gather_step/
COPY services/pick_step/pyproject.toml ./services/pick_step/
COPY services/subject_step/pyproject.toml ./services/subject_step/
COPY services/scrape_step/pyproject.toml ./services/scrape_step/
COPY services/segment_step/pyproject.toml ./services/segment_step/
COPY services/image_step/pyproject.toml ./services/image_step/
COPY services/assemble_step/pyproject.toml ./services/assemble_step/
COPY services/render_step/pyproject.toml ./services/render_step/
COPY services/persist_step/pyproject.toml ./services/persist_step/
COPY services/deliver_step/pyproject.toml ./services/deliver_step/

# Source for everything that runs in this container.
COPY packages/writer_engine/src ./packages/writer_engine/src
COPY services/orchestrator/src ./services/orchestrator/src
COPY services/library_retrieve_step/src ./services/library_retrieve_step/src
COPY services/gather_step/src ./services/gather_step/src
COPY services/pick_step/src ./services/pick_step/src
COPY services/subject_step/src ./services/subject_step/src
COPY services/scrape_step/src ./services/scrape_step/src
COPY services/segment_step/src ./services/segment_step/src
COPY services/image_step/src ./services/image_step/src
COPY services/assemble_step/src ./services/assemble_step/src
COPY services/render_step/src ./services/render_step/src
COPY services/persist_step/src ./services/persist_step/src
COPY services/deliver_step/src ./services/deliver_step/src

COPY services/runtime/entrypoint.sh /entrypoint.sh

# Install every workspace package at once.
RUN uv sync --all-packages --no-dev
RUN chmod +x /entrypoint.sh

ENV PATH="/app/.venv/bin:$PATH"
# Orchestrator exposes 8001 outside; step services + arq stay internal.
EXPOSE 8001
CMD ["/entrypoint.sh"]
