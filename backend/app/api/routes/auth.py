"""
Authentication routes — register, login, refresh, logout,
OTP (email-code) verification, forgot/reset password, and /me.
"""

import asyncio
import hmac
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.avatar import resolve_avatar
from app.core.email import (
    send_otp_email,
    send_password_reset_email,
)
from app.core.email_tokens import create_email_token, password_fingerprint, verify_email_token
from app.core.rate_limit import limiter
from app.core.security import (
    REFRESH_COOKIE,
    clear_refresh_cookie,
    decode_token,
    get_current_user,
    hash_password,
    issue_token_pair,
    verify_password,
)
from app.db.session import get_db
from app.models.otp import OTPCode
from app.models.user import User
from app.schemas.auth import (
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResetPasswordRequest,
    SendOTPRequest,
    TokenResponse,
    UserInToken,
    VerifyOTPRequest,
)
from app.utils.logger import logger

router = APIRouter(prefix="/auth", tags=["auth"])

OTP_TTL_MINUTES = 10
MAX_OTP_ATTEMPTS = 5


def _user_token_payload(user: User) -> UserInToken:
    return UserInToken(
        id=str(user.id),
        name=user.name,
        email=user.email,
        role=user.role,
        email_verified=user.email_verified,
        avatar_url=resolve_avatar(user),
    )


def _new_otp_code() -> str:
    """Cryptographically secure 6-digit code."""
    return f"{secrets.randbelow(1_000_000):06d}"


async def _issue_otp(db: AsyncSession, email: str) -> str:
    """Replace any existing OTP for *email* with a fresh one and return the code."""
    code = _new_otp_code()
    expires = datetime.now(UTC) + timedelta(minutes=OTP_TTL_MINUTES)
    await db.execute(delete(OTPCode).where(OTPCode.email == email))
    db.add(OTPCode(email=email, code=code, expires_at=expires))
    await db.commit()
    return code


def _dev_only(response: dict, **dev_fields) -> dict:
    """
    Attach debugging fields (OTP codes, reset links) to a response ONLY in
    development. In any other environment they are never sent to the client,
    otherwise anyone could take over an account whenever email delivery fails.
    """
    if settings.is_development:
        response.update(dev_fields)
        logger.warning("[AUTH] Dev mode: returning OTP / reset token in API response.")
    return response


# ---------------------------------------------------------------------------
# Register  — creates account, then sends an OTP (or, with EMAIL_VERIFICATION
#             off, logs the new user straight in)
# ---------------------------------------------------------------------------


