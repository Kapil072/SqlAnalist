"""
In-memory file session store.

When a user uploads a CSV or Excel file, the data is loaded into
an in-memory SQLite database. A unique file_session_id is returned.
Subsequent questions can be routed to this SQLite instead of MySQL.

Sessions are stored in process memory — they disappear on server
restart or when evicted (max 100 sessions, LRU-style).
"""

import sqlite3
import threading
import uuid
import io
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

from app.utils.logger import logger

MAX_SESSIONS = 100

_store: OrderedDict[str, sqlite3.Connection] = OrderedDict()
_meta:  Dict[str, Dict[str, Any]] = {}   # session_id → {filename, rows, columns, table_name}
_lock = threading.Lock()


def _sanitize_col(name: str) -> str:
    """Make a column name safe for SQLite."""
    import re
    safe = re.sub(r'[^\w]', '_', str(name)).strip('_') or 'col'
    if safe[0].isdigit():
        safe = 'c_' + safe
    return safe


def _sanitize_table(name: str) -> str:
    import re
    return re.sub(r'[^\w]', '_', name).strip('_') or 'data'


def create_file_session(
    filename: str,
    data_bytes: bytes,
    ext: str,
) -> Tuple[str, Dict[str, Any]]:
    """
    Parse data_bytes (CSV or Excel) and load into an in-memory SQLite.
    Returns (file_session_id, meta_dict).
    """
    import pandas as pd

    # Parse
    if ext == 'csv':
        df = pd.read_csv(io.BytesIO(data_bytes), nrows=50_000)
    else:
        df = pd.read_excel(io.BytesIO(data_bytes), nrows=50_000)

    # Sanitize column names
    df.columns = [_sanitize_col(c) for c in df.columns]
    table_name = _sanitize_table(filename.rsplit('.', 1)[0])

    # Create in-memory SQLite and load data
    conn = sqlite3.connect(':memory:', check_same_thread=False)
    df.to_sql(table_name, conn, index=False, if_exists='replace')
    conn.commit()

    rows, cols = df.shape
    columns = list(df.columns)

    session_id = str(uuid.uuid4())
    meta = {
        'filename':   filename,
        'table_name': table_name,
        'rows':       rows,
        'columns':    columns,
        'original_columns': columns,  # after sanitization
    }

    with _lock:
        # Evict oldest if at capacity
        if len(_store) >= MAX_SESSIONS:
            oldest = next(iter(_store))
            _store[oldest].close()
            del _store[oldest]
            del _meta[oldest]

        _store[session_id] = conn
        _meta[session_id]  = meta

    logger.info(f"[FILE_SESSION] Created {session_id}: {filename} ({rows} rows, {cols} cols)")
    return session_id, meta


def get_file_session(session_id: str) -> Optional[Tuple[sqlite3.Connection, Dict[str, Any]]]:
    """Return (connection, meta) for a session, or None if not found."""
    with _lock:
        conn = _store.get(session_id)
        meta = _meta.get(session_id)
    if conn is None:
        return None
    return conn, meta


def execute_on_file(session_id: str, sql: str) -> Tuple[List[str], List[List[Any]], int]:
    """
    Run a SQL query on a file session's SQLite database.
    Returns (columns, rows, timing_ms).
    Raises ValueError if session not found.
    Raises Exception if query fails.
    """
    import time

    result = get_file_session(session_id)
    if result is None:
        raise ValueError(f"File session '{session_id}' not found or expired.")

    conn, meta = result
    t0 = time.monotonic()

    cursor = conn.cursor()
    cursor.execute(sql)

    col_names = [desc[0] for desc in (cursor.description or [])]
    rows      = [list(r) for r in cursor.fetchmany(5000)]
    timing_ms = int((time.monotonic() - t0) * 1000)

    return col_names, rows, timing_ms


def clear_file_session(session_id: str) -> None:
    with _lock:
        conn = _store.pop(session_id, None)
        _meta.pop(session_id, None)
    if conn:
        conn.close()


def session_count() -> int:
    return len(_store)
