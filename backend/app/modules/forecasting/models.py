"""Forecasting models: historical series + versioned, approvable forecasts."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    JSON,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.mixins import TenantMixin, TimestampMixin, UUIDMixin


class HistoricalSeries(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "historical_series"

    queue_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("queues.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    granularity: Mapped[str] = mapped_column(String(16), default="daily")
    source: Mapped[str] = mapped_column(String(32), default="upload")
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    cleaning_report: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    points: Mapped[list[HistoricalPoint]] = relationship(
        back_populates="series", cascade="all, delete-orphan", order_by="HistoricalPoint.day"
    )


class HistoricalPoint(UUIDMixin, Base):
    __tablename__ = "historical_points"
    __table_args__ = (UniqueConstraint("series_id", "day"),)

    series_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("historical_series.id", ondelete="CASCADE"), index=True
    )
    day: Mapped[date] = mapped_column(Date, index=True)
    volume: Mapped[float] = mapped_column(Float)
    aht: Mapped[float | None] = mapped_column(Float, nullable=True)

    series: Mapped[HistoricalSeries] = relationship(back_populates="points")


class Forecast(UUIDMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "forecasts"

    queue_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("queues.id", ondelete="CASCADE"), nullable=True, index=True
    )
    series_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("historical_series.id", ondelete="SET NULL"), nullable=True
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(), ForeignKey("forecasts.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(128))
    model: Mapped[str] = mapped_column(String(32))
    granularity: Mapped[str] = mapped_column(String(16), default="daily")
    horizon_days: Mapped[int] = mapped_column(Integer)
    version: Mapped[int] = mapped_column(Integer, default=1)
    # draft | pending_approval | approved | rejected
    status: Mapped[str] = mapped_column(String(24), default="draft", index=True)
    mape: Mapped[float | None] = mapped_column(Float, nullable=True)
    backtest: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    params: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rejection_reason: Mapped[str | None] = mapped_column(String(512), nullable=True)

    points: Mapped[list[ForecastPoint]] = relationship(
        back_populates="forecast", cascade="all, delete-orphan", order_by="ForecastPoint.day"
    )


class ForecastPoint(UUIDMixin, Base):
    __tablename__ = "forecast_points"
    __table_args__ = (UniqueConstraint("forecast_id", "day"),)

    forecast_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(), ForeignKey("forecasts.id", ondelete="CASCADE"), index=True
    )
    day: Mapped[date] = mapped_column(Date, index=True)
    volume: Mapped[float] = mapped_column(Float)
    lower: Mapped[float] = mapped_column(Float, default=0)
    upper: Mapped[float] = mapped_column(Float, default=0)
    aht: Mapped[float] = mapped_column(Float, default=0)

    forecast: Mapped[Forecast] = relationship(back_populates="points")
