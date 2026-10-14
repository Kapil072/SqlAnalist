"""
Shared rate limiter (slowapi), keyed by client IP.

Usage on a route (the route MUST accept a `request: Request` argument):

    from app.core.rate_limit import limiter

    @router.post("/login")
    @limiter.limit("10/minute")
    async def login(request: Request, ...):
        ...

Set RATE_LIMIT_ENABLED=false to switch limiting off (tests do this).
"""

import os

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

limiter = Limiter(
    key_func=get_remote_address,
    enabled=os.getenv("RATE_LIMIT_ENABLED", "true").lower() in ("1", "true", "yes"),
)


def install_rate_limiter(app) -> None:
    """Attach the limiter + 429 handler to the FastAPI app."""
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
