#!/usr/bin/env bash
# Thin shim — all supervision lives in writer_engine.supervisor (B1).
#
# This file used to start 19 step services and the arq worker as bare `&` background jobs and then
# `exec` the orchestrator. Nothing watched the background jobs, so a dead step service was never
# restarted and never noticed: the container stayed up, the orchestrator kept answering, and every
# job routed through that step failed. Combined with a flat-"ok" /admin/health (B2), a half-dead
# container could serve failures indefinitely.
#
# The replacement is Python rather than shell on purpose. Supervision is the part that must not be
# wrong, and `wait -n` + `declare -A` need bash >= 4.3 — which macOS does not ship, so the shell
# version could not be exercised outside the container. The Python supervisor is unit-tested
# (packages/writer_engine/tests/test_supervisor.py) and type-checked.
#
# Process table + ports: writer_engine/runtime_processes.py (single source of truth, asserted
# against the /admin/health probe registry by tests/test_runtime_processes.py).
#
# Kept as a file so the Dockerfile CMD and any external tooling referencing /entrypoint.sh keep
# working. `exec` so the supervisor is PID 1 and receives SIGTERM directly.
set -euo pipefail

exec python -m writer_engine.supervisor