@router.post("/register", status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def register(
    request: Request,
    body: RegisterRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    email = body.email.lower()
    # Ensure email is unique
    result = await db.execute(select(User).where(func.lower(User.email) == email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        email=email,
        name=body.name,
        password_hash=hash_password(body.password),
        email_verified=False,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    if not settings.email_verification:
        access_token = issue_token_pair(user, response)
        return TokenResponse(
            access_token=access_token,
            token_type="bearer",
            user=_user_token_payload(user),
        )

    code = await _issue_otp(db, email)
    email_sent = await asyncio.to_thread(send_otp_email, email, body.name, code)

    result = {
        "id": str(user.id),
        "email": user.email,
        "name": user.name,
        "email_sent": email_sent,
        "message": (
            "OTP sent to your email."
            if email_sent
            else "We could not send the verification email. Please try again later."
        ),
    }
    if not email_sent:
        _dev_only(result, dev_otp=code)
    return result


# ---------------------------------------------------------------------------
# Send OTP  — resend / send fresh code to an email
# ---------------------------------------------------------------------------


@router.post("/send-otp")
@limiter.limit("5/minute")
async def send_otp(
    request: Request,
    body: SendOTPRequest,
    db: AsyncSession = Depends(get_db),
):
    email = body.email.lower()
    result = await db.execute(select(User).where(func.lower(User.email) == email))
    user = result.scalar_one_or_none()
    if not user:
        # Same shape as success so the endpoint can't be used to discover accounts
        return {"detail": "If that email is registered, an OTP has been sent.", "email_sent": False}

    code = await _issue_otp(db, email)
    email_sent = await asyncio.to_thread(send_otp_email, email, user.name, code)

    response = {
        "detail": "OTP sent. Check your inbox."
        if email_sent
        else "We could not send the email. Please try again later.",
        "email_sent": email_sent,
    }
    if not email_sent:
        _dev_only(response, dev_otp=code)
    return response


# ---------------------------------------------------------------------------
# Verify OTP  — marks email verified, returns tokens so user is logged in
# ---------------------------------------------------------------------------


@router.post("/verify-otp", response_model=TokenResponse)
@limiter.limit("10/minute")
async def verify_otp(
    request: Request,
    body: VerifyOTPRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    email = body.email.lower()
    # Look up the latest unused OTP for this email
    result = await db.execute(
        select(OTPCode)
        .where(OTPCode.email == email, OTPCode.used.is_(False))
        .order_by(OTPCode.created_at.desc())
        .limit(1)
    )
    otp = result.scalar_one_or_none()

    if not otp:
        raise HTTPException(status_code=400, detail="No OTP found. Request a new one.")
    if otp.is_expired():
        raise HTTPException(status_code=400, detail="OTP has expired. Request a new one.")
    if (otp.attempts or 0) >= MAX_OTP_ATTEMPTS:
        otp.used = True
        await db.commit()
        raise HTTPException(status_code=429, detail="Too many wrong attempts. Request a new code.")

    if not hmac.compare_digest(otp.code, body.code.strip()):
        otp.attempts = (otp.attempts or 0) + 1
        if otp.attempts >= MAX_OTP_ATTEMPTS:
            otp.used = True  # burn the code
        await db.commit()
        remaining = max(MAX_OTP_ATTEMPTS - otp.attempts, 0)
        raise HTTPException(
            status_code=400,
            detail=f"Incorrect OTP code. {remaining} attempt(s) left."
            if remaining
            else "Too many wrong attempts. Request a new code.",
        )

    user_result = await db.execute(select(User).where(func.lower(User.email) == email))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is deactivated")

    otp.used = True
    user.email_verified = True
    await db.commit()
    await db.refresh(user)

    # Issue tokens so user is logged in immediately after verification
    access_token = issue_token_pair(user, response)
    return TokenResponse(
        access_token=access_token,
        token_type="bearer",
        user=_user_token_payload(user),
    )


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
async def login(
    request: Request,
    body: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    input_val = body.email.strip().lower()
    # Convenience: typing just "admin" logs in as the configured default admin
    if input_val == "admin":
        input_val = settings.default_admin_email.strip().lower()

    result = await db.execute(select(User).where(func.lower(User.email) == input_val))
    user = result.scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is deactivated")
    if settings.email_verification and not user.email_verified:
        raise HTTPException(
            status_code=403,
            detail="Email not verified. Please enter the OTP sent to your email.",
        )

    access_token = issue_token_pair(user, response)
    return TokenResponse(
        access_token=access_token,
        token_type="bearer",
        user=_user_token_payload(user),
    )


# ---------------------------------------------------------------------------
# Refresh
# ---------------------------------------------------------------------------


@router.post("/refresh", response_model=TokenResponse)
@limiter.limit("30/minute")
async def refresh_token(
    request: Request,
    response: Response,
    refresh_token: str = Cookie(None, alias=REFRESH_COOKIE),
    db: AsyncSession = Depends(get_db),
):
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Refresh token missing")
    try:
        payload = decode_token(refresh_token)
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Wrong token type")

    try:
        user_uuid = uuid.UUID(payload.get("sub") or "")
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    result = await db.execute(select(User).where(User.id == user_uuid))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    if payload.get("ver", 0) != (user.token_version or 0):
        clear_refresh_cookie(response)
        raise HTTPException(status_code=401, detail="Session has been revoked")

    new_access = issue_token_pair(user, response)
    return TokenResponse(
        access_token=new_access,
        token_type="bearer",
        user=_user_token_payload(user),
    )


# ---------------------------------------------------------------------------
# Logout — revokes every token issued to this user so far
# ---------------------------------------------------------------------------


@router.post("/logout")
async def logout(
    response: Response,
    refresh_token: str = Cookie(None, alias=REFRESH_COOKIE),
    db: AsyncSession = Depends(get_db),
):
    if refresh_token:
        try:
            payload = decode_token(refresh_token)
            if payload.get("type") == "refresh":
                result = await db.execute(
                    select(User).where(User.id == uuid.UUID(payload.get("sub") or ""))
                )
                user = result.scalar_one_or_none()
                if user and payload.get("ver", 0) == (user.token_version or 0):
                    user.token_version = (user.token_version or 0) + 1
                    await db.commit()
        except (jwt.InvalidTokenError, ValueError):
            pass  # already invalid — nothing to revoke
    clear_refresh_cookie(response)
    return {"detail": "Logged out"}


# ---------------------------------------------------------------------------
# Forgot password
# ---------------------------------------------------------------------------


@router.post("/forgot-password")
@limiter.limit("5/minute")
async def forgot_password(
    request: Request,
    body: ForgotPasswordRequest,
    db: AsyncSession = Depends(get_db),
):
    generic = {
        "detail": "If that email is registered, a reset link has been sent.",
        "email_sent": False,
    }
    result = await db.execute(select(User).where(func.lower(User.email) == body.email.lower()))
    user = result.scalar_one_or_none()
    if not user:
        return generic

    reset_token = create_email_token(
        "password_reset", str(user.id), fingerprint=password_fingerprint(user.password_hash)
    )
    email_sent = await asyncio.to_thread(
        send_password_reset_email, user.email, user.name, reset_token
    )

    if email_sent:
        return {
            "detail": "Password reset link sent! Please check your email inbox.",
            "email_sent": True,
        }

    response = {
        "detail": "We could not send the reset email. Please try again later.",
        "email_sent": False,
    }
    return _dev_only(
        response,
        dev_reset_token=reset_token,
        dev_reset_url=f"{settings.frontend_url}/auth?reset_token={reset_token}",
    )


# ---------------------------------------------------------------------------
# Reset password  (single-use: the token dies once the password changes)
# ---------------------------------------------------------------------------


@router.post("/reset-password")
@limiter.limit("10/minute")
async def reset_password(
    request: Request,
    body: ResetPasswordRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        user_id = verify_email_token(body.token, "password_reset")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=400, detail="Reset link has expired")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid reset token")

    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="Invalid reset token")

    try:
        verify_email_token(
            body.token,
            "password_reset",
            expected_fingerprint=password_fingerprint(user.password_hash),
        )
    except Exception:
        raise HTTPException(status_code=400, detail="This reset link has already been used")

    user.password_hash = hash_password(body.new_password)
    # Log out every existing session after a password change
    user.token_version = (user.token_version or 0) + 1
    await db.commit()
    return {"detail": "Password reset successfully. You can now log in."}


# ---------------------------------------------------------------------------
# Current user profile (/me)
# ---------------------------------------------------------------------------


@router.get("/me")
async def me(current_user: User = Depends(get_current_user)):
    return {
        "id": str(current_user.id),
        "name": current_user.name,
        "email": current_user.email,
        "role": current_user.role,
        "is_active": current_user.is_active,
        "email_verified": current_user.email_verified,
        "avatar_url": resolve_avatar(current_user),
        "created_at": current_user.created_at.isoformat(),
    }
