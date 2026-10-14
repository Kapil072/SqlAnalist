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
from urllib.parse import quote_plus, urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import func, select

from app.config import settings
from app.core.avatar import is_real_photo, resolve_avatar
from app.core.rate_limit import limiter
from app.core.security import hash_password, issue_token_pair
from app.db.session import AsyncSessionLocal
from app.models.user import User
from app.schemas.auth import TokenResponse, UserInToken
from app.utils.logger import logger

router = APIRouter(prefix="/auth", tags=["auth"])

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo"
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"


# ── Shared helper: find-or-create user from Google info ──────
async def _get_or_create_google_user(
    email: str,
    name: str,
    avatar_url: str | None = None,
) -> User:
    # Only store a real Google photo; otherwise resolve_avatar() uses Gravatar
    if not is_real_photo(avatar_url):
        avatar_url = None

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(func.lower(User.email) == email.lower()))
        user = result.scalar_one_or_none()

        if user is None:
            user = User(
                email=email,
                name=name,
                password_hash=hash_password(uuid.uuid4().hex),
                role="user",
                is_active=True,
                email_verified=True,
                avatar_url=avatar_url,
            )
            db.add(user)
            await db.commit()
            await db.refresh(user)
            logger.info(f"[GOOGLE] New user created: {email} with profile picture")
        elif not user.is_active:
            raise HTTPException(status_code=403, detail="Account is deactivated")
        else:
            updated = False
            if not user.email_verified:
                user.email_verified = True
                updated = True
            if avatar_url and user.avatar_url != avatar_url:
                user.avatar_url = avatar_url
                updated = True
            if updated:
                db.add(user)
                await db.commit()
                await db.refresh(user)

        return user


def _google_configured() -> bool:
    cid = settings.google_client_id
    return bool(cid) and "your-google" not in cid


def _frontend_url() -> str:
    return (settings.frontend_url or "http://localhost:3000").rstrip("/")


def _issue_tokens(user: User, response: Response) -> TokenResponse:
    access = issue_token_pair(user, response)
    return TokenResponse(
        access_token=access,
        token_type="bearer",
        user=UserInToken(
            id=str(user.id),
            name=user.name,
            email=user.email,
            role=user.role,
            email_verified=True,
            avatar_url=resolve_avatar(user),
        ),
    )


def _success_redirect(user: User) -> RedirectResponse:
    """
    Redirect back to the frontend after a redirect-flow login.

    The access token is put in the URL *fragment* (#...), not the query
    string: fragments are never sent to servers, so the token does not end
    up in access logs, proxies or Referer headers. The refresh cookie is set
    on the redirect so silent refresh works afterwards.
    """
    redirect = RedirectResponse(url="/")  # url replaced below
    access = issue_token_pair(user, redirect)
    params = (
        f"token={quote_plus(access)}"
        f"&name={quote_plus(user.name)}&email={quote_plus(user.email)}"
        f"&role={quote_plus(user.role)}&id={user.id}"
    )
    params += f"&avatar_url={quote_plus(resolve_avatar(user))}"
    redirect.headers["location"] = f"{_frontend_url()}/auth/google-success#{params}"
    return redirect


# ── 1. ID-token flow (JS SDK popup) ─────────────────────────
class GoogleTokenRequest(BaseModel):
    credential: str


@router.post("/google/token", response_model=TokenResponse)
@limiter.limit("10/minute")
async def google_token_login(request: Request, body: GoogleTokenRequest, response: Response):
    """Verify a Google ID token from the JS SDK and return a JWT pair."""
    client_id = settings.google_client_id
    if not _google_configured():
        raise HTTPException(status_code=501, detail="Google OAuth not configured.")

    try:
        from google.auth.transport import requests as g_req
        from google.oauth2 import id_token

        info = id_token.verify_oauth2_token(body.credential, g_req.Request(), client_id)
    except Exception as exc:
        logger.warning(f"[GOOGLE] Token verify failed: {exc}")
        raise HTTPException(status_code=401, detail="Invalid Google token")

    email = info.get("email", "").lower().strip()
    name = info.get("name", email.split("@")[0])
    picture = info.get("picture")
    if not email:
        raise HTTPException(status_code=400, detail="Google account has no email")
    if not info.get("email_verified", False):
        raise HTTPException(status_code=401, detail="Google email address is not verified")

    user = await _get_or_create_google_user(email, name, avatar_url=picture)
    logger.info(f"[GOOGLE] Token login: {email}")
    return _issue_tokens(user, response)


# ── 2. Redirect flow — start ─────────────────────────────────
@router.get("/google/redirect")
async def google_redirect():
    """Redirect browser to Google consent screen (or dev auto-login in development only)."""
    if _google_configured():
        redirect_uri = f"{settings.app_url}/auth/google/callback"
        params = urlencode(
            {
                "client_id": settings.google_client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": "openid email profile",
                "access_type": "offline",
                "prompt": "select_account",
            }
        )
        return RedirectResponse(url=f"{GOOGLE_AUTH_URL}?{params}")

    # Google is not configured. Outside development this must NOT log anyone
    # in — previously any visitor was signed in as the SMTP account.
    if not settings.is_development:
        return RedirectResponse(url=f"{_frontend_url()}/auth?error=google_not_configured")

    # Dev-only fallback: log in with the configured SMTP account (or a dummy user)
    logger.warning("[GOOGLE] Google OAuth not configured — using DEVELOPMENT auto-login.")
    email = (
        settings.smtp_user if settings.smtp_user and "@" in settings.smtp_user else "user@gmail.com"
    )
    name = email.split("@")[0].replace(".", " ").title()
    user = await _get_or_create_google_user(email, name)
    return _success_redirect(user)


# ── 3. Redirect flow — callback ──────────────────────────────
@router.get("/google/callback")
async def google_callback(request: Request, response: Response):
    """Google redirects here with ?code=... — exchange for user info."""
    code = request.query_params.get("code")
    error = request.query_params.get("error")

    frontend_url = _frontend_url()
    if error or not code:
        return RedirectResponse(url=f"{frontend_url}/auth?error=google_denied")

    client_id = settings.google_client_id
    client_secret = settings.google_client_secret
    redirect_uri = f"{settings.app_url}/auth/google/callback"

    # Exchange code for tokens
    try:
        async with httpx.AsyncClient() as client:
            token_resp = await client.post(
                GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                },
            )
            token_data = token_resp.json()

            if "access_token" not in token_data:
                raise ValueError(
                    f"No access_token in Google response (error={token_data.get('error')})"
                )

            # Get user info
            user_resp = await client.get(
                GOOGLE_USERINFO, headers={"Authorization": f"Bearer {token_data['access_token']}"}
            )
            info = user_resp.json()
    except Exception as exc:
        logger.error(f"[GOOGLE] Callback failed: {exc}")
        return RedirectResponse(url=f"{frontend_url}/auth?error=google_failed")

    email = info.get("email", "").lower().strip()
    name = info.get("name", email.split("@")[0])
    picture = info.get("picture")

    if not email:
        return RedirectResponse(url=f"{frontend_url}/auth?error=no_email")
    if not info.get("email_verified", False):
        return RedirectResponse(url=f"{frontend_url}/auth?error=google_failed")

    try:
        user = await _get_or_create_google_user(email, name, avatar_url=picture)
    except HTTPException:
        return RedirectResponse(url=f"{frontend_url}/auth?error=account_disabled")

    logger.info(f"[GOOGLE] Callback login: {email}")
    return _success_redirect(user)
