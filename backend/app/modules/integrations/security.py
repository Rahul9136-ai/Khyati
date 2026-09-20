"""Inbound-callback verification for Slack and Teams.

Slack signs every interactive request with an HMAC-SHA256 over
`v0:{timestamp}:{raw_body}` keyed by the app's signing secret (docs:
https://api.slack.com/authentication/verifying-requests-from-slack). Teams
Actionable Message `Action.Http` calls can't be signed the same way, so we hand
Teams a shared bearer token at card-build time and require it back verbatim.
"""
from __future__ import annotations

import hashlib
import hmac
import time


def verify_slack_signature(
    signing_secret: str,
    timestamp: str | None,
    signature: str | None,
    raw_body: bytes,
    *,
    max_skew_seconds: int = 60 * 5,
) -> bool:
    """True iff the request carries a valid, non-stale Slack signature."""
    if not signing_secret or not timestamp or not signature:
        return False
    try:
        if abs(time.time() - int(timestamp)) > max_skew_seconds:
            return False  # replay guard
    except ValueError:
        return False
    basestring = b"v0:" + timestamp.encode() + b":" + raw_body
    digest = hmac.new(signing_secret.encode(), basestring, hashlib.sha256).hexdigest()
    expected = f"v0={digest}"
    return hmac.compare_digest(expected, signature)


def verify_teams_token(expected_token: str, provided_token: str | None) -> bool:
    """Constant-time compare of the Teams shared secret echoed back on callbacks."""
    if not expected_token or not provided_token:
        return False
    return hmac.compare_digest(expected_token, provided_token)
