# syntax=docker/dockerfile:1.7
# Build the gateway service. Build context = engine/ (the uv workspace root).
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# uv = fast Python package manager
COPY --from=ghcr.io/astral-sh/uv:0.5.13 /uv /usr/local/bin/uv

# Copy workspace metadata + lockfile early for cache-friendly installs
# uv.lock + --frozen with no fallback: this used to be `--frozen || uv sync`, and because the lock
# was never copied into the image the fallback was the only arm that ever ran — so the deployed
# dependencies were whatever resolved on build day rather than what the tests ran against. See
# services/runtime/Dockerfile for the failure that exposed it.
COPY uv.lock ./
COPY pyproject.toml ./
COPY packages/writer_engine/pyproject.toml packages/writer_engine/README.md ./packages/writer_engine/
COPY services/gateway/pyproject.toml ./services/gateway/

# Source
COPY packages/writer_engine/src ./packages/writer_engine/src
COPY services/gateway/src ./services/gateway/src

RUN uv sync --frozen --package gateway --no-dev

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
CMD ["uvicorn", "gateway.main:app", "--host", "0.0.0.0", "--port", "8000"]
