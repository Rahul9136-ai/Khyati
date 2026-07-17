"""Autonomy API DTOs."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

AutonomyLevel = Literal["manual", "assisted", "autonomous"]


class AgentInfo(BaseModel):
    """Static description of a registered agent, plus its policy state."""

    key: str
    label: str
    description: str
    enabled: bool
    auto_apply: bool


class ActionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    run_id: uuid.UUID
    agent: str
    action_type: str
    title: str
    rationale: str
    confidence: float
    severity: str
    status: str
    target_type: str | None
    target_id: uuid.UUID | None
    target_label: str | None
    payload: dict
    decided_by: uuid.UUID | None
    decided_at: datetime | None
    applied_at: datetime | None
    result_note: str | None
    created_at: datetime


class RunRequest(BaseModel):
    dry_run: bool = Field(
        default=False,
        description="Evaluate agents and return proposals without persisting or applying.",
    )
    agents: list[str] | None = Field(
        default=None, description="Restrict the run to these agent keys (default: all enabled)."
    )


class RunResult(BaseModel):
    run_id: uuid.UUID
    dry_run: bool
    autonomy_level: str
    auto_apply_threshold: float
    proposed: int
    auto_applied: int
    pending_review: int
    actions: list[ActionOut]


class DecisionRequest(BaseModel):
    note: str | None = Field(default=None, max_length=500)


class PolicyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    autonomy_level: AutonomyLevel
    auto_apply_threshold: float
    agents: list[AgentInfo]


class PolicyUpdate(BaseModel):
    autonomy_level: AutonomyLevel | None = None
    auto_apply_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    # {agent_key: {"enabled": bool, "auto_apply": bool}}
    agent_config: dict[str, dict[str, bool]] | None = None
