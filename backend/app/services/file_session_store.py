"""
In-memory file session store.

When a user uploads a CSV or Excel file, the data is loaded into
an in-memory SQLite database. A unique file_session_id is returned.
Subsequent questions can be routed to this SQLite instead of the main DB.

Sessions are stored in process memory — they disappear on server restart,
when evicted (max MAX_SESSIONS, oldest first) or after SESSION_TTL_SECONDS
without use. Each session belongs to the user who uploaded it; other users
cannot query it even if they learn the session id.
"""

import io
import re
import sqlite3
import threading
import time
import uuid
from collections import OrderedDict
from typing import Any

from app.utils.logger import logger

MAX_SESSIONS = 100
SESSION_TTL_SECONDS = 60 * 60  # 1 hour idle
MAX_RESULT_ROWS = 5000

_store: "OrderedDict[str, sqlite3.Connection]" = OrderedDict()
_meta: dict[
    str, dict[str, Any]
] = {}  # session_id → {filename, rows, columns, table_name, owner_id, last_used}
_lock = threading.Lock()


def _sanitize_col(name: str) -> str:
    """Make a column name safe for SQLite."""
    safe = re.sub(r"[^\w]", "_", str(name)).strip("_") or "col"
    if safe[0].isdigit():
        safe = "c_" + safe
    return safe


def _sanitize_table(name: str) -> str:
    safe = re.sub(r"[^\w]", "_", name).strip("_") or "data"
    if safe[0].isdigit():
        safe = "t_" + safe  # identifiers may not start with a digit
    return safe.lower()


def _dedupe(columns: list[str]) -> list[str]:
    """Sanitised names can collide ("Sales $" and "Sales %") — make them unique."""
    seen: dict[str, int] = {}
    out = []
    for c in columns:
        if c in seen:
            seen[c] += 1
            out.append(f"{c}_{seen[c]}")
        else:
            seen[c] = 0
            out.append(c)
    return out


def _describe_columns(df: Any, n_samples: int = 5) -> list[dict[str, Any]]:
    """Per-column type + a few distinct sample values, so the LLM knows what the data looks like."""
    info = []
    for c in df.columns:
        series = df[c].dropna()
        samples = []
        for v in series.unique()[:n_samples]:
            s = str(v)
            samples.append(s[:40] + "…" if len(s) > 40 else s)
        kind = df[c].dtype.kind
        sql_type = "INTEGER" if kind in "iu" else "REAL" if kind == "f" else "TEXT"
        info.append({"name": c, "type": sql_type, "samples": samples})
    return info


def _close_session_locked(session_id: str) -> None:
    conn = _store.pop(session_id, None)
    _meta.pop(session_id, None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass


def _evict_expired_locked() -> None:
    now = time.monotonic()
    expired = [
        sid for sid, m in _meta.items() if now - m.get("last_used", now) > SESSION_TTL_SECONDS
    ]
    for sid in expired:
        _close_session_locked(sid)
    if expired:
        logger.info(f"[FILE_SESSION] Evicted {len(expired)} idle session(s)")


def create_file_session(
    filename: str,
    data_bytes: bytes,
    ext: str,
    owner_id: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """
    Parse data_bytes (CSV or Excel) and load into an in-memory SQLite.
    Returns (file_session_id, meta_dict).
    """
    import pandas as pd

    # Parse
    if ext == "csv":
        df = pd.read_csv(io.BytesIO(data_bytes), nrows=50_000)
    else:
        df = pd.read_excel(io.BytesIO(data_bytes), nrows=50_000)

    # Sanitize column names
    df.columns = _dedupe([_sanitize_col(c) for c in df.columns])
    table_name = _sanitize_table(filename.rsplit(".", 1)[0])

    # Trim stray whitespace in text cells so searches like "Delhi" match " Delhi "
    for c in df.select_dtypes(include="object").columns:
        df[c] = df[c].map(lambda v: v.strip() if isinstance(v, str) else v)

    column_info = _describe_columns(df)

    # Create in-memory SQLite and load data
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    df.to_sql(table_name, conn, index=False, if_exists="replace")
    conn.commit()
    # Defence in depth: the connection is read-only from now on
    conn.execute("PRAGMA query_only = ON")

    rows, cols = df.shape
    columns = list(df.columns)

    session_id = str(uuid.uuid4())
    meta = {
        "filename": filename,
        "table_name": table_name,
        "rows": rows,
        "columns": columns,
        "original_columns": columns,  # after sanitization
        "column_info": column_info,
        "owner_id": owner_id,
        "last_used": time.monotonic(),
    }

    with _lock:
        _evict_expired_locked()
        # Evict oldest if at capacity
        while len(_store) >= MAX_SESSIONS:
            _close_session_locked(next(iter(_store)))
        _store[session_id] = conn
        _meta[session_id] = meta

    logger.info(f"[FILE_SESSION] Created {session_id}: {filename} ({rows} rows, {cols} cols)")
    return session_id, meta


def get_file_session(
    session_id: str,
    owner_id: str | None = None,
) -> tuple[sqlite3.Connection, dict[str, Any]] | None:
    """
    Return (connection, meta) for a session, or None if not found / expired /
    owned by a different user.
    """
    with _lock:
        _evict_expired_locked()
        conn = _store.get(session_id)
        meta = _meta.get(session_id)
        if conn is None or meta is None:
            return None
        if owner_id is not None and meta.get("owner_id") not in (None, owner_id):
            return None
        meta["last_used"] = time.monotonic()
        _store.move_to_end(session_id)
    return conn, meta


def execute_on_file(
    session_id: str,
    sql: str,
    owner_id: str | None = None,
) -> tuple[list[str], list[list[Any]], int]:
    """
    Run a (pre-validated) SQL query on a file session's SQLite database.
    Returns (columns, rows, timing_ms).
    Raises ValueError if session not found.
    """
    result = get_file_session(session_id, owner_id)
    if result is None:
        raise ValueError("File session not found or expired.")

    conn, _meta_ = result
    t0 = time.monotonic()

    cursor = conn.cursor()
    try:
        cursor.execute(sql)
        col_names = [desc[0] for desc in (cursor.description or [])]
        rows = [list(r) for r in cursor.fetchmany(MAX_RESULT_ROWS)]
    finally:
        cursor.close()
    timing_ms = int((time.monotonic() - t0) * 1000)

    return col_names, rows, timing_ms
