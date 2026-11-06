"""Capacity Planning API — what the app and a connected CRM use to stay in sync:
shared sheets and switches, row-level updates by business key, versioning,
server-side results identical to the browser, and signed webhooks."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.modules.connect import webhooks
from tests.test_connect import Receiver, dispatch, make_key
from tests.test_connect import receiver as receiver  # noqa: F401  (pytest fixture)

API = "/api/v1/capacity"
FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "capacity_parity.json").read_text("utf-8")
)
SCENARIO = next(s for s in FIXTURE["scenarios"] if s["name"] == "default")


def workbook_body() -> dict:
    return {
        "sheets": {
            sid: {"rows": s["rows"], "monthColumns": s.get("monthColumns"), "fileName": "mini.xlsx"}
            for sid, s in SCENARIO["dataset"].items()
        }
    }


def sep(rows: list[dict]) -> dict:
    return next(r for r in rows if r["month"] == "2026-09" and r["customer"] == "PROJECT X")


async def load(client: AsyncClient, h: dict) -> None:
    r = await client.put(f"{API}/workbook", headers=h, json=workbook_body())
    assert r.status_code == 200, r.text
    assert len(r.json()["data"]) == 14


async def test_needs_planning_permissions(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    assert (await client.get(f"{API}/state")).status_code == 401
    ro = {"X-API-Key": await make_key(client, h, "planning:read", name="ro")}
    assert (await client.get(f"{API}/state", headers=ro)).status_code == 200
    assert (
        await client.put(f"{API}/workbook", headers=ro, json=workbook_body())
    ).status_code == 403
    rw = {"X-API-Key": await make_key(client, h, "planning:read", "planning:write", name="crm")}
    assert (
        await client.put(f"{API}/workbook", headers=rw, json=workbook_body())
    ).status_code == 200


async def test_schema_lists_every_sheet(client: AsyncClient, admin: dict) -> None:
    data = (await client.get(f"{API}/schema", headers=admin["headers"])).json()["data"]
    assert len(data["sheets"]) == 14
    um = next(s for s in data["sheets"] if s["id"] == "userMapping")
    assert {"name": "City", "type": "text"} in um["columns"] and um["matchKeys"] == ["Emp Id"]
    assert "capacity.results.updated" in data["events"]


async def test_results_on_the_server_match_the_browser(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await load(client, h)
    full = (await client.get(f"{API}/results", headers=h, params={"view": "full"})).json()["data"]
    expected = {(r["key"], r["month"]): r for r in SCENARIO["expected"]["rows"]}
    assert full["total"] == len(expected)
    for r in full["rows"]:
        e = expected[(r["key"], r["month"])]
        for f in ("baseFte", "peakTarget", "actualHc", "actualQa"):
            assert r[f] == pytest.approx(e[f]) if e[f] is not None else r[f] is None
        assert r["prod"]["reqHcProd"] == (
            pytest.approx(e["prod"]["reqHcProd"]) if e["prod"]["reqHcProd"] else None
        )
        assert r["vol"]["capacityPct"] == (
            pytest.approx(e["vol"]["capacityPct"]) if e["vol"]["capacityPct"] else None
        )

    summary = (await client.get(f"{API}/results", headers=h, params={"month": "Sep'26"})).json()[
        "data"
    ]
    assert summary["total"] == 1
    row = summary["rows"][0]
    assert row["reqHcProd"] == pytest.approx(11.3)  # 2100 ÷ 21 ÷ 10 = 10 FTE + 13% buffer
    assert row["projectedHc"] == pytest.approx(11) and row["additions"] == 3
    assert summary["monthlyTotals"][0]["month"] == "2026-09"
    assert (
        await client.get(f"{API}/results", headers=h, params={"month": "Smarch"})
    ).status_code == 422


async def test_crm_updates_rows_by_business_key_and_results_follow(
    client: AsyncClient, admin: dict
) -> None:
    h = admin["headers"]
    await load(client, h)
    key = {"X-API-Key": await make_key(client, h, "planning:read", "planning:write")}
    v1 = (await client.get(f"{API}/state", headers=key)).json()["data"]
    assert v1["sheets"]["workingDays"]["version"] == 1

    # Sep'26 working days 21 → 42 halves Base FTE
    r = await client.patch(
        f"{API}/sheets/workingDays/rows",
        headers=key,
        json={
            "upsert": [{"match": {"Month": "2026-09"}, "values": {"Days": 42}}],
            "base_version": 1,
        },
    )
    assert r.status_code == 200, r.text
    assert (
        r.json()["data"]["inserted"] == 0
        and r.json()["data"]["updated"] == 1
        and r.json()["data"]["version"] == 2
    )
    row = sep(
        (await client.get(f"{API}/results", headers=key, params={"view": "full"})).json()["data"][
            "rows"
        ]
    )
    assert row["baseFte"] == pytest.approx(5)

    v2 = (await client.get(f"{API}/state", headers=key)).json()["data"]
    assert v2["resultsVersion"] != v1["resultsVersion"]

    # stale version → 409, nothing changes
    r = await client.patch(
        f"{API}/sheets/workingDays/rows",
        headers=key,
        json={"upsert": [{"row": 2, "values": {"Days": 10}}], "base_version": 1},
    )
    assert r.status_code == 409 and r.json()["error"]["details"]["version"] == 2

    # no match → a new row; a new hire gets the next S.No
    r = await client.patch(
        f"{API}/sheets/hiring/rows",
        headers=key,
        json={
            "upsert": [
                {
                    "match": {"RR Number": "RR-NEW"},
                    "values": {
                        "Customer Name": "PROJECT X",
                        "SL-As Per EM": "Coding",
                        "Location": "Chennai",
                        "Opening": 4,
                        "Designation": "CODER",
                        "Approved Status": "Approved",
                        "Status": "OPEN",
                        "Due to delivery month": "Oct-26",
                    },
                }
            ]
        },
    )
    assert r.json()["data"]["inserted"] == 1
    hiring = (await client.get(f"{API}/sheets/hiring", headers=key)).json()["data"]["rows"]
    assert hiring[-1]["S.No"] == 4 and hiring[-1]["Due to delivery month"] == "Oct'26"
    oct_row = next(
        x
        for x in (
            await client.get(f"{API}/results", headers=key, params={"month": "2026-10"})
        ).json()["data"]["rows"]
    )
    assert oct_row["additions"] == 4

    # delete by match
    r = await client.patch(
        f"{API}/sheets/hiring/rows", headers=key, json={"deleteMatch": [{"RR Number": "RR-NEW"}]}
    )
    assert r.json()["data"]["deleted"] == 1


async def test_bad_input_is_refused(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await load(client, h)
    assert (await client.put(f"{API}/sheets/nope", headers=h, json={"rows": []})).status_code == 404
    r = await client.put(
        f"{API}/sheets/workingDays", headers=h, json={"rows": [{"Month": "Sep'26", "Dayz": 3}]}
    )
    assert r.status_code == 422 and "Dayz" in r.json()["error"]["message"]
    r = await client.patch(
        f"{API}/sheets/workingDays/rows",
        headers=h,
        json={"upsert": [{"row": 999, "values": {"Days": 3}}]},
    )
    assert r.status_code == 404
    r = await client.put(
        f"{API}/sheets/forecast", headers=h, json={"rows": [{"Customer Name": "X"}]}
    )
    assert r.status_code == 422 and "month column" in r.json()["error"]["message"]
    assert (
        await client.patch(f"{API}/config", headers=h, json={"config": {"rampMode": "fast"}})
    ).status_code == 422
    assert (
        await client.patch(f"{API}/config", headers=h, json={"config": {"nope": 1}})
    ).status_code == 422


async def test_switches_are_shared_and_change_results(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await load(client, h)
    cfg = (await client.get(f"{API}/config", headers=h)).json()["data"]
    assert cfg["version"] == 0 and cfg["config"]["qcaAttritionMode"] == "snp"
    r = await client.patch(
        f"{API}/config",
        headers=h,
        json={"config": {"qcaAttritionMode": "attrition"}, "base_version": 0},
    )
    assert r.json()["data"]["version"] == 1
    row = sep(
        (await client.get(f"{API}/results", headers=h, params={"view": "full"})).json()["data"][
            "rows"
        ]
    )
    assert row["qca"]["attritionHc"] == pytest.approx(0.05)  # QA 1 × budget attrition 5%
    assert (
        await client.patch(
            f"{API}/config", headers=h, json={"config": {"snpPct": 0.3}, "base_version": 0}
        )
    ).status_code == 409


async def test_exceptions_endpoint(client: AsyncClient, admin: dict) -> None:
    h = admin["headers"]
    await load(client, h)
    data = (await client.get(f"{API}/exceptions", headers=h, params={"severity": "error"})).json()[
        "data"
    ]
    assert data["total"] == data["counts"]["error"] >= 1
    assert {e["code"] for e in data["rows"]} == {"forecast-task-missing"}
    by_cust = (
        await client.get(f"{API}/exceptions", headers=h, params={"customer": "project x"})
    ).json()["data"]
    assert by_cust["total"] > 0 and all(e["customer"] == "PROJECT X" for e in by_cust["rows"])


async def test_changes_send_signed_webhooks(
    client: AsyncClient, admin: dict, receiver: Receiver
) -> None:  # noqa: F811
    h = admin["headers"]
    sub = (
        await client.post(
            "/api/v1/connect/webhooks",
            headers=h,
            json={
                "url": "https://crm.example/hook",
                "events": [
                    "capacity.inputs.updated",
                    "capacity.config.updated",
                    "capacity.results.updated",
                ],
            },
        )
    ).json()["data"]
    await load(client, h)
    await client.patch(
        f"{API}/sheets/workingDays/rows",
        headers=h,
        json={"upsert": [{"row": 2, "values": {"Days": 42}}]},
    )
    await client.patch(f"{API}/config", headers=h, json={"config": {"snpPct": 0.25}})
    await client.delete(f"{API}/sheets", headers=h)
    await dispatch()
    types = [e["type"] for e in receiver.events()]
    # workbook: 14 sheets + 1 results; edit: inputs + results;
    # config: config + results; clear: inputs + results
    assert types.count("capacity.inputs.updated") == 16
    assert types.count("capacity.results.updated") == 4
    assert types.count("capacity.config.updated") == 1
    edit = next(
        e
        for e in receiver.events()
        if e["type"] == "capacity.inputs.updated" and e["data"]["change"] == "edited"
    )
    assert edit["data"]["sheet"] == "workingDays" and edit["data"]["changedRows"][0]["Days"] == 42
    res = [e for e in receiver.events() if e["type"] == "capacity.results.updated"][1]
    assert (
        res["data"]["months"][0]["month"] == "2026-09" and "capacityPct" in res["data"]["months"][0]
    )
    req = receiver.calls[0]
    assert webhooks.verify(
        sub["secret"], req.headers["X-WFM-Timestamp"], req.content, req.headers["X-WFM-Signature"]
    )

    assert (await client.get(f"{API}/state", headers=h)).json()["data"]["sheets"][
        "userMapping"
    ] is None
