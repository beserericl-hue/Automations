# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:0.4.18 /uv /usr/local/bin/uv

COPY pyproject.toml ./
COPY packages/writer_engine/pyproject.toml packages/writer_engine/README.md ./packages/writer_engine/
COPY services/orchestrator/pyproject.toml ./services/orchestrator/

COPY packages/writer_engine/src ./packages/writer_engine/src
COPY services/orchestrator/src ./services/orchestrator/src

RUN uv sync --frozen --package orchestrator --no-dev || uv sync --package orchestrator --no-dev

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8001
CMD ["uvicorn", "orchestrator.main:app", "--host", "0.0.0.0", "--port", "8001"]
