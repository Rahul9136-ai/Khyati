"""Smoke tests for the foundation: liveness probe + OpenAPI availability."""
from __future__ import annotations

from httpx import AsyncClient


async def test_health_liveness(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "version" in body


async def test_openapi_served(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/openapi.json")
    assert resp.status_code == 200
    assert resp.json()["info"]["title"] == "FlowForce WFM"
