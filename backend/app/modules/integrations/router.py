"""Integration + approval-bridge endpoints: /integrations.

Authenticated endpoints manage the Slack/Teams config and let an Operations
Manager review/decide approvals in-app. Two *public* endpoints receive the
interactive button callbacks from Slack and Teams; they authenticate the caller
by verifying the platform signature / shared token rather than a JWT.
"""
from __future__ import annotations

import json
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response

from app.api.deps import DbSession, require_permission
from app.modules.identity.models import User
from app.modules.integrations import service
from app.modules.integrations.models import IntegrationConfig
from app.modules.integrations.schemas import (
    ApprovalCreate,
    ApprovalDecision,
    ApprovalDetailOut,
    ApprovalOut,
    IntegrationConfigIn,
    IntegrationConfigOut,
    TestDispatchOut,
)
from app.modules.integrations.security import verify_slack_signature, verify_teams_token
from app.modules.workforce.service import org_scope
from app.schemas.common import ApiResponse, Page

router = APIRouter(prefix="/integrations", tags=["integrations"])

ConfigManager = Annotated[User, Depends(require_permission("integration:manage"))]
ApprovalReader = Annotated[User, Depends(require_permission("request:read", "intraday:read"))]
ApprovalRaiser = Annotated[
    User, Depends(require_permission("intraday:write", "schedule:write"))
]
OmApprover = Annotated[User, Depends(require_permission("request:approve_manager"))]


def _config_out(config: IntegrationConfig) -> IntegrationConfigOut:
    return IntegrationConfigOut(
        slack_enabled=config.slack_enabled,
        slack_configured=bool(config.slack_webhook_url or config.slack_bot_token),
        slack_channel=config.slack_channel,
        slack_webhook_set=bool(config.slack_webhook_url),
        slack_bot_token_set=bool(config.slack_bot_token),
        slack_signing_secret_set=bool(config.slack_signing_secret),
        teams_enabled=config.teams_enabled,
        teams_configured=bool(config.teams_webhook_url),
        teams_webhook_set=bool(config.teams_webhook_url),
        teams_security_token_set=bool(config.teams_security_token),
        default_approver_id=config.default_approver_id,
        auto_apply_on_approve=config.auto_apply_on_approve,
        any_channel_live=config.any_channel_live,
    )


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
@router.get("/config", response_model=ApiResponse[IntegrationConfigOut])
async def get_config(db: DbSession, user: ConfigManager):
    config = await service.get_or_create_config(db, org_scope(user))
    return ApiResponse(data=_config_out(config))


@router.put("/config", response_model=ApiResponse[IntegrationConfigOut])
async def put_config(body: IntegrationConfigIn, db: DbSession, actor: ConfigManager):
    config = await service.update_config(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=_config_out(config))


@router.post("/config/test", response_model=ApiResponse[TestDispatchOut])
async def test_dispatch(db: DbSession, actor: ConfigManager):
    """Send a throwaway approval card to the configured channels to verify wiring."""
    from app.modules.integrations.adapters import SlackAdapter, TeamsAdapter
    from app.modules.integrations.models import ApprovalRequest

    config = await service.get_or_create_config(db, org_scope(actor))
    probe = ApprovalRequest(
        organization_id=org_scope(actor), source="intraday", kind="overtime",
        title="FlowForce connection test",
        summary="If you can see this card with Approve/Reject buttons, the channel is wired up.",
    )
    probe.id = uuid.uuid4()
    results = []
    for channel, adapter in (("slack", SlackAdapter(config)), ("teams", TeamsAdapter(config))):
        enabled = config.slack_enabled if channel == "slack" else config.teams_enabled
        if not enabled:
            continue
        res = await adapter.send(probe)
        results.append({"channel": channel, "ok": res.ok,
                        "simulated": res.simulated, "detail": res.detail})
    return ApiResponse(data=TestDispatchOut(results=results))


# --------------------------------------------------------------------------- #
# Approvals
# --------------------------------------------------------------------------- #
@router.post("/approvals", response_model=ApiResponse[ApprovalDetailOut], status_code=201)
async def create_approval(body: ApprovalCreate, db: DbSession, actor: ApprovalRaiser):
    approval = await service.create_approval(db, org_scope(actor), body, actor=actor)
    return ApiResponse(data=ApprovalDetailOut.model_validate(approval))


@router.get("/approvals", response_model=ApiResponse[Page[ApprovalOut]])
async def list_approvals(
    db: DbSession,
    user: ApprovalReader,
    status: str | None = None,
    source: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
):
    rows, total = await service.list_approvals(
        db, org_scope(user), status=status, source=source,
        offset=(page - 1) * size, limit=size,
    )
    return ApiResponse(
        data=Page(items=[ApprovalOut.model_validate(r) for r in rows],
                  total=total, page=page, size=size)
    )


