"""
Google OAuth — POST /auth/google
Frontend sends the ID token obtained from Google Sign-In.
Backend verifies it with google-auth, finds or creates the user,
and returns a JWT access token exactly like /auth/login does.

Flow
----
1. User clicks "Continue with Google" in the frontend.
2. Frontend opens Google's consent screen via the Google Identity
   Services JS SDK (one-tap or popup).
3. Google returns a credential (ID token) to the frontend callback.
4. Frontend POSTs that ID token to this endpoint.
5. Backend verifies the token with Google's public keys.
6. If email not in DB → create a verified user (no OTP needed).
7. Return access + refresh tokens — user is logged in.
"""

import uuid
from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select

from app.config import settings
from app.core.security import create_access_token, create_refresh_token, hash_password
from app.db.session import AsyncSessionLocal
from app.models.user import User
from app.schemas.auth import TokenResponse, UserInToken
from app.utils.logger import logger

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "refresh_token"


class GoogleTokenRequest(BaseModel):
    credential: str          # The ID token from Google Identity Services


@router.post("/google", response_model=TokenResponse)
async def google_login(body: GoogleTokenRequest, response: Response):
    """
    Verify a Google ID token and return a JWT pair.
    Creates the user on first sign-in (email verified automatically).
    """
    client_id = settings.google_client_id
    if not client_id or client_id == "your-google-client-id.apps.googleusercontent.com":
        raise HTTPException(
            status_code=501,
            detail="Google OAuth is not configured. Set GOOGLE_CLIENT_ID in .env.",
        )

    # ── Verify token with Google ──────────────────────────────
    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests

        idinfo = id_token.verify_oauth2_token(
            body.credential,
            google_requests.Request(),
            client_id,
        )
    except ValueError as exc:
        logger.warning(f"[GOOGLE_AUTH] Token verification failed: {exc}")
        raise HTTPException(status_code=401, detail="Invalid Google token")

    email: str = idinfo.get("email", "").lower().strip()
    name:  str = idinfo.get("name", email.split("@")[0])
    if not email:
        raise HTTPException(status_code=400, detail="Google account has no email")

    # ── Find or create user ───────────────────────────────────
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()

        if user is None:
            # First Google sign-in — create account (pre-verified)
            user = User(
                email=email,
                name=name,
                password_hash=hash_password(uuid.uuid4().hex),   # unusable random pw
                role="user",
                is_active=True,
                email_verified=True,   # Google already verified the email
            )
            db.add(user)
            await db.commit()
            await db.refresh(user)
            logger.info(f"[GOOGLE_AUTH] New user created via Google: {email}")
        elif not user.is_active:
            raise HTTPException(status_code=403, detail="Account is deactivated")
        else:
            # Ensure existing user has email_verified set
            if not user.email_verified:
                user.email_verified = True
                db.add(user)
                await db.commit()

        # ── Issue tokens ──────────────────────────────────────
        access_token  = create_access_token({"sub": str(user.id)})
        refresh_token = create_refresh_token({"sub": str(user.id)})

    response.set_cookie(
        key=REFRESH_COOKIE,
        value=refresh_token,
        httponly=True,
        max_age=60 * 60 * 24 * 30,
        secure=False,
        samesite="lax",
    )

    logger.info(f"[GOOGLE_AUTH] User logged in via Google: {email}")

    return TokenResponse(
        access_token=access_token,
        token_type="bearer",
        user=UserInToken(
            id=str(user.id),
            name=user.name,
            email=user.email,
            role=user.role,
            email_verified=True,
        ),
    )
