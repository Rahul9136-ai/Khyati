"""Inbound automation: @mention the bot in a designated Slack/Teams channel with a
schedule-change message, and it's parsed, raised, and — above the configured
confidence threshold — applied immediately, then replied to in the same
channel/thread. Below the threshold (or for a kind that never auto-applies) it's
raised for the Operations Manager exactly like the in-app "Request OM sign-off"
flow, and the reply says so instead.

This reuses the same parser (`app.modules.ai.service.parse_schedule_request`) and
the same approval pipeline (`create_approval` / `_apply_change`) as a message
pasted into the app — automation only decides whether a human has to click
Approve first, never how the message is read or how the change is applied.
"""
from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.modules.ai import schedule_parser
from app.modules.ai.service import parse_schedule_request
from app.modules.integrations.adapters import DispatchResult, SlackAdapter, TeamsAdapter, kind_label
from app.modules.integrations.models import ApprovalRequest, IntegrationConfig
from app.modules.integrations.schemas import ApprovalCreate
from app.modules.integrations.service import auto_decide_and_apply, create_approval

_CONFIDENCE_ORDER = {"Low": 0, "Medium": 1, "High": 2}

# The kinds the automation policy will ever apply with no human — deliberately a
# stricter list than the six actions the parser recognises. Shift Swap always
# needs a human: it touches two people's shifts and the parser only ever names one
# of them with confidence, so swapping the wrong pair unattended is a distinctly
# higher-severity mistake than any single-employee action below.
AUTO_APPLY_KINDS = {
    "Mark Leave": "leave_mark",
    "Cancel Leave": "leave_cancel",
    "Mark Absence": "absence_mark",
    "Change Shift Timing": "shift_change",
}
KIND_FOR_ACTION = {**AUTO_APPLY_KINDS, "Shift Swap": "shift_swap", "Other": "schedule_request"}


def meets_threshold(confidence: str, min_confidence: str) -> bool:
    if min_confidence == "Off":
        return False
    return _CONFIDENCE_ORDER.get(confidence, 0) >= _CONFIDENCE_ORDER.get(min_confidence, 2)


def single_resolved_date(date_or_week: str | None) -> str | None:
    """The ISO date if `date_or_week` names exactly one day, else None — a range
    ("2026-07-03 to 2026-07-05") or a week label ("WK-3") is ambiguous about which
    single day to touch, so auto-apply skips it and a human picks the day instead."""
    if not date_or_week or len(date_or_week) != 10:
        return None
    try:
        date.fromisoformat(date_or_week)
    except ValueError:
        return None
    return date_or_week


def _who(parsed: dict, matched: dict | None) -> str:
    if matched:
        return f"{matched['name']} ({matched['employee_code']})"
    bits = [parsed.get("employee_name"), f"({parsed['employee_id']})" if parsed.get("employee_id") else None]
    return " ".join(b for b in bits if b) or "an employee"


def _title_and_summary(parsed: dict, parser: str, source: str) -> tuple[str, str]:
    who = _who(parsed, None)
    title = f"{parsed['action']} — {who}"
    if parsed.get("date_or_week"):
        title += f" · {parsed['date_or_week']}"
    lines = [
        f'Requested by message: "{parsed["raw_message"].strip()}"',
        f"Employee: {who}",
        "Action: " + parsed["action"] + (f" on {parsed['date_or_week']}" if parsed.get("date_or_week") else ""),
    ]
    if parsed.get("field_to_change"):
        lines.append(f"Change: {parsed['field_to_change']} → {parsed.get('new_value') or '(no value)'}")
    lines.append(
        f"Parsed by {'Claude' if parser == 'claude' else 'rules'} · confidence {parsed['confidence']}"
        f" · auto-ingested from {source}"
    )
    return title[:200], "\n".join(lines)


def _approval_link(approval_id: uuid.UUID) -> str:
    return f"{settings.APP_WEB_URL.rstrip('/')}/approvals?focus={approval_id}"


