"""Org structure + employee management integration tests."""
from __future__ import annotations

from httpx import AsyncClient

from tests.conftest import login
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


async def test_bulk_import_creates_real_accounts_and_isolates_bad_rows(
    client: AsyncClient, admin: dict
) -> None:
    """One row -> one Employee + one linked, real (hashed-password) User.
    Bad rows (unknown role, duplicate login email within the same batch)
    must not take down the good row around them."""
    headers = admin["headers"]
    ids = await create_structure(client, headers)

    resp = await client.post(
        "/api/v1/employees/bulk-import", headers=headers,
        json={
            "rows": [
                {  # good row, team resolved by name
                    "first_name": "Nina", "last_name": "Lopez", "email": "nina.lopez@test.dev",
                    "team": "Alpha", "role": "Team Leader",
                },
                {  # bad row: role name doesn't exist
                    "first_name": "Bad", "last_name": "Role", "email": "bad.role@test.dev",
                    "role": "Not A Real Role",
                },
                {  # bad row: same login email as row 1, created moments earlier
                   # in the same batch — proves cross-row dedup within one import
                    "first_name": "Dup", "last_name": "Email", "email": "nina.lopez@test.dev",
                    "role": "Employee",
                },
            ]
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()["data"]
    assert body["total"] == 3
    assert body["created"] == 1
    assert body["failed"] == 2

    good, bad_role, bad_email = body["results"]
    assert good["status"] == "created"
    assert good["email"] == "nina.lopez@test.dev"
    assert good["team_matched"] is True
    assert good["employee_code"]  # auto-generated since none was supplied
    assert good["temp_password"] and len(good["temp_password"]) >= 8

    assert bad_role["status"] == "error"
    assert bad_role["email"] == "bad.role@test.dev"
    assert bad_email["status"] == "error"
    assert "already exists" in bad_email["error"]

    # the generated temp password is real and actually logs in
    login_resp = await client.post(
        "/api/v1/auth/login",
        json={"email": "nina.lopez@test.dev", "password": good["temp_password"]},
    )
    assert login_resp.status_code == 200, login_resp.text

    # exactly one employee/user pair exists — the failed dup row left no trace
    listed = await client.get(
        "/api/v1/employees", headers=headers, params={"search": "lopez"}
    )
    assert listed.json()["data"]["total"] == 1

    # a non-admin role (Team Leader here) can't hit this endpoint at all —
    # it mints real login accounts, gated on admin:users specifically
    team_leader_headers = await login(client, "nina.lopez@test.dev", good["temp_password"])
    denied = await client.post(
        "/api/v1/employees/bulk-import", headers=team_leader_headers,
        json={"rows": [{"first_name": "X", "email": "x2@test.dev", "role": "Employee"}]},
    )
    assert denied.status_code == 403
