"""Password hashing (argon2id) and JWT access/refresh token handling.

argon2-cffi and PyJWT are used directly (passlib/python-jose are unmaintained
and passlib breaks on Python 3.13). Refresh tokens are opaque to clients but
stored server-side as SHA-256 hashes so a DB leak cannot replay sessions.
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from app.core.config import settings
from app.core.exceptions import AuthenticationError

_hasher = PasswordHasher()

_TEMP_PW_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"


def generate_temp_password(length: int = 14) -> str:
    """One-time temp password for bulk-provisioned accounts.

    Excludes visually ambiguous characters (0/O, 1/l/I) since these get
    printed/copy-pasted by admins onboarding real employees. Never persisted
    anywhere in plaintext beyond the single API response that mints it.
    """
    return "".join(secrets.choice(_TEMP_PW_ALPHABET) for _ in range(length))

TokenType = Literal["access", "refresh"]


def hash_password(plain: str) -> str:
    return _hasher.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, plain)
    except (VerifyMismatchError, InvalidHashError):
        return False


def _create_token(subject: str, token_type: TokenType, expires_delta: timedelta) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": subject,
        "type": token_type,
        "jti": uuid.uuid4().hex,
        "iat": now,
        "exp": now + expires_delta,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_access_token(user_id: uuid.UUID) -> str:
    return _create_token(
        str(user_id), "access", timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )


def create_refresh_token(user_id: uuid.UUID) -> tuple[str, datetime]:
    delta = timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    token = _create_token(str(user_id), "refresh", delta)
    return token, datetime.now(UTC) + delta


def decode_token(token: str, expected_type: TokenType) -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except jwt.ExpiredSignatureError as exc:
        raise AuthenticationError("Token has expired") from exc
    except jwt.InvalidTokenError as exc:
        raise AuthenticationError("Invalid token") from exc
    if payload.get("type") != expected_type:
        raise AuthenticationError(f"Expected a {expected_type} token")
    return payload


def hash_token(token: str) -> str:
    """Stable fingerprint for storing refresh tokens server-side."""
    return hashlib.sha256(token.encode()).hexdigest()
