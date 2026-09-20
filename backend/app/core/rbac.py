from enum import Enum
from functools import wraps
from fastapi import HTTPException


class Role(str, Enum):
    USER = "user"
    ADMIN = "admin"


def require_role(*roles: Role):
    """
    Decorator factory for route-level role enforcement.
    Usage:
        @require_role(Role.ADMIN)
        async def my_route(user = Depends(get_current_user)):
            ...
    """
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            # Find 'user' in kwargs (injected by FastAPI dependency)
            user = kwargs.get("current_user") or kwargs.get("user")
            if user is None:
                raise HTTPException(status_code=401, detail="Not authenticated")
            if user.role not in [r.value for r in roles]:
                raise HTTPException(status_code=403, detail="Insufficient permissions")
            return await func(*args, **kwargs)
        return wrapper
    return decorator
