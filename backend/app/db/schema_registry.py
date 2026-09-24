"""
Schema registry — introspects the live target database and caches the result.

Flow
----
1. At startup: refresh_schema() connects to TARGET_DB_URL, walks every table,
   writes data/schema_cache.json, and warms the in-process lru_cache.
2. get_schema() / get_allowed_tables() read from that cache (fast, no DB hit).
3. Changing TARGET_DB_URL in .env then calling POST /api/schema/refresh
   (or restarting the server) is all that is needed to switch databases.
"""

import json
import os
from functools import lru_cache
from typing import Any, Dict, Set

from sqlalchemy import inspect, text

from app.utils.logger import logger

_SCHEMA_CACHE_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "schema_cache.json")
)


# ---------------------------------------------------------------------------
# Live introspection
# ---------------------------------------------------------------------------

def _introspect_db() -> Dict[str, Any]:
    """
    Connect to the target DB, walk every table, and return a schema dict.
    Works with MySQL, PostgreSQL, SQLite, SQL Server, Oracle.
    """
    from app.db.connection import engine

    schema: Dict[str, Any] = {"tables": {}}

    try:
        inspector = inspect(engine)
        table_names = inspector.get_table_names()
        logger.info(f"[SCHEMA] Found {len(table_names)} tables in target DB.")

        with engine.connect() as conn:
            for table in table_names:
                # --- columns ---
                cols = []
                try:
                    for col in inspector.get_columns(table):
                        cols.append({
                            "name": col["name"],
                            "type": str(col["type"]),
                            "nullable": col.get("nullable", True),
                        })
                except Exception as col_err:
                    logger.warning(f"[SCHEMA] Could not read columns for '{table}': {col_err}")

                # --- row count (try backtick syntax first, then quoted) ---
                row_count = 0
                for count_sql in [
                    f"SELECT COUNT(*) FROM `{table}`",
                    f'SELECT COUNT(*) FROM "{table}"',
                    f"SELECT COUNT(*) FROM {table}",
                ]:
                    try:
                        row_count = conn.execute(text(count_sql)).scalar() or 0
                        break
                    except Exception:
                        continue

                schema["tables"][table] = {
                    "columns": cols,
                    "row_count": row_count,
                }

        logger.info(f"[SCHEMA] Introspection complete: {list(schema['tables'].keys())}")

    except Exception as exc:
        logger.error(f"[SCHEMA] DB introspection failed: {exc}")

    return schema


def _save_cache(schema: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(_SCHEMA_CACHE_PATH), exist_ok=True)
    with open(_SCHEMA_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(schema, f, indent=2)
    logger.info(f"[SCHEMA] schema_cache.json written ({len(schema['tables'])} tables).")


def _load_cache() -> Dict[str, Any]:
    if not os.path.exists(_SCHEMA_CACHE_PATH):
        logger.warning("[SCHEMA] schema_cache.json not found — returning empty schema.")
        return {"tables": {}}
    with open(_SCHEMA_CACHE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# lru_cache wrapper — cleared on every refresh
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _cached_schema() -> Dict[str, Any]:
    return _load_cache()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def refresh_schema() -> Dict[str, Any]:
    """
    Re-introspect the live target DB, overwrite schema_cache.json,
    and clear the in-process lru_cache.

    Also resets the DB engine so any TARGET_DB_URL change in .env
    is picked up immediately without a server restart.

    Call this:
      - at app startup  (automatic)
      - after changing TARGET_DB_URL
      - via POST /api/schema/refresh
    """
    # Reset the engine first so we connect to the current URL
    from app.db.connection import reset_engine
    reset_engine()

    schema = _introspect_db()
    _save_cache(schema)
    _cached_schema.cache_clear()          # bust the in-memory cache
    return schema


def get_schema() -> Dict[str, Any]:
    """Return the cached schema dict (reads file once per process lifetime)."""
    return _cached_schema()


def get_allowed_tables() -> Set[str]:
    """Return the set of allowed table names (lowercase)."""
    return {t.lower() for t in get_schema().get("tables", {}).keys()}
