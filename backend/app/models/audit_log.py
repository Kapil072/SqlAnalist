import uuid
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import BigInteger, String, DateTime, ForeignKey, Text, Integer
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base    


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    session_id: Mapped[Optional[uuid.UUID]] = mapped_column(nullable=True, index=True)
    question: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sql_used: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    row_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="success", index=True)
    error_msg: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    timing_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )

    def __repr__(self) -> str:
        return f"<AuditLog id={self.id} user_id={self.user_id} status={self.status}>"
