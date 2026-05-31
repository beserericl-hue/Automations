"""Telemetry — structured logging, Prometheus metrics, OTel spans."""

from .logging import configure_logging, get_logger
from .metrics import metrics_app, observe_latency, register_default_metrics

__all__ = [
    "configure_logging",
    "get_logger",
    "metrics_app",
    "observe_latency",
    "register_default_metrics",
]
