# Environment‑based configuration
# All values are read directly from OS environment variables.
# Defaults are provided for local development.

import os
import re
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


def _float(name: str, default: float) -> float:
    """Return a float from the environment or the supplied default."""
    try:
        return float(os.getenv(name, str(default)))
    except (ValueError, TypeError):
        return default


class Settings:
    # Application basics
    app_env: str = os.getenv("APP_ENV", "development")
    app_url: str = os.getenv("APP_URL", "http://localhost:8000")
    frontend_url: str = os.getenv("FRONTEND_URL", "http://localhost:3000")
    secret_key: str = os.getenv("SECRET_KEY", "change-me")
    is_production: bool = app_env == "production"
    # Dev-only conveniences (showing OTP codes on screen, Google dev login, ...)
    # are enabled ONLY when APP_ENV is exactly "development".
    is_development: bool = app_env == "development"

    # CORS — comma-separated list of allowed browser origins
    cors_origins: list[str] = [
        o.strip()
        for o in os.getenv(
            "CORS_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000",
        ).split(",")
        if o.strip()
    ]
    # Optional regex for extra origins, e.g. Vercel's per-deployment URLs
    cors_origin_regex: str | None = os.getenv("CORS_ORIGIN_REGEX") or None

    # Cookies — Secure flag defaults to on in production (requires HTTPS)
    cookie_secure: bool = os.getenv(
        "COOKIE_SECURE", "true" if app_env == "production" else "false"
    ).lower() in ("1", "true", "yes")
    # SameSite for the refresh cookie. Use "none" when the frontend and API are on
    # different sites (e.g. Vercel + Render); browsers require Secure with "none".
    cookie_samesite: str = os.getenv(
        "COOKIE_SAMESITE", "none" if cookie_secure else "lax"
    ).lower()

    # Admins may run INSERT/UPDATE/DELETE/DDL from the SQL console ("write mode").
    # Regular users and the AI chat are always read-only.
    admin_sql_writes: bool = os.getenv("ADMIN_SQL_WRITES", "true").lower() in ("1", "true", "yes")

    # Redis (query cache)
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379")

    # JWT timing
    access_token_expire_minutes: int = _int("ACCESS_TOKEN_EXPIRE_MINUTES", 15)
    refresh_token_expire_days: int = _int("REFRESH_TOKEN_EXPIRE_DAYS", 7)

    # Email token timing (in minutes)
    password_reset_expire_minutes: int = _int("PASSWORD_RESET_EXPIRE_MINUTES", 60)  # 1h

    # Databases
    database_url: str = re.sub(
        r"^postgres(ql)?://",
        "postgresql+asyncpg://",
        os.getenv(
            "DATABASE_URL",
            "postgresql+asyncpg://postgres:postgres@localhost:5432/sqlanalyst",
        ),
    )  # hosts like Render hand out postgres:// URLs; asyncpg needs the driver prefix
    target_db_url: str = os.getenv("TARGET_DB_URL", "sqlite:///./data/analytics.db")

    # AI / LLM
    groq_api_key: str = os.getenv("GROQ_API_KEY", "")
    llm_model: str = os.getenv("LLM_MODEL", "llama-3.3-70b-versatile")
    llm_base_url: str = os.getenv("LLM_BASE_URL", "https://api.groq.com")
    llm_temperature: float = _float("LLM_TEMPERATURE", 0.0)
    llm_max_tokens: int = _int("LLM_MAX_TOKENS", 500)
    llm_explanation_temperature: float = _float("LLM_EXPLANATION_TEMPERATURE", 0.3)
    llm_explanation_max_tokens: int = _int("LLM_EXPLANATION_MAX_TOKENS", 300)

    # Conversation memory: embedding model (true) or keyword matching (false).
    # The model needs ~500 MB of RAM — set false on small hosts (e.g. Render free).
    rag_enabled: bool = os.getenv("RAG_ENABLED", "true").lower() in ("1", "true", "yes")

    # Security
    db_max_rows: int = _int("DB_MAX_ROWS", 10000)
    db_encryption_key: str = os.getenv("DB_ENCRYPTION_KEY", "")

    # SMTP (for email verification & password reset)
    smtp_host: str = os.getenv("SMTP_HOST", "").strip()
    smtp_port: int = _int("SMTP_PORT", 465)
    smtp_user: str = os.getenv("SMTP_USER", "").strip()
    smtp_password: str = os.getenv("SMTP_PASSWORD", "")
    smtp_from: str = os.getenv("SMTP_FROM", "noreply@sqlanalyst.local").strip()
    smtp_timeout: int = _int("SMTP_TIMEOUT", 15)  # seconds before giving up on the mail server

    # Print every SQL statement the app runs (very noisy — hides real errors)
    sql_echo: bool = os.getenv("SQL_ECHO", "false").lower() in ("1", "true", "yes")

    # Brevo HTTP email API. Used instead of SMTP when set — needed on hosts that
    # block outbound SMTP ports (e.g. Render free). Sender = SMTP_FROM, which
    # must be a verified sender in Brevo.
    brevo_api_key: str = os.getenv("BREVO_API_KEY", "").strip()

    @property
    def smtp_configured(self) -> bool:
        if self.brevo_api_key:
            return bool(self.smtp_from or self.smtp_user)
        return bool(self.smtp_host and self.smtp_user and self.smtp_password)

    # Default admin seed credentials
    default_admin_email: str = os.getenv("DEFAULT_ADMIN_EMAIL", "admin@sqlanalyst.com")
    default_admin_password: str = os.getenv("DEFAULT_ADMIN_PASSWORD", "Admin1234")
    default_admin_name: str = os.getenv("DEFAULT_ADMIN_NAME", "Admin")

    # Google OAuth
    google_client_id: str = os.getenv(
        "GOOGLE_CLIENT_ID", "your-google-client-id.apps.googleusercontent.com"
    )
    google_client_secret: str = os.getenv("GOOGLE_CLIENT_SECRET", "")


_WEAK_SECRETS = {"", "change-me", "change-me-in-production", "secret"}


def validate_production_settings(s: "Settings") -> None:
    """
    Refuse to start in production with insecure defaults.
    Raises RuntimeError listing every problem found.
    """
    if not s.is_production:
        return
    problems = []
    if s.secret_key in _WEAK_SECRETS or len(s.secret_key) < 32:
        problems.append("SECRET_KEY must be a random string of at least 32 characters")
    if not s.db_encryption_key:
        problems.append(
            "DB_ENCRYPTION_KEY must be set (generate with: "
            'python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")'
        )
    if s.default_admin_password in ("Admin1234", ""):
        problems.append("DEFAULT_ADMIN_PASSWORD must be changed from the default")
    if problems:
        raise RuntimeError("Insecure production configuration:\n  - " + "\n  - ".join(problems))


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance (read env only once)."""
    return Settings()


# Export a singleton used throughout the code base
settings = get_settings()
