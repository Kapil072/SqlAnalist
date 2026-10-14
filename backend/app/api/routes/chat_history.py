"""
Chat history endpoints.

POST /chat/save      — save one Q&A turn (called after streaming finishes)
GET  /chat/history   — return the last N turns for the current user
DELETE /chat/history — clear all history for the current user
"""

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.chat_history import ChatMessage
from app.models.user import User

router = APIRouter(prefix="/chat", tags=["chat"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class SaveMessageRequest(BaseModel):
    question: str
    sql_query: str | None = None
    explanation: str | None = None
    engine_used: str | None = None
    session_id: str | None = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/save", status_code=201)
async def save_message(
    body: SaveMessageRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Save one Q&A turn for the current user."""
    msg = ChatMessage(
        user_id=current_user.id,
        question=body.question,
        sql_query=body.sql_query,
        explanation=body.explanation,
        engine_used=body.engine_used,
        session_id=body.session_id,
    )
    db.add(msg)
    await db.commit()
    await db.refresh(msg)
    return {"id": str(msg.id), "created_at": msg.created_at.isoformat()}


@router.get("/history")
async def get_history(
    limit: int = Query(30, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the last `limit` messages for the current user, newest first."""
    result = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.user_id == current_user.id)
        .order_by(ChatMessage.created_at.desc())
        .limit(limit)
    )
    messages = result.scalars().all()
    return {
        "messages": [
            {
                "id": str(m.id),
                "question": m.question,
                "sql_query": m.sql_query,
                "explanation": m.explanation,
                "engine_used": m.engine_used,
                "session_id": m.session_id,
                "created_at": m.created_at.isoformat(),
            }
            for m in messages
        ]
    }


@router.delete("/history", status_code=204)
async def clear_history(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete all chat history for the current user."""
    await db.execute(delete(ChatMessage).where(ChatMessage.user_id == current_user.id))
    await db.commit()
