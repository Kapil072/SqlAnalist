import os
from typing import Any
from urllib.parse import quote_plus

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import settings
from app.models.data_source import DataSource
from app.db.table_rules import table_rules
from app.utils.logger import logger

# ---------------------------------------------------------------------------
# Encryption key for stored data-source passwords
# ---------------------------------------------------------------------------
# Previously a NEW random key was generated on every start when
# DB_ENCRYPTION_KEY was empty, so every saved password became unreadable
# after a restart. Now:
#   - DB_ENCRYPTION_KEY set          → use it (required in production)
#   - not set, development/test      → generate once and persist it in
#                                      backend/data/.encryption_key
_KEY_FILE = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data", ".encryption_key")
)


def _get_encryption_key() -> str:
    key = (settings.db_encryption_key or "").strip()
    if key:
        return key
    if settings.is_production:
        raise RuntimeError("DB_ENCRYPTION_KEY must be set in production.")
    if os.path.exists(_KEY_FILE):
        with open(_KEY_FILE, encoding="utf-8") as f:
            stored = f.read().strip()
        if stored:
            return stored
    key = Fernet.generate_key().decode()
    os.makedirs(os.path.dirname(_KEY_FILE), exist_ok=True)
    with open(_KEY_FILE, "w", encoding="utf-8") as f:
        f.write(key)
    logger.warning(
        f"[CONNECTION_MANAGER] DB_ENCRYPTION_KEY not set — generated one and saved it to {_KEY_FILE}. "
        "Copy it into DB_ENCRYPTION_KEY in your .env (and keep it safe)."
    )
    return key


ENCRYPTION_KEY = _get_encryption_key()
try:
    fernet = Fernet(ENCRYPTION_KEY.encode())
except (ValueError, TypeError) as exc:
    raise RuntimeError(
        "DB_ENCRYPTION_KEY is not a valid Fernet key. Generate one with: "
        'python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"'
    ) from exc

# In-memory cache for engines to avoid creating new connections constantly
_engine_cache: dict[Any, Any] = {}
_schema_cache: dict[str, dict] = {}


def inspect_schema_sync(conn) -> dict:
    """Synchronous schema introspection — call via AsyncConnection.run_sync()."""
    from sqlalchemy import inspect

    insp = inspect(conn)
    schema_data: dict[str, Any] = {"tables": {}}
    for table in insp.get_table_names():
        cols = []
        try:
            for col in insp.get_columns(table):
                cols.append(
                    {
                        "name": col["name"],
                        "type": str(col["type"]),
                        "nullable": col.get("nullable", True),
                        "default": None if col.get("default") is None else str(col.get("default")),
                    }
                )
        except Exception as e:
            logger.warning(f"[SCHEMA] Failed to get columns for table {table}: {e}")
        schema_data["tables"][table] = {"columns": cols, **table_rules(insp, table)}
    return schema_data


class ConnectionManager:
    @staticmethod
    def encrypt_password(password: str) -> str:
        return fernet.encrypt(password.encode()).decode()

    @staticmethod
    def decrypt_password(encrypted_password: str) -> str:
        if not encrypted_password:
            return ""
        try:
            return fernet.decrypt(encrypted_password.encode()).decode()
        except InvalidToken as exc:
            raise ValueError(
                "Stored password cannot be decrypted (DB_ENCRYPTION_KEY changed?). "
                "Re-enter the password for this data source."
            ) from exc

    @staticmethod
    def invalidate_cache(data_source_id):
        engine = _engine_cache.pop(data_source_id, None)
        _schema_cache.pop(str(data_source_id), None)
        if engine is not None:
            try:
                import asyncio

                asyncio.get_running_loop().create_task(engine.dispose())
            except RuntimeError:
                pass  # no running loop — engine will be garbage-collected

    @staticmethod
    def get_connection_url(data_source: DataSource) -> str:
        # Reconstruct the connection URL based on db_type
        password = quote_plus(
            ConnectionManager.decrypt_password(data_source.encrypted_password or "")
        )
        user = quote_plus(data_source.username or "")
        if data_source.db_type == "sqlite":
            return f"sqlite+aiosqlite:///{data_source.database_name}"
        elif data_source.db_type == "postgresql":
            return f"postgresql+asyncpg://{user}:{password}@{data_source.host}:{data_source.port}/{data_source.database_name}"
        elif data_source.db_type == "mysql":
            return f"mysql+aiomysql://{user}:{password}@{data_source.host}:{data_source.port}/{data_source.database_name}"
        elif data_source.db_type == "sqlserver":
            return f"mssql+aioodbc://{user}:{password}@{data_source.host}:{data_source.port}/{data_source.database_name}"
        elif data_source.db_type == "oracle":
            return f"oracle+oracledb://{user}:{password}@{data_source.host}:{data_source.port}/{data_source.database_name}"
        raise ValueError(f"Unsupported db_type: {data_source.db_type}")

    @staticmethod
    def create_engine(data_source: DataSource):
        """Create a new (uncached) async engine for *data_source*."""
        return create_async_engine(
            ConnectionManager.get_connection_url(data_source),
            pool_pre_ping=True,
        )

    @staticmethod
    def get_engine(data_source: DataSource):
        """Return a cached engine for a saved data source."""
        if data_source.id is None:
            # Unsaved (e.g. connection test) — never cache under a None key
            return ConnectionManager.create_engine(data_source)
        if data_source.id in _engine_cache:
            return _engine_cache[data_source.id]
        engine = ConnectionManager.create_engine(data_source)
        _engine_cache[data_source.id] = engine
        return engine

    @staticmethod
    async def get_schema(data_source: DataSource, raise_errors: bool = False) -> dict:
        """
        Introspect and cache tables and columns for a dynamic data source.
        raise_errors=True re-raises connection errors instead of returning an
        empty schema, so callers can tell the user WHY no tables were found.
        Failures are never cached — the next call tries again.
        """
        ds_id = str(data_source.id)
        if ds_id in _schema_cache:
            return _schema_cache[ds_id]

        engine = ConnectionManager.get_engine(data_source)

        try:
            async with engine.connect() as conn:
                schema_dict = await conn.run_sync(inspect_schema_sync)
                _schema_cache[ds_id] = schema_dict
                return schema_dict
        except Exception as e:
            logger.error(
                f"[SCHEMA] Failed to introspect schema for data source {data_source.name}: {e}"
            )
            # Drop the cached engine: a broken connection should not be reused
            ConnectionManager.invalidate_cache(data_source.id)
            if raise_errors:
                raise
            return {"tables": {}}
