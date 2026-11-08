"""Identity endpoints: /auth, /users, /roles, /permissions, /audit."""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr, Field

from app.api.deps import DbSession, get_current_user, require_permission
from app.core.exceptions import PermissionDeniedError, ValidationError
from app.modules.identity import password_reset, service
from app.modules.identity.models import User
from app.modules.identity.rbac import PERMISSIONS
from app.modules.identity.schemas import (
    AuditLogOut,
    ChangePasswordRequest,
    LoginRequest,
    RefreshRequest,
    RoleCreate,
    RoleOut,
    RoleUpdate,
    TokenPair,
    UserCreate,
    UserOut,
    UserUpdate,
)
from app.schemas.common import ApiResponse, Page

auth_router = APIRouter(prefix="/auth", tags=["auth"])
users_router = APIRouter(prefix="/users", tags=["users"])
roles_router = APIRouter(prefix="/roles", tags=["roles"])
audit_router = APIRouter(prefix="/audit", tags=["audit"])


# ------------------------------------------------------------------ auth

@auth_router.post("/login", response_model=ApiResponse[TokenPair])
async def login(body: LoginRequest, db: DbSession):
    user = await service.authenticate(db, body.email, body.password)
    tokens = await service.issue_tokens(db, user)
    await service.record_audit(
        db, actor=user, action="auth.login", entity_type="user", entity_id=user.id
    )
    return ApiResponse(data=tokens)


@auth_router.post("/token", response_model=TokenPair)
async def login_form(
    form: Annotated[OAuth2PasswordRequestForm, Depends()], db: DbSession
) -> TokenPair:
    """OAuth2 password-flow login (used by the Swagger `Authorize` button)."""
    user = await service.authenticate(db, form.username, form.password)
    return await service.issue_tokens(db, user)


@auth_router.post("/refresh", response_model=ApiResponse[TokenPair])
async def refresh(body: RefreshRequest, db: DbSession):
    return ApiResponse(data=await service.rotate_refresh(db, body.refresh_token))


@auth_router.post("/logout", response_model=ApiResponse[dict])
async def logout(body: RefreshRequest, db: DbSession):
    await service.revoke_refresh(db, body.refresh_token)
    return ApiResponse(data={"detail": "Logged out"})


@auth_router.get("/me", response_model=ApiResponse[UserOut])
async def me(user: Annotated[User, Depends(get_current_user)]):
    return ApiResponse(data=UserOut.model_validate(user))


@auth_router.post("/change-password", response_model=ApiResponse[dict])
async def change_password(
    body: ChangePasswordRequest,
    db: DbSession,
    user: Annotated[User, Depends(get_current_user)],
):
    if getattr(user, "api_key_id", None):
        raise PermissionDeniedError("Passwords can't be changed with an API key")
    if problem := password_reset.password_problem(body.new_password, user.email):
        raise ValidationError(problem)
    if body.new_password == body.current_password:
        raise ValidationError("Choose a password different from your current one")
    await service.change_password(db, user, body.current_password, body.new_password)
    return ApiResponse(data={"detail": "Password updated"})


class ForgotPasswordIn(BaseModel):
    email: EmailStr


class ResetPasswordIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    new_password: str = Field(min_length=1, max_length=128)


@auth_router.post("/forgot-password", response_model=ApiResponse[dict])
async def forgot_password(body: ForgotPasswordIn, db: DbSession, request: Request):
    """Email a one-time reset link (valid 30 minutes) if the account exists. The
    answer is the same either way."""
    await password_reset.request_reset(db, body.email, request.headers.get("origin"))
    return ApiResponse(data={
        "detail": "If an account uses that email, we've sent it a link to reset the password.",
        "valid_minutes": password_reset.RESET_MINUTES,
    })


@auth_router.get("/reset-password", response_model=ApiResponse[dict])
async def check_reset_link(db: DbSession, token: str = Query(min_length=10, max_length=200)):
    """Whether a reset link still works (and for which email)."""
    return ApiResponse(data=await password_reset.check_token(db, token))


