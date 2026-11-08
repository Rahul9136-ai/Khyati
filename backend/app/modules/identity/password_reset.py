"""Forgot password and admin password resets.

* "Forgot password?" (`request_reset`): if the email belongs to an active
  account, a one-time link valid for RESET_MINUTES is emailed to it. The answer
  is the same either way, so nobody can find out which emails have accounts,
  and requests are rate-limited per email.
* Admin reset (`admin_reset_link`): an admin makes a one-time link for someone
  in their organisation, valid for ADMIN_RESET_HOURS. It's emailed when email is
  set up, and always shown to the admin to pass on (for when it isn't).
* Using a link (`reset_password`): sets the new password, uses up every open
  link for that account and signs the account out everywhere.

Only a SHA-256 hash of a link's token is stored.
"""

from __future__ import annotations

import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from html import escape

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import (
    NotFoundError,
    PermissionDeniedError,
    TooManyRequestsError,
    ValidationError,
)
from app.core.logging import get_logger
from app.core.security import hash_password, hash_token
from app.modules.identity.models import PasswordResetToken, RefreshToken, User
from app.modules.identity.service import _login_failures, get_user_by_email, record_audit
from app.modules.reporting import mailer

log = get_logger(__name__)

RESET_MINUTES = 30
ADMIN_RESET_HOURS = 24
#: "Forgot password?" requests per email per window.
REQUESTS_PER_WINDOW = 3
REQUEST_WINDOW = timedelta(minutes=15)
_requests: dict[str, list[datetime]] = {}


def password_problem(password: str, email: str = "") -> str | None:
    """Why a new password isn't acceptable, or None."""
    if len(password) < 8:
        return "Use at least 8 characters"
    if len(password) > 128:
        return "Use at most 128 characters"
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        return "Use at least one letter and one number"
    if email and password.strip().lower() == email.strip().lower():
        return "Don't use your email address as your password"
    return None


def web_base(origin: str | None) -> str:
    """Where the web app is: the address the request came from when it's one the
    server trusts (its CORS origins), else APP_WEB_URL. An untrusted origin is
    never used, so nobody can get a reset link pointing at another site."""
    allowed = {o.rstrip("/") for o in settings.BACKEND_CORS_ORIGINS}
    if origin and origin.rstrip("/") in allowed:
        return origin.rstrip("/")
    return settings.APP_WEB_URL.rstrip("/")


def _link(token: str, base: str) -> str:
    return f"{base}/reset-password?token={token}"


async def _issue(
    db: AsyncSession, user: User, ttl: timedelta, created_by: uuid.UUID | None
) -> tuple[str, datetime]:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(UTC) + ttl
    db.add(
        PasswordResetToken(
            user_id=user.id, token_hash=hash_token(token), expires_at=expires, created_by=created_by
        )
    )
    await db.flush()
    return token, expires


async def _email(user: User, link: str, valid_for: str, by_admin: bool) -> str | None:
    """Send the link; returns why it couldn't be sent, or None."""
    who = "An administrator asked" if by_admin else "Someone (hopefully you) asked"
    text = (
        f"Hi {user.full_name or user.email},\n\n{who} to reset the password for your "
        f"Purvi.AI account ({user.email}).\n\nSet a new password here (valid for {valid_for}, "
        f"works once):\n{link}\n\nIf you didn't ask for this, ignore this email; your "
        "password stays as it is."
    )
    html = (
        f"<p>Hi {escape(user.full_name or user.email)},</p><p>{who} to reset the password for "
        f'your Purvi.AI account ({escape(user.email)}).</p><p><a href="{escape(link)}">'
        f"Set a new password</a> (valid for {valid_for}, works once).</p><p>If you didn't ask "
        "for this, ignore this email; your password stays as it is.</p>"
    )
    try:
        await mailer.send([user.email], [], "Reset your Purvi.AI password", html, text)
        return None
    except mailer.MailNotConfiguredError as exc:
        return str(exc)
    except mailer.MailSendError as exc:
        log.warning("password_reset.email_failed", user=str(user.id), error=str(exc))
        return "The email couldn't be sent"


