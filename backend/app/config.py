# Environment‑based configuration
# All values are read directly from OS environment variables.
# Defaults are provided for local development.

import os
from functools import lru_cache
from dotenv import load_dotenv

# Load environment variables from .env file if present
load_dotenv()

def _int(name: str, default: int) -> int:
    """Return an int from the environment or the supplied default."""
    try:
        return int(os.getenv(name, str(default)))
    except (ValueError, TypeError):
        return default

class Settings:
    # Application basics
    app_env: str = os.getenv("APP_ENV", "development")
    app_url: str = os.getenv("APP_URL", "http://localhost:8000")
    secret_key: str = os.getenv("SECRET_KEY", "change-me")
    is_production: bool = app_env == "production"

    # JWT timing
    access_token_expire_minutes: int = _int("ACCESS_TOKEN_EXPIRE_MINUTES", 15)
    refresh_token_expire_days: int = _int("REFRESH_TOKEN_EXPIRE_DAYS", 7)

    # Email token timing (in minutes)
    email_verify_expire_minutes: int = _int("EMAIL_VERIFY_EXPIRE_MINUTES", 1440)   # 24h
    password_reset_expire_minutes: int = _int("PASSWORD_RESET_EXPIRE_MINUTES", 60) # 1h

    # Databases
    database_url: str = os.getenv(
        "DATABASE_URL",
        "postgresql+asyncpg://postgres:postgres@localhost:5432/sqlanalyst",
    )
    target_db_url: str = os.getenv("TARGET_DB_URL", "sqlite:///./data/analytics.db")

    # AI / LLM
    groq_api_key: str = os.getenv("GROQ_API_KEY", "")
    llm_model: str = os.getenv("LLM_MODEL", "llama-3.3-70b-versatile")
    llm_base_url: str = os.getenv("LLM_BASE_URL", "https://api.groq.com")

    # Security
    db_max_rows: int = _int("DB_MAX_ROWS", 10000)
    db_encryption_key: str = os.getenv("DB_ENCRYPTION_KEY", "")

    # SMTP (for email verification & password reset)
    smtp_host: str = os.getenv("SMTP_HOST", "")
    smtp_port: int = _int("SMTP_PORT", 465)
    smtp_user: str = os.getenv("SMTP_USER", "")
    smtp_password: str = os.getenv("SMTP_PASSWORD", "")
    smtp_from: str = os.getenv("SMTP_FROM", "noreply@sqlanalyst.local")

    @property
    def smtp_configured(self) -> bool:
        return bool(self.smtp_host and self.smtp_user and self.smtp_password)

    # Default admin seed credentials
    default_admin_email: str = os.getenv("DEFAULT_ADMIN_EMAIL", "admin@sqlanalyst.com")
    default_admin_password: str = os.getenv("DEFAULT_ADMIN_PASSWORD", "Admin1234")
    default_admin_name: str = os.getenv("DEFAULT_ADMIN_NAME", "Admin")

@lru_cache()
def get_settings() -> Settings:
    """Return a cached Settings instance (read env only once)."""
    return Settings()

# Export a singleton used throughout the code base
settings = get_settings()