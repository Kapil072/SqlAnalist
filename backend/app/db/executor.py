"""
Safe query executor — runs pre-validated SQL against the target DB.
Always rolls back the transaction (even on success) for maximum safety.
"""
import time
from typing import Any, Dict, List, Optional
from dataclasses import dataclass

from app.db.connection import engine as target_engine
from app.config import settings
from app.utils.logger import logger


@dataclass
class QueryResult:
    columns: List[str]
    rows: List[List[Any]]
    row_count: int
    timing_ms: int
    truncated: bool = False  # True if row cap was hit


def execute_safe_query(sql: str, max_rows: Optional[int] = None) -> QueryResult:
    """
    Execute a pre-validated SQL string against the target database.
    - Uses a transaction that is ALWAYS rolled back
    - Enforces a hard row cap
    - Sets a statement timeout for PostgreSQL
    """
    cap = max_rows or settings.db_max_rows
    start = time.monotonic()

    conn = target_engine.raw_connection()
    try:
        cursor = conn.cursor()

        # Timeout safety (5 seconds)
        url = settings.target_db_url
        if "postgresql" in url or "postgres" in url:
            try:
                cursor.execute("SET statement_timeout = '5000ms'")
            except Exception:
                pass  # Not critical
        elif "mysql" in url:
            try:
                cursor.execute("SET max_execution_time = 5000")
            except Exception:
                pass  # Not critical

        cursor.execute(sql)

        columns: List[str] = []
        rows: List[List[Any]] = []
        truncated = False

        if cursor.description:
            columns = [desc[0] for desc in cursor.description]
            raw_rows = cursor.fetchmany(cap + 1)

            if len(raw_rows) > cap:
                raw_rows = raw_rows[:cap]
                truncated = True

            rows = [list(row) for row in raw_rows] #Convert row into List

        elapsed_ms = int((time.monotonic() - start) * 1000)
        logger.info(f"[EXECUTOR] Query returned {len(rows)} rows in {elapsed_ms}ms (truncated={truncated})")

        return QueryResult(
            columns=columns,
            rows=rows,
            row_count=len(rows),
            timing_ms=elapsed_ms,
            truncated=truncated,
        )

    except Exception as exc:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        logger.error(f"[EXECUTOR] Query failed after {elapsed_ms}ms: {exc}")
        raise Exception(f"Query execution failed: {exc}") from exc

    finally:
        # ALWAYS rollback — we never want user queries to have side effects
        try:
            conn.rollback()
        except Exception:
            pass
        conn.close()
