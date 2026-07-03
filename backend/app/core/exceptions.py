"""Typed application errors → consistent JSON error envelope.

Domain/service code raises these instead of HTTPException, keeping business logic
framework-agnostic. The handlers in app.main translate them to HTTP responses.
"""
from __future__ import annotations

from typing import Any


class AppError(Exception):
    """Base for all expected, handled application errors."""

    status_code: int = 400
    code: str = "app_error"

    def __init__(self, message: str, *, details: Any | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"


class ConflictError(AppError):
    status_code = 409
    code = "conflict"


class ValidationError(AppError):
    status_code = 422
    code = "validation_error"


class AuthenticationError(AppError):
    status_code = 401
    code = "authentication_error"


class PermissionDeniedError(AppError):
    status_code = 403
    code = "permission_denied"
