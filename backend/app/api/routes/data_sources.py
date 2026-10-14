"""
Data Source API endpoints for managing dynamic database connections.
All endpoints require admin privileges.
"""

import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_admin
from app.db.session import get_db
from app.models.data_source import DataSource
from app.models.user import User
from app.schemas.data_source import (
    DataSourceCreate,
    DataSourceResponse,
    DataSourceTestRequest,
    DataSourceTestResponse,
    DataSourceUpdate,
    QueryExecutionRequest,
    QueryExecutionResponse,
    SchemaReflectionResponse,
)
from app.services.connection_manager import ConnectionManager, inspect_schema_sync
from app.services.query_cache import query_cache
from app.services.query_pipeline import (
    load_active_data_source,
    public_error,
    run_on_data_source,
    tables_of,
)
from app.services.sql_dialect import dialect_for_db_type
from app.sql_safety.validator import SQLValidationError, validate_sql
from app.utils.logger import logger

router = APIRouter(prefix="/data-sources", tags=["data-sources"])


def _to_response(ds: DataSource) -> DataSourceResponse:
    return DataSourceResponse(
        id=ds.id,
        user_id=ds.user_id,
        name=ds.name,
        db_type=ds.db_type,
        host=ds.host,
        port=ds.port,
        username=ds.username,
        database_name=ds.database_name,
        is_active=ds.is_active,
        created_at=ds.created_at.isoformat(),
        updated_at=ds.updated_at.isoformat(),
    )


