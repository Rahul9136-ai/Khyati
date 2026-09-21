"""Demo/dev seeder: builds a complete, coherent organization end to end.

Run:  python -m app.db.seed
Creates tables (SQLite dev backend), seeds RBAC, one demo org, users for every
role, org structure, 20 agents, 120 days of history, an auto forecast, a
capacity plan, shift templates, a published schedule, two weeks of attendance
and today's interval actuals — so every screen and endpoint has live data.

Idempotence: aborts if the demo org already exists.
"""
from __future__ import annotations

import asyncio
import random
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import select

import app.db.registry  # noqa: F401  (register all models)
from app.db.base import Base
from app.db.session import AsyncSessionLocal, engine
from app.modules.attendance.models import AttendanceCode
from app.modules.attendance.schemas import RecordIn
from app.modules.attendance.service import create_record
from app.modules.forecasting.schemas import ForecastRequest, PointIn, SeriesUpload
from app.modules.forecasting.service import create_series, run_forecast, transition_forecast
from app.modules.identity.schemas import UserCreate
from app.modules.identity.service import create_user, seed_rbac
from app.modules.integrations.schemas import ApprovalCreate
from app.modules.integrations.service import create_approval, get_or_create_config
from app.modules.intraday.schemas import ActualIn
from app.modules.intraday.service import upsert_actuals
from app.modules.planning.schemas import Assumptions, PlanCreate, PlanWeekIn
from app.modules.planning.service import create_plan
from app.modules.scheduling.models import ScheduleShift, ShiftTemplate
from app.modules.scheduling.schemas import GenerateScheduleRequest
from app.modules.scheduling.service import generate_schedule, publish_schedule
from app.modules.workforce.models import (
    BusinessUnit,
    Country,
    Employee,
    Lob,
    Organization,
    Queue,
    Skill,
    Team,
)

RNG = random.Random(42)

FIRST = ["Ana", "Ben", "Chloe", "Dev", "Elif", "Femi", "Gita", "Hugo", "Iris", "Jon",
         "Kira", "Liam", "Mona", "Nils", "Omar", "Pia", "Quinn", "Rhea", "Sam", "Tara"]
LAST = ["Alvarez", "Becker", "Chen", "Diaz", "Ekwueme", "Fischer", "Gupta", "Haddad",
        "Ivanov", "Jensen", "Kaur", "Lopez", "Meyer", "Novak", "Okafor", "Patel",
        "Quintero", "Rossi", "Silva", "Tanaka"]


def _history(days: int = 120, base: float = 900.0) -> list[PointIn]:
    """Synthetic but realistic daily volume: trend + weekly season + noise."""
    weekday_mult = [1.15, 1.1, 1.0, 0.98, 1.05, 0.55, 0.4]
    points = []
    start = date.today() - timedelta(days=days)
    for i in range(days):
        day = start + timedelta(days=i)
        trend = 1 + 0.0015 * i
        noise = RNG.gauss(1.0, 0.06)
        volume = max(0.0, base * trend * weekday_mult[day.weekday()] * noise)
        points.append(PointIn(day=day, volume=round(volume, 1),
                              aht=round(RNG.gauss(310, 12), 1)))
    return points


