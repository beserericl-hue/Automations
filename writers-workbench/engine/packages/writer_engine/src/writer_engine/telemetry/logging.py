"""structlog JSON logging set up once at process start, with secret redaction (C3/G4)."""

from __future__ import annotations

import logging
import sys

import structlog

from writer_engine.telemetry.redaction import redact_processor


def configure_logging(level: str = "INFO", service: str = "writer-engine") -> None:
    """Configure structlog + stdlib logging for production-quality JSON output."""

    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level.upper())
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            # C3/G4: last before rendering, so it also covers the formatted exception text. Every
            # service logs provider errors verbatim (`error=str(exc)[:200]`), and a provider error
            # is one of the likeliest places for a credential to surface — an SDK that quotes the
            # failing request brings the authorization header with it, and a PostgREST error can
            # quote a URL carrying `apikey=`. Railway's logs are readable by anyone with project
            # access and they are retained.
            redact_processor,
            structlog.processors.JSONRenderer(sort_keys=True),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, level.upper(), logging.INFO)),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
    structlog.contextvars.bind_contextvars(service=service)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """Get a bound logger. Pass ``__name__`` from the caller for module context."""
    return structlog.get_logger(name)
