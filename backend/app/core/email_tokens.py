"""
Password-reset tokens (signed JWTs sent by email).

Email addresses are verified with 6-digit codes (see routes/auth.py), so
"password_reset" is the only purpose in use. These are short-lived, single-purpose tokens that are sent out of band
(via email link) and NOT used for API authentication.
"""

import hashlib
from datetime import UTC, datetime, timedelta

import jwt

from app.config import settings

ALGORITHM = "HS256"
_EMAIL_SECRET_SUFFIX = ":email-tokens"


def _email_secret() -> str:
    """Derive a separate secret so email tokens cannot be reused as access tokens."""
    return settings.secret_key + _EMAIL_SECRET_SUFFIX


def password_fingerprint(password_hash: str) -> str:
    """
    Short fingerprint of the user's current password hash.
    Embedded in password-reset tokens so a token stops working as soon as
    the password changes (i.e. reset links are single-use).
    """
    return hashlib.sha256(password_hash.encode()).hexdigest()[:16]


def create_email_token(purpose: str, user_id: str, fingerprint: str | None = None) -> str:
    """
    Create a signed JWT for out-of-band email flows.

    Args:
        purpose: "password_reset"
        user_id: the UUID of the target user (as string)

    Returns:
        Compact JWT string
    """
    if purpose == "password_reset":
        expires = timedelta(minutes=settings.password_reset_expire_minutes)
    else:
        raise ValueError(f"Unknown email token purpose: {purpose}")

    payload = {
        "sub": user_id,
        "purpose": purpose,
        "exp": datetime.now(UTC) + expires,
        "iat": datetime.now(UTC),
    }
    if fingerprint:
        payload["fp"] = fingerprint
    return jwt.encode(payload, _email_secret(), algorithm=ALGORITHM)


def verify_email_token(
    token: str,
    expected_purpose: str,
    expected_fingerprint: str | None = None,
) -> str:
    """
    Decode and validate an email token.

    Returns user_id (str) if valid.
    Raises jwt.ExpiredSignatureError, jwt.InvalidTokenError, or ValueError.
    """
    payload = jwt.decode(token, _email_secret(), algorithms=[ALGORITHM])
    if payload.get("purpose") != expected_purpose:
        raise ValueError("Token purpose mismatch")
    if expected_fingerprint is not None and payload.get("fp") != expected_fingerprint:
        raise ValueError("Token has already been used or is no longer valid")
    user_id = payload.get("sub")
    if not user_id:
        raise ValueError("Missing subject in token")
    return user_id
