"""Shared API DTOs: response envelope, pagination, health."""
from __future__ import annotations

from collections.abc import Sequence
from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class ApiResponse(BaseModel, Generic[T]):
    """Standard success envelope so every endpoint returns the same shape."""

    success: bool = True
    data: T


class PageParams(BaseModel):
    """Query params for paginated list endpoints."""

    page: int = Field(1, ge=1)
    size: int = Field(20, ge=1, le=200)

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.size


class Page(BaseModel, Generic[T]):
    """Paginated result envelope."""

    items: Sequence[T]
    total: int
    page: int
    size: int

    @property
    def pages(self) -> int:
        return (self.total + self.size - 1) // self.size if self.size else 0


class HealthStatus(BaseModel):
    status: str = "ok"
    version: str
    environment: str


class ReadinessStatus(BaseModel):
    status: str
    database: str
    redis: str
