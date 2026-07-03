"""Org structure + employee management integration tests."""
from __future__ import annotations

from httpx import AsyncClient

from tests.helpers import create_employees, create_structure


async def test_org_structure_crud(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    ids = await create_structure(client, headers)

    listed = await client.get("/api/v1/org/lobs", headers=headers)
    assert listed.status_code == 200
    assert listed.json()["data"][0]["code"] == "SUP"

    updated = await client.patch(
        f"/api/v1/org/teams/{ids['team']['id']}", headers=headers,
        json={"lob_id": ids["lob"]["id"], "name": "Alpha Prime"},
    )
    assert updated.status_code == 200
    assert updated.json()["data"]["name"] == "Alpha Prime"

    org = await client.get("/api/v1/org", headers=headers)
    assert org.json()["data"]["code"] == "TEST"


async def test_employee_lifecycle(client: AsyncClient, admin: dict) -> None:
    headers = admin["headers"]
    ids = await create_structure(client, headers)
    employees = await create_employees(
        client, headers, ids["team"]["id"], ids["lob"]["id"], count=3
    )

    dup = await client.post(
        "/api/v1/employees", headers=headers,
        json={"employee_code": "E000", "first_name": "Dup", "email": "d@test.dev"},
    )
    assert dup.status_code == 409

    search = await client.get(
        "/api/v1/employees", headers=headers, params={"search": "emp1"}
    )
    assert search.json()["data"]["total"] == 1

    emp_id = employees[0]["id"]
    patched = await client.patch(
        f"/api/v1/employees/{emp_id}", headers=headers,
        json={"status": "inactive", "location": "Berlin"},
    )
    assert patched.status_code == 200
    assert patched.json()["data"]["status"] == "inactive"

    skill = (await client.post("/api/v1/org/skills", headers=headers,
                               json={"name": "Voice", "category": "channel"})
             ).json()["data"]
    skilled = await client.put(
        f"/api/v1/employees/{emp_id}/skills", headers=headers,
        json=[{"skill_id": skill["id"], "proficiency": 4, "priority": 1}],
    )
    assert skilled.status_code == 200
    assert skilled.json()["data"]["skills"][0]["proficiency"] == 4

    # audit trail recorded the mutations
    audit = await client.get("/api/v1/audit", headers=headers,
                             params={"entity_type": "employee"})
    actions = [row["action"] for row in audit.json()["data"]["items"]]
    assert "employee.create" in actions and "employee.update" in actions
