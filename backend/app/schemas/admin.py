"""
Pydantic schemas for the admin panel API.
"""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class UserAdminView(BaseModel):
    id: str
    name: str
    email: str
    role: str
    is_active: bool
    email_verified: bool
    created_at: datetime

    class Config:
        from_attributes = True


class UserUpdateRequest(BaseModel):
    role: Optional[str] = None        # "user" | "admin"
    is_active: Optional[bool] = None


class AuditLogView(BaseModel):
    id: int
    user_id: Optional[str] = None
    question: Optional[str] = None
    sql_used: Optional[str] = None
    row_count: Optional[int] = None
    status: str
    error_msg: Optional[str] = None
    timing_ms: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


class AdminStats(BaseModel):
    total_users: int
    active_users: int
    admin_count: int
    total_queries: int
    successful_queries: int
    failed_queries: int
