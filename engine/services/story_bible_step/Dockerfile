# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.4.18 /uv /usr/local/bin/uv
COPY pyproject.toml ./
COPY packages/writer_engine/pyproject.toml packages/writer_engine/README.md ./packages/writer_engine/
COPY services/story_bible_step/pyproject.toml ./services/story_bible_step/
COPY packages/writer_engine/src ./packages/writer_engine/src
COPY services/story_bible_step/src ./services/story_bible_step/src
RUN uv sync --frozen --package story-bible-step --no-dev || uv sync --package story-bible-step --no-dev
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8025
CMD ["uvicorn", "story_bible_step.main:app", "--host", "0.0.0.0", "--port", "8025"]
