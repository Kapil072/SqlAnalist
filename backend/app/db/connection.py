# Target DB connection module
#
# The engine is built lazily and cached. Calling reset_engine() (or
# POST /api/schema/refresh) tears it down and rebuilds it from the
# current TARGET_DB_URL — so a URL change takes effect without a
# full server restart.

from contextlib import contextmanager
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from app.utils.logger import logger

_engine: Engine | None = None


def _build_engine() -> Engine:
    from app.config import settings          # re-read every time so .env changes are picked up
    url = settings.target_db_url
    kwargs = {"future": True, "pool_pre_ping": True}

    # SQLite doesn't support connection pooling arguments
    if not url.startswith("sqlite"):
        kwargs.update({"pool_size": 5, "max_overflow": 10})

    logger.info(f"[CONNECTION] Building engine for: {url}")
    return create_engine(url, **kwargs)


def get_engine() -> Engine:
    """Return the shared engine, creating it on first call."""
    global _engine
    if _engine is None:
        _engine = _build_engine()
    return _engine


def reset_engine() -> None:
    """
    Dispose the current engine and clear the cache.
    The next call to get_engine() / get_target_connection() will build
    a fresh engine from the current TARGET_DB_URL.

    Called automatically by schema_registry.refresh_schema().
    """
    global _engine
    if _engine is not None:
        try:
            _engine.dispose()
        except Exception:
            pass
        _engine = None
    logger.info("[CONNECTION] Engine reset — will reconnect on next request.")


# ---------------------------------------------------------------------------
# Convenience helpers used by the rest of the codebase
# ---------------------------------------------------------------------------

@contextmanager
def get_target_connection():
    """Yield a raw DBAPI connection and ensure it is closed."""
    conn = get_engine().raw_connection()
    try:
        yield conn
    finally:
        conn.close()


# Keep this as a module-level alias so existing imports of
# `from app.db.connection import engine` still resolve.
# It proxies to get_engine() so it always reflects the current engine.
class _EngineProxy:
    """Thin proxy that forwards attribute access to the live engine."""
    def __getattr__(self, name):
        return getattr(get_engine(), name)

    def __repr__(self):
        return repr(get_engine())


engine = _EngineProxy()
target_engine = engine          # backward-compat alias
