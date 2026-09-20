"""
Authentication routes — register, login, refresh, logout,
email verification, forgot/reset password, and /me.
"""

import uuid
import jwt
from datetime import datetime, timedelta
from fastapi import APIRouter, BackgroundTasks, Cookie, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, and_, func

from app.db.session import get_db
from app.models.user import User
from app.schemas.auth import (
    RegisterRequest,
    LoginRequest,
    TokenResponse,
    UserInToken,
    ForgotPasswordRequest,
    ResetPasswordRequest,
)
from app.core.security import (
    hash_password,
    verify_password,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
)
from app.core.email_tokens import create_email_token, verify_email_token
from app.core.email import send_verification_email, send_password_reset_email

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "refresh_token"


def _user_token_payload(user: User) -> UserInToken:
    return UserInToken(
        id=str(user.id),
        name=user.name,
        email=user.email,
        role=user.role,
        email_verified=user.email_verified,
    )


# ---------------------------------------------------------------------------
# Register
# ---------------------------------------------------------------------------

@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    # Ensure email is unique
    result = await db.execute(select(User).where(User.email == body.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        email=body.email,
        name=body.name,
        password_hash=hash_password(body.password),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Send verification email in background (optional — user can log in immediately)
    verify_token = create_email_token("email_verify", str(user.id))
    background_tasks.add_task(
        send_verification_email, user.email, user.name, verify_token
    )

    return {
        "id": str(user.id),
        "email": user.email,
        "name": user.name,
        "message": "Account created. Check your email to verify your address.",
    }


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    input_val = body.email.strip().lower()
    result = await db.execute(
        select(User).where(
            or_(
                func.lower(User.email) == input_val,
                and_(User.role == "admin", input_val == "admin"),
            )
        )
    )
    user = result.scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is deactivated")

    access_token = create_access_token({"sub": str(user.id)})
    refresh_token = create_refresh_token({"sub": str(user.id)})

    response.set_cookie(
        key=REFRESH_COOKIE,
        value=refresh_token,
        httponly=True,
        max_age=60 * 60 * 24 * 30,  # 30 days
        secure=False,
        samesite="lax",
    )
    return TokenResponse(
        access_token=access_token,
        token_type="bearer",
        user=_user_token_payload(user),
    )


# ---------------------------------------------------------------------------
# Refresh
# ---------------------------------------------------------------------------

@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
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

    user_id = payload.get("sub")
    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")

    new_access = create_access_token({"sub": user_id})
    new_refresh = create_refresh_token({"sub": user_id})
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=new_refresh,
        httponly=True,
        max_age=60 * 60 * 24 * 30,
        secure=False,
        samesite="lax",
    )
    return TokenResponse(
        access_token=new_access,
        token_type="bearer",
        user=_user_token_payload(user),
    )


# ---------------------------------------------------------------------------
# Logout
# ---------------------------------------------------------------------------

@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(REFRESH_COOKIE)
    return {"detail": "Logged out"}


# ---------------------------------------------------------------------------
# Email verification
# ---------------------------------------------------------------------------

@router.get("/verify-email")
async def verify_email(token: str, db: AsyncSession = Depends(get_db)):
    try:
        user_id = verify_email_token(token, "email_verify")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=400, detail="Verification link has expired")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid verification token")

    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if not user.email_verified:
        user.email_verified = True
        db.add(user)
        await db.commit()

    return {"detail": "Email verified successfully"}


# ---------------------------------------------------------------------------
# Forgot password
# ---------------------------------------------------------------------------

@router.post("/forgot-password")
async def forgot_password(
    body: ForgotPasswordRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()
    # Always return 200 to prevent email enumeration
    if user:
        reset_token = create_email_token("password_reset", str(user.id))
        background_tasks.add_task(
            send_password_reset_email, user.email, user.name, reset_token
        )
    return {"detail": "If that email is registered, a reset link has been sent."}


# ---------------------------------------------------------------------------
# Reset password
# ---------------------------------------------------------------------------

@router.post("/reset-password")
async def reset_password(body: ResetPasswordRequest, db: AsyncSession = Depends(get_db)):
    try:
        user_id = verify_email_token(body.token, "password_reset")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=400, detail="Reset link has expired")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid reset token")

    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.password_hash = hash_password(body.new_password)
    db.add(user)
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
        "created_at": current_user.created_at.isoformat(),
    }
