import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class OTPCode(Base):
    """
    Stores a 6-digit OTP for email verification during registration.
    One active OTP per email at a time — old ones are deleted on re-send.
    Expires after 10 minutes.
    """

    __tablename__ = "otp_codes"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(6), nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Wrong guesses so far — the code is burned after MAX_OTP_ATTEMPTS.
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
    )

    def is_expired(self) -> bool:
        now = datetime.now(UTC)
        expires = self.expires_at
        # SQLite returns naive datetimes — normalize both to UTC for comparison
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=UTC)
        return now > expires