@router.get("/approvals/{approval_id}", response_model=ApiResponse[ApprovalDetailOut])
async def get_approval(approval_id: uuid.UUID, db: DbSession, user: ApprovalReader):
    approval = await service.get_approval(db, approval_id)
    return ApiResponse(data=ApprovalDetailOut.model_validate(approval))


@router.post("/approvals/{approval_id}/decision", response_model=ApiResponse[ApprovalDetailOut])
async def decide(
    approval_id: uuid.UUID, body: ApprovalDecision, db: DbSession, actor: OmApprover
):
    approval = await service.decide_approval(
        db, approval_id, approve=body.approve, actor=actor, note=body.note, via="in_app"
    )
    return ApiResponse(data=ApprovalDetailOut.model_validate(approval))


# --------------------------------------------------------------------------- #
# Inbound platform callbacks (public — verified by signature/token, not JWT)
# --------------------------------------------------------------------------- #
async def _decide_from_platform(
    db: DbSession, approval_id: uuid.UUID, approve: bool, via: str
) -> None:
    approval = await service.get_approval(db, approval_id)
    actor = await service.resolve_om(db, approval.organization_id,
                                     preferred_id=approval.assigned_om_id)
    if actor is None:
        raise ValueError("No Operations Manager available to record this decision")
    await service.decide_approval(db, approval_id, approve=approve, actor=actor, via=via)


@router.post("/slack/actions", include_in_schema=True)
async def slack_actions(request: Request, db: DbSession):
    """Slack interactive-components callback (Approve/Reject button clicks)."""
    raw = await request.body()
    config = await _config_for_request(db, request)
    if config is None or not verify_slack_signature(
        config.slack_signing_secret,
        request.headers.get("X-Slack-Request-Timestamp"),
        request.headers.get("X-Slack-Signature"),
        raw,
    ):
        return Response(status_code=401, content="invalid signature")

    form = dict(x.split("=", 1) for x in raw.decode().split("&") if "=" in x)
    from urllib.parse import unquote_plus

    payload = json.loads(unquote_plus(form.get("payload", "{}")))
    actions = payload.get("actions", [])
    if not actions:
        return {"text": "No action received."}
    action_id = actions[0].get("action_id", "")
    approval_id = actions[0].get("value", "")
    if action_id not in ("approval_approve", "approval_reject") or not approval_id:
        return {"text": "Nothing to do."}
    try:
        await _decide_from_platform(
            db, uuid.UUID(approval_id), action_id == "approval_approve", via="slack"
        )
    except Exception as exc:  # noqa: BLE001 - report back to Slack, never 500
        return {"replace_original": False, "text": f"Could not record decision: {exc}"}
    verb = "approved ✅" if action_id == "approval_approve" else "rejected ❌"
    return {"replace_original": True, "text": f"Decision recorded — {verb} in FlowForce WFM."}


@router.post("/teams/actions", include_in_schema=True)
async def teams_actions(request: Request, db: DbSession):
    """Teams Actionable-Message callback (Action.Http Approve/Reject)."""
    body = await request.json()
    config = await _config_for_teams(db)
    if config is None or not verify_teams_token(config.teams_security_token, body.get("token")):
        return Response(status_code=401, content="invalid token")
    approval_id = body.get("approval_id", "")
    action = body.get("action", "")
    if action not in ("approve", "reject") or not approval_id:
        return Response(status_code=400, content="bad request")
    try:
        await _decide_from_platform(db, uuid.UUID(approval_id), action == "approve", via="teams")
    except Exception as exc:  # noqa: BLE001
        return Response(status_code=200, content=f"Could not record decision: {exc}")
    return Response(status_code=200, content=f"Decision recorded ({action}) in FlowForce WFM.")


async def _config_for_request(db: DbSession, request: Request) -> IntegrationConfig | None:
    """Slack doesn't tell us the org up front; we match by the only Slack-enabled
    config that carries a signing secret. Single-tenant demo keeps this simple."""
    from sqlalchemy import select

    rows = await db.execute(
        select(IntegrationConfig).where(IntegrationConfig.slack_signing_secret != "")
    )
    return rows.scalars().first()


async def _config_for_teams(db: DbSession) -> IntegrationConfig | None:
    """Match the Teams callback to the (single-tenant demo) config holding a token."""
    from sqlalchemy import select

    rows = await db.execute(
        select(IntegrationConfig).where(IntegrationConfig.teams_security_token != "")
    )
    return rows.scalars().first()