async def request_reset(db: AsyncSession, email: str, origin: str | None = None) -> None:
    """Email a reset link if the account exists (same answer either way)."""
    key, now = email.strip().lower(), datetime.now(UTC)
    recent = [t for t in _requests.get(key, []) if now - t < REQUEST_WINDOW]
    if len(recent) >= REQUESTS_PER_WINDOW:
        raise TooManyRequestsError(
            "Too many reset requests for this email; try again in 15 minutes"
        )
    _requests[key] = [*recent, now]
    user = await get_user_by_email(db, key)
    if user is None or not user.is_active:
        return
    token, _ = await _issue(db, user, timedelta(minutes=RESET_MINUTES), None)
    link = _link(token, web_base(origin))
    problem = await _email(user, link, f"{RESET_MINUTES} minutes", by_admin=False)
    if problem and not settings.is_production:
        # developing without email: the link is in the server log
        log.info("password_reset.link", email=user.email, link=link)
    await record_audit(
        db,
        actor=user,
        action="user.password_reset_requested",
        entity_type="user",
        entity_id=user.id,
        after={"emailed": problem is None},
    )


async def admin_reset_link(
    db: AsyncSession, actor: User, user_id: uuid.UUID, origin: str | None = None
) -> dict:
    """A one-time link for someone in the admin's organisation (emailed if possible)."""
    user = await db.get(User, user_id)
    if user is None:
        raise NotFoundError("User not found")
    if not actor.is_superuser and user.organization_id != actor.organization_id:
        raise PermissionDeniedError("That account belongs to another organisation")
    if not user.is_active:
        raise ValidationError("This account is disabled; enable it before resetting its password")
    token, expires = await _issue(db, user, timedelta(hours=ADMIN_RESET_HOURS), actor.id)
    link = _link(token, web_base(origin))
    problem = await _email(user, link, f"{ADMIN_RESET_HOURS} hours", by_admin=True)
    await record_audit(
        db,
        actor=actor,
        action="user.password_reset_link",
        entity_type="user",
        entity_id=user.id,
        after={"emailed": problem is None, "email": user.email},
    )
    return {
        "link": link,
        "expires_at": expires,
        "emailed": problem is None,
        "email_problem": problem,
    }


async def _live_token(db: AsyncSession, token: str) -> tuple[PasswordResetToken, User]:
    row = (
        await db.execute(
            select(PasswordResetToken).where(PasswordResetToken.token_hash == hash_token(token))
        )
    ).scalar_one_or_none()
    expired = row is not None and row.expires_at.replace(tzinfo=UTC) < datetime.now(UTC)
    if row is None or row.used_at is not None or expired:
        raise ValidationError("This reset link has expired or was already used. Ask for a new one.")
    user = await db.get(User, row.user_id)
    if user is None or not user.is_active:
        raise ValidationError("This account is disabled. Ask an administrator for help.")
    return row, user


async def check_token(db: AsyncSession, token: str) -> dict:
    """Whether a link still works, and for which email (so the page can say)."""
    _, user = await _live_token(db, token)
    return {"email": user.email}


async def reset_password(db: AsyncSession, token: str, new_password: str) -> None:
    row, user = await _live_token(db, token)
    if problem := password_problem(new_password, user.email):
        raise ValidationError(problem)
    now = datetime.now(UTC)
    user.hashed_password = hash_password(new_password)
    # every open link for this account is used up, and every session ends
    await db.execute(
        update(PasswordResetToken)
        .where(PasswordResetToken.user_id == user.id, PasswordResetToken.used_at.is_(None))
        .values(used_at=now)
    )
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    _login_failures.pop(user.email.lower(), None)  # a locked-out user can sign in again
    await record_audit(
        db,
        actor=user,
        action="user.password_reset",
        entity_type="user",
        entity_id=user.id,
        after={"via": "admin link" if row.created_by else "forgot password"},
    )
