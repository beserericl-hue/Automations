"""Prometheus metrics — mounted by every step / orchestrator / gateway under ``/metrics``."""

from __future__ import annotations

from collections.abc import Iterable
from contextlib import contextmanager
from time import perf_counter

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    REGISTRY,
    CollectorRegistry,
    Counter,
    Histogram,
    generate_latest,
)
from starlette.responses import Response

# Default counters/histograms — register once at import.
HTTP_REQUESTS = Counter(
    "engine_http_requests_total",
    "Count of HTTP requests handled.",
    labelnames=("service", "route", "method", "status"),
)
HTTP_LATENCY = Histogram(
    "engine_http_request_seconds",
    "HTTP request latency in seconds.",
    labelnames=("service", "route", "method"),
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 300.0),
)
STEP_LATENCY = Histogram(
    "engine_step_seconds",
    "Step-service execution latency in seconds.",
    labelnames=("service", "step", "status"),
    buckets=(0.01, 0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 300.0),
)
LLM_CALLS = Counter(
    "engine_llm_calls_total",
    "LLM provider call count.",
    labelnames=("service", "provider", "model", "status"),
)
LLM_TOKENS = Counter(
    "engine_llm_tokens_total",
    "LLM tokens consumed (input + output).",
    labelnames=("service", "provider", "model", "kind"),  # kind in {input, output, cache_read, cache_write}
)


def register_default_metrics(_: Iterable[str] = ()) -> None:
    """No-op placeholder kept for symmetry; default metrics register on import."""
    return None


@contextmanager
def observe_latency(histogram: Histogram, **labels: str):
    """Time a block and record to the given histogram. Use as ``with observe_latency(...)``."""
    start = perf_counter()
    try:
        yield
    finally:
        histogram.labels(**labels).observe(perf_counter() - start)


def metrics_app(registry: CollectorRegistry = REGISTRY) -> Response:
    """Return a Starlette response with the latest Prometheus exposition."""
    return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)
