"""Shared FastAPI dependencies: DB session, current user, RBAC guards."""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import Depends
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import AuthenticationError, PermissionDeniedError
from app.core.security import decode_token
from app.db.session import get_db

DbSession = Annotated[AsyncSession, Depends(get_db)]

oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_V1_PREFIX}/auth/token")


async def get_current_user(db: DbSession, token: Annotated[str, Depends(oauth2_scheme)]):
    from app.modules.identity.models import User  # avoid import cycle at module load

    payload = decode_token(token, "access")
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if user is None or not user.is_active:
        raise AuthenticationError("User is inactive or no longer exists")
    return user


CurrentUser = Annotated["object", Depends(get_current_user)]


def require_permission(*codes: str):
    """Dependency factory: the current user must hold ANY of `codes`.

    Superusers bypass. Usage: `user: User = Depends(require_permission("forecast:write"))`.
    """

    async def checker(user=Depends(get_current_user)):
        if user.is_superuser or set(codes) & user.permission_codes:
            return user
        raise PermissionDeniedError(
            f"Requires one of: {', '.join(codes)}", details={"required": list(codes)}
        )

    return checker
