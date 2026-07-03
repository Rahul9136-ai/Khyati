"""Identity services: authentication, token lifecycle, user/role CRUD, audit."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import (
    AuthenticationError,
    ConflictError,
    NotFoundError,
    ValidationError,
)
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    hash_token,
    verify_password,
)
from app.modules.identity.models import AuditLog, Permission, RefreshToken, Role, User
from app.modules.identity.rbac import PERMISSIONS, ROLE_MATRIX
from app.modules.identity.schemas import (
    RoleCreate,
    RoleUpdate,
    TokenPair,
    UserCreate,
    UserUpdate,
)

# ---------------------------------------------------------------- audit


def _jsonable(value: Any) -> Any:
    """Coerce audit payloads (UUIDs, dates, models) into JSON-safe values."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    return str(value)


async def record_audit(
    db: AsyncSession,
    *,
    actor: User | None,
    action: str,
    entity_type: str,
    entity_id: str | uuid.UUID | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    note: str | None = None,
) -> None:
    db.add(
        AuditLog(
            organization_id=actor.organization_id if actor else None,
            actor_user_id=actor.id if actor else None,
            actor_email=actor.email if actor else "system",
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id else None,
            before=_jsonable(before),
            after=_jsonable(after),
            note=note,
        )
    )


async def list_audit_logs(
    db: AsyncSession,
    *,
    entity_type: str | None = None,
    action: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> tuple[list[AuditLog], int]:
    query = select(AuditLog)
    if entity_type:
        query = query.where(AuditLog.entity_type == entity_type)
    if action:
        query = query.where(AuditLog.action == action)
    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    rows = await db.execute(
        query.order_by(AuditLog.created_at.desc()).offset(offset).limit(limit)
    )
    return list(rows.scalars()), total


# ---------------------------------------------------------------- auth


async def get_user_by_email(db: AsyncSession, email: str) -> User | None:
    result = await db.execute(select(User).where(User.email == email.lower()))
    return result.scalar_one_or_none()


async def authenticate(db: AsyncSession, email: str, password: str) -> User:
    user = await get_user_by_email(db, email)
    if user is None or not verify_password(password, user.hashed_password):
        raise AuthenticationError("Incorrect email or password")
    if not user.is_active:
        raise AuthenticationError("Account is disabled")
    user.last_login_at = datetime.now(UTC)
    return user


async def issue_tokens(db: AsyncSession, user: User) -> TokenPair:
    access = create_access_token(user.id)
    refresh, expires_at = create_refresh_token(user.id)
    db.add(RefreshToken(user_id=user.id, token_hash=hash_token(refresh), expires_at=expires_at))
    return TokenPair(
        access_token=access,
        refresh_token=refresh,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


async def _get_live_refresh(db: AsyncSession, refresh_token: str) -> RefreshToken:
    decode_token(refresh_token, "refresh")  # signature + expiry check
    result = await db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == hash_token(refresh_token))
    )
    stored = result.scalar_one_or_none()
    if stored is None or stored.revoked_at is not None:
        raise AuthenticationError("Refresh token is not recognised or already used")
    if stored.expires_at.replace(tzinfo=UTC) < datetime.now(UTC):
        raise AuthenticationError("Refresh token has expired")
    return stored


async def rotate_refresh(db: AsyncSession, refresh_token: str) -> TokenPair:
    """One-time-use refresh: revoke the presented token, mint a new pair."""
    stored = await _get_live_refresh(db, refresh_token)
    stored.revoked_at = datetime.now(UTC)
    user = await db.get(User, stored.user_id)
    if user is None or not user.is_active:
        raise AuthenticationError("Account is disabled")
    return await issue_tokens(db, user)


async def revoke_refresh(db: AsyncSession, refresh_token: str) -> None:
    stored = await _get_live_refresh(db, refresh_token)
    stored.revoked_at = datetime.now(UTC)


async def change_password(db: AsyncSession, user: User, current: str, new: str) -> None:
    if not verify_password(current, user.hashed_password):
        raise AuthenticationError("Current password is incorrect")
    user.hashed_password = hash_password(new)
    await record_audit(
        db, actor=user, action="user.change_password", entity_type="user", entity_id=user.id
    )


# ---------------------------------------------------------------- users


async def _resolve_roles(db: AsyncSession, names: list[str]) -> list[Role]:
    if not names:
        return []
    result = await db.execute(select(Role).where(Role.name.in_(names)))
    roles = list(result.scalars())
    missing = set(names) - {r.name for r in roles}
    if missing:
        raise ValidationError(f"Unknown roles: {', '.join(sorted(missing))}")
    return roles