async def seed_demo() -> dict:
    async with AsyncSessionLocal() as db:
        existing = await db.execute(select(Organization).where(Organization.code == "DEMO"))
        if existing.scalar_one_or_none():
            return {"status": "skipped", "reason": "demo org already exists"}

        await seed_rbac(db)

        org = Organization(name="FlowForce Demo Corp", code="DEMO")
        db.add(org)
        await db.flush()

        # ---- users for every role -----------------------------------------
        admin = await create_user(
            db,
            UserCreate(email="admin@flowforce.dev", password="Admin@12345",
                       full_name="Avery Admin", role_names=["Super Admin"],
                       organization_id=org.id),
            actor=None,
        )
        admin.is_superuser = True
        role_users = {
            "director@flowforce.dev": ("Dana Director", "WFM Director"),
            "planner@flowforce.dev": ("Petra Planner", "Planning Manager"),
            "analyst@flowforce.dev": ("Farid Forecaster", "Forecasting Analyst"),
            "scheduler@flowforce.dev": ("Sana Scheduler", "Scheduler"),
            "rta@flowforce.dev": ("Riley RTA", "Real-Time Analyst"),
            "opsmgr@flowforce.dev": ("Omar Ops", "Operations Manager"),
            "teamlead@flowforce.dev": ("Tess Lead", "Team Leader"),
            "hr@flowforce.dev": ("Hana HR", "HR"),
            "reporter@flowforce.dev": ("Remy Reports", "Reporting Analyst"),
        }
        for email, (name, role) in role_users.items():
            await create_user(
                db,
                UserCreate(email=email, password="Demo@12345", full_name=name,
                           role_names=[role], organization_id=org.id),
                actor=admin,
            )

        # ---- org structure -------------------------------------------------
        country = Country(organization_id=org.id, name="United States", iso_code="US",
                          timezone="America/New_York")
        db.add(country)
        bu = BusinessUnit(organization_id=org.id, name="Customer Care", code="CARE")
        db.add(bu)
        await db.flush()
        lob = Lob(organization_id=org.id, business_unit_id=bu.id, name="Support",
                  code="SUP", client="Acme Retail", department="Operations")
        db.add(lob)
        await db.flush()
        team_a = Team(organization_id=org.id, lob_id=lob.id, name="Team Alpha")
        team_b = Team(organization_id=org.id, lob_id=lob.id, name="Team Beta")
        db.add_all([team_a, team_b])
        skills = [Skill(organization_id=org.id, name=n, category=c)
                  for n, c in (("Voice", "channel"), ("Chat", "channel"),
                               ("English", "language"), ("Billing", "product"))]
        db.add_all(skills)
        voice_q = Queue(organization_id=org.id, lob_id=lob.id, name="Voice Support",
                        channel="voice", sla_threshold_seconds=30, sla_target_pct=0.8,
                        default_aht_seconds=310, interval_minutes=30)
        chat_q = Queue(organization_id=org.id, lob_id=lob.id, name="Chat Support",
                       channel="chat", sla_threshold_seconds=60, sla_target_pct=0.85,
                       concurrency=2.0, default_aht_seconds=480, interval_minutes=30)
        db.add_all([voice_q, chat_q])
        await db.flush()

        # ---- employees ------------------------------------------------------
        employees: list[Employee] = []
        for i in range(20):
            emp = Employee(
                organization_id=org.id,
                employee_code=f"E{1000 + i}",
                first_name=FIRST[i], last_name=LAST[i],
                email=f"{FIRST[i].lower()}.{LAST[i].lower()}@flowforce.dev",
                country_id=country.id,
                team_id=(team_a if i < 12 else team_b).id,
                lob_id=lob.id,
                employment_type="full_time" if i % 5 else "part_time",
                weekly_hours=40 if i % 5 else 25,
                timezone="America/New_York",
                location="Austin, TX",
                hire_date=date.today() - timedelta(days=200 + i * 11),
            )
            db.add(emp)
            employees.append(emp)
        await db.flush()

        # link an agent login to the first employee
        await create_user(
            db,
            UserCreate(email="agent@flowforce.dev", password="Demo@12345",
                       full_name=employees[0].full_name, role_names=["Employee"],
                       organization_id=org.id, employee_id=employees[0].id),
            actor=admin,
        )

        # ---- attendance codes ----------------------------------------------
        codes = {
            "PRS": AttendanceCode(organization_id=org.id, code="PRS", name="Present",
                                  category="present"),
            "LTE": AttendanceCode(organization_id=org.id, code="LTE", name="Late login",
                                  category="late"),
            "ABS": AttendanceCode(organization_id=org.id, code="ABS", name="Unplanned absence",
                                  category="absent", is_paid=False, counts_as_shrinkage=True),
            "SIC": AttendanceCode(organization_id=org.id, code="SIC", name="Sick leave",
                                  category="sick", counts_as_shrinkage=True),
            "VAC": AttendanceCode(organization_id=org.id, code="VAC", name="Vacation",
                                  category="vacation", counts_as_shrinkage=True),
            "TRN": AttendanceCode(organization_id=org.id, code="TRN", name="Training",
                                  category="training", counts_as_shrinkage=True),
        }
        db.add_all(codes.values())
        await db.flush()

        # ---- history + forecast ----------------------------------------------
        series = await create_series(
            db, org.id,
            SeriesUpload(name="Voice Support daily volume", queue_id=voice_q.id,
                         points=_history()),
            actor=admin, source="seed",
        )
        forecast = await run_forecast(
            db, org.id,
            ForecastRequest(series_id=series.id, name="Voice Support 28-day",
                            model="auto", horizon_days=28),
            actor=admin,
        )
        await transition_forecast(db, forecast.id, "submit", actor=admin)
        await transition_forecast(db, forecast.id, "approve", actor=admin)

        # ---- capacity plan ----------------------------------------------------
        next_monday = date.today() + timedelta(days=(7 - date.today().weekday()) % 7 or 7)
        await create_plan(
            db, org.id,
            PlanCreate(
                name="Support H2 ramp", queue_id=voice_q.id, lob_id=lob.id,
                starting_headcount=20,
                assumptions=Assumptions(aht_seconds=310, shrinkage=0.3, occupancy=0.85,
                                        weekly_hours=40, attrition_weekly_pct=0.005,
                                        buffer_pct=0.05),
                weeks=[
                    PlanWeekIn(week_start=next_monday + timedelta(weeks=w),
                               volume=6200 + 150 * w,
                               new_hires=3 if w in (2, 5) else 0)
                    for w in range(8)
                ],
            ),
            actor=admin,
        )

        # ---- shift templates + schedule ---------------------------------------
        breaks = [
            {"offset_minutes": 120, "duration_minutes": 15, "activity": "break"},
            {"offset_minutes": 240, "duration_minutes": 30, "activity": "lunch"},
            {"offset_minutes": 390, "duration_minutes": 15, "activity": "break"},
        ]
        early = ShiftTemplate(organization_id=org.id, name="Early 08:00-16:30",
                              start_time=time(8, 0), end_time=time(16, 30),
                              days_of_week=[0, 1, 2, 3, 4], breaks=breaks)
        late = ShiftTemplate(organization_id=org.id, name="Late 12:00-20:30",
                             start_time=time(12, 0), end_time=time(20, 30),
                             days_of_week=[0, 1, 2, 3, 4], breaks=breaks)
        night = ShiftTemplate(organization_id=org.id, name="Night 22:00-06:30",
                              shift_type="night", start_time=time(22, 0),
                              end_time=time(6, 30), days_of_week=[0, 1, 2, 3, 4],
                              breaks=breaks)
        db.add_all([early, late, night])
        await db.flush()
        schedule = await generate_schedule(
            db, org.id,
            GenerateScheduleRequest(team_id=team_a.id, week_start=next_monday,
                                    template_ids=[early.id, late.id]),
            actor=admin,
        )
        await publish_schedule(db, schedule.id, actor=admin)

        # ---- two weeks of attendance ------------------------------------------
        for offset in range(1, 15):
            day = date.today() - timedelta(days=offset)
            if day.weekday() >= 5:
                continue
            for emp in employees[:12]:
                roll = RNG.random()
                sched_start = datetime.combine(day, time(8, 0), tzinfo=UTC)
                sched_end = datetime.combine(day, time(16, 30), tzinfo=UTC)
                if roll < 0.05:
                    code, actual_start, actual_end = codes["ABS"], None, None
                elif roll < 0.09:
                    code, actual_start, actual_end = codes["SIC"], None, None
                elif roll < 0.2:
                    code = codes["LTE"]
                    actual_start = sched_start + timedelta(minutes=RNG.randint(6, 35))
                    actual_end = sched_end
                else:
                    code = codes["PRS"]
                    actual_start = sched_start - timedelta(minutes=RNG.randint(0, 5))
                    actual_end = sched_end + timedelta(minutes=RNG.randint(-4, 10))
                await create_record(
                    db, org.id,
                    RecordIn(employee_id=emp.id, code_id=code.id, day=day,
                             scheduled_start=sched_start, scheduled_end=sched_end,
                             actual_start=actual_start, actual_end=actual_end),
                    actor=admin, source="system",
                )

        # ---- today's interval actuals (first 24 half-hours) ---------------------
        from app.modules.forecasting.engine import distribute_to_intervals

        today = date.today()
        slots = distribute_to_intervals(950, 30)
        actuals = []
        for i, expected in enumerate(slots[:24]):
            ts = datetime.combine(today, time(0, 0), tzinfo=UTC) + timedelta(
                minutes=30 * i
            )
            offered = max(0.0, expected * RNG.gauss(1.05, 0.1))
            actuals.append(
                ActualIn(queue_id=voice_q.id, ts=ts, offered=round(offered, 1),
                         handled=round(offered * 0.97, 1),
                         aht_seconds=round(RNG.gauss(310, 15), 1),
                         service_level=round(min(1, max(0, RNG.gauss(0.82, 0.06))), 3),
                         occupancy=round(min(1, max(0, RNG.gauss(0.85, 0.05))), 3),
                         staffed=round(max(1, offered * 310 / 1800 / 0.85), 1))
            )
        await upsert_actuals(db, org.id, actuals)

        # ---- Slack/Teams approval bridge -------------------------------------
        # Channels enabled in "simulated" mode (no real creds) so the demo shows
        # cards being dispatched to Slack + Teams and routed to the OM for
        # sign-off, with zero external setup. Swap in real webhooks/tokens in
        # Settings → Integrations to go live.
        bridge = await get_or_create_config(db, org.id)
        bridge.slack_enabled = True
        bridge.teams_enabled = True
        bridge.slack_channel = "#wfm-approvals"
        bridge.auto_apply_on_approve = True
        await db.flush()

        first_shift = (
            await db.execute(
                select(ScheduleShift)
                .where(ScheduleShift.schedule_id == schedule.id)
                .order_by(ScheduleShift.start_ts)
                .limit(1)
            )
        ).scalar_one_or_none()

        await create_approval(
            db, org.id,
            ApprovalCreate(
                source="intraday", kind="overtime",
                title="Offer 2h OT on Voice — volume 14% over forecast",
                summary=("Voice Support is tracking 14% above forecast with SL at 74%. "
                         "RTA proposes offering 2 hours of overtime to 3 agents to protect SL."),
                queue_id=voice_q.id, employee_id=employees[0].id,
                payload={"queue": "Voice Support", "hours": 2, "agents": 3},
            ),
            actor=admin,
        )
        if first_shift is not None:
            await create_approval(
                db, org.id,
                ApprovalCreate(
                    source="scheduling", kind="shift_change",
                    title="Extend early shift by 1h to cover afternoon peak",
                    summary=("Scheduler proposes extending an early shift to 17:30 to close "
                             "a projected coverage gap in the 16:00–17:30 window."),
                    employee_id=first_shift.employee_id,
                    payload={
                        "shift_id": str(first_shift.id),
                        "new_end_ts": (first_shift.end_ts + timedelta(hours=1)).isoformat(),
                    },
                ),
                actor=admin,
            )
        await create_approval(
            db, org.id,
            ApprovalCreate(
                source="intraday", kind="reforecast_publish",
                title="Publish intraday reforecast (+9% remaining day)",
                summary=("Observed pacing implies a +9% reforecast for the rest of the day. "
                         "Publishing updates downstream staffing recommendations."),
                queue_id=voice_q.id,
                payload={"queue": "Voice Support", "adjustment_pct": 9},
            ),
            actor=admin,
        )

        # ---- HC planning (AGS Health CP model) --------------------------------
        # Planning profiles for the seeded employees + monthly demand + config,
        # so the Planning → Capacity screen has a live, computable LOB.
        from app.modules.hcplanning.engine.dates import add_months, month_key
        from app.modules.hcplanning.models import (
            AgentPlanningProfile,
            HcDemand,
            HcPlanningConfig,
            NewHireBatch,
        )

        plan_status_cycle = ["FTE", "FTE", "FTE", "Ramp", "OJT", "FTE", "Notice Period",
                             "FTE", "Maternity Leave", "FTE"]
        for i, emp in enumerate(employees):
            db.add(AgentPlanningProfile(
                organization_id=org.id, employee_id=emp.id,
                planning_status=plan_status_cycle[i % len(plan_status_cycle)],
                dop=(emp.hire_date + timedelta(days=30)) if emp.hire_date else None,
                experience_type=("Fresher" if i % 4 == 0 else "Lateral"),
                function="Non-Voice", current_function="Non-Voice",
            ))

        start = month_key(date.today().replace(day=1))
        months = [add_months(start, k) for k in range(14)]
        base = 15.0
        for k, m in enumerate(months):
            db.add(HcDemand(organization_id=org.id, lob_id=lob.id, month=m,
                            billable_fte=round(base + k * 0.3, 2)))
        db.add(HcPlanningConfig(
            organization_id=org.id, lob_id=lob.id,
            ooo_shrinkage=0.04, io_shrinkage=0.04, attrition=0.0125, weekly_hours=40,
            hiring_throughput=0.90, training_throughput=0.95,
            actuals_through=add_months(start, 4),
        ))
        # a couple of demo hiring batches (feed Ramp ~1 month after hire)
        first_of = date.today().replace(day=1)
        db.add(NewHireBatch(organization_id=org.id, lob_id=lob.id,
                            hire_date=first_of + timedelta(days=90), planned_hires=20,
                            experience_type="Fresher", note="Q-hire wave 1"))
        db.add(NewHireBatch(organization_id=org.id, lob_id=lob.id,
                            hire_date=first_of + timedelta(days=210), planned_hires=30,
                            experience_type="Fresher", note="Q-hire wave 2"))
        await db.flush()

        await db.commit()
        return {
            "status": "seeded",
            "org": org.code,
            "users": ["admin@flowforce.dev / Admin@12345",
                      "…9 role accounts / Demo@12345"],
            "employees": len(employees),
            "forecast": str(forecast.id),
        }


async def main() -> None:
    from app.core.config import settings

    if settings.DB_BACKEND == "sqlite":
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    result = await seed_demo()
    print(result)


if __name__ == "__main__":
    asyncio.run(main())
