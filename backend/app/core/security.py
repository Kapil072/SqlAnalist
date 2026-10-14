import uuid
from datetime import UTC, datetime, timedelta

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.session import AsyncSessionLocal, get_db

ALGORITHM = "HS256"
REFRESH_COOKIE = "refresh_token"
_bearer = HTTPBearer(auto_error=False)


# ---------------------------------------------------------------------------
# Passwords — bcrypt (cost factor 12)
# ---------------------------------------------------------------------------


def hash_password(password: str) -> str:
    """Return a bcrypt hash of the plaintext password."""
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(password: str, hashed: str) -> bool:
    """Return True if the plaintext password matches the stored bcrypt hash."""
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except Exception:
        return False


# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------


def _create_token(data: dict, expires: timedelta) -> str:
    payload = {
        **data,
        "exp": datetime.now(UTC) + expires,
        "iat": datetime.now(UTC),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def create_access_token(data: dict, token_version: int = 0) -> str:
    return _create_token(
        {**data, "type": "access", "ver": token_version},
        timedelta(minutes=settings.access_token_expire_minutes),
    )


def create_refresh_token(data: dict, token_version: int = 0) -> str:
    jti = str(uuid.uuid4())
    return _create_token(
        {**data, "type": "refresh", "jti": jti, "ver": token_version},
        timedelta(days=settings.refresh_token_expire_days),
    )


def decode_token(token: str) -> dict:
    """Decode and verify a JWT. Raises jwt.InvalidTokenError on failure."""
    return jwt.decode(
        token,
        settings.secret_key,
        algorithms=[ALGORITHM],
    )


# ---------------------------------------------------------------------------
# Refresh-token cookie helpers (single place for cookie flags)
# ---------------------------------------------------------------------------


def set_refresh_cookie(response: Response, refresh_token: str) -> None:
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=refresh_token,
        httponly=True,
        max_age=settings.refresh_token_expire_days * 24 * 60 * 60,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path="/",
    )


def clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        REFRESH_COOKIE, path="/", secure=settings.cookie_secure, httponly=True, samesite=settings.cookie_samesite
    )


def issue_token_pair(user, response: Response) -> str:
    """Create access + refresh tokens for *user*, set the refresh cookie, return the access token."""
    version = getattr(user, "token_version", 0) or 0
    access = create_access_token({"sub": str(user.id)}, token_version=version)
    refresh = create_refresh_token({"sub": str(user.id)}, token_version=version)
    set_refresh_cookie(response, refresh)
    return access


# ---------------------------------------------------------------------------
# Token → User
# ---------------------------------------------------------------------------


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


async def user_from_access_token(token: str, db: AsyncSession):
    """
    Validate an access JWT and return the active User it belongs to.
    Raises HTTP 401/403 on any failure.
    """
    from app.models.user import User  # local import to avoid circular deps

    try:
        payload = decode_token(token)
    except jwt.ExpiredSignatureError:
        raise _unauthorized("Token has expired")
    except jwt.InvalidTokenError:
        raise _unauthorized("Invalid authentication token")

    if payload.get("type") != "access":
        raise _unauthorized("Invalid token type")

    user_id = payload.get("sub")
    if not user_id:
        raise _unauthorized("Token missing subject")
    try:
        user_uuid = uuid.UUID(user_id)
    except ValueError:
        raise _unauthorized("Invalid authentication token")

    result = await db.execute(select(User).where(User.id == user_uuid))
    user = result.scalar_one_or_none()
    if user is None:
        raise _unauthorized("User not found")
    if payload.get("ver", 0) != (user.token_version or 0):
        raise _unauthorized("Session has been revoked")
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is deactivated",
        )
    return user


async def authenticate_request(request: Request):
    """
    Auth helper for streaming routes (SSE), which open their own short-lived
    DB session instead of using Depends(get_db). Returns the User.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise _unauthorized("Missing authentication token")
    async with AsyncSessionLocal() as db:
        return await user_from_access_token(auth_header[len("Bearer ") :], db)


# ---------------------------------------------------------------------------
# FastAPI dependency — current authenticated user
# ---------------------------------------------------------------------------


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
):
    """
    FastAPI dependency that extracts and validates the Bearer JWT,
    then loads and returns the corresponding User from the database.

    Raises HTTP 401 if the token is missing, invalid, revoked, or the user is not found.
    Raises HTTP 403 if the user's account is inactive.
    """
    if credentials is None:
        raise _unauthorized("Missing authentication token")
    return await user_from_access_token(credentials.credentials, db)


async def require_admin(current_user=Depends(get_current_user)):
    """Dependency that additionally requires the user to have the 'admin' role."""
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return current_user
