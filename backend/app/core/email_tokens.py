"""
Email-specific JWT tokens for:
  - email address verification
  - password reset

These are short-lived, single-purpose tokens that are sent out of band
(via email link) and NOT used for API authentication.
"""
from datetime import datetime, timedelta, timezone

import jwt
from app.config import settings

ALGORITHM = "HS256"
_EMAIL_SECRET_SUFFIX = ":email-tokens"


def _email_secret() -> str:
    """Derive a separate secret so email tokens cannot be reused as access tokens."""
    return settings.secret_key + _EMAIL_SECRET_SUFFIX


def create_email_token(purpose: str, user_id: str) -> str:
    """
    Create a signed JWT for out-of-band email flows.

    Args:
        purpose: one of "email_verify" | "password_reset"
        user_id: the UUID of the target user (as string)

    Returns:
        Compact JWT string
    """
    if purpose == "email_verify":
        expires = timedelta(minutes=settings.email_verify_expire_minutes)
    elif purpose == "password_reset":
        expires = timedelta(minutes=settings.password_reset_expire_minutes)
    else:
        raise ValueError(f"Unknown email token purpose: {purpose}")

    payload = {
        "sub": user_id,
        "purpose": purpose,
        "exp": datetime.now(timezone.utc) + expires,
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, _email_secret(), algorithm=ALGORITHM)


def verify_email_token(token: str, expected_purpose: str) -> str:
    """
    Decode and validate an email token.

    Returns user_id (str) if valid.
    Raises jwt.ExpiredSignatureError, jwt.InvalidTokenError, or ValueError.
    """
    payload = jwt.decode(token, _email_secret(), algorithms=[ALGORITHM])
    if payload.get("purpose") != expected_purpose:
        raise ValueError("Token purpose mismatch")
    user_id = payload.get("sub")
    if not user_id:
        raise ValueError("Missing subject in token")
    return user_id
