# syntax=docker/dockerfile:1.7
# Build the gateway service. Build context = engine/ (the uv workspace root).
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# uv = fast Python package manager
COPY --from=ghcr.io/astral-sh/uv:0.5.13 /uv /usr/local/bin/uv

# Copy workspace metadata + lockfile early for cache-friendly installs
COPY pyproject.toml ./
COPY packages/writer_engine/pyproject.toml packages/writer_engine/README.md ./packages/writer_engine/
COPY services/gateway/pyproject.toml ./services/gateway/

# Source
COPY packages/writer_engine/src ./packages/writer_engine/src
COPY services/gateway/src ./services/gateway/src

RUN uv sync --frozen --package gateway --no-dev || uv sync --package gateway --no-dev

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["uvicorn", "gateway.main:app", "--host", "0.0.0.0", "--port", "8000"]
