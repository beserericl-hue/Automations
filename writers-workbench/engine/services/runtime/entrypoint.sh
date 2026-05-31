#!/usr/bin/env bash
# Start orchestrator + arq worker + every step service in this container. Step services bind to localhost only
# (no external port) — only the orchestrator is reachable from outside the container.
set -euo pipefail

ORCH_PORT="${PORT:-8001}"

# Step services on their conventional ports — orchestrator's *_STEP_URL defaults already point at these.
start() {
  local module="$1"; local port="$2"; local name="$3"
  echo "starting $name on :$port"
  uvicorn "$module" --host 127.0.0.1 --port "$port" --log-level warning &
}

start library_retrieve_step.main:app 8002 library_retrieve_step
start gather_step.main:app             8010 gather_step
start pick_step.main:app               8011 pick_step
start subject_step.main:app            8012 subject_step
start scrape_step.main:app             8013 scrape_step
start segment_step.main:app            8014 segment_step
start image_step.main:app              8015 image_step
start assemble_step.main:app           8016 assemble_step
start render_step.main:app             8017 render_step
start persist_step.main:app            8018 persist_step
start deliver_step.main:app            8019 deliver_step

# Point orchestrator's saga at localhost for every step.
export GATHER_STEP_URL="http://localhost:8010"
export PICK_STEP_URL="http://localhost:8011"
export SUBJECT_STEP_URL="http://localhost:8012"
export SCRAPE_STEP_URL="http://localhost:8013"
export SEGMENT_STEP_URL="http://localhost:8014"
export IMAGE_STEP_URL="http://localhost:8015"
export ASSEMBLE_STEP_URL="http://localhost:8016"
export RENDER_STEP_URL="http://localhost:8017"
export PERSIST_STEP_URL="http://localhost:8018"
export DELIVER_STEP_URL="http://localhost:8019"
export LIBRARY_RETRIEVE_STEP_URL="http://localhost:8002"

# arq worker drives the saga between HITL pauses.
echo "starting arq worker"
arq orchestrator.worker.WorkerSettings &

# Orchestrator FastAPI app is the one externally-bound service (Railway routes to ${PORT}).
echo "starting orchestrator on 0.0.0.0:${ORCH_PORT}"
exec uvicorn orchestrator.main:app --host 0.0.0.0 --port "${ORCH_PORT}"
