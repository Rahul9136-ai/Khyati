"""API keys: generate, hash, resolve to an acting principal.

A key acts as the user who created it, but only with the permission codes in
its scopes (intersected with what that user still has), and never as a
superuser. `ApiKeyActor` is handed to the rest of the app wherever a user is
expected; it forwards everything else (id, organization_id, …) to the user,
so audit entries and org scoping work unchanged.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AuthenticationError
from app.modules.connect.models import ApiKey
from app.modules.identity.models import User
from app.modules.identity.rbac import PERMISSIONS

KEY_PREFIX = "wfm_"
#: Only touch last_used_at this often, so busy keys don't write on every call.
_TOUCH_EVERY = timedelta(minutes=1)


def generate_key() -> tuple[str, str, str]:
    """(full key, display prefix, sha256 hash)."""
    raw = KEY_PREFIX + secrets.token_urlsafe(32)
    return raw, raw[:12], hash_key(raw)


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def allowed_scopes(user: User) -> list[str]:
    """Scopes a user may put on a key: their own permissions (all for superusers)."""
    return sorted(PERMISSIONS) if user.is_superuser else sorted(user.permission_codes)


class ApiKeyActor:
    """A user acting through an API key, limited to the key's scopes."""

    is_superuser = False

    def __init__(self, user: User, key: ApiKey) -> None:
        self._user = user
        self.api_key_id = key.id
        self.api_key_name = key.name
        self._scopes = set(key.scopes or [])

    @property
    def permission_codes(self) -> set[str]:
        return self._scopes & set(allowed_scopes(self._user))

    @property
    def email(self) -> str:
        return f"{self._user.email} (API key: {self.api_key_name})"[:255]

    def __getattr__(self, name: str):  # noqa: ANN204 - forwards to the user
        return getattr(self._user, name)


def _as_aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


async def resolve_api_key(db: AsyncSession, raw: str) -> ApiKeyActor:
    key = (
        await db.execute(select(ApiKey).where(ApiKey.key_hash == hash_key(raw.strip())))
    ).scalar_one_or_none()
    now = datetime.now(UTC)
    if key is None or key.revoked_at is not None:
        raise AuthenticationError("Invalid or revoked API key")
    if key.expires_at is not None and _as_aware(key.expires_at) <= now:
        raise AuthenticationError("This API key has expired")
    user = await db.get(User, key.created_by)
    if user is None or not user.is_active:
        raise AuthenticationError("The user behind this API key is inactive")
    if key.last_used_at is None or now - _as_aware(key.last_used_at) > _TOUCH_EVERY:
        key.last_used_at = now
    return ApiKeyActor(user, key)