def _reply_text(approval: ApprovalRequest, parsed: dict, attempted_auto: bool) -> str:
    link = _approval_link(approval.id)
    if approval.status == "applied":
        detail = (approval.apply_result or {}).get("detail", "")
        return f"✅ Done — {detail or f'{kind_label(approval.kind)} applied'}. ({link})"
    if attempted_auto:  # tried to auto-apply, couldn't — auto_decide_and_apply rolled it back to pending
        return f"⚠️ {approval.decision_note} ({link})"
    if not parsed["employee_id"]:
        return (
            "📝 Got it, but I couldn't find an employee ID in that message, so I didn't guess one — "
            f"sent to the Operations Manager for approval. Add the ID in FlowForce to speed this up. ({link})"
        )
    return (
        f"📝 Got it — {kind_label(approval.kind)} for {_who(parsed, None)} sent to the Operations Manager "
        f"for approval (confidence: {parsed['confidence']}). ({link})"
    )


async def handle_inbound_command(
    db: AsyncSession, config: IntegrationConfig, *, source: str, text: str, reply_target: dict,
) -> dict:
    """`source` is "slack" or "teams" — it only labels where the command came from
    and where the reply goes; the approval itself is always raised with
    `source="scheduling"` because every action this parser recognises is a roster
    change, not one of the real-time desk's own overtime/VTO/break-recovery
    proposals (those still only come from the in-app Real-Time tab)."""
    org_id = config.organization_id
    result = await parse_schedule_request(db, org_id, text, date.today())
    parsed, parser, matched = result["parsed"], result["parser"], result["matched_employee"]

    action = parsed["action"]
    kind = KIND_FOR_ACTION[action]
    resolved_date = single_resolved_date(parsed["date_or_week"])
    clock_range = schedule_parser.resolve_clock_range(text) if action == "Change Shift Timing" else None

    can_resolve = bool(resolved_date) and (action != "Change Shift Timing" or clock_range is not None)
    can_auto = (
        config.automation_enabled
        and action in AUTO_APPLY_KINDS
        and matched is not None
        and can_resolve
        and meets_threshold(parsed["confidence"], config.auto_apply_min_confidence)
    )

    title, summary = _title_and_summary(parsed, parser, source)
    payload = {
        "employee_code": parsed["employee_id"], "employee_name": parsed["employee_name"],
        "action": action, "date_or_week": parsed["date_or_week"], "date": resolved_date,
        "field_to_change": parsed["field_to_change"], "new_value": parsed["new_value"],
        "raw_message": parsed["raw_message"], "confidence": parsed["confidence"],
        "parser": parser, "raised_from": source,
    }
    if clock_range:
        payload["new_start_minutes"], payload["new_end_minutes"] = clock_range

    approval = await create_approval(
        db, org_id,
        ApprovalCreate(
            source="scheduling", kind=kind, title=title, summary=summary, payload=payload,
            employee_id=uuid.UUID(matched["id"]) if matched else None,
        ),
        actor=None,
    )

    if can_auto:
        note = f"Auto-applied — {parsed['confidence']} confidence via {source} command"
        approval = await auto_decide_and_apply(db, approval, note=note)

    reply = _reply_text(approval, parsed, attempted_auto=can_auto)
    dispatch = await _send_reply(config, source, reply, reply_target)

    return {
        "parsed": parsed, "parser": parser, "matched_employee": matched,
        "approval_id": str(approval.id), "status": approval.status,
        "auto_applied": approval.status == "applied" and approval.decided_via == "auto",
        "reply": reply, "reply_sent": dispatch.ok, "reply_simulated": dispatch.simulated,
    }


async def _send_reply(config: IntegrationConfig, source: str, text: str, target: dict) -> DispatchResult:
    if source == "slack":
        return await SlackAdapter(config).reply(target["channel"], target.get("thread_ts"), text)
    return await TeamsAdapter(config).reply(
        target["service_url"], target["conversation_id"], target.get("activity_id"), text
    )
