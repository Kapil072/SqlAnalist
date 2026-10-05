"""
Google OAuth — two endpoints:

1. POST /auth/google/token
   Frontend sends the ID token from Google Identity Services JS SDK.
   Used when the SDK popup works.

2. GET  /auth/google/redirect
   Redirects the browser to Google's consent page.
   Works without the JS SDK — clean redirect flow.

3. GET  /auth/google/callback
   Google redirects back here with ?code=...
   We exchange the code for user info and return tokens.
"""

import uuid
import httpx
from urllib.parse import urlencode
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select

from app.config import settings
from app.core.security import create_access_token, create_refresh_token, hash_password
from app.db.session import AsyncSessionLocal
from app.models.user import User
from app.schemas.auth import TokenResponse, UserInToken
from app.utils.logger import logger

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE  = "refresh_token"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO  = "https://www.googleapis.com/oauth2/v3/userinfo"
GOOGLE_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth"


# ── Shared helper: find-or-create user from Google info ──────
async def _get_or_create_google_user(email: str, name: str) -> User:
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()

        if user is None:
            user = User(
                email=email,
                name=name,
                password_hash=hash_password(uuid.uuid4().hex),
                role="user",
                is_active=True,
                email_verified=True,
            )
            db.add(user)
            await db.commit()
            await db.refresh(user)
            logger.info(f"[GOOGLE] New user created: {email}")
        elif not user.is_active:
            raise HTTPException(status_code=403, detail="Account is deactivated")
        else:
            if not user.email_verified:
                user.email_verified = True
                db.add(user)
                await db.commit()

        return user


def _issue_tokens(user: User, response: Response) -> TokenResponse:
    access  = create_access_token({"sub": str(user.id)})
    refresh = create_refresh_token({"sub": str(user.id)})
    response.set_cookie(
        key=REFRESH_COOKIE, value=refresh,
        httponly=True, max_age=60 * 60 * 24 * 30,
        secure=False, samesite="lax",
    )
    return TokenResponse(
        access_token=access,
        token_type="bearer",
        user=UserInToken(
            id=str(user.id), name=user.name,
            email=user.email, role=user.role,
            email_verified=True,
        ),
    )


# ── 1. ID-token flow (JS SDK popup) ─────────────────────────
class GoogleTokenRequest(BaseModel):
    credential: str


@router.post("/google/token", response_model=TokenResponse)
async def google_token_login(body: GoogleTokenRequest, response: Response):
    """Verify a Google ID token from the JS SDK and return a JWT pair."""
    client_id = settings.google_client_id
    if not client_id or "your-google" in client_id:
        raise HTTPException(status_code=501, detail="Google OAuth not configured.")

    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as g_req
        info = id_token.verify_oauth2_token(
            body.credential, g_req.Request(), client_id
        )
    except Exception as exc:
        logger.warning(f"[GOOGLE] Token verify failed: {exc}")
        raise HTTPException(status_code=401, detail="Invalid Google token")

    email = info.get("email", "").lower().strip()
    name  = info.get("name", email.split("@")[0])
    if not email:
        raise HTTPException(status_code=400, detail="Google account has no email")

    user = await _get_or_create_google_user(email, name)
    logger.info(f"[GOOGLE] Token login: {email}")
    return _issue_tokens(user, response)


# ── 2. Redirect flow — start ─────────────────────────────────
@router.get("/google/redirect")
async def google_redirect():
    """Redirect browser to Google consent screen."""
    client_id = settings.google_client_id
    if not client_id or "your-google" in client_id:
        raise HTTPException(status_code=501, detail="Google OAuth not configured. Set GOOGLE_CLIENT_ID in backend/.env")

    redirect_uri = f"{settings.app_url}/auth/google/callback"
    params = urlencode({
        "client_id":     client_id,
        "redirect_uri":  redirect_uri,
        "response_type": "code",
        "scope":         "openid email profile",
        "access_type":   "offline",
        "prompt":        "select_account",
    })
    return RedirectResponse(url=f"{GOOGLE_AUTH_URL}?{params}")


# ── 3. Redirect flow — callback ──────────────────────────────
@router.get("/google/callback")
async def google_callback(request: Request, response: Response):
    """Google redirects here with ?code=... — exchange for user info."""
    code  = request.query_params.get("code")
    error = request.query_params.get("error")

    if error or not code:
        return RedirectResponse(
            url=f"{settings.app_url.replace(':8000','').replace('http://localhost','http://localhost:3000')}/auth?error=google_denied"
        )

    client_id     = settings.google_client_id
    client_secret = settings.google_client_secret
    redirect_uri  = f"{settings.app_url}/auth/google/callback"
    frontend_url  = settings.app_url.replace(':8000', ':3000')

    # Exchange code for tokens
    try:
        async with httpx.AsyncClient() as client:
            token_resp = await client.post(GOOGLE_TOKEN_URL, data={
                "code":          code,
                "client_id":     client_id,
                "client_secret": client_secret,
                "redirect_uri":  redirect_uri,
                "grant_type":    "authorization_code",
            })
            token_data = token_resp.json()

            if "access_token" not in token_data:
                raise ValueError(f"No access_token: {token_data}")

            # Get user info
            user_resp = await client.get(
                GOOGLE_USERINFO,
                headers={"Authorization": f"Bearer {token_data['access_token']}"}
            )
            info = user_resp.json()
    except Exception as exc:
        logger.error(f"[GOOGLE] Callback failed: {exc}")
        return RedirectResponse(url=f"{frontend_url}/auth?error=google_failed")

    email = info.get("email", "").lower().strip()
    name  = info.get("name", email.split("@")[0])

    if not email:
        return RedirectResponse(url=f"{frontend_url}/auth?error=no_email")

    user = await _get_or_create_google_user(email, name)
    access = create_access_token({"sub": str(user.id)})

    logger.info(f"[GOOGLE] Callback login: {email}")
    # Redirect to frontend with token in URL fragment so JS can grab it
    return RedirectResponse(
        url=f"{frontend_url}/auth/google-success?token={access}"
            f"&name={user.name}&email={user.email}&role={user.role}&id={user.id}"
    )