async def create_user(db: AsyncSession, payload: UserCreate, *, actor: User | None) -> User:
    if await get_user_by_email(db, payload.email):
        raise ConflictError(f"A user with email {payload.email} already exists")
    user = User(
        email=payload.email.lower(),
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name,
        organization_id=payload.organization_id
        or (actor.organization_id if actor else None),
        employee_id=payload.employee_id,
        is_active=payload.is_active,
        roles=await _resolve_roles(db, payload.role_names),
    )
    db.add(user)
    await db.flush()
    await record_audit(
        db,
        actor=actor,
        action="user.create",
        entity_type="user",
        entity_id=user.id,
        after={"email": user.email, "roles": payload.role_names},
    )
    return user


async def update_user(
    db: AsyncSession, user_id: uuid.UUID, payload: UserUpdate, *, actor: User
) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise NotFoundError("User not found")
    before = {"full_name": user.full_name, "is_active": user.is_active, "roles": user.role_names}
    if payload.full_name is not None:
        user.full_name = payload.full_name
    if payload.is_active is not None:
        user.is_active = payload.is_active
    if payload.employee_id is not None:
        user.employee_id = payload.employee_id
    if payload.password is not None:
        user.hashed_password = hash_password(payload.password)
    if payload.role_names is not None:
        user.roles = await _resolve_roles(db, payload.role_names)
    await record_audit(
        db,
        actor=actor,
        action="user.update",
        entity_type="user",
        entity_id=user.id,
        before=before,
        after={"full_name": user.full_name, "is_active": user.is_active,
               "roles": user.role_names},
    )
    return user


async def list_users(
    db: AsyncSession, *, offset: int = 0, limit: int = 50
) -> tuple[list[User], int]:
    total = (await db.execute(select(func.count()).select_from(User))).scalar_one()
    rows = await db.execute(select(User).order_by(User.email).offset(offset).limit(limit))
    return list(rows.scalars()), total


# ---------------------------------------------------------------- roles


async def list_roles(db: AsyncSession) -> list[Role]:
    return list((await db.execute(select(Role).order_by(Role.name))).scalars())


async def _resolve_permissions(db: AsyncSession, codes: list[str]) -> list[Permission]:
    unknown = set(codes) - set(PERMISSIONS)
    if unknown:
        raise ValidationError(f"Unknown permissions: {', '.join(sorted(unknown))}")
    result = await db.execute(select(Permission).where(Permission.code.in_(codes)))
    return list(result.scalars())


async def create_role(db: AsyncSession, payload: RoleCreate, *, actor: User) -> Role:
    existing = await db.execute(select(Role).where(Role.name == payload.name))
    if existing.scalar_one_or_none():
        raise ConflictError(f"Role {payload.name} already exists")
    role = Role(
        name=payload.name,
        description=payload.description,
        permissions=await _resolve_permissions(db, payload.permission_codes),
    )
    db.add(role)
    await db.flush()
    await record_audit(
        db, actor=actor, action="role.create", entity_type="role", entity_id=role.id,
        after={"name": role.name, "permissions": payload.permission_codes},
    )
    return role


async def update_role(
    db: AsyncSession, role_id: uuid.UUID, payload: RoleUpdate, *, actor: User
) -> Role:
    role = await db.get(Role, role_id)
    if role is None:
        raise NotFoundError("Role not found")
    before = {"description": role.description, "permissions": [p.code for p in role.permissions]}
    if payload.description is not None:
        role.description = payload.description
    if payload.permission_codes is not None:
        role.permissions = await _resolve_permissions(db, payload.permission_codes)
    await record_audit(
        db, actor=actor, action="role.update", entity_type="role", entity_id=role.id,
        before=before,
        after={"description": role.description,
               "permissions": [p.code for p in role.permissions]},
    )
    return role


# ---------------------------------------------------------------- seeding


async def seed_rbac(db: AsyncSession) -> None:
    """Idempotent upsert of the permission catalogue and the 11 system roles."""
    existing_perms = {
        p.code: p for p in (await db.execute(select(Permission))).scalars()
    }
    for code, description in PERMISSIONS.items():
        if code in existing_perms:
            existing_perms[code].description = description
        else:
            perm = Permission(code=code, description=description)
            db.add(perm)
            existing_perms[code] = perm
    await db.flush()

    existing_roles = {r.name: r for r in (await db.execute(select(Role))).scalars()}
    for name, codes in ROLE_MATRIX.items():
        role = existing_roles.get(name)
        if role is None:
            role = Role(name=name, is_system=True, description=f"System role: {name}")
            db.add(role)
        role.permissions = [existing_perms[c] for c in codes]
    await db.flush()
