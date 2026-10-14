"""
Pydantic schemas for the admin panel API.
"""

from pydantic import BaseModel


class UserUpdateRequest(BaseModel):
    role: str | None = None  # "user" | "admin"
    is_active: bool | None = None


class AdminStats(BaseModel):
    total_users: int
    active_users: int
    admin_count: int
    total_queries: int
    successful_queries: int
    failed_queries: int
