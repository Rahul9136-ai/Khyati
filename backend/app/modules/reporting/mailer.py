"""Sending email: an HTTPS API (Resend) or SMTP, chosen by environment settings.

Hosts that block SMTP (such as Render's free web services) need the API route.
Credentials only ever come from the environment; they're never stored or returned.
"""

from __future__ import annotations

import asyncio
import smtplib
from email.message import EmailMessage

import httpx

from app.core.config import settings

#: Tests swap in an httpx.MockTransport.
_transport: httpx.AsyncBaseTransport | None = None


class MailNotConfiguredError(Exception):
    pass


class MailSendError(Exception):
    pass


def provider() -> str:
    """ "resend", "smtp", or "" when email isn't set up."""
    if not settings.EMAIL_FROM:
        return ""
    if settings.RESEND_API_KEY:
        return "resend"
    return "smtp" if settings.SMTP_HOST else ""


def _smtp_send(msg: EmailMessage) -> None:
    security = settings.SMTP_SECURITY
    cls = smtplib.SMTP_SSL if security == "ssl" else smtplib.SMTP
    with cls(settings.SMTP_HOST, settings.SMTP_PORT, timeout=20) as smtp:
        if security == "starttls":
            smtp.starttls()
        if settings.SMTP_USER:
            smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        smtp.send_message(msg)


async def send(to: list[str], cc: list[str], subject: str, html: str, text: str) -> None:
    kind = provider()
    if not kind:
        raise MailNotConfiguredError("Email isn't set up on the server yet")
    try:
        if kind == "resend":
            async with httpx.AsyncClient(timeout=20, transport=_transport) as client:
                resp = await client.post(
                    "https://api.resend.com/emails",
                    headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}"},
                    json={
                        "from": settings.EMAIL_FROM,
                        "to": to,
                        "cc": cc,
                        "subject": subject,
                        "html": html,
                        "text": text,
                    },
                )
            if resp.status_code >= 300:
                raise MailSendError(f"Email service answered {resp.status_code}: {resp.text[:300]}")
            return
        msg = EmailMessage()
        msg["From"] = settings.EMAIL_FROM
        msg["To"] = ", ".join(to)
        if cc:
            msg["Cc"] = ", ".join(cc)
        msg["Subject"] = subject
        msg.set_content(text)
        msg.add_alternative(html, subtype="html")
        await asyncio.to_thread(_smtp_send, msg)
    except (httpx.HTTPError, OSError, smtplib.SMTPException) as exc:
        raise MailSendError(f"{type(exc).__name__}: {exc}"[:500]) from exc