@auth_router.post("/reset-password", response_model=ApiResponse[dict])
async def reset_password(body: ResetPasswordIn, db: DbSession):
    """Set a new password with a reset link. Signs the account out everywhere."""
    await password_reset.reset_password(db, body.token, body.new_password)
    return ApiResponse(data={"detail": "Password changed. Sign in with your new password."})


# ------------------------------------------------------------------ users

@users_router.get("", response_model=ApiResponse[Page[UserOut]])
async def list_users(
    db: DbSession,
    actor: Annotated[User, Depends(require_permission("admin:users"))],
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    search: str | None = Query(None, max_length=100, description="Part of an email or name"),
):
    """Accounts in your organisation (superusers: every organisation)."""
    users, total = await service.list_users(
        db,
        offset=(page - 1) * size,
        limit=size,
        organization_id=None if actor.is_superuser else actor.organization_id,
        search=search,
    )
    return ApiResponse(
        data=Page(items=[UserOut.model_validate(u) for u in users],
                  total=total, page=page, size=size)
    )


@users_router.post("", response_model=ApiResponse[UserOut], status_code=201)
async def create_user(
    body: UserCreate,
    db: DbSession,
    actor: Annotated[User, Depends(require_permission("admin:users"))],
):
    user = await service.create_user(db, body, actor=actor)
    return ApiResponse(data=UserOut.model_validate(user))


@users_router.patch("/{user_id}", response_model=ApiResponse[UserOut])
async def update_user(
    user_id: uuid.UUID,
    body: UserUpdate,
    db: DbSession,
    actor: Annotated[User, Depends(require_permission("admin:users"))],
):
    user = await service.update_user(db, user_id, body, actor=actor)
    return ApiResponse(data=UserOut.model_validate(user))


@users_router.post("/{user_id}/reset-password-link", response_model=ApiResponse[dict])
async def reset_password_link(
    user_id: uuid.UUID,
    db: DbSession,
    request: Request,
    actor: Annotated[User, Depends(require_permission("admin:users"))],
):
    """Make a one-time link (valid 24 hours) for this person to set a new password.
    It's emailed to them when email is set up; pass it on yourself otherwise."""
    return ApiResponse(
        data=await password_reset.admin_reset_link(
            db, actor, user_id, request.headers.get("origin")
        )
    )


# ------------------------------------------------------------------ roles

@roles_router.get("", response_model=ApiResponse[list[RoleOut]])
async def list_roles(
    db: DbSession,
    _: Annotated[User, Depends(require_permission("admin:roles", "admin:users"))],
):
    roles = await service.list_roles(db)
    return ApiResponse(data=[RoleOut.model_validate(r) for r in roles])


@roles_router.get("/permissions", response_model=ApiResponse[dict[str, str]])
async def list_permissions(
    _: Annotated[User, Depends(require_permission("admin:roles", "admin:users"))],
):
    return ApiResponse(data=PERMISSIONS)


@roles_router.post("", response_model=ApiResponse[RoleOut], status_code=201)
async def create_role(
    body: RoleCreate,
    db: DbSession,
    actor: Annotated[User, Depends(require_permission("admin:roles"))],
):
    role = await service.create_role(db, body, actor=actor)
    return ApiResponse(data=RoleOut.model_validate(role))


@roles_router.patch("/{role_id}", response_model=ApiResponse[RoleOut])
async def update_role(
    role_id: uuid.UUID,
    body: RoleUpdate,
    db: DbSession,
    actor: Annotated[User, Depends(require_permission("admin:roles"))],
):
    role = await service.update_role(db, role_id, body, actor=actor)
    return ApiResponse(data=RoleOut.model_validate(role))


# ------------------------------------------------------------------ audit

@audit_router.get("", response_model=ApiResponse[Page[AuditLogOut]])
async def list_audit(
    db: DbSession,
    _: Annotated[User, Depends(require_permission("audit:read"))],
    entity_type: str | None = None,
    action: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
):
    logs, total = await service.list_audit_logs(
        db, entity_type=entity_type, action=action, offset=(page - 1) * size, limit=size
    )
    return ApiResponse(
        data=Page(items=[AuditLogOut.model_validate(entry) for entry in logs],
                  total=total, page=page, size=size)
    )
