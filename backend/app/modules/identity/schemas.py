"""Identity DTOs."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1)


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int  # access-token TTL in seconds


class RefreshRequest(BaseModel):
    refresh_token: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


class PermissionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    code: str
    description: str


class RoleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str
    is_system: bool
    permissions: list[PermissionOut]


class RoleCreate(BaseModel):
    name: str = Field(min_length=2, max_length=64)
    description: str = ""
    permission_codes: list[str] = []


class RoleUpdate(BaseModel):
    description: str | None = None
    permission_codes: list[str] | None = None


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    full_name: str = ""
    role_names: list[str] = []
    organization_id: uuid.UUID | None = None
    employee_id: uuid.UUID | None = None
    is_active: bool = True


class UserUpdate(BaseModel):
    full_name: str | None = None
    role_names: list[str] | None = None
    is_active: bool | None = None
    employee_id: uuid.UUID | None = None
    password: str | None = Field(default=None, min_length=8, max_length=128)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    full_name: str
    is_active: bool
    is_superuser: bool
    organization_id: uuid.UUID | None
    employee_id: uuid.UUID | None
    last_login_at: datetime | None
    role_names: list[str]
    permission_codes: set[str]


class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    actor_user_id: uuid.UUID | None
    actor_email: str
    action: str
    entity_type: str
    entity_id: str | None
    before: dict | None
    after: dict | None
    note: str | None
    created_at: datetime
