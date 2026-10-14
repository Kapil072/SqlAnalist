"""
Admin write mode for the SQL console.

POST /admin/sql/execute
    {"sql": "...", "data_source_id": "<id>" | null, "confirm_full_table": false}

Regular users — and the AI chat — are always read-only. Admins can run
INSERT / UPDATE / DELETE / MERGE, CREATE/DROP TABLE|VIEW|INDEX, ALTER TABLE
and TRUNCATE on the default database or a data source. Every statement is
checked by sql_safety/admin_writes.py, runs in its own transaction
(committed on success, rolled back on error), and is written to the audit
log. UPDATE/DELETE without WHERE, TRUNCATE and DROP return 409 until the
request is repeated with "confirm_full_table": true.

Disable completely with ADMIN_SQL_WRITES=false.
The database account in TARGET_DB_URL / the data source must itself be
allowed to write — a read-only account will refuse with a permission error.
"""

import asyncio
import re
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.friendly_errors import friendly_message, missing_reference
from app.core.security import require_admin
from app.db.connection import get_engine
from app.db.schema_registry import refresh_schema
from app.db.session import AsyncSessionLocal, get_db
from app.models.audit_log import AuditLog
from app.services.connection_manager import ConnectionManager
from app.services.query_cache import query_cache
from app.services.query_pipeline import (
    load_active_data_source,
    resolve_context,
    run_query,
)
from app.sql_safety.admin_writes import AdminSQLError, validate_admin_sql
from app.sql_safety.validator import SQLValidationError, validate_sql
from app.utils.logger import logger

router = APIRouter(prefix="/admin/sql", tags=["admin"])

STATEMENT_TIMEOUT_MS = 60_000


class AdminSQLRequest(BaseModel):
    sql: str
    data_source_id: str | None = None
    # Second confirmation for UPDATE/DELETE without WHERE, TRUNCATE and DROP
    confirm_full_table: bool = False


async def _audit(
    user_id, sql: str, status: str, rows: int | None, ms: int | None, err: str | None = None
):
    try:
        async with AsyncSessionLocal() as db:
            db.add(
                AuditLog(
                    user_id=user_id,
                    question=f"[ADMIN WRITE] {sql}"[:4000],
                    sql_used=sql,
                    row_count=rows,
                    timing_ms=ms,
                    status=status,
                    error_msg=err,
                )
            )
            await db.commit()
    except Exception as e:  # never fail the request because of the audit log
        logger.warning(f"[ADMIN SQL] audit log failed: {e}")


def _run_on_default(sql: str) -> int:
    """Synchronous: execute + commit on TARGET_DB_URL. Returns rows affected."""
    engine = get_engine()
    with engine.begin() as conn:  # commits on success, rolls back on error
        if engine.dialect.name == "postgresql":
            conn.execute(text(f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}"))
        result = conn.execute(text(sql))
        return result.rowcount if result.rowcount is not None else -1


async def _run_on_source(data_source, sql: str) -> int:
    engine = ConnectionManager.get_engine(data_source)
    async with engine.begin() as conn:  # commits on success, rolls back on error
        if data_source.db_type == "postgresql":
            await conn.execute(text(f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}"))
        result = await conn.execute(text(sql))
        return result.rowcount if result.rowcount is not None else -1


async def _existing_values(data_source, table: str, column: str) -> list:
    """A few values that do exist, to suggest after a foreign key error."""
    try:
        sql = f"SELECT {column} FROM {table} ORDER BY {column} LIMIT 10"
        res = await run_query(sql, data_source)
        return [r[0] for r in res.rows]
    except Exception:
        return []


@router.post("/execute")
async def execute_admin_sql(
    body: AdminSQLRequest,
    admin=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    if not settings.admin_sql_writes:
        raise HTTPException(
            status_code=403, detail="Admin write mode is disabled (ADMIN_SQL_WRITES=false)."
        )

    data_source = None
    if body.data_source_id and body.data_source_id != "default":
        data_source = await load_active_data_source(db, body.data_source_id)
    dialect, schema, existing_tables = await resolve_context(data_source)

    try:
        stmt = validate_admin_sql(
            body.sql,
            dialect=dialect,
            existing_tables=existing_tables,
            allow_full_table=body.confirm_full_table,
        )
    except AdminSQLError as exc:
        # 409 = allowed, but only after the admin confirms a whole-table change
        raise HTTPException(
            status_code=409 if exc.needs_confirmation else 400,
            detail=exc.message,
        )

    # A plain SELECT in write mode just runs through the normal read-only path
    if stmt.kind == "select":
        try:
            safe_sql = validate_sql(stmt.sql, dialect=dialect, allowed_tables=existing_tables)
        except SQLValidationError as exc:
            raise HTTPException(status_code=400, detail=f"Safety Check Failed: {exc.message}")
        res = await run_query(safe_sql, data_source)
        return {
            "kind": "select",
            "sql": safe_sql,
            "columns": res.columns,
            "rows": res.rows,
            "row_count": res.row_count,
            "truncated": res.truncated,
            "timing_ms": res.timing_ms,
        }

    target = data_source.name if data_source else "default database"
    start = time.monotonic()
    try:
        if data_source is not None:
            rows = await _run_on_source(data_source, stmt.sql)
        else:
            rows = await asyncio.to_thread(_run_on_default, stmt.sql)
    except Exception as exc:
        ms = int((time.monotonic() - start) * 1000)
        logger.error(f"[ADMIN SQL] {admin.email} on {target} failed: {exc}")
        await _audit(admin.id, stmt.sql, "error", None, ms, str(exc)[:2000])
        detail = friendly_message("Not saved", exc, schema, show_details=not settings.is_production)
        missing = missing_reference(exc)
        if missing and re.fullmatch(r"\w+", missing[0]) and re.fullmatch(r"\w+", missing[2]):
            values = await _existing_values(data_source, missing[2], missing[0])
            if values:
                detail += f" Existing {missing[0]} values: {', '.join(map(str, values))}."
        raise HTTPException(status_code=400, detail=detail)

    ms = int((time.monotonic() - start) * 1000)
    logger.info(
        f"[ADMIN SQL] {admin.email} ran {stmt.kind.upper()} on {target}: {rows} row(s), {ms}ms"
    )
    await _audit(admin.id, stmt.sql, "success", rows if rows >= 0 else None, ms)

    # Keep caches honest: cached query results and table lists may now be stale
    schema_refreshed = False
    if data_source is not None:
        await query_cache.invalidate_data_source(str(data_source.id))
        if stmt.changes_schema:
            ConnectionManager.invalidate_cache(data_source.id)
            schema_refreshed = True
    elif stmt.changes_schema:
        await asyncio.to_thread(refresh_schema)
        schema_refreshed = True

    return {
        "kind": stmt.kind,
        "sql": stmt.sql,
        "rows_affected": rows if rows >= 0 else None,
        "timing_ms": ms,
        "schema_refreshed": schema_refreshed,
        "database": target,
    }