async def _get_data_source(db: AsyncSession, data_source_id: str) -> DataSource:
    try:
        ds_uuid = uuid.UUID(data_source_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid data source ID format")
    result = await db.execute(select(DataSource).where(DataSource.id == ds_uuid))
    data_source = result.scalar_one_or_none()
    if not data_source:
        raise HTTPException(status_code=404, detail="Data source not found")
    return data_source


# ---------------------------------------------------------------------------
# Data Source CRUD Operations
# ---------------------------------------------------------------------------


@router.post("", response_model=DataSourceResponse, status_code=201)
async def create_data_source(
    data_source: DataSourceCreate,
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Create a new data source connection (admin only)."""
    # Validate required fields based on db_type
    if data_source.db_type != "sqlite":
        if not all(
            [data_source.host, data_source.port, data_source.username, data_source.database_name]
        ):
            raise HTTPException(
                status_code=400,
                detail="host, port, username, and database_name are required for non-SQLite databases",
            )
    else:
        if not data_source.database_name:
            raise HTTPException(status_code=400, detail="database_name is required for SQLite")

    # Encrypt the password
    encrypted_password = None
    if data_source.password:
        encrypted_password = ConnectionManager.encrypt_password(data_source.password)

    new_data_source = DataSource(
        user_id=current_admin.id,
        name=data_source.name,
        db_type=data_source.db_type,
        host=data_source.host,
        port=data_source.port,
        username=data_source.username,
        database_name=data_source.database_name,
        encrypted_password=encrypted_password,
        is_active=True,
    )

    db.add(new_data_source)
    await db.commit()
    await db.refresh(new_data_source)

    logger.info(
        f"[DATA_SOURCE] Created new data source: {new_data_source.name} by admin {current_admin.email}"
    )
    return _to_response(new_data_source)


@router.get("", response_model=dict)
async def list_data_sources(
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
):
    """List all data sources (admin only)."""
    result = await db.execute(
        select(DataSource).order_by(DataSource.created_at.desc()).offset(skip).limit(limit)
    )
    data_sources = result.scalars().all()
    total = (await db.execute(select(func.count()).select_from(DataSource))).scalar_one()

    return {
        "total": total,
        "skip": skip,
        "limit": limit,
        "data_sources": [_to_response(ds) for ds in data_sources],
    }


@router.get("/{data_source_id}", response_model=DataSourceResponse)
async def get_data_source(
    data_source_id: str,
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Get a specific data source by ID (admin only)."""
    data_source = await _get_data_source(db, data_source_id)

    return _to_response(data_source)


@router.patch("/{data_source_id}", response_model=DataSourceResponse)
async def update_data_source(
    data_source_id: str,
    update_data: DataSourceUpdate,
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Update a data source (admin only)."""
    data_source = await _get_data_source(db, data_source_id)

    # Update fields if provided
    if update_data.name is not None:
        data_source.name = update_data.name
    if update_data.host is not None:
        data_source.host = update_data.host
    if update_data.port is not None:
        data_source.port = update_data.port
    if update_data.username is not None:
        data_source.username = update_data.username
    if update_data.database_name is not None:
        data_source.database_name = update_data.database_name
    if update_data.password is not None:
        data_source.encrypted_password = ConnectionManager.encrypt_password(update_data.password)
    if update_data.is_active is not None:
        data_source.is_active = update_data.is_active

    db.add(data_source)
    await db.commit()
    await db.refresh(data_source)

    # Clear connection manager engine/schema cache and query cache
    ConnectionManager.invalidate_cache(data_source.id)
    await query_cache.invalidate_data_source(str(data_source.id))

    logger.info(
        f"[DATA_SOURCE] Updated data source: {data_source.name} by admin {current_admin.email}"
    )
    return _to_response(data_source)


@router.delete("/{data_source_id}", status_code=204)
async def delete_data_source(
    data_source_id: str,
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Delete a data source (admin only)."""
    data_source = await _get_data_source(db, data_source_id)

    await db.delete(data_source)
    await db.commit()

    # Clear from connection manager cache
    ConnectionManager.invalidate_cache(data_source.id)

    # Clear query cache for this data source
    await query_cache.invalidate_data_source(str(data_source.id))

    logger.info(
        f"[DATA_SOURCE] Deleted data source: {data_source.name} by admin {current_admin.email}"
    )


# ---------------------------------------------------------------------------
# Connection Testing
# ---------------------------------------------------------------------------


@router.post("/test", response_model=DataSourceTestResponse)
async def test_data_source_connection(
    test_request: DataSourceTestRequest,
    current_admin: User = Depends(require_admin),
):
    """Test a data source connection without saving it (admin only)."""
    from sqlalchemy import text

    start_time = time.monotonic()
    engine = None
    try:
        temp_source = DataSource(
            user_id=current_admin.id,
            name="Test Connection",
            db_type=test_request.db_type,
            host=test_request.host,
            port=test_request.port,
            username=test_request.username,
            database_name=test_request.database_name,
            encrypted_password=ConnectionManager.encrypt_password(test_request.password)
            if test_request.password
            else None,
        )
        # A fresh engine every time — previously the unsaved source (id=None)
        # was cached, so every later test silently reused the FIRST test's engine.
        engine = ConnectionManager.create_engine(temp_source)
        probe = "SELECT 1 FROM dual" if test_request.db_type == "oracle" else "SELECT 1"
        async with engine.connect() as conn:
            await conn.execute(text(probe))

        return DataSourceTestResponse(
            success=True,
            message="Connection successful",
            execution_time_ms=int((time.monotonic() - start_time) * 1000),
        )
    except Exception as e:
        logger.error(f"[DATA_SOURCE] Connection test failed: {e}")
        return DataSourceTestResponse(
            success=False,
            message=public_error("Connection failed", e),
            execution_time_ms=int((time.monotonic() - start_time) * 1000),
        )
    finally:
        if engine is not None:
            await engine.dispose()


# ---------------------------------------------------------------------------
# Schema Reflection
# ---------------------------------------------------------------------------


@router.get("/{data_source_id}/schema", response_model=SchemaReflectionResponse)
async def get_data_source_schema(
    data_source_id: str,
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Get the database schema for a specific data source (admin only)."""
    data_source = await load_active_data_source(db, data_source_id)
    try:
        engine = ConnectionManager.get_engine(data_source)
        # Inspector is synchronous — it must run through run_sync() on an
        # async connection (calling inspect(conn) directly always failed).
        async with engine.connect() as conn:
            schema = await conn.run_sync(inspect_schema_sync)
    except Exception as e:
        logger.error(f"[DATA_SOURCE] Schema reflection failed for {data_source.name}: {e}")
        raise HTTPException(status_code=500, detail=public_error("Failed to reflect schema", e))

    tables = [
        {"name": name, "columns": info.get("columns", [])}
        for name, info in schema.get("tables", {}).items()
    ]
    return SchemaReflectionResponse(tables=tables, total_tables=len(tables))


# ---------------------------------------------------------------------------
# Query Execution
# ---------------------------------------------------------------------------


@router.post("/{data_source_id}/query", response_model=QueryExecutionResponse)
async def execute_query_on_data_source(
    data_source_id: str,
    query_request: QueryExecutionRequest,
    current_admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Execute a SQL query against a specific data source (admin only)."""
    from app.config import settings

    data_source = await load_active_data_source(db, data_source_id)

    # Validate against THIS data source's tables and dialect
    schema = await ConnectionManager.get_schema(data_source)
    max_rows = query_request.max_rows or settings.db_max_rows
    try:
        validated_sql = validate_sql(
            query_request.sql,
            dialect=dialect_for_db_type(data_source.db_type),
            allowed_tables=tables_of(schema),
            max_rows=max_rows,
        )
    except SQLValidationError as e:
        raise HTTPException(status_code=400, detail=f"SQL validation failed: {e.message}")

    page = query_request.page or 1
    page_size = query_request.page_size or 50

    def _response(data: dict) -> QueryExecutionResponse:
        all_rows = data["rows"]
        total_count = len(all_rows)
        start_idx = (page - 1) * page_size
        page_rows = all_rows[start_idx : start_idx + page_size]
        total_pages = (total_count + page_size - 1) // page_size if total_count else 0
        return QueryExecutionResponse(
            columns=data["columns"],
            rows=page_rows,
            row_count=len(page_rows),
            timing_ms=data["timing_ms"],
            truncated=data["truncated"],
            sql=validated_sql,
            pagination={
                "page": page,
                "page_size": page_size,
                "total_count": total_count,
                "total_pages": total_pages,
                "has_next": page < total_pages,
                "has_prev": page > 1,
            }
            if total_count
            else None,
        )

    # The cache stores the FULL capped result (not one page), keyed by SQL +
    # row cap, so every page is served correctly from one cached entry.
    cache_key_sql = f"{validated_sql}\n-- max_rows={max_rows}"
    cached = await query_cache.get(cache_key_sql, str(data_source.id))
    if cached:
        logger.info(f"[DATA_SOURCE] Returning cached result for query on {data_source.name}")
        return _response(cached)

    try:
        res = await run_on_data_source(data_source, validated_sql, max_rows=max_rows)
    except Exception as e:
        logger.error(f"[DATA_SOURCE] Query execution failed on {data_source.name}: {e}")
        raise HTTPException(status_code=500, detail=public_error("Query execution failed", e))

    data = {
        "columns": res.columns,
        "rows": res.rows,
        "timing_ms": res.timing_ms,
        "truncated": res.truncated,
    }
    await query_cache.set(cache_key_sql, data, str(data_source.id))
    return _response(data)
