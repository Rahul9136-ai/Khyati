"""Month-key helpers. A planning month is identified by its ``YYYY-MM`` string
and anchored to the first day of the month (the workbook snapshots on the 1st)."""
from __future__ import annotations

from datetime import date


def month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def month_first_day(key: str) -> date:
    year, month = (int(x) for x in key.split("-"))
    return date(year, month, 1)


def month_index(key: str) -> int:
    """Absolute month ordinal, so month arithmetic/comparison is trivial."""
    year, month = (int(x) for x in key.split("-"))
    return year * 12 + (month - 1)


def months_between(start: str, end: str) -> list[str]:
    """Inclusive list of month keys from ``start`` to ``end``."""
    a, b = month_index(start), month_index(end)
    if b < a:
        return []
    return [f"{i // 12:04d}-{i % 12 + 1:02d}" for i in range(a, b + 1)]


def add_months(key: str, n: int) -> str:
    i = month_index(key) + n
    return f"{i // 12:04d}-{i % 12 + 1:02d}"


def tenure_months(from_date: date, at_month: str) -> float:
    """Tenure in months between ``from_date`` (e.g. DOP) and a planning month.

    Mirrors the workbook's ``(month_date - date)/365*12`` day-based measure.
    """
    anchor = month_first_day(at_month)
    days = (anchor - from_date).days
    return days / 365.0 * 12.0
