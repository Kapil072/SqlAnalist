"""
Database sources that regular users can chat with.

GET  /sources                     — the default database + every ACTIVE data
                                    source an admin has added (no credentials)
GET  /sources/{source_id}/schema  — tables / columns / suggestions for one source
POST /sources/{source_id}/refresh — re-read the tables of one source

`source_id` is either "default" (the database in TARGET_DB_URL) or the UUID of
a data source created in the admin panel. The chat sends the chosen id as
`data_source_id` to /ask/stream, so questions are answered from — and SQL is
validated against — that database's own tables.
"""

import asyncio
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.security import get_current_user, require_admin
from app.db.schema_registry import get_schema, refresh_schema
from app.db.session import get_db
from app.models.data_source import DataSource
from app.services.connection_manager import ConnectionManager
from app.services.query_pipeline import (
    load_active_data_source,
    load_data_source_schema,
    public_error,
    source_label,
)
from app.services.sql_dialect import dialect_from_url
from app.utils.logger import logger

router = APIRouter(prefix="/sources", tags=["sources"])

DEFAULT_SOURCE_ID = "default"


def build_suggestions(table_names: list[str]) -> list[str]:
    """Example questions based on the tables that actually exist."""
    names = {t.lower() for t in table_names}
    suggestions: list[str] = []
    if "customers" in names:
        suggestions += [
            "Show me the top 5 customers by spending",
            "How many customers do we have by country?",
        ]
    if "orders" in names:
        suggestions += [
            "Show me recent orders",
            "What is the order status distribution?",
        ]
    if "products" in names:
        suggestions += [
            "Show me top selling products",
            "Which categories generate the most revenue?",
        ]
    if not suggestions and table_names:
        first = table_names[0]
        suggestions = [
            f"Show me 10 rows from {first}",
            f"How many rows are in {first}?",
        ]
        if len(table_names) > 1:
            suggestions.append(f"How many rows are in {table_names[1]}?")
    return suggestions


# table_rules() stores foreign keys as "col_a, col_b → other(id_a, id_b)"
_FK_RE = re.compile(r"^(.*?)\s*→\s*(.+?)\((.*)\)\s*$")


def _split_cols(text: str) -> list[str]:
    return [c.strip() for c in text.split(",") if c.strip()]


def _foreign_keys(info: dict[str, Any]) -> list[dict[str, Any]]:
    """Foreign keys as {columns, ref_table, ref_columns} for the schema diagram."""
    fks = []
    for fk in info.get("foreign_keys", []):
        m = _FK_RE.match(fk) if isinstance(fk, str) else None
        if m:
            fks.append(
                {
                    "columns": _split_cols(m.group(1)),
                    "ref_table": m.group(2).strip(),
                    "ref_columns": _split_cols(m.group(3)),
                }
            )
    return fks


def _schema_payload(schema: dict[str, Any]) -> dict[str, Any]:
    tables = [
        {
            "name": name,
            # Row counts are only collected for the default database
            # (counting every table of an external database can be slow)
            "row_count": info.get("row_count"),
            "columns": info.get("columns", []),
            "primary_key": info.get("primary_key", []),
            "foreign_keys": _foreign_keys(info),
        }
        for name, info in (schema or {}).get("tables", {}).items()
    ]
    return {
        "tables": tables,
        "suggestions": build_suggestions([t["name"] for t in tables]),
    }


@router.get("")
async def list_sources(
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Databases the current user can ask questions about."""
    result = await db.execute(
        select(DataSource).where(DataSource.is_active.is_(True)).order_by(DataSource.name)
    )
    sources = [
        {
            "id": DEFAULT_SOURCE_ID,
            "name": source_label(None),
            "db_type": dialect_from_url(settings.target_db_url),
            "is_default": True,
        }
    ]
    sources += [
        {"id": str(ds.id), "name": ds.name, "db_type": ds.db_type, "is_default": False}
        for ds in result.scalars().all()
    ]
    return {"sources": sources}


@router.get("/{source_id}/schema")
async def source_schema(
    source_id: str,
    _user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Tables, columns and example questions for one source."""
    if source_id == DEFAULT_SOURCE_ID:
        return {"source_id": source_id, **_schema_payload(get_schema())}

    data_source = await load_active_data_source(db, source_id)
    # Raises a clear 502/400 when the database cannot be reached or is empty
    schema = await load_data_source_schema(data_source)
    return {"source_id": source_id, **_schema_payload(schema)}


@router.post("/{source_id}/refresh")
async def refresh_source_schema(
    source_id: str,
    _admin=Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    Re-read the tables of a source (admin only) — use after tables are added
    or removed in that database.
    """
    try:
        if source_id == DEFAULT_SOURCE_ID:
            schema = await asyncio.to_thread(refresh_schema)
        else:
            data_source = await load_active_data_source(db, source_id)
            ConnectionManager.invalidate_cache(data_source.id)
            schema = await load_data_source_schema(data_source)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[SOURCES] Refresh failed for {source_id}: {e}")
        raise HTTPException(status_code=500, detail=public_error("Schema refresh failed", e))

    return {"source_id": source_id, **_schema_payload(schema)}
