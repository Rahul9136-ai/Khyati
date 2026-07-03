"""Pytest fixtures: in-memory SQLite database + authenticated ASGI client.

Each test function gets a fresh schema (StaticPool keeps one connection for
the :memory: database) and a seeded org + RBAC + superadmin, so tests exercise
the real HTTP stack including permissions.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import app.db.registry  # noqa: F401  (register every model on Base.metadata)
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.modules.identity.schemas import UserCreate
from app.modules.identity.service import create_user, seed_rbac
from app.modules.workforce.models import Organization

test_engine = create_async_engine(
    "sqlite+aiosqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestSession = async_sessionmaker(bind=test_engine, expire_on_commit=False, autoflush=False)


async def _get_test_db() -> AsyncIterator:
    async with TestSession() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


app.dependency_overrides[get_db] = _get_test_db

ADMIN_EMAIL = "admin@test.dev"
ADMIN_PASSWORD = "Admin@12345"


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest.fixture
async def admin(client: AsyncClient) -> dict:
    """Seed org + RBAC + superadmin; return auth headers and ids."""
    async with TestSession() as db:
        await seed_rbac(db)
        org = Organization(name="Test Org", code="TEST")
        db.add(org)
        await db.flush()
        user = await create_user(
            db,
            UserCreate(email=ADMIN_EMAIL, password=ADMIN_PASSWORD,
                       full_name="Test Admin", role_names=["Super Admin"],
                       organization_id=org.id),
            actor=None,
        )
        user.is_superuser = True
        org_id = str(org.id)
        await db.commit()

    resp = await client.post(
        "/api/v1/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    tokens = resp.json()["data"]
    return {
        "headers": {"Authorization": f"Bearer {tokens['access_token']}"},
        "refresh_token": tokens["refresh_token"],
        "org_id": org_id,
    }


async def login(client: AsyncClient, email: str, password: str) -> dict:
    resp = await client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    token = resp.json()["data"]["access_token"]
    return {"Authorization": f"Bearer {token}"}
