# Import all models here so SQLAlchemy's metadata knows about every table.
from app.models.user import User                    # noqa: F401
from app.models.otp import OTPCode                  # noqa: F401
from app.models.chat_history import ChatMessage     # noqa: F401
from app.models.data_source import DataSource       # noqa: F401
from app.models.audit_log import AuditLog           # noqa: F401
