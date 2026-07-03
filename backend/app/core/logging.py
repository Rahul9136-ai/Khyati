"""Structured logging. JSON in production, pretty console locally."""
from __future__ import annotations

import logging

import structlog

from app.core.config import settings


def configure_logging() -> None:
    """Configure structlog + stdlib logging once at startup."""
    shared = [
        structlog.contextvars.merge_contextvars,  # carries request_id per request
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
    ]
    renderer = (
        structlog.processors.JSONRenderer()
        if settings.is_production
        else structlog.dev.ConsoleRenderer()
    )
    structlog.configure(
        processors=[*shared, renderer],  # type: ignore[list-item]
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.DEBUG if settings.DEBUG else logging.INFO
        ),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
