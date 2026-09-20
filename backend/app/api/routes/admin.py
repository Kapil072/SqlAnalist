"""
Admin-only API routes.
All endpoints require a valid JWT with role == "admin".
"""
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.db.session import get_db
from app.models.user import User
from app.models.audit_log import AuditLog
from app.core.security import require_admin
from app.schemas.admin import (
    AdminStats,
    UserAdminView,
    UserUpdateRequest,
    AuditLogView,
)

router = APIRouter(prefix="/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Dashboard stats
# ---------------------------------------------------------------------------

@router.get("/stats", response_model=AdminStats)
async def admin_stats(
    _=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    total_users = (await db.execute(select(func.count()).select_from(User))).scalar_one()
    active_users = (await db.execute(
        select(func.count()).select_from(User).where(User.is_active == True)
    )).scalar_one()
    admin_count = (await db.execute(
        select(func.count()).select_from(User).where(User.role == "admin")
    )).scalar_one()
    total_queries = (await db.execute(select(func.count()).select_from(AuditLog))).scalar_one()
    successful_queries = (await db.execute(
        select(func.count()).select_from(AuditLog).where(AuditLog.status == "success")
    )).scalar_one()
    failed_queries = (await db.execute(
        select(func.count()).select_from(AuditLog).where(AuditLog.status == "error")
    )).scalar_one()

    return AdminStats(
        total_users=total_users,
        active_users=active_users,
        admin_count=admin_count,
        total_queries=total_queries,
        successful_queries=successful_queries,
        failed_queries=failed_queries,
    )


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------

@router.get("/users")
async def list_users(
    _=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
):
    result = await db.execute(
        select(User).order_by(User.created_at.desc()).offset(skip).limit(limit)
    )
    users = result.scalars().all()
    total = (await db.execute(select(func.count()).select_from(User))).scalar_one()
    return {
        "total": total,
        "skip": skip,
        "limit": limit,
        "users": [
            {
                "id": str(u.id),
                "name": u.name,
                "email": u.email,
                "role": u.role,
                "is_active": u.is_active,
                "email_verified": u.email_verified,
                "created_at": u.created_at.isoformat(),
            }
            for u in users
        ],
    }


@router.patch("/users/{user_id}")
async def update_user(
    user_id: str,
    body: UserUpdateRequest,
    current_admin=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Prevent admin from deactivating themselves
    if str(user.id) == str(current_admin.id) and body.is_active is False:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own account")

    if body.role is not None:
        if body.role not in ("user", "admin"):
            raise HTTPException(status_code=400, detail="Role must be 'user' or 'admin'")
        user.role = body.role
    if body.is_active is not None:
        user.is_active = body.is_active

    db.add(user)
    await db.commit()
    return {
        "id": str(user.id),
        "name": user.name,
        "email": user.email,
        "role": user.role,
        "is_active": user.is_active,
        "email_verified": user.email_verified,
    }


# ---------------------------------------------------------------------------
# Audit logs
# ---------------------------------------------------------------------------

@router.get("/audit-logs")
async def list_audit_logs(
    _=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    status_filter: Optional[str] = Query(None, alias="status"),
):
    query = select(AuditLog).order_by(AuditLog.created_at.desc())
    if status_filter:
        query = query.where(AuditLog.status == status_filter)

    total_query = select(func.count()).select_from(AuditLog)
    if status_filter:
        total_query = total_query.where(AuditLog.status == status_filter)

    result = await db.execute(query.offset(skip).limit(limit))
    logs = result.scalars().all()
    total = (await db.execute(total_query)).scalar_one()

    return {
        "total": total,
        "skip": skip,
        "limit": limit,
        "logs": [
            {
                "id": log.id,
                "user_id": str(log.user_id) if log.user_id else None,
                "question": log.question,
                "sql_used": log.sql_used,
                "row_count": log.row_count,
                "status": log.status,
                "error_msg": log.error_msg,
                "timing_ms": log.timing_ms,
                "created_at": log.created_at.isoformat(),
            }
            for log in logs
        ],
    }
